import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';

import { boot } from '../src/index.ts';
import type { ChatHandlerContext } from '../src/shared/types.ts';

const originalPoolMin = process.env.COVE_POOL_MIN;
const originalPoolMax = process.env.COVE_POOL_MAX;
const originalSweepInterval = process.env.COVE_SWEEP_INTERVAL;
const originalWorkflowApiBaseUrl = process.env.COVE_WORKFLOW_API_BASE_URL;

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

  if (originalWorkflowApiBaseUrl === undefined) {
    delete process.env.COVE_WORKFLOW_API_BASE_URL;
  } else {
    process.env.COVE_WORKFLOW_API_BASE_URL = originalWorkflowApiBaseUrl;
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
  stateDir: string;
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
        stateDir,
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
    const workflowService = {
      listDefinitions: async () => [],
      listInstances: async () => [],
      startWorkflow: async () => ({ instanceId: 'workflow-instance-1' }),
      getWorkflow: async () => null,
      signalWorkflow: async () => {},
      terminateWorkflow: async () => {},
      waitForWorkflow: async () => {
        throw new Error('not implemented');
      },
      startScheduledWorkflow: async () => ({ instanceId: 'workflow-instance-1' }),
      rollbackWorkflow: async () => {},
    };
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
          bindPi() {
            steps.push('workflow-runtime.bindPi');
          },
          async start() {
            steps.push('workflow-runtime.start');
          },
          async stop() {
            steps.push('workflow-runtime.stop');
          },
          registerDefinition() {},
          workflowService,
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
      startApiServer(options) {
        steps.push('api.start');
        expect(options.workflowService).toBe(workflowService);
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
      'workflow-runtime.bindPi',
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
      'workflow-runtime.bindPi',
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

  it('stops tracked session containers during runtime shutdown', async () => {
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
      createWorkflowRuntime() {
        return {
          bindPi() {},
          async start() {},
          async stop() {
            steps.push('workflow-runtime.stop');
          },
          registerDefinition() {},
          workflowService: {
            listDefinitions: async () => [],
            listInstances: async () => [],
            startWorkflow: async () => ({ instanceId: 'workflow-instance-1' }),
            getWorkflow: async () => null,
            signalWorkflow: async () => {},
            terminateWorkflow: async () => {},
            waitForWorkflow: async () => {
              throw new Error('not implemented');
            },
            startScheduledWorkflow: async () => ({ instanceId: 'workflow-instance-1' }),
            rollbackWorkflow: async () => {},
          },
          async startWorkflow() {
            return { instanceId: 'workflow-instance-1' };
          },
          async rollbackWorkflow() {},
        };
      },
      createScheduler() {
        return {
          async start() {},
          async stop() {
            steps.push('scheduler.stop');
          },
        };
      },
      startSweep() {
        return {
          async stop() {
            steps.push('sweep.stop');
          },
        };
      },
      startApiServer() {
        return {
          hostname: '127.0.0.1',
          port: 4111,
          async stop() {
            steps.push('api.stop');
          },
        };
      },
      stopTrackedContainers() {
        steps.push('containers.stop');
      },
    });

    await runtime.stop();

    expect(steps).toEqual([
      'db.get',
      'db.migrate',
      'cleanup.orphans',
      'warm-pool.init',
      'warm-pool.start',
      'api.stop',
      'sweep.stop',
      'scheduler.stop',
      'workflow-runtime.stop',
      'containers.stop',
      'warm-pool.stop',
      'db.close',
    ]);
  });

  it('passes workflowService plus the existing schedule seams into the API server', async () => {
    const workflowService = {
      listDefinitions: async () => [],
      listInstances: async () => [],
      startWorkflow: async () => ({ instanceId: 'workflow-instance-1' }),
      getWorkflow: async () => null,
      signalWorkflow: async () => {},
      terminateWorkflow: async () => {},
      waitForWorkflow: async () => {
        throw new Error('not implemented');
      },
      startScheduledWorkflow: async () => ({ instanceId: 'workflow-instance-1' }),
      rollbackWorkflow: async () => {},
    };
    const sharedStartWorkflow = async () => ({ instanceId: 'workflow-instance-1' });
    const sharedRollbackWorkflow = async () => {};
    let startApiServerArgs:
      | {
          workflowService?: unknown;
          startWorkflow?: unknown;
          rollbackWorkflow?: unknown;
        }
      | undefined;
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
          bindPi() {},
          async start() {},
          async stop() {},
          registerDefinition() {},
          workflowService,
          startWorkflow: sharedStartWorkflow,
          rollbackWorkflow: sharedRollbackWorkflow,
        };
      },
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
      expect(startApiServerArgs?.workflowService).toBe(workflowService);
      expect(startApiServerArgs?.startWorkflow).toBe(sharedStartWorkflow);
      expect(startApiServerArgs?.rollbackWorkflow).toBe(sharedRollbackWorkflow);
    } finally {
      await runtime.stop();
    }
  });

  it('computes a container-facing workflow API base URL from the bound server origin', async () => {
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
          bindPi() {},
          async start() {},
          async stop() {},
          registerDefinition() {},
          workflowService: {
            listDefinitions: async () => [],
            listInstances: async () => [],
            startWorkflow: async () => ({ instanceId: 'workflow-instance-1' }),
            getWorkflow: async () => null,
            signalWorkflow: async () => {},
            terminateWorkflow: async () => {},
            waitForWorkflow: async () => {
              throw new Error('not implemented');
            },
            startScheduledWorkflow: async () => ({ instanceId: 'workflow-instance-1' }),
            rollbackWorkflow: async () => {},
          },
          async startWorkflow() {
            return { instanceId: 'workflow-instance-1' };
          },
          async rollbackWorkflow() {},
        };
      },
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
      expect(process.env.COVE_WORKFLOW_API_BASE_URL).toBe('http://host.docker.internal:4111');
    } finally {
      await runtime.stop();
    }
  });

  it('preserves non-loopback server hostnames when computing the workflow API base URL', async () => {
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
          bindPi() {},
          async start() {},
          async stop() {},
          registerDefinition() {},
          workflowService: {
            listDefinitions: async () => [],
            listInstances: async () => [],
            startWorkflow: async () => ({ instanceId: 'workflow-instance-1' }),
            getWorkflow: async () => null,
            signalWorkflow: async () => {},
            terminateWorkflow: async () => {},
            waitForWorkflow: async () => {
              throw new Error('not implemented');
            },
            startScheduledWorkflow: async () => ({ instanceId: 'workflow-instance-1' }),
            rollbackWorkflow: async () => {},
          },
          async startWorkflow() {
            return { instanceId: 'workflow-instance-1' };
          },
          async rollbackWorkflow() {},
        };
      },
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
          hostname: 'cove-host.internal',
          port: 4222,
          async stop() {},
        };
      },
    });

    try {
      expect(process.env.COVE_WORKFLOW_API_BASE_URL).toBe('http://cove-host.internal:4222');
    } finally {
      await runtime.stop();
    }
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
    const { capturedChat, warmEntries, log, stateDir } = await bootWithDefaultWarmPool({
      poolMin: '2',
      poolMax: '7',
    });

    expect(capturedChat?.ensureSessionRuntime).toEqual(expect.any(Function));
    expect(warmEntries).toHaveLength(2);
    expect(log).toContain('run');
    expect(log).toContain('--name');
    expect(log).toContain('cove-agent:test');
    expect(log).toContain(path.join(stateDir, 'cove.db') + ':/app/session/cove.db');
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
  getRegisteredWorkflowService() {
    return null;
  },
  removeSchedule() {},
  registerRollbackWorkflow() {},
  registerRunAgentPrompt() {},
  registerStartWorkflow() {},
  registerWorkflowService() {},
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
let registerWorkflowServiceArgs;
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
  getRegisteredWorkflowService() {
    return null;
  },
  removeSchedule() {},
  registerRollbackWorkflow() {},
  registerRunAgentPrompt(runAgentPrompt) {
    registerRunAgentPromptArgs = runAgentPrompt;
  },
  registerStartWorkflow() {},
  registerWorkflowService(workflowService) {
    registerWorkflowServiceArgs = workflowService;
  },
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
      expect(registerWorkflowServiceArgs).toBeDefined();
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
let registerWorkflowServiceArgs;
let startApiServerArgs;
const sharedStartWorkflow = async () => ({ instanceId: 'workflow-instance-1' });
const sharedWorkflowService = {
  listDefinitions: async () => [],
  listInstances: async () => [],
  startWorkflow: async () => ({ instanceId: 'workflow-instance-1' }),
  getWorkflow: async () => null,
  signalWorkflow: async () => {},
  terminateWorkflow: async () => {},
  waitForWorkflow: async () => {
    throw new Error('not implemented');
  },
  startScheduledWorkflow: async () => ({ instanceId: 'workflow-instance-1' }),
  rollbackWorkflow: async () => {},
};

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
  getRegisteredWorkflowService() {
    return null;
  },
  removeSchedule() {},
  registerRollbackWorkflow() {},
  registerRunAgentPrompt() {},
  registerStartWorkflow(startWorkflow) {
    registerStartWorkflowArgs = startWorkflow;
  },
  registerWorkflowService(workflowService) {
    registerWorkflowServiceArgs = workflowService;
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
          bindPi() {},
          async start() {},
          async stop() {},
          registerDefinition() {},
          workflowService: sharedWorkflowService,
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
      expect(registerWorkflowServiceArgs).toBe(sharedWorkflowService);
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
  getRegisteredWorkflowService() {
    return null;
  },
  removeSchedule() {},
  registerRollbackWorkflow() {},
  registerRunAgentPrompt() {},
  registerStartWorkflow() {},
  registerWorkflowService() {},
  setScheduleRuntimeSync() {},
  upsertSchedule() {},
}));

