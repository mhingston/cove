import type { Database } from 'bun:sqlite';

import { startApiServer } from './api/server.ts';
import { cleanupOrphans as cleanupOrphanContainers } from './container/detect.ts';
import { getDb } from './db/index.ts';
import { migrate } from './db/migrate.ts';
import type { ApiServer, Scheduler, SweepHandle, WarmPool } from './shared/types.ts';

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
  startApiServer(options: { db: Database }): ApiServer;
};

function createNoopWarmPool(): WarmPool {
  return {
    async start() {},
    async stop() {},
  };
}

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

function createWarmPool(_db: Database): WarmPool {
  return createNoopWarmPool();
}

function createScheduler(_db: Database): Scheduler {
  return createNoopScheduler();
}

function startSweep(_db: Database): SweepHandle {
  return createNoopSweepHandle();
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

    const scheduler = dependencies.createScheduler(db);
    cleanupActions.unshift(() => scheduler.stop());
    await scheduler.start();

    const sweep = dependencies.startSweep(db);
    cleanupActions.unshift(() => sweep.stop());

    const apiServer = dependencies.startApiServer({ db });
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
