import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createWarmPool } from '../../src/warm-pool.ts';
import { getActiveContainers } from '../../src/container/spawn.ts';
import { openOutboundDb, writeProcessingAck } from '../../src/session/outbound.ts';

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

describe('warm-pool benchmarks', () => {
  it('measures acquire/release loop overhead', async () => {
    const stateDir = makeTempDir('cove-v2-warm-bench-loop-');
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

      const iterations = 100;
      const start = performance.now();

      for (let index = 0; index < iterations; index += 1) {
        const allocation = await pool.acquire();
        expect(allocation).not.toBeNull();
        pool.release(allocation!.sessionId);
      }

      const elapsed = performance.now() - start;
      console.log(
        `  warm-pool acquire/release x${iterations}: ${elapsed.toFixed(2)}ms (${(elapsed / iterations).toFixed(3)}ms/op)`,
      );
    } finally {
      await pool.stop();
    }
  });

  it('measures getStats overhead', async () => {
    const stateDir = makeTempDir('cove-v2-warm-bench-stats-');
    const pool = createWarmPool({
      stateDir,
      minSize: 2,
      maxSize: 2,
      spawnContainer() {
        return true;
      },
    });

    try {
      await pool.start();

      const iterations = 100_000;
      const start = performance.now();

      for (let index = 0; index < iterations; index += 1) {
        pool.getStats();
      }

      const elapsed = performance.now() - start;
      console.log(
        `  warm-pool getStats x${iterations}: ${elapsed.toFixed(2)}ms (${(elapsed / iterations).toFixed(4)}ms/op)`,
      );
    } finally {
      await pool.stop();
    }
  });

  it('measures ready-entry acquisition latency', async () => {
    const stateDir = makeTempDir('cove-v2-warm-bench-ready-');
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

      const start = performance.now();
      const allocation = await pool.acquire();
      const elapsed = performance.now() - start;

      expect(allocation).not.toBeNull();
      console.log(`  warm-pool ready acquire: ${elapsed.toFixed(3)}ms`);

      if (allocation) {
        pool.release(allocation.sessionId);
      }
    } finally {
      await pool.stop();
    }
  });
});
