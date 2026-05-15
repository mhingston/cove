import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';

import { boot } from '../src/index.ts';
import type { ChatHandlerContext } from '../src/shared/types.ts';

const originalPoolMin = process.env.COVE_POOL_MIN;
const originalPoolMax = process.env.COVE_POOL_MAX;
const originalSweepInterval = process.env.COVE_SWEEP_INTERVAL;

afterEach(() => {
  if (originalPoolMin === undefined) {
    delete process.env.COVE_POOL_MIN;
  } else {
    process.env.COVE_POOL_MIN = originalPoolMin;
  }

  if (originalPoolMax === undefined) {
    delete process.env.COVE_POOL_MAX;
  } else {
    process.env.COVE_POOL_MAX = originalPoolMax;
  }

  if (originalSweepInterval === undefined) {
    delete process.env.COVE_SWEEP_INTERVAL;
  } else {
    process.env.COVE_SWEEP_INTERVAL = originalSweepInterval;
  }

  delete process.env.COVE_STATE_DIR;
  delete process.env.COVE_IMAGE_NAME;
  delete process.env.COVE_TEST_LOG;
  delete process.env.COVE_CONTAINER_RUNTIME_BIN;
});

async function bootWithDefaultWarmPool(options: {
  poolMin?: string;
  poolMax?: string;
} = {}): Promise<{
  capturedChat: ChatHandlerContext | undefined;
  warmEntries: string[];
  log: string;
}> {
  if (options.poolMin !== undefined) {
    process.env.COVE_POOL_MIN = options.poolMin;
  }

  if (options.poolMax !== undefined) {
    process.env.COVE_POOL_MAX = options.poolMax;
  }

  const stateDir = `/tmp/cove-v2-boot-${crypto.randomUUID()}`;
  const runtimePath = `/tmp/cove-v2-boot-runtime-${crypto.randomUUID()}.sh`;
  const logPath = `/tmp/cove-v2-boot-log-${crypto.randomUUID()}.txt`;
  process.env.COVE_STATE_DIR = stateDir;
  process.env.COVE_IMAGE_NAME = 'cove-agent:test';
  process.env.COVE_CONTAINER_RUNTIME_BIN = runtimePath;
  process.env.COVE_TEST_LOG = logPath;

  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(logPath, '');
  fs.writeFileSync(
    runtimePath,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  exit 0\nfi\nprintf "%s\\n" "$@" >> "$COVE_TEST_LOG"\nexit 0\n',
  );
  fs.chmodSync(runtimePath, 0o755);

  const db = new Database(path.join(stateDir, 'cove.db'));
  let capturedChat: ChatHandlerContext | undefined;

  try {
    const runtime = await boot({
      getDb() {
        return db;
      },
      migrate() {},
      async cleanupOrphans() {},
      createScheduler() {
        return {
          async start() {},
          async stop() {},
        };
      },
      startSweep() {
        return {
          async stop() {},
        };
      },
      startApiServer(serverOptions) {
        capturedChat = serverOptions.chat;
        return {
          hostname: '127.0.0.1',
          port: 4111,
          async stop() {},
        };
      },
    });

    try {
      return {
        capturedChat,
        warmEntries: fs.readdirSync(path.join(stateDir, 'warm')),
        log: fs.readFileSync(logPath, 'utf8'),
      };
    } finally {
      await runtime.stop();
    }
  } finally {
    db.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(runtimePath, { force: true });
    fs.rmSync(logPath, { force: true });
  }
}

