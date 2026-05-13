import type { Database } from 'bun:sqlite';
import path from 'node:path';

import { startApiServer } from './api/server.ts';
import { cleanupOrphans as cleanupOrphanContainers } from './container/detect.ts';
import { getImageName } from './container/image.ts';
import { spawnContainer } from './container/spawn.ts';
import { getDb } from './db/index.ts';
import { getStateDir } from './db/index.ts';
import { migrate } from './db/migrate.ts';
import { startSweep as startDefaultSweep } from './host-sweep.ts';
import { createEnsureSessionRuntime } from './session/runtime.ts';
import type { ApiServer, Scheduler, SweepHandle, WarmPool } from './shared/types.ts';
import type { ChatHandlerContext } from './shared/types.ts';
import { createWarmPool as createDefaultWarmPool } from './warm-pool.ts';

export type BootRuntime = {
  stop(): Promise<void>;
};

export type BootDependencies = {
  getDb(): Database;
  migrate(db: Database): void;
  cleanupOrphans(): Promise<void>;
  createWarmPool(db: Database): WarmPool;
  createScheduler(db: Database): Scheduler;
  startSweep(db: Database): SweepHandle;
  startApiServer(options: { db: Database; chat?: ChatHandlerContext }): ApiServer;
};

function createNoopScheduler(): Scheduler {
  return {
    async start() {},
    async stop() {},
  };
}

function createNoopSweepHandle(): SweepHandle {
  return {
    async stop() {},
  };
}

async function cleanupOrphans(): Promise<void> {
  cleanupOrphanContainers();
}

function readPoolSize(name: 'COVE_POOL_MIN' | 'COVE_POOL_MAX', fallback: number): number {
  const value = process.env[name]?.trim();

  if (value == null || !/^\d+$/.test(value)) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function createWarmPool(_db: Database): WarmPool {
  const stateDir = getStateDir();
  const imageName = getImageName();

  return createDefaultWarmPool({
    stateDir,
    minSize: readPoolSize('COVE_POOL_MIN', 1),
    maxSize: readPoolSize('COVE_POOL_MAX', 5),
    imageName,
    spawnContainer(sessionId, containerName, sessionDir, warmImageName) {
      return spawnContainer({
        imageName: warmImageName,
        containerName,
        sessionId,
        sessionDir,
      });
    },
  });
}

function createScheduler(_db: Database): Scheduler {
  return createNoopScheduler();
}

function readSweepIntervalMs(): number {
  const value = process.env.COVE_SWEEP_INTERVAL?.trim();

  if (value == null || !/^\d+$/.test(value)) {
    return 1000;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1000;
}

function startSweep(_db: Database): SweepHandle {
  return startDefaultSweep({
    intervalMs: readSweepIntervalMs(),
    ceilingMs: 30 * 60 * 1000,
    claimStuckMs: 60 * 1000,
  });
}

const defaultDependencies: BootDependencies = {
  getDb,
  migrate,
  cleanupOrphans,
  createWarmPool,
  createScheduler,
  startSweep,
  startApiServer,
};

async function runCleanup(
  actions: Array<() => void | Promise<void>>,
  initialError?: unknown,
): Promise<void> {
  let firstError = initialError;

  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      firstError ??= error;
    }
  }

  if (firstError) {
    throw firstError;
  }
}

export async function boot(overrides: Partial<BootDependencies> = {}): Promise<BootRuntime> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const db = dependencies.getDb();
  const cleanupActions: Array<() => void | Promise<void>> = [() => db.close()];

  try {
    dependencies.migrate(db);
    await dependencies.cleanupOrphans();

    const warmPool = dependencies.createWarmPool(db);
    cleanupActions.unshift(() => warmPool.stop());
    await warmPool.start();

    const ensureSessionRuntime = createEnsureSessionRuntime({
      db,
      warmPool,
      imageName: getImageName(),
      centralDbPath: path.join(getStateDir(), 'cove.db'),
    });

    const scheduler = dependencies.createScheduler(db);
    cleanupActions.unshift(() => scheduler.stop());
    await scheduler.start();

    const sweep = dependencies.startSweep(db);
    cleanupActions.unshift(() => sweep.stop());

    const apiServer = dependencies.startApiServer({
      db,
      chat: { ensureSessionRuntime },
    });
    cleanupActions.unshift(() => apiServer.stop());

    return {
      async stop() {
        await runCleanup(cleanupActions);
      },
    };
  } catch (error) {
    await runCleanup(cleanupActions, error);
    throw error;
  }
}

if (import.meta.main) {
  await boot();
}
