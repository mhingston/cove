import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openInboundDb, writeInboundMessage } from '../src/session/inbound.ts';
import { openOutboundDb, writeProcessingAck } from '../src/session/outbound.ts';
import { decideStuckAction, startSweep, type SweepOptions } from '../src/host-sweep.ts';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeSweepOptions(overrides: Partial<SweepOptions> = {}): SweepOptions {
  return {
    intervalMs: 5,
    ceilingMs: 30 * 60 * 1000,
    claimStuckMs: 60 * 1000,
    ...overrides,
  };
}

function seedInboundMessages(sessionDir: string, count: number, sessionId = 'sess'): void {
  const db = openInboundDb(sessionDir);

  try {
    for (let index = 0; index < count; index += 1) {
      writeInboundMessage(db, {
        id: `${sessionId}-${index}`,
        role: 'user',
        content: `message ${index}`,
      });
    }
  } finally {
    db.close();
  }
}

function readMaxInboundSeqFromSessionDir(sessionDir: string): number | null {
  const db = new Database(path.join(sessionDir, 'inbound.db'), { readonly: true });

  try {
    const row = db.prepare('SELECT MAX(seq) AS maxSeq FROM messages_in').get() as { maxSeq: number | null } | null;
    return row?.maxSeq ?? null;
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('host sweep', () => {
  describe('decideStuckAction', () => {
    it('returns ok for healthy progress', () => {
      expect(
        decideStuckAction({
          heartbeatAgeMs: 5_000,
          ceilingMs: 30 * 60 * 1000,
          claimAgeMs: 5_000,
          claimStuckMs: 60 * 1000,
        }),
      ).toEqual({ action: 'ok' });
    });

    it('returns kill-ceiling when the heartbeat exceeds the ceiling', () => {
      expect(
        decideStuckAction({
          heartbeatAgeMs: 31 * 60 * 1000,
          ceilingMs: 30 * 60 * 1000,
          claimAgeMs: 5_000,
          claimStuckMs: 60 * 1000,
        }).action,
      ).toBe('kill-ceiling');
    });

    it('returns kill-claim when claimed work is stuck beyond the threshold', () => {
      expect(
        decideStuckAction({
          heartbeatAgeMs: 5_000,
          ceilingMs: 30 * 60 * 1000,
          claimAgeMs: 61_000,
          claimStuckMs: 60 * 1000,
        }).action,
      ).toBe('kill-claim');
    });
  });

  describe('startSweep', () => {
    it('does not throw when no containers are active', async () => {
      const activeContainers = new Map<string, { startedAt: number; options: { sessionDir: string } }>();
      let getCountCalls = 0;
      let runningCalls = 0;
      const sweep = startSweep(makeSweepOptions(), {
        getActiveContainers: () => activeContainers as never,
        getActiveContainerCount: () => {
          getCountCalls += 1;
          return activeContainers.size;
        },
        isContainerRunning: () => {
          runningCalls += 1;
          return false;
        },
        restartContainer: () => false,
        killContainer: () => {},
        log: () => {},
      });

      await wait(20);
      await expect(sweep.stop()).resolves.toBeUndefined();
      expect(runningCalls).toBe(0);
      expect(getCountCalls).toBeGreaterThan(0);
    });

    it('restarts exited containers and heartbeat-stale containers', async () => {
      const now = Date.now();
      const activeContainers = new Map<string, { startedAt: number; options: { sessionDir: string } }>([
        ['sess-exited', { startedAt: now, options: { sessionDir: '/tmp/sess-exited' } }],
        ['sess-stale-heartbeat', { startedAt: now, options: { sessionDir: '/tmp/sess-stale-heartbeat' } }],
      ]);
      const runningStates = new Map([
        ['sess-exited', false],
        ['sess-stale-heartbeat', true],
      ]);
      const heartbeatAges = new Map([
        ['sess-stale-heartbeat', new Date(now - 31 * 60 * 1000).toISOString()],
      ]);
      const restarts: string[] = [];
      const kills: string[] = [];

      const sweep = startSweep(makeSweepOptions(), {
        getActiveContainers: () => activeContainers as never,
        getActiveContainerCount: () => activeContainers.size,
        isContainerRunning: (sessionId) => runningStates.get(sessionId) ?? false,
        restartContainer: (sessionId) => {
          restarts.push(sessionId);
          runningStates.set(sessionId, true);
          const entry = activeContainers.get(sessionId);
          if (entry) {
            entry.startedAt = Date.now();
          }
          heartbeatAges.set(sessionId, new Date().toISOString());
          return true;
        },
        killContainer: (sessionId) => {
          kills.push(sessionId);
        },
        readAck: (sessionId) => {
          const heartbeatAt = heartbeatAges.get(sessionId);
          if (heartbeatAt == null) {
            return null;
          }

          return {
            session_id: sessionId,
            heartbeat_at: heartbeatAt,
            last_in_seq: null,
            last_out_seq: null,
            container_id: null,
          };
        },
        readMaxInboundSeq: () => null,
        log: () => {},
      });

      await wait(25);
      await sweep.stop();

      expect(restarts).toEqual(expect.arrayContaining(['sess-exited', 'sess-stale-heartbeat']));
      expect(kills).toEqual([]);
    });

    it('degrades missing or bad per-session db reads to null observations without breaking the tick', async () => {
      const missingDir = makeTempDir('cove-v2-sweep-missing-');
      const badDir = makeTempDir('cove-v2-sweep-bad-');
      const staleDir = makeTempDir('cove-v2-sweep-stale-');
      const outboundDb = openOutboundDb(staleDir);

      writeProcessingAck(outboundDb, {
        session_id: 'sess-stale',
        last_in_seq: 2,
        last_out_seq: 1,
        heartbeat_at: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
      });
      outboundDb.close();

      fs.writeFileSync(path.join(badDir, 'inbound.db'), 'not-a-sqlite-db', 'utf8');
      fs.writeFileSync(path.join(badDir, 'outbound.db'), 'not-a-sqlite-db', 'utf8');

      const activeContainers = new Map<string, { startedAt: number; options: { sessionDir: string } }>([
        ['sess-missing', { startedAt: Date.now(), options: { sessionDir: missingDir } }],
        ['sess-bad', { startedAt: Date.now(), options: { sessionDir: badDir } }],
        ['sess-stale', { startedAt: Date.now(), options: { sessionDir: staleDir } }],
      ]);
      const restarts: string[] = [];

      const sweep = startSweep(makeSweepOptions(), {
        getActiveContainers: () => activeContainers as never,
        getActiveContainerCount: () => activeContainers.size,
        isContainerRunning: () => true,
        restartContainer: (sessionId) => {
          restarts.push(sessionId);
          activeContainers.delete(sessionId);
          return true;
        },
        killContainer: () => {},
        log: () => {},
      });

      await wait(25);
      await sweep.stop();

      expect(restarts).toEqual(['sess-stale']);
      expect(activeContainers.has('sess-missing')).toBe(true);
      expect(activeContainers.has('sess-bad')).toBe(true);
    });

    it('reads adopted-session ack state using COVE_SESSION_ID before deciding health', async () => {
      const sessionDir = makeTempDir('cove-v2-sweep-adopted-ack-');
      const activeContainers = new Map<string, {
        startedAt: number;
        options: { sessionDir: string; envVars?: Record<string, string> };
      }>([
        [
          'sess-live',
          {
            startedAt: Date.now() - 45 * 60 * 1000,
            options: {
              sessionDir,
              envVars: { COVE_SESSION_ID: 'warm-42' },
            },
          },
        ],
      ]);
      const readAckCalls: string[] = [];
      const restarts: string[] = [];

      const sweep = startSweep(makeSweepOptions({ intervalMs: 5 }), {
        getActiveContainers: () => activeContainers as never,
        getActiveContainerCount: () => activeContainers.size,
        isContainerRunning: () => true,
        restartContainer: (sessionId) => {
          restarts.push(sessionId);
          return true;
        },
        killContainer: () => {},
        readAck: (sessionId) => {
          readAckCalls.push(sessionId);

          if (sessionId !== 'warm-42') {
            return null;
          }

          return {
            session_id: sessionId,
            heartbeat_at: new Date().toISOString(),
            last_in_seq: null,
            last_out_seq: null,
            container_id: null,
          };
        },
        readMaxInboundSeq: () => null,
        log: () => {},
      });

      await wait(20);
      await sweep.stop();

      expect(readAckCalls).toContain('warm-42');
      expect(restarts).toEqual([]);
    });

    it('does not restart adopted containers before their first adopted-session ack arrives', async () => {
      let now = 45 * 60 * 1000;
      const activeContainers = new Map<string, {
        startedAt: number;
        options: { sessionDir: string; envVars?: Record<string, string> };
      }>([
        [
          'sess-live',
          {
            startedAt: 0,
            options: {
              sessionDir: '/tmp/sess-live',
              envVars: { COVE_SESSION_ID: 'warm-42' },
            },
          },
        ],
      ]);
      const restarts: string[] = [];

      const sweep = startSweep(makeSweepOptions({ intervalMs: 5 }), {
        getActiveContainers: () => activeContainers as never,
        getActiveContainerCount: () => activeContainers.size,
        isContainerRunning: () => true,
        restartContainer: (sessionId) => {
          restarts.push(sessionId);
          return true;
        },
        killContainer: () => {},
        readAck: () => null,
        readMaxInboundSeq: () => null,
        now: () => now,
        log: () => {},
      });

      await wait(12);
      now += 20_000;
      await wait(12);
      await sweep.stop();

      expect(restarts).toEqual([]);
    });

    it('does not kill-claim idle sessions when no inbound work remains using real session db files', async () => {
      const idleDir = makeTempDir('cove-v2-sweep-idle-');
      const busyDir = makeTempDir('cove-v2-sweep-busy-');
      seedInboundMessages(idleDir, 1, 'idle');
      seedInboundMessages(busyDir, 2, 'busy');

      const idleOutboundDb = openOutboundDb(idleDir);
      const busyOutboundDb = openOutboundDb(busyDir);

      try {
        writeProcessingAck(idleOutboundDb, {
          session_id: 'sess-idle',
          last_in_seq: 2,
          last_out_seq: 1,
          heartbeat_at: new Date().toISOString(),
        });
        writeProcessingAck(busyOutboundDb, {
          session_id: 'sess-busy',
          last_in_seq: 2,
          last_out_seq: 1,
          heartbeat_at: new Date().toISOString(),
        });
      } finally {
        idleOutboundDb.close();
        busyOutboundDb.close();
      }

      const activeContainers = new Map<string, { startedAt: number; options: { sessionDir: string } }>([
        ['sess-idle', { startedAt: Date.now(), options: { sessionDir: idleDir } }],
        ['sess-busy', { startedAt: Date.now(), options: { sessionDir: busyDir } }],
      ]);
      const restarts: string[] = [];

      const sweep = startSweep(makeSweepOptions({ intervalMs: 5, claimStuckMs: 20 }), {
        getActiveContainers: () => activeContainers as never,
        getActiveContainerCount: () => activeContainers.size,
        isContainerRunning: () => true,
        restartContainer: (sessionId) => {
          restarts.push(sessionId);
          activeContainers.delete(sessionId);
          return true;
        },
        killContainer: () => {},
        readAck: (sessionId, sessionDir) => {
          const db = openOutboundDb(sessionDir);

          try {
            return db
              .prepare(
                `SELECT session_id, last_in_seq, last_out_seq, container_id, heartbeat_at
                 FROM processing_ack
                 WHERE session_id = ?`,
              )
              .get(sessionId) as
              | {
                  session_id: string;
                  last_in_seq: number | null;
                  last_out_seq: number | null;
                  container_id: string | null;
                  heartbeat_at: string;
                }
              | null;
          } finally {
            db.close();
          }
        },
        readMaxInboundSeq: readMaxInboundSeqFromSessionDir,
        log: () => {},
      });

      await wait(60);
      await sweep.stop();

      expect(restarts).toContain('sess-busy');
      expect(restarts).not.toContain('sess-idle');
    });

    it('resets claim observation when processing_ack.container_id changes', async () => {
      const activeContainers = new Map<string, { startedAt: number; options: { sessionDir: string } }>([
        ['sess-container-change', { startedAt: Date.now(), options: { sessionDir: '/tmp/sess-container-change' } }],
      ]);
      const restarts: string[] = [];
      const ack = {
        heartbeat_at: new Date().toISOString(),
        last_in_seq: 2,
        last_out_seq: 1,
        container_id: 'container-a',
      };

      const sweep = startSweep(makeSweepOptions({ intervalMs: 5, claimStuckMs: 20 }), {
        getActiveContainers: () => activeContainers as never,
        getActiveContainerCount: () => activeContainers.size,
        isContainerRunning: () => true,
        restartContainer: (sessionId) => {
          restarts.push(sessionId);
          return true;
        },
        killContainer: () => {},
        readAck: () => ({
          session_id: 'sess-container-change',
          heartbeat_at: new Date().toISOString(),
          last_in_seq: ack.last_in_seq,
          last_out_seq: ack.last_out_seq,
          container_id: ack.container_id,
        }),
        readMaxInboundSeq: () => 4,
        log: () => {},
      });

      await wait(12);
      ack.container_id = 'container-b';
      await wait(12);
      expect(restarts).toEqual([]);

      await wait(20);
      await sweep.stop();

      expect(restarts).toEqual(['sess-container-change']);
    });

    it('drops stale observations for sessions removed and later re-added to the active map', async () => {
      let now = 1_000;
      const activeContainers = new Map<string, { startedAt: number; options: { sessionDir: string } }>([
        ['sess-readded', { startedAt: 1_000, options: { sessionDir: '/tmp/sess-readded' } }],
      ]);
      const restarts: string[] = [];

      const sweep = startSweep(makeSweepOptions({ intervalMs: 5, claimStuckMs: 20 }), {
        getActiveContainers: () => activeContainers as never,
        getActiveContainerCount: () => activeContainers.size,
        isContainerRunning: () => true,
        restartContainer: (sessionId) => {
          restarts.push(sessionId);
          return true;
        },
        killContainer: () => {},
        readAck: () => ({
          session_id: 'sess-readded',
          heartbeat_at: new Date(now).toISOString(),
          last_in_seq: 2,
          last_out_seq: 1,
          container_id: 'container-a',
        }),
        readMaxInboundSeq: () => 4,
        now: () => now,
        log: () => {},
      });

      await wait(8);
      activeContainers.delete('sess-readded');
      now = 1_100;
      await wait(8);
      expect(restarts).toEqual([]);

      activeContainers.set('sess-readded', { startedAt: 1_000, options: { sessionDir: '/tmp/sess-readded' } });
      await wait(8);
      expect(restarts).toEqual([]);

      now = 1_130;
      await wait(8);
      await sweep.stop();

      expect(restarts).toEqual(['sess-readded']);
    });

    it('does not overlap tick execution when dependencies are slow', async () => {
      const activeContainers = new Map<string, { startedAt: number; options: { sessionDir: string } }>([
        ['sess-serial', { startedAt: Date.now(), options: { sessionDir: '/tmp/sess-serial' } }],
      ]);
      let inFlight = 0;
      let maxInFlight = 0;

      const sweep = startSweep(makeSweepOptions({ intervalMs: 5 }), {
        getActiveContainers: () => activeContainers as never,
        getActiveContainerCount: () => activeContainers.size,
        isContainerRunning: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await wait(20);
          inFlight -= 1;
          return true;
        },
        restartContainer: () => false,
        killContainer: () => {},
        readAck: () => null,
        readMaxInboundSeq: () => null,
        log: () => {},
      } as never);

      await wait(45);
      await sweep.stop();

      expect(maxInFlight).toBe(1);
    });

    it('waits for in-flight tick work to finish before stop resolves', async () => {
      const activeContainers = new Map<string, { startedAt: number; options: { sessionDir: string } }>([
        ['sess-stop-wait', { startedAt: Date.now(), options: { sessionDir: '/tmp/sess-stop-wait' } }],
      ]);
      let resolver: (() => void) | undefined;
      let completed = false;

      const sweep = startSweep(makeSweepOptions({ intervalMs: 5 }), {
        getActiveContainers: () => activeContainers as never,
        getActiveContainerCount: () => activeContainers.size,
        isContainerRunning: async () => {
          await new Promise<void>((resolve) => {
            resolver = () => resolve();
          });
          completed = true;
          return true;
        },
        restartContainer: () => false,
        killContainer: () => {},
        readAck: () => null,
        readMaxInboundSeq: () => null,
        log: () => {},
      } as never);

      await wait(15);
      const stopPromise = sweep.stop();
      await wait(10);

      expect(completed).toBe(false);

      resolver?.();
      await stopPromise;

      expect(completed).toBe(true);
    });
  });
});
