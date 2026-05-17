import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createWarmPool } from '../src/warm-pool.ts';
import { getActiveContainers } from '../src/container/spawn.ts';
import { openOutboundDb, writeProcessingAck } from '../src/session/outbound.ts';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function markReady(sessionDir: string, sessionId: string): void {
  const db = openOutboundDb(sessionDir);

  try {
    writeProcessingAck(db, {
      session_id: sessionId,
      last_in_seq: null,
      last_out_seq: null,
      heartbeat_at: new Date().toISOString(),
    });
  } finally {
    db.close();
  }
}

afterEach(() => {
  getActiveContainers().clear();

  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('warm pool', () => {
  it('starts at least minSize warm entries in starting state', async () => {
    const stateDir = makeTempDir('cove-v2-warm-start-');
    const started: string[] = [];

    const pool = createWarmPool({
      stateDir,
      minSize: 1,
      maxSize: 2,
      spawnContainer(sessionId) {
        started.push(sessionId);
        return true;
      },
    });

    try {
      await pool.start();

      expect(started).toHaveLength(1);
      expect(pool.getStats()).toEqual({ ready: 0, allocated: 0, starting: 1 });
    } finally {
      await pool.stop();
    }
  });

  it('writes a minimal warm session_config before spawning the container', async () => {
    const stateDir = makeTempDir('cove-v2-warm-config-');
    let capturedSessionDir: string | undefined;
    let capturedSessionId: string | undefined;

    const pool = createWarmPool({
      stateDir,
      centralDbPath: path.join(stateDir, 'cove.db'),
      minSize: 1,
      maxSize: 1,
      spawnContainer(sessionId, _containerName, sessionDir) {
        capturedSessionDir = sessionDir;
        capturedSessionId = sessionId;
        return true;
      },
    });

    try {
      await pool.start();

      expect(capturedSessionDir).toBeTruthy();
      const inboundDbPath = path.join(capturedSessionDir!, 'inbound.db');
      expect(fs.existsSync(inboundDbPath)).toBe(true);

      const { Database } = await import('bun:sqlite');
      const db = new Database(inboundDbPath);

      try {
        const row = db.prepare(
          'SELECT provider, model, extra_env FROM session_config LIMIT 1',
        ).get() as { provider: string | null; model: string | null; extra_env: string | null };

        expect(row.provider).toBeNull();
        expect(row.model).toBeNull();
        expect(JSON.parse(row.extra_env ?? '{}')).toMatchObject({
          COVE_SESSION_ID: capturedSessionId!,
          COVE_CENTRAL_DB_PATH: '/app/cove.db',
        });
      } finally {
        db.close();
      }
    } finally {
      await pool.stop();
    }
  });

  it('does not allocate until readiness is confirmed through processing_ack', async () => {
    const stateDir = makeTempDir('cove-v2-warm-not-ready-');

    const pool = createWarmPool({
      stateDir,
      minSize: 1,
      maxSize: 1,
      spawnContainer() {
        return true;
      },
    });

    try {
      await pool.start();

      expect(await pool.acquire()).toBeNull();
    } finally {
      await pool.stop();
    }
  });

  it('allocates a ready entry and keeps the pool at minSize', async () => {
    const stateDir = makeTempDir('cove-v2-warm-acquire-');
    const started: Array<{ sessionId: string; sessionDir: string }> = [];

    const pool = createWarmPool({
      stateDir,
      minSize: 1,
      maxSize: 2,
      spawnContainer(sessionId, _containerName, sessionDir) {
        started.push({ sessionId, sessionDir });
        return true;
      },
    });

    try {
      await pool.start();
      markReady(started[0]!.sessionDir, started[0]!.sessionId);

      const allocation = await pool.acquire();

      expect(allocation).toBeTruthy();
      expect(allocation?.sessionId).toBe(started[0]!.sessionId);
      expect(pool.getStats().allocated).toBe(1);
      expect(pool.getStats().ready + pool.getStats().starting + pool.getStats().allocated).toBeGreaterThanOrEqual(1);
    } finally {
      await pool.stop();
    }
  });

  it('returns an allocated entry to ready on release', async () => {
    const stateDir = makeTempDir('cove-v2-warm-release-');
    const started: Array<{ sessionId: string; sessionDir: string }> = [];

    const pool = createWarmPool({
      stateDir,
      minSize: 1,
      maxSize: 1,
      spawnContainer(sessionId, _containerName, sessionDir) {
        started.push({ sessionId, sessionDir });
        return true;
      },
    });

    try {
      await pool.start();
      markReady(started[0]!.sessionDir, started[0]!.sessionId);

      const allocation = await pool.acquire();
      expect(allocation).toBeTruthy();

      pool.release(allocation!.sessionId);

      expect(pool.getStats()).toEqual({ ready: 1, allocated: 0, starting: 0 });
    } finally {
      await pool.stop();
    }
  });

  it('consumes an allocation permanently and replenishes the pool', async () => {
    const stateDir = makeTempDir('cove-v2-warm-consume-');
    const started: Array<{ sessionId: string; sessionDir: string }> = [];

    const pool = createWarmPool({
      stateDir,
      minSize: 1,
      maxSize: 2,
      spawnContainer(sessionId, _containerName, sessionDir) {
        started.push({ sessionId, sessionDir });
        return true;
      },
    });

    try {
      await pool.start();
      markReady(started[0]!.sessionDir, started[0]!.sessionId);

      const allocation = await pool.acquire();
      expect(allocation).toBeTruthy();

      pool.consume(allocation!.sessionId);

      expect(pool.getStats().allocated).toBe(0);
      expect(started.length).toBeGreaterThanOrEqual(2);
    } finally {
      await pool.stop();
    }
  });

  it('never exceeds maxSize even when minSize is larger', async () => {
    const stateDir = makeTempDir('cove-v2-warm-max-');

    const pool = createWarmPool({
      stateDir,
      minSize: 5,
      maxSize: 3,
      spawnContainer() {
        return true;
      },
    });

    try {
      await pool.start();

      const stats = pool.getStats();
      expect(stats.ready + stats.allocated + stats.starting).toBeLessThanOrEqual(3);
    } finally {
      await pool.stop();
    }
  });

  it('drops failed spawns instead of leaving phantom entries', async () => {
    const stateDir = makeTempDir('cove-v2-warm-fail-');

    const pool = createWarmPool({
      stateDir,
      minSize: 1,
      maxSize: 1,
      spawnContainer() {
        return false;
      },
    });

    try {
      await pool.start();

      expect(pool.getStats()).toEqual({ ready: 0, allocated: 0, starting: 0 });
    } finally {
      await pool.stop();
    }
  });

  it('evicts stuck starting entries after the readiness timeout and retries', async () => {
    const stateDir = makeTempDir('cove-v2-warm-stuck-');
    let spawnCount = 0;

    const pool = createWarmPool({
      stateDir,
      minSize: 1,
      maxSize: 1,
      startingTimeoutMs: 10,
      maintainIntervalMs: 10,
      spawnContainer() {
        spawnCount += 1;
        return true;
      },
    });

    try {
      await pool.start();
      expect(pool.getStats()).toEqual({ ready: 0, allocated: 0, starting: 1 });

      await Bun.sleep(50);

      expect(pool.getStats()).toEqual({ ready: 0, allocated: 0, starting: 1 });
      expect(spawnCount).toBeGreaterThan(1);
    } finally {
      await pool.stop();
    }
  });
});