describe('boot sequence', () => {
  it('starts one host-owned workflow runtime against the state-dir database and stops it on shutdown', async () => {
    const steps: string[] = [];
    const db = {
      close() {
        steps.push('db.close');
      },
    } as unknown as Database;

    process.env.COVE_STATE_DIR = '/tmp/cove-v2-workflow-runtime';

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
          async acquire() {
            return null;
          },
          consume() {},
          release() {},
          getStats() {
            return { ready: 0, allocated: 0, starting: 0 };
          },
        };
      },
      createWorkflowRuntime(databasePath) {
        steps.push(`workflow-runtime.init:${databasePath}`);
        return {
          async start() {
            steps.push('workflow-runtime.start');
          },
          async stop() {
            steps.push('workflow-runtime.stop');
          },
          async startWorkflow() {
            return { instanceId: 'workflow-instance-1' };
          },
          async rollbackWorkflow() {},
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

    expect(steps).toEqual([
      'db.get',
      'db.migrate',
      'cleanup.orphans',
      'warm-pool.init',
      'warm-pool.start',
      'workflow-runtime.init:/tmp/cove-v2-workflow-runtime/workflows.db',
      'workflow-runtime.start',
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
      'workflow-runtime.init:/tmp/cove-v2-workflow-runtime/workflows.db',
      'workflow-runtime.start',
      'scheduler.init',
      'scheduler.start',
      'sweep.start',
      'api.start',
      'api.stop',
      'sweep.stop',
      'scheduler.stop',
      'workflow-runtime.stop',
      'warm-pool.stop',
      'db.close',
    ]);
  });

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
          async acquire() {
            return null;
          },
          consume() {},
          release() {},
          getStats() {
            return { ready: 0, allocated: 0, starting: 0 };
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
            async acquire() {
              return null;
            },
            consume() {},
            release() {},
            getStats() {
              return { ready: 0, allocated: 0, starting: 0 };
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
            async acquire() {
              return null;
            },
            consume() {},
            release() {},
            getStats() {
              return { ready: 0, allocated: 0, starting: 0 };
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
          async acquire() {
            return null;
          },
          consume() {},
          release() {},
          getStats() {
            return { ready: 0, allocated: 0, starting: 0 };
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
            async acquire() {
              return null;
            },
            consume() {},
            release() {},
            getStats() {
              return { ready: 0, allocated: 0, starting: 0 };
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

  it('builds the default warm pool and passes a live ensureSessionRuntime into the API server', async () => {
    const { capturedChat, warmEntries, log } = await bootWithDefaultWarmPool({
      poolMin: '2',
      poolMax: '7',
    });

    expect(capturedChat?.ensureSessionRuntime).toEqual(expect.any(Function));
    expect(warmEntries).toHaveLength(2);
    expect(log).toContain('run');
    expect(log).toContain('--name');
    expect(log).toContain('cove-agent:test');
  });

  it('uses warm-pool size defaults of 1 and 5 when pool env vars are unset', async () => {
    const tempTestPath = path.join(
      path.dirname(import.meta.path),
      `.pool-defaults-${crypto.randomUUID()}.test.ts`,
    );
    const tempTestSource = `
import { describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';

let capturedOptions;

mock.module('../src/warm-pool.ts', () => ({
  createWarmPool(options) {
    capturedOptions = options;
    return {
      async start() {},
      async stop() {},
      async acquire() {
        return null;
      },
      consume() {},
      release() {},
      getStats() {
        return { ready: 0, allocated: 0, starting: 0 };
      },
    };
  },
}));

const { boot } = await import('../src/index.ts?pool-defaults=' + ${JSON.stringify(crypto.randomUUID())});

describe('default warm-pool sizing isolation', () => {
  it('uses 1 and 5 when env vars are unset', async () => {
    const db = {
      close() {},
    } as unknown as Database;

    const runtime = await boot({
      getDb() {
        return db;
      },
      migrate() {},
      async cleanupOrphans() {},
      createScheduler() {
        return {
          async start() {},
          async stop() {},
        };
      },
      startSweep() {
        return {
          async stop() {},
        };
      },
      startApiServer() {
        return {
          hostname: '127.0.0.1',
          port: 4111,
          async stop() {},
        };
      },
    });

    try {
      expect(capturedOptions).toMatchObject({
        minSize: 1,
        maxSize: 5,
      });
    } finally {
      await runtime.stop();
    }
  });
});
`;

    fs.writeFileSync(tempTestPath, tempTestSource);

    const result = Bun.spawnSync(['bun', 'test', tempTestPath], {
      cwd: path.dirname(import.meta.dir),
      env: {
        ...process.env,
        COVE_POOL_MIN: undefined,
        COVE_POOL_MAX: undefined,
      },
      stderr: 'pipe',
      stdout: 'pipe',
    });

    try {
      const output = result.stdout.toString() + result.stderr.toString();
      expect(result.exitCode, output).toBe(0);
      expect(output).toContain('1 pass');
    } finally {
      fs.rmSync(tempTestPath, { force: true });
    }
  });

  it('uses the real default sweep wiring and passes COVE_SWEEP_INTERVAL through to host-sweep', async () => {
    const tempTestPath = path.join(
      path.dirname(import.meta.path),
      `.sweep-defaults-${crypto.randomUUID()}.test.ts`,
    );
    const tempTestSource = `
import { describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';

let capturedOptions;

mock.module('../src/host-sweep.ts', () => ({
  startSweep(options) {
    capturedOptions = options;
    return {
      async stop() {},
    };
  },
  decideStuckAction: () => ({ action: 'ok' }),
}));

const { boot } = await import('../src/index.ts?sweep-defaults=' + ${JSON.stringify(crypto.randomUUID())});

describe('default sweep wiring isolation', () => {
  it('passes env-derived sweep options into host-sweep', async () => {
    const db = {
      close() {},
    } as unknown as Database;

    const runtime = await boot({
      getDb() {
        return db;
      },
      migrate() {},
      async cleanupOrphans() {},
      createWarmPool() {
        return {
          async start() {},
          async stop() {},
          async acquire() {
            return null;
          },
          consume() {},
          release() {},
          getStats() {
            return { ready: 0, allocated: 0, starting: 0 };
          },
        };
      },
      createScheduler() {
        return {
          async start() {},
          async stop() {},
        };
      },
      startApiServer() {
        return {
          hostname: '127.0.0.1',
          port: 4111,
          async stop() {},
        };
      },
    });

    try {
      expect(capturedOptions).toEqual({
        intervalMs: 2345,
        ceilingMs: 30 * 60 * 1000,
        claimStuckMs: 60 * 1000,
      });
    } finally {
      await runtime.stop();
    }
  });
});
`;

    fs.writeFileSync(tempTestPath, tempTestSource);
    process.env.COVE_SWEEP_INTERVAL = '2345';

    const result = Bun.spawnSync(['bun', 'test', tempTestPath], {
      cwd: path.dirname(import.meta.dir),
      env: process.env,
      stderr: 'pipe',
      stdout: 'pipe',
    });

    try {
      const output = result.stdout.toString() + result.stderr.toString();
      expect(result.exitCode, output).toBe(0);
      expect(output).toContain('1 pass');
    } finally {
      fs.rmSync(tempTestPath, { force: true });
    }
  });

  it('uses the real default scheduler wiring and registers runtime sync hooks', async () => {
    const tempTestPath = path.join(
      path.dirname(import.meta.path),
      `.scheduler-defaults-${crypto.randomUUID()}.test.ts`,
    );
    const tempTestSource = `
import { describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';

let capturedOptions;
const events = [];

mock.module('../src/jobs/cron-scheduler.ts', () => ({
  createScheduler(db) {
    capturedOptions = { db };
    return {
      upsertSchedule() {},
      removeSchedule() {},
      async start() {
        events.push('scheduler.start');
      },
      async stop() {
        events.push('scheduler.stop');
      },
    };
  },
  getRegisteredRunAgentPrompt() {
    return null;
  },
  getRegisteredRollbackWorkflow() {
    return null;
  },
  getRegisteredStartWorkflow() {
    return null;
  },
  removeSchedule() {},
  registerRollbackWorkflow() {},
  registerRunAgentPrompt() {},
  registerStartWorkflow() {},
  setScheduleRuntimeSync(sync) {
    events.push(sync == null ? 'sync.clear' : 'sync.set');
  },
  upsertSchedule() {},
}));

const { boot } = await import('../src/index.ts?scheduler-defaults=' + ${JSON.stringify(crypto.randomUUID())});

describe('default scheduler wiring isolation', () => {
  it('builds the default scheduler and clears sync hooks on shutdown', async () => {
    const db = {
      close() {},
    } as unknown as Database;

    const runtime = await boot({
      getDb() {
        return db;
      },
      migrate() {},
      async cleanupOrphans() {},
      createWarmPool() {
        return {
          async start() {},
          async stop() {},
          async acquire() {
            return null;
          },
          consume() {},
          release() {},
          getStats() {
            return { ready: 0, allocated: 0, starting: 0 };
          },
        };
      },
      startSweep() {
        return {
          async stop() {},
        };
      },
      startApiServer() {
        return {
          hostname: '127.0.0.1',
          port: 4111,
          async stop() {},
        };
      },
    });

    try {
      expect(capturedOptions).toEqual({ db });
      expect(events).toEqual(['sync.set', 'scheduler.start']);
    } finally {
      await runtime.stop();
    }

    expect(events).toEqual(['sync.set', 'scheduler.start', 'scheduler.stop', 'sync.clear']);
  });
});
`;

    fs.writeFileSync(tempTestPath, tempTestSource);

    const result = Bun.spawnSync(['bun', 'test', tempTestPath], {
      cwd: path.dirname(import.meta.dir),
      env: process.env,
      stderr: 'pipe',
      stdout: 'pipe',
    });

    try {
      const output = result.stdout.toString() + result.stderr.toString();
      expect(result.exitCode, output).toBe(0);
      expect(output).toContain('1 pass');
    } finally {
      fs.rmSync(tempTestPath, { force: true });
    }
  });

  it('builds one shared runAgentPrompt during boot and passes it into the default scheduler', async () => {
    const tempTestPath = path.join(
      path.dirname(import.meta.path),
      `.scheduler-run-agent-prompt-${crypto.randomUUID()}.test.ts`,
    );
    const tempTestSource = `
import { describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';

let createSchedulerArgs;
let createRunAgentPromptArgs;
let ensureSessionRuntimeArgs;
let registerRunAgentPromptArgs;
const sharedRunAgentPrompt = async () => ({
  content: 'ok',
  sessionId: 'session-1',
  threadId: 'schedule:schedule-1',
  lastRunAt: '2026-01-15T09:00:00.000Z',
});

mock.module('../src/jobs/run-agent-prompt.ts', () => ({
  createScheduleThreadId(scheduleId) {
    return 'schedule:' + scheduleId;
  },
  createRunAgentPrompt(args) {
    createRunAgentPromptArgs = args;
    return sharedRunAgentPrompt;
  },
}));

mock.module('../src/session/runtime.ts', () => ({
  createEnsureSessionRuntime(args) {
    ensureSessionRuntimeArgs = args;
    return async () => true;
  },
}));

mock.module('../src/jobs/cron-scheduler.ts', () => ({
  createScheduler(db) {
    createSchedulerArgs = { db };
    return {
      upsertSchedule() {},
      removeSchedule() {},
      async start() {},
      async stop() {},
    };
  },
  getRegisteredRunAgentPrompt() {
    return null;
  },
  getRegisteredRollbackWorkflow() {
    return null;
  },
  getRegisteredStartWorkflow() {
    return null;
  },
  removeSchedule() {},
  registerRollbackWorkflow() {},
  registerRunAgentPrompt(runAgentPrompt) {
    registerRunAgentPromptArgs = runAgentPrompt;
  },
  registerStartWorkflow() {},
  setScheduleRuntimeSync() {},
  upsertSchedule() {},
}));

const { boot } = await import('../src/index.ts?scheduler-run-agent-prompt=' + ${JSON.stringify(crypto.randomUUID())});

describe('default scheduler runAgentPrompt isolation', () => {
  it('registers the shared boot-built helper before calling createScheduler(db)', async () => {
    const db = {
      close() {},
    } as unknown as Database;

    const runtime = await boot({
      getDb() {
        return db;
      },
      migrate() {},
      async cleanupOrphans() {},
      createWarmPool() {
        return {
          async start() {},
          async stop() {},
          async acquire() {
            return null;
          },
          consume() {},
          release() {},
          getStats() {
            return { ready: 0, allocated: 0, starting: 0 };
          },
        };
      },
      startSweep() {
        return {
          async stop() {},
        };
      },
      startApiServer() {
        return {
          hostname: '127.0.0.1',
          port: 4111,
          async stop() {},
        };
      },
    });

    try {
      expect(createRunAgentPromptArgs).toBeDefined();
      expect(ensureSessionRuntimeArgs).toMatchObject({ db });
      expect(registerRunAgentPromptArgs).toBe(sharedRunAgentPrompt);
      expect(createSchedulerArgs).toEqual({ db });
    } finally {
      await runtime.stop();
    }
  });
});
`;

    fs.writeFileSync(tempTestPath, tempTestSource);

    const result = Bun.spawnSync(['bun', 'test', tempTestPath], {
      cwd: path.dirname(import.meta.dir),
      env: process.env,
      stderr: 'pipe',
      stdout: 'pipe',
    });

    try {
      const output = result.stdout.toString() + result.stderr.toString();
      expect(result.exitCode, output).toBe(0);
      expect(output).toContain('1 pass');
    } finally {
      fs.rmSync(tempTestPath, { force: true });
    }
  });

  it('registers the shared workflow starter during boot and passes it into the API server', async () => {
    const tempTestPath = path.join(
      path.dirname(import.meta.path),
      `.workflow-runtime-boot-${crypto.randomUUID()}.test.ts`,
    );
    const tempTestSource = `
import { describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';

let registerStartWorkflowArgs;
let startApiServerArgs;
const sharedStartWorkflow = async () => ({ instanceId: 'workflow-instance-1' });

mock.module('../src/jobs/cron-scheduler.ts', () => ({
  createScheduler() {
    return {
      upsertSchedule() {},
      removeSchedule() {},
      async start() {},
      async stop() {},
    };
  },
  getRegisteredRunAgentPrompt() {
    return null;
  },
  getRegisteredRollbackWorkflow() {
    return null;
  },
  getRegisteredStartWorkflow() {
    return null;
  },
  removeSchedule() {},
  registerRollbackWorkflow() {},
  registerRunAgentPrompt() {},
  registerStartWorkflow(startWorkflow) {
    registerStartWorkflowArgs = startWorkflow;
  },
  setScheduleRuntimeSync() {},
  upsertSchedule() {},
}));

const { boot } = await import('../src/index.ts?workflow-runtime-boot=' + ${JSON.stringify(crypto.randomUUID())});

describe('workflow starter boot isolation', () => {
  it('registers the shared workflow starter before exposing it to the API server', async () => {
    const db = {
      close() {},
    } as unknown as Database;

    const runtime = await boot({
      getDb() {
        return db;
      },
      migrate() {},
      async cleanupOrphans() {},
      createWarmPool() {
        return {
          async start() {},
          async stop() {},
          async acquire() {
            return null;
          },
          consume() {},
          release() {},
          getStats() {
            return { ready: 0, allocated: 0, starting: 0 };
          },
        };
      },
      createWorkflowRuntime() {
        return {
          async start() {},
          async stop() {},
          startWorkflow: sharedStartWorkflow,
          async rollbackWorkflow() {},
        };
      },
      startSweep() {
        return {
          async stop() {},
        };
      },
      startApiServer(options) {
        startApiServerArgs = options;
        return {
          hostname: '127.0.0.1',
          port: 4111,
          async stop() {},
        };
      },
    });

    try {
      expect(registerStartWorkflowArgs).toBe(sharedStartWorkflow);
      expect(startApiServerArgs.startWorkflow).toBe(sharedStartWorkflow);
    } finally {
      await runtime.stop();
    }
  });
});
`;

    fs.writeFileSync(tempTestPath, tempTestSource);

    const result = Bun.spawnSync(['bun', 'test', tempTestPath], {
      cwd: path.dirname(import.meta.dir),
      env: process.env,
      stderr: 'pipe',
      stdout: 'pipe',
    });

    try {
      const output = result.stdout.toString() + result.stderr.toString();
      expect(result.exitCode, output).toBe(0);
      expect(output).toContain('1 pass');
    } finally {
      fs.rmSync(tempTestPath, { force: true });
    }
  });

  it('avoids duplicating user turns when replaying a mixed-role transcript through the shared runAgentPrompt seam', async () => {
    const tempTestPath = path.join(
      path.dirname(import.meta.path),
      `.scheduler-mixed-replay-${crypto.randomUUID()}.test.ts`,
    );
    const tempTestSource = `
import { afterAll, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';

import { openInboundDb } from '../src/session/inbound.ts';

let createRunAgentPromptArgs;
const sessionDir = '/tmp/cove-v2-mixed-replay-' + crypto.randomUUID();

mock.module('../src/jobs/run-agent-prompt.ts', () => ({
  createScheduleThreadId(scheduleId) {
    return 'schedule:' + scheduleId;
  },
  createRunAgentPrompt(args) {
    createRunAgentPromptArgs = args;
    return async () => ({
      content: 'ok',
      sessionId: 'session-1',
      threadId: 'schedule:schedule-1',
      lastRunAt: '2026-01-15T09:00:00.000Z',
    });
  },
}));

mock.module('../src/session/runtime.ts', () => ({
  createEnsureSessionRuntime() {
    return async () => true;
  },
}));

mock.module('../src/router.ts', () => ({
  routeRequest() {
    return {
      agentGroup: {
        id: 'support',
        provider: 'anthropic',
        model: 'support-model',
        thinking: 'medium',
        workspace: '/workspace/support',
        permissions: '{}',
        config: null,
      },
      threadId: 'schedule:schedule-1',
      session: {
        id: 'session-1',
        agent_group_id: 'support',
        thread_id: 'schedule:schedule-1',
        session_file: sessionDir,
        metadata: null,
        created_at: '2026-01-15T08:00:00.000Z',
        updated_at: '2026-01-15T08:00:00.000Z',
      },
    };
  },
}));

mock.module('../src/jobs/cron-scheduler.ts', () => ({
  createScheduler() {
    return {
      upsertSchedule() {},
      removeSchedule() {},
      async start() {},
      async stop() {},
    };
  },
  getRegisteredRunAgentPrompt() {
    return null;
  },
  getRegisteredRollbackWorkflow() {
    return null;
  },
  getRegisteredStartWorkflow() {
    return null;
  },
  removeSchedule() {},
  registerRollbackWorkflow() {},
  registerRunAgentPrompt() {},
  registerStartWorkflow() {},
  setScheduleRuntimeSync() {},
  upsertSchedule() {},
}));

mock.module('../src/delivery.ts', () => ({
  DeliveryTimeoutError: class DeliveryTimeoutError extends Error {},
  pollForResponse() {
    return Promise.resolve([]);
  },
}));

const { boot } = await import('../src/index.ts?scheduler-mixed-replay=' + ${JSON.stringify(crypto.randomUUID())});

afterAll(() => {
  fs.rmSync(sessionDir, { recursive: true, force: true });
});

describe('mixed-role replay safety isolation', () => {
  it('compares replay prefixes against the persisted executable subset only', async () => {
    const db = {
      close() {},
    } as unknown as Database;

    const runtime = await boot({
      getDb() {
        return db;
      },
      migrate() {},
      async cleanupOrphans() {},
      createWarmPool() {
        return {
          async start() {},
          async stop() {},
          async acquire() {
            return null;
          },
          consume() {},
          release() {},
          getStats() {
            return { ready: 0, allocated: 0, starting: 0 };
          },
        };
      },
      startSweep() {
        return {
          async stop() {},
        };
      },
      startApiServer() {
        return {
          hostname: '127.0.0.1',
          port: 4111,
          async stop() {},
        };
      },
    });

    try {
      await createRunAgentPromptArgs.execute({
        agent_group_id: 'support',
        thread_id: 'schedule:schedule-1',
        messages: [
          { role: 'assistant', content: 'Previously answered' },
          { role: 'user', content: 'Run now' },
        ],
      });
      await createRunAgentPromptArgs.execute({
        agent_group_id: 'support',
        thread_id: 'schedule:schedule-1',
        messages: [
          { role: 'assistant', content: 'Previously answered' },
          { role: 'user', content: 'Run now' },
        ],
      });

      const inboundDb = openInboundDb(sessionDir);

      try {
        const rows = inboundDb.prepare('SELECT role, content FROM messages_in ORDER BY seq ASC').all();
        expect(rows).toEqual([
          { role: 'user', content: 'Run now' },
        ]);
      } finally {
        inboundDb.close();
      }
    } finally {
      await runtime.stop();
    }
  });
});
`;

    fs.writeFileSync(tempTestPath, tempTestSource);

    const result = Bun.spawnSync(['bun', 'test', tempTestPath], {
      cwd: path.dirname(import.meta.dir),
      env: process.env,
      stderr: 'pipe',
      stdout: 'pipe',
    });

    try {
      const output = result.stdout.toString() + result.stderr.toString();
      expect(result.exitCode, output).toBe(0);
      expect(output).toContain('1 pass');
    } finally {
      fs.rmSync(tempTestPath, { force: true });
    }
  });
});