mock.module('../src/delivery.ts', () => ({
  DeliveryTimeoutError: class DeliveryTimeoutError extends Error {},
  pollForResponse() {
    return Promise.resolve([]);
  },
  pollForWorkflowActionResult() {
    return Promise.resolve({
      type: 'workflow_action_result',
      request_id: 'unused',
      action: 'prompt',
      status: 'completed',
      result: '',
    });
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

  it('preserves a null stored model when the boot-built runAgentPrompt targets an agent group without a default model', async () => {
    const tempTestPath = path.join(
      path.dirname(import.meta.path),
      `.scheduler-null-model-${crypto.randomUUID()}.test.ts`,
    );
    const tempTestSource = `
import { afterAll, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';

import { openInboundDb } from '../src/session/inbound.ts';

let createRunAgentPromptArgs;
const sessionDir = '/tmp/cove-v2-scheduler-null-model-' + crypto.randomUUID();

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
        model: null,
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
  getRegisteredWorkflowService() {
    return null;
  },
  removeSchedule() {},
  registerRollbackWorkflow() {},
  registerRunAgentPrompt() {},
  registerStartWorkflow() {},
  registerWorkflowService() {},
  setScheduleRuntimeSync() {},
  upsertSchedule() {},
}));

mock.module('../src/delivery.ts', () => ({
  DeliveryTimeoutError: class DeliveryTimeoutError extends Error {},
  pollForResponse() {
    return Promise.resolve([]);
  },
  pollForWorkflowActionResult() {
    return Promise.resolve({
      type: 'workflow_action_result',
      request_id: 'unused',
      action: 'prompt',
      status: 'completed',
      result: '',
    });
  },
}));

const { boot } = await import('../src/index.ts?scheduler-null-model=' + ${JSON.stringify(crypto.randomUUID())});

afterAll(() => {
  fs.rmSync(sessionDir, { recursive: true, force: true });
});

describe('null-model schedule isolation', () => {
  it('writes a null model into session_config instead of fabricating the agent group id', async () => {
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
          { role: 'user', content: 'Run now' },
        ],
      });

      const inboundDb = openInboundDb(sessionDir);

      try {
        const configRow = inboundDb.prepare('SELECT model FROM session_config').get() as { model: string | null } | null;
        expect(configRow?.model).toBeNull();
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

  it('fails the boot-built runAgentPrompt when the routed agent group runtime-prep config is invalid', async () => {
    const tempTestPath = path.join(
      path.dirname(import.meta.path),
      `.scheduler-invalid-config-${crypto.randomUUID()}.test.ts`,
    );
    const tempTestSource = `
import { describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';

let createRunAgentPromptArgs;

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
        config: '{"provider_env_passthrough":[{"name":""}]}',
      },
      threadId: 'schedule:schedule-1',
      session: {
        id: 'session-1',
        agent_group_id: 'support',
        thread_id: 'schedule:schedule-1',
        session_file: '/tmp/cove-v2-scheduler-invalid-config-' + crypto.randomUUID(),
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
  getRegisteredWorkflowService() {
    return null;
  },
  removeSchedule() {},
  registerRollbackWorkflow() {},
  registerRunAgentPrompt() {},
  registerStartWorkflow() {},
  registerWorkflowService() {},
  setScheduleRuntimeSync() {},
  upsertSchedule() {},
}));

mock.module('../src/delivery.ts', () => ({
  DeliveryTimeoutError: class DeliveryTimeoutError extends Error {},
  pollForResponse() {
    return Promise.resolve([]);
  },
  pollForWorkflowActionResult() {
    return Promise.resolve({
      type: 'workflow_action_result',
      request_id: 'unused',
      action: 'prompt',
      status: 'completed',
      result: '',
    });
  },
}));

const { boot } = await import('../src/index.ts?scheduler-invalid-config=' + ${JSON.stringify(crypto.randomUUID())});

describe('invalid-config schedule isolation', () => {
  it('throws the shared runtime-prep validation error', async () => {
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
      await expect(createRunAgentPromptArgs.execute({
        agent_group_id: 'support',
        thread_id: 'schedule:schedule-1',
        messages: [
          { role: 'user', content: 'Run now' },
        ],
      })).rejects.toThrow('Invalid agent group config: provider_env_passthrough[0].name must be a non-empty string');
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
