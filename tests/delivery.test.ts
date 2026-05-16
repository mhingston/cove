import { afterEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DeliveryTimeoutError,
  findMissingOutboundSeqs,
  pollForResponse,
  readDeliverableMessages,
} from '../src/delivery.ts';
import {
  getNextOutboundSeq,
  openOutboundDb,
  readProcessingAck,
  readVisibleOutboundMessages,
  writeOutboundMessage,
  writeProcessingAck,
} from '../src/session/outbound.ts';

const tempDirs: string[] = [];
const openDbs: Database[] = [];

function makeTempSessionDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cove-v2-delivery-'));
  tempDirs.push(dir);
  return dir;
}

function createOutboundDb(): Database {
  const db = openOutboundDb(makeTempSessionDir());
  openDbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    db.close();
  }

  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('delivery', () => {
  it('getNextOutboundSeq uses the larger of lastOutSeq + 2 and inbound seq + 1', () => {
    expect(getNextOutboundSeq(7, 2)).toBe(9);
    expect(getNextOutboundSeq(1, 8)).toBe(9);
    expect(getNextOutboundSeq(null, 2)).toBe(3);
  });

  it('writes and reads outbound messages visible after a baseline seq', () => {
    const db = createOutboundDb();

    writeOutboundMessage(db, {
      id: 'out-1',
      seq: 3,
      role: 'assistant',
      content: 'first',
      finish_reason: 'stop',
      tool_calls: [{ id: 'tool-1' }],
      metadata: { phase: 1 },
    });
    writeOutboundMessage(db, {
      id: 'out-2',
      seq: 5,
      role: 'assistant',
      content: 'second',
    });

    expect(readVisibleOutboundMessages(db, 3)).toEqual([
      expect.objectContaining({
        id: 'out-2',
        seq: 5,
        role: 'assistant',
        content: 'second',
        finish_reason: null,
        tool_calls: null,
        metadata: null,
      }),
    ]);
  });

  it('writes and reads processing_ack rows for the current session', () => {
    const db = createOutboundDb();

    writeProcessingAck(db, {
      session_id: 'session-1',
      last_in_seq: 4,
      last_out_seq: 5,
      container_id: 'container-a',
      heartbeat_at: '2026-01-01T00:00:00.000Z',
    });
    writeProcessingAck(db, {
      session_id: 'session-1',
      last_in_seq: 6,
      last_out_seq: 7,
      container_id: 'container-b',
      heartbeat_at: '2026-01-01T00:00:01.000Z',
    });

    expect(readProcessingAck(db, 'session-1')).toEqual({
      session_id: 'session-1',
      last_in_seq: 6,
      last_out_seq: 7,
      container_id: 'container-b',
      heartbeat_at: '2026-01-01T00:00:01.000Z',
    });
    expect(readProcessingAck(db, 'session-2')).toBeNull();
  });

  it('does not regress processing ack seq values when a stale ack arrives after a newer one', () => {
    const db = createOutboundDb();

    writeProcessingAck(db, {
      session_id: 'session-1',
      last_in_seq: 6,
      last_out_seq: 7,
      container_id: 'container-b',
      heartbeat_at: '2026-01-01T00:00:01.000Z',
    });
    writeProcessingAck(db, {
      session_id: 'session-1',
      last_in_seq: 4,
      last_out_seq: 5,
      container_id: 'container-a',
      heartbeat_at: '2026-01-01T00:00:00.000Z',
    });

    expect(readProcessingAck(db, 'session-1')).toEqual({
      session_id: 'session-1',
      last_in_seq: 6,
      last_out_seq: 7,
      container_id: 'container-a',
      heartbeat_at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('returns visible outbound messages only when the current session ack aligns with the latest visible seq', () => {
    const db = createOutboundDb();

    writeOutboundMessage(db, {
      id: 'out-1',
      seq: 3,
      role: 'assistant',
      content: 'first',
    });
    writeOutboundMessage(db, {
      id: 'out-2',
      seq: 5,
      role: 'assistant',
      content: 'second',
    });
    writeProcessingAck(db, {
      session_id: 'other-session',
      last_in_seq: 4,
      last_out_seq: 5,
      heartbeat_at: '2026-01-01T00:00:00.000Z',
    });
    writeProcessingAck(db, {
      session_id: 'session-1',
      last_in_seq: 4,
      last_out_seq: 3,
      heartbeat_at: '2026-01-01T00:00:00.000Z',
    });

    expect(readDeliverableMessages({ db, sessionId: 'session-1', baselineOutSeq: 1 })).toBeNull();

    writeProcessingAck(db, {
      session_id: 'session-1',
      last_in_seq: 4,
      last_out_seq: 5,
      heartbeat_at: '2026-01-01T00:00:01.000Z',
    });

    expect(readDeliverableMessages({ db, sessionId: 'session-1', baselineOutSeq: 1 })).toEqual([
      expect.objectContaining({ id: 'out-1', seq: 3 }),
      expect.objectContaining({ id: 'out-2', seq: 5 }),
    ]);
  });

  it('keeps already-visible outbound messages deliverable after a stale ack write', () => {
    const db = createOutboundDb();

    writeOutboundMessage(db, {
      id: 'out-1',
      seq: 3,
      role: 'assistant',
      content: 'first',
    });
    writeOutboundMessage(db, {
      id: 'out-2',
      seq: 5,
      role: 'assistant',
      content: 'second',
    });
    writeProcessingAck(db, {
      session_id: 'session-1',
      last_in_seq: 4,
      last_out_seq: 5,
      heartbeat_at: '2026-01-01T00:00:01.000Z',
    });

    expect(readDeliverableMessages({ db, sessionId: 'session-1', baselineOutSeq: 1 })).toEqual([
      expect.objectContaining({ id: 'out-1', seq: 3 }),
      expect.objectContaining({ id: 'out-2', seq: 5 }),
    ]);

    writeProcessingAck(db, {
      session_id: 'session-1',
      last_in_seq: 2,
      last_out_seq: 3,
      heartbeat_at: '2026-01-01T00:00:00.000Z',
    });

    expect(readDeliverableMessages({ db, sessionId: 'session-1', baselineOutSeq: 1 })).toEqual([
      expect.objectContaining({ id: 'out-1', seq: 3 }),
      expect.objectContaining({ id: 'out-2', seq: 5 }),
    ]);
  });

  it('detects missing leading odd seq values after the baseline', () => {
    expect(
      findMissingOutboundSeqs(
        [
          { id: 'out-5', seq: 5, role: 'assistant', content: 'late', finish_reason: null, tool_calls: null, metadata: null, created_at: '2026-01-01T00:00:00.000Z' },
          { id: 'out-7', seq: 7, role: 'assistant', content: 'later', finish_reason: null, tool_calls: null, metadata: null, created_at: '2026-01-01T00:00:01.000Z' },
        ],
        1,
      ),
    ).toEqual([3]);
  });

  it('detects missing intermediate odd seq values', () => {
    expect(
      findMissingOutboundSeqs(
        [
          { id: 'out-3', seq: 3, role: 'assistant', content: 'first', finish_reason: null, tool_calls: null, metadata: null, created_at: '2026-01-01T00:00:00.000Z' },
          { id: 'out-7', seq: 7, role: 'assistant', content: 'third', finish_reason: null, tool_calls: null, metadata: null, created_at: '2026-01-01T00:00:01.000Z' },
        ],
        1,
      ),
    ).toEqual([5]);
  });

  it('retries once after a timeout with seq gaps and then throws a 504-oriented delivery timeout error', async () => {
    const db = createOutboundDb();

    writeOutboundMessage(db, {
      id: 'out-7',
      seq: 7,
      role: 'assistant',
      content: 'late only',
    });
    writeProcessingAck(db, {
      session_id: 'session-1',
      last_in_seq: 6,
      last_out_seq: 7,
      heartbeat_at: '2026-01-01T00:00:00.000Z',
    });

    let currentTime = 0;

    try {
      await pollForResponse({
        db,
        sessionId: 'session-1',
        baselineOutSeq: 1,
        timeoutMs: 1,
        pollIntervalMs: 1,
        now: () => currentTime,
        sleep: async (ms) => {
          currentTime += ms;
        },
      });

      throw new Error('expected pollForResponse to time out');
    } catch (error) {
      expect(error).toBeInstanceOf(DeliveryTimeoutError);
      expect(error).toMatchObject({
        attempts: 2,
        hasGaps: true,
        statusCode: 504,
      });
    }
  });

  it('returns after retrying when a missing outbound message arrives before the retry window ends', async () => {
    const db = createOutboundDb();

    writeOutboundMessage(db, {
      id: 'out-3',
      seq: 3,
      role: 'assistant',
      content: 'first',
    });
    writeOutboundMessage(db, {
      id: 'out-7',
      seq: 7,
      role: 'assistant',
      content: 'third',
    });
    writeProcessingAck(db, {
      session_id: 'session-1',
      last_in_seq: 6,
      last_out_seq: 7,
      heartbeat_at: '2026-01-01T00:00:00.000Z',
    });

    let currentTime = 0;
    let sleepCalls = 0;

    const delivered = await pollForResponse({
      db,
      sessionId: 'session-1',
      baselineOutSeq: 1,
      timeoutMs: 2,
      pollIntervalMs: 1,
      now: () => currentTime,
      sleep: async (ms) => {
        sleepCalls += 1;
        currentTime += ms;

        if (sleepCalls === 3) {
          writeOutboundMessage(db, {
            id: 'out-5',
            seq: 5,
            role: 'assistant',
            content: 'second',
          });
        }
      },
    });

    expect(delivered).toEqual([
      expect.objectContaining({ id: 'out-3', seq: 3 }),
      expect.objectContaining({ id: 'out-5', seq: 5 }),
      expect.objectContaining({ id: 'out-7', seq: 7 }),
    ]);
    expect(sleepCalls).toBe(3);
  });

  it('polls successfully when the caller provides openDb instead of a shared db handle', async () => {
    const sessionDir = makeTempSessionDir();
    const db = openOutboundDb(sessionDir);
    openDbs.push(db);

    writeOutboundMessage(db, {
      id: 'out-3',
      seq: 3,
      role: 'assistant',
      content: 'reply',
    });
    writeProcessingAck(db, {
      session_id: 'session-1',
      last_in_seq: 2,
      last_out_seq: 3,
      heartbeat_at: '2026-01-01T00:00:00.000Z',
    });

    const delivered = await pollForResponse({
      openDb: () => openOutboundDb(sessionDir),
      sessionId: 'session-1',
      baselineOutSeq: 1,
    });

    expect(delivered).toEqual([
      expect.objectContaining({ id: 'out-3', seq: 3, content: 'reply' }),
    ]);
  });

  it('treats the first assistant reply at seq 3 as deliverable when baselineOutSeq is 0', async () => {
    const db = createOutboundDb();
    let currentTime = 0;

    writeOutboundMessage(db, {
      id: 'out-3',
      seq: 3,
      role: 'assistant',
      content: 'first reply',
    });
    writeProcessingAck(db, {
      session_id: 'session-1',
      last_in_seq: 2,
      last_out_seq: 3,
      heartbeat_at: '2026-01-01T00:00:00.000Z',
    });

    const delivered = await pollForResponse({
      db,
      sessionId: 'session-1',
      baselineOutSeq: 0,
      timeoutMs: 1,
      pollIntervalMs: 1,
      now: () => currentTime,
      sleep: async (ms) => {
        currentTime += ms;
      },
    });

    expect(delivered).toEqual([
      expect.objectContaining({ id: 'out-3', seq: 3, content: 'first reply' }),
    ]);
  });

  it('allows a slower provider reply within the default delivery timeout window', async () => {
    const db = createOutboundDb();
    let currentTime = 0;
    let wroteReply = false;

    const delivered = await pollForResponse({
      db,
      sessionId: 'session-1',
      baselineOutSeq: 1,
      now: () => currentTime,
      sleep: async (ms) => {
        currentTime += ms;

        if (!wroteReply && currentTime >= 6_000) {
          wroteReply = true;
          writeOutboundMessage(db, {
            id: 'out-3',
            seq: 3,
            role: 'assistant',
            content: 'slow reply',
          });
          writeProcessingAck(db, {
            session_id: 'session-1',
            last_in_seq: 2,
            last_out_seq: 3,
            heartbeat_at: '2026-01-01T00:00:06.000Z',
          });
        }
      },
    });

    expect(delivered).toEqual([
      expect.objectContaining({ id: 'out-3', seq: 3, content: 'slow reply' }),
    ]);
  });
});
