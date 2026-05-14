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
import {
  createScheduler as createDefaultScheduler,
  registerRunAgentPrompt,
  setScheduleRuntimeSync,
  type SchedulerRuntimeSync,
} from './jobs/cron-scheduler.ts';
import { createRunAgentPrompt, type RunAgentPromptExecutionResult } from './jobs/run-agent-prompt.ts';
import { routeRequest } from './router.ts';
import { pollForResponse } from './delivery.ts';
import { openInboundDb, writeInboundMessage } from './session/inbound.ts';
import { openOutboundDb } from './session/outbound.ts';
import { createEnsureSessionRuntime } from './session/runtime.ts';
import type { ApiServer, Scheduler, SweepHandle, WarmPool } from './shared/types.ts';
import type { ChatHandlerContext, ChatMessage, SessionConfig } from './shared/types.ts';
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

function createNoopSweepHandle(): SweepHandle {
  return {
    async stop() {},
  };
}

function isSchedulerRuntimeSync(value: Scheduler): value is Scheduler & SchedulerRuntimeSync {
  return typeof (value as Partial<SchedulerRuntimeSync>).upsertSchedule === 'function'
    && typeof (value as Partial<SchedulerRuntimeSync>).removeSchedule === 'function';
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

function createScheduler(db: Database): Scheduler {
  return createDefaultScheduler(db);
}

function parseAgentGroupConfig(configValue: string | null): {
  api_key?: string;
  extra_env?: Record<string, string>;
} | null {
  if (typeof configValue !== 'string' || configValue.trim() === '') {
    return null;
  }

  try {
    return JSON.parse(configValue) as {
      api_key?: string;
      extra_env?: Record<string, string>;
    };
  } catch {
    return null;
  }
}

function buildScheduledSessionConfig(agentGroup: {
  id: string;
  provider: string;
  model: string | null;
  thinking: string;
  workspace: string | null;
  permissions: string;
  config: string | null;
}): SessionConfig {
  const parsedConfig = parseAgentGroupConfig(agentGroup.config);
  const mcpConfig = parsedConfig != null && 'mcpServers' in (parsedConfig as Record<string, unknown>)
    ? JSON.stringify({
        mcpServers: (parsedConfig as Record<string, unknown>).mcpServers,
      })
    : null;
  const extraEnv = {
    ...(parsedConfig?.extra_env ?? {}),
    ...(mcpConfig == null ? {} : { COVE_MCP_CONFIG: mcpConfig }),
  };

  return {
    provider: agentGroup.provider,
    model: agentGroup.model || agentGroup.id,
    thinking_level: agentGroup.thinking,
    api_key: parsedConfig?.api_key ?? null,
    workspace: agentGroup.workspace,
    extra_env: Object.keys(extraEnv).length > 0 ? extraEnv : null,
    permissions: agentGroup.permissions,
  };
}

function writeSessionConfig(db: Database, config: SessionConfig): void {
  db.exec('DELETE FROM session_config');
  db.prepare(
    `INSERT INTO session_config (provider, model, thinking_level, api_key, workspace, extra_env, permissions)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    config.provider,
    config.model,
    config.thinking_level ?? null,
    config.api_key ?? null,
    config.workspace ?? null,
    config.extra_env == null ? null : JSON.stringify(config.extra_env),
    config.permissions ?? null,
  );
}

function appendNewExecutableTurns(db: Database, messages: ChatMessage[]): void {
  const executableMessages = messages.filter((message) => message.role === 'user');
  const existingRows = db.prepare('SELECT role, content FROM messages_in ORDER BY seq ASC').all() as Array<{
    role: string;
    content: string;
  }>;
  let replayPrefixLength = 0;

  while (replayPrefixLength < existingRows.length && replayPrefixLength < executableMessages.length) {
    const existing = existingRows[replayPrefixLength];
    const incoming = executableMessages[replayPrefixLength];

    if (existing?.role !== incoming?.role || existing?.content !== incoming?.content) {
      break;
    }

    replayPrefixLength += 1;
  }

  for (const message of executableMessages.slice(replayPrefixLength)) {
    writeInboundMessage(db, {
      id: crypto.randomUUID(),
      role: message.role,
      content: message.content,
    });
  }
}

function createBootRunAgentPrompt(options: {
  db: Database;
  ensureSessionRuntime: NonNullable<ChatHandlerContext['ensureSessionRuntime']>;
  stateDir: string;
}) {
  return createRunAgentPrompt({
    execute: async (input): Promise<RunAgentPromptExecutionResult> => {
      const routed = routeRequest({
        db: options.db,
        request: new Request('http://scheduler.local/internal/schedules/run'),
        body: {
          agent_group_id: input.agent_group_id,
          thread_id: input.thread_id,
        },
        stateDir: options.stateDir,
      });
      const config = buildScheduledSessionConfig(routed.agentGroup);
      const ready = await options.ensureSessionRuntime({ routed, config });

      if (!ready) {
        throw new Error('Container runtime unavailable');
      }

      const sessionDir = routed.session.session_file;

      if (sessionDir == null) {
        throw new Error('Session runtime is unavailable');
      }

      const outboundBaselineDb = openOutboundDb(sessionDir);
      let baselineSeq = 0;

      try {
        const baselineRow = outboundBaselineDb.prepare('SELECT MAX(seq) AS seq FROM messages_out').get() as {
          seq: number | null;
        };
        baselineSeq = baselineRow.seq ?? 0;
      } finally {
        outboundBaselineDb.close();
      }

      const inboundDb = openInboundDb(sessionDir);

      try {
        writeSessionConfig(inboundDb, config);
        appendNewExecutableTurns(inboundDb, input.messages);
      } finally {
        inboundDb.close();
      }

      const outboundDb = openOutboundDb(sessionDir);

      try {
        const messages = await pollForResponse({
          db: outboundDb,
          sessionId: routed.session.id,
          baselineOutSeq: baselineSeq,
        });

        return {
          content: messages.map((message) => message.content).join(''),
          sessionId: routed.session.id,
          lastRunAt: new Date().toISOString(),
        };
      } finally {
        outboundDb.close();
      }
    },
  });
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

    const runAgentPrompt = createBootRunAgentPrompt({
      db,
      ensureSessionRuntime,
      stateDir: getStateDir(),
    });
    registerRunAgentPrompt(runAgentPrompt);
    cleanupActions.unshift(() => registerRunAgentPrompt(null));

    const scheduler = dependencies.createScheduler(db);
    if (isSchedulerRuntimeSync(scheduler)) {
      setScheduleRuntimeSync(scheduler);
      cleanupActions.unshift(() => setScheduleRuntimeSync(null));
    }
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
