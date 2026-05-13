import { describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import fs from 'node:fs';

import { boot } from '../src/index.ts';

describe('boot sequence', () => {
  it('starts the Phase 1 services in order', async () => {
    const steps: string[] = [];
    const db = {
      close() {
        steps.push('db.close');
      },
    } as unknown as Database;

    const runtime = await boot({
      getDb() {
        steps.push('db.get');
        return db;
      },
      migrate(receivedDb) {
        expect(receivedDb).toBe(db);
        steps.push('db.migrate');
      },
      async cleanupOrphans() {
        steps.push('cleanup.orphans');
      },
      createWarmPool() {
        steps.push('warm-pool.init');
        return {
          async start() {
            steps.push('warm-pool.start');
          },
          async stop() {
            steps.push('warm-pool.stop');
          },
        };
      },
      createScheduler() {
        steps.push('scheduler.init');
        return {
          async start() {
            steps.push('scheduler.start');
          },
          async stop() {
            steps.push('scheduler.stop');
          },
        };
      },
      startSweep() {
        steps.push('sweep.start');
        return {
          async stop() {
            steps.push('sweep.stop');
          },
        };
      },
      startApiServer({ db: receivedDb }) {
        expect(receivedDb).toBe(db);
        steps.push('api.start');
        return {
          hostname: '127.0.0.1',
          port: 4111,
          async stop() {
            steps.push('api.stop');
          },
        };
      },
    });

    expect(steps).toEqual([
      'db.get',
      'db.migrate',
      'cleanup.orphans',
      'warm-pool.init',
      'warm-pool.start',
      'scheduler.init',
      'scheduler.start',
      'sweep.start',
      'api.start',
    ]);

    await runtime.stop();

    expect(steps).toEqual([
      'db.get',
      'db.migrate',
      'cleanup.orphans',
      'warm-pool.init',
      'warm-pool.start',
      'scheduler.init',
      'scheduler.start',
      'sweep.start',
      'api.start',
      'api.stop',
      'sweep.stop',
      'scheduler.stop',
      'warm-pool.stop',
      'db.close',
    ]);
  });

  it('cleans up already-started resources when startup fails', async () => {
    const steps: string[] = [];
    const db = {
      close() {
        steps.push('db.close');
      },
    } as unknown as Database;

    await expect(
      boot({
        getDb() {
          steps.push('db.get');
          return db;
        },
        migrate() {
          steps.push('db.migrate');
        },
        async cleanupOrphans() {
          steps.push('cleanup.orphans');
        },
        createWarmPool() {
          steps.push('warm-pool.init');
          return {
            async start() {
              steps.push('warm-pool.start');
            },
            async stop() {
              steps.push('warm-pool.stop');
            },
          };
        },
        createScheduler() {
          steps.push('scheduler.init');
          return {
            async start() {
              steps.push('scheduler.start');
              throw new Error('scheduler failed');
            },
            async stop() {
              steps.push('scheduler.stop');
            },
          };
        },
      }),
    ).rejects.toThrow('scheduler failed');

    expect(steps).toEqual([
      'db.get',
      'db.migrate',
      'cleanup.orphans',
      'warm-pool.init',
      'warm-pool.start',
      'scheduler.init',
      'scheduler.start',
      'scheduler.stop',
      'warm-pool.stop',
      'db.close',
    ]);
  });

  it('stops components whose start partially initializes before throwing', async () => {
    const steps: string[] = [];
    const db = {
      close() {
        steps.push('db.close');
      },
    } as unknown as Database;

    await expect(
      boot({
        getDb() {
          steps.push('db.get');
          return db;
        },
        migrate() {
          steps.push('db.migrate');
        },
        async cleanupOrphans() {
          steps.push('cleanup.orphans');
        },
        createWarmPool() {
          steps.push('warm-pool.init');
          return {
            async start() {
              steps.push('warm-pool.start');
              throw new Error('warm-pool failed after init');
            },
            async stop() {
              steps.push('warm-pool.stop');
            },
          };
        },
      }),
    ).rejects.toThrow('warm-pool failed after init');

    expect(steps).toEqual([
      'db.get',
      'db.migrate',
      'cleanup.orphans',
      'warm-pool.init',
      'warm-pool.start',
      'warm-pool.stop',
      'db.close',
    ]);
  });

  it('continues best-effort cleanup if one stop action throws', async () => {
    const steps: string[] = [];
    const db = {
      close() {
        steps.push('db.close');
      },
    } as unknown as Database;

    const runtime = await boot({
      getDb() {
        steps.push('db.get');
        return db;
      },
      migrate() {
        steps.push('db.migrate');
      },
      async cleanupOrphans() {
        steps.push('cleanup.orphans');
      },
      createWarmPool() {
        steps.push('warm-pool.init');
        return {
          async start() {
            steps.push('warm-pool.start');
          },
          async stop() {
            steps.push('warm-pool.stop');
          },
        };
      },
      createScheduler() {
        steps.push('scheduler.init');
        return {
          async start() {
            steps.push('scheduler.start');
          },
          async stop() {
            steps.push('scheduler.stop');
          },
        };
      },
      startSweep() {
        steps.push('sweep.start');
        return {
          async stop() {
            steps.push('sweep.stop');
            throw new Error('sweep stop failed');
          },
        };
      },
      startApiServer() {
        steps.push('api.start');
        return {
          hostname: '127.0.0.1',
          port: 4111,
          async stop() {
            steps.push('api.stop');
          },
        };
      },
    });

    await expect(runtime.stop()).rejects.toThrow('sweep stop failed');

    expect(steps).toEqual([
      'db.get',
      'db.migrate',
      'cleanup.orphans',
      'warm-pool.init',
      'warm-pool.start',
      'scheduler.init',
      'scheduler.start',
      'sweep.start',
      'api.start',
      'api.stop',
      'sweep.stop',
      'scheduler.stop',
      'warm-pool.stop',
      'db.close',
    ]);
  });

  it('uses the default orphan cleanup implementation when no override is provided', async () => {
    const cleanupCalls: string[] = [];
    const originalRuntimeBin = process.env.COVE_CONTAINER_RUNTIME_BIN;
    const runtimePath = `/tmp/cove-v2-cleanup-${crypto.randomUUID()}.sh`;
    await Bun.write(
      runtimePath,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  exit 0\nfi\nif [ "$1" = "ps" ]; then\n  printf "%s\\n" orphan-a orphan-b\n  exit 0\nfi\nprintf "%s\\n" "$@" >> "$COVE_TEST_LOG"\nexit 0\n',
    );
    const logPath = `/tmp/cove-v2-cleanup-log-${crypto.randomUUID()}.txt`;
    await Bun.write(logPath, '');
    fs.chmodSync(runtimePath, 0o755);
    process.env.COVE_CONTAINER_RUNTIME_BIN = runtimePath;
    process.env.COVE_TEST_LOG = logPath;

    const db = {
      close() {
        cleanupCalls.push('db.close');
      },
    } as unknown as Database;

    try {
      const runtime = await boot({
        getDb() {
          cleanupCalls.push('db.get');
          return db;
        },
        migrate() {
          cleanupCalls.push('db.migrate');
        },
        createWarmPool() {
          cleanupCalls.push('warm-pool.init');
          return {
            async start() {
              cleanupCalls.push('warm-pool.start');
            },
            async stop() {
              cleanupCalls.push('warm-pool.stop');
            },
          };
        },
        createScheduler() {
          cleanupCalls.push('scheduler.init');
          return {
            async start() {
              cleanupCalls.push('scheduler.start');
            },
            async stop() {
              cleanupCalls.push('scheduler.stop');
            },
          };
        },
        startSweep() {
          cleanupCalls.push('sweep.start');
          return {
            async stop() {
              cleanupCalls.push('sweep.stop');
            },
          };
        },
        startApiServer() {
          cleanupCalls.push('api.start');
          return {
            hostname: '127.0.0.1',
            port: 4111,
            async stop() {
              cleanupCalls.push('api.stop');
            },
          };
        },
      });

      await runtime.stop();

      const log = await Bun.file(logPath).text();
      expect(log).toContain('stop');
      expect(log).toContain('orphan-a');
      expect(log).toContain('orphan-b');
      expect(cleanupCalls).toContain('api.start');
    } finally {
      if (originalRuntimeBin === undefined) {
        delete process.env.COVE_CONTAINER_RUNTIME_BIN;
      } else {
        process.env.COVE_CONTAINER_RUNTIME_BIN = originalRuntimeBin;
      }
      delete process.env.COVE_TEST_LOG;
      fs.rmSync(runtimePath, { force: true });
      fs.rmSync(logPath, { force: true });
    }
  });
});
