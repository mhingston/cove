import type { Database } from 'bun:sqlite';
import path from 'node:path';

import { startApiServer } from './api/server.ts';
import { cleanupOrphans as cleanupOrphanContainers } from './container/detect.ts';
import { getImageName } from './container/image.ts';
import { getActiveContainers, killContainer, spawnContainer } from './container/spawn.ts';
import { getDb } from './db/index.ts';
import { getStateDir } from './db/index.ts';
import { migrate } from './db/migrate.ts';
import { startSweep as startDefaultSweep } from './host-sweep.ts';
import { resolveRuntimeMcpConfig, serializeRuntimeMcpConfig } from './integrations/mcp.ts';
import {
  createScheduler as createDefaultScheduler,
  registerRollbackWorkflow,
  registerRunAgentPrompt,
  registerStartWorkflow,
  registerWorkflowService,
  setScheduleRuntimeSync,
  type SchedulerRuntimeSync,
} from './jobs/cron-scheduler.ts';
import { createRunAgentPrompt, type RunAgentPromptExecutionResult } from './jobs/run-agent-prompt.ts';
import { routeRequest } from './router.ts';
import { pollForResponse } from './delivery.ts';
import { openInboundDb, writeInboundMessage } from './session/inbound.ts';
import { openExistingOutboundDb } from './session/outbound.ts';
import { createEnsureSessionRuntime } from './session/runtime.ts';
import { buildAgentGroupSessionConfig } from './session-config.ts';
import { createWorkflowRuntime as createDefaultWorkflowRuntime, type WorkflowRuntime } from './workflows/runtime.ts';
import { createWorkflowSessionBindings } from './workflows/session-bindings.ts';
import type { ApiServer, Scheduler, SweepHandle, WarmPool } from './shared/types.ts';
import type { ChatHandlerContext, ChatMessage, SessionConfig } from './shared/types.ts';
import type { ScheduleRollbackWorkflow } from './shared/types.ts';
import type { ScheduleStartWorkflow } from './shared/types.ts';
import type { WorkflowService } from './workflows/bridge.ts';
import { createWarmPool as createDefaultWarmPool } from './warm-pool.ts';

export type BootRuntime = {
  stop(): Promise<void>;
};

export type BootDependencies = {
  getDb(): Database;
  migrate(db: Database): void;
  cleanupOrphans(): Promise<void>;
  stopTrackedContainers(): void;
  createWarmPool(db: Database): WarmPool;
  createWorkflowRuntime(databasePath: string): WorkflowRuntime;
  createScheduler(db: Database): Scheduler;
  startSweep(db: Database): SweepHandle;
  startApiServer(options: {
    db: Database;
    chat?: ChatHandlerContext;
    startWorkflow?: ScheduleStartWorkflow;
    rollbackWorkflow?: ScheduleRollbackWorkflow;
    workflowService?: WorkflowService;
  }): ApiServer;
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

function stopTrackedContainers(): void {
  for (const sessionId of [...getActiveContainers().keys()]) {
    killContainer(sessionId, 'runtime shutdown');
  }
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
  const centralDbPath = path.join(stateDir, 'cove.db');

  return createDefaultWarmPool({
    stateDir,
    minSize: readPoolSize('COVE_POOL_MIN', 1),
    maxSize: readPoolSize('COVE_POOL_MAX', 5),
    centralDbPath,
    imageName,
    spawnContainer(sessionId, containerName, sessionDir, warmImageName) {
      return spawnContainer({
        imageName: warmImageName,
        containerName,
        sessionId,
        sessionDir,
        centralDbPath,
      });
    },
  });
}

function createScheduler(db: Database): Scheduler {
  return createDefaultScheduler(db);
}

function createWorkflowRuntime(databasePath: string): WorkflowRuntime {
  return createDefaultWorkflowRuntime(databasePath);
}

function buildScheduledSessionConfig(agentGroup: {
  provider: string;
  model: string | null;
  thinking: string;
  workspace: string | null;
  permissions: string;
  config: string | null;
}): SessionConfig {
  return buildAgentGroupSessionConfig(agentGroup);
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

      const outboundBaselineDb = openExistingOutboundDb(sessionDir);
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

      const messages = await pollForResponse({
        openDb: () => openExistingOutboundDb(sessionDir),
        sessionId: routed.session.id,
        baselineOutSeq: baselineSeq,
      });

      return {
        content: messages.map((message) => message.content).join(''),
        sessionId: routed.session.id,
        lastRunAt: new Date().toISOString(),
      };
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

function resolveContainerFacingWorkflowApiBaseUrl(origin: string): string {
  const url = new URL(origin);

  if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(url.hostname)) {
    url.hostname = 'host.docker.internal';
  }

  return url.origin;
}

const defaultDependencies: BootDependencies = {
  getDb,
  migrate,
  cleanupOrphans,
  stopTrackedContainers,
  createWarmPool,
  createWorkflowRuntime,
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
    cleanupActions.unshift(() => dependencies.stopTrackedContainers());
    await warmPool.start();

    const ensureSessionRuntime = createEnsureSessionRuntime({
      db,
      warmPool,
      imageName: getImageName(),
      centralDbPath: path.join(getStateDir(), 'cove.db'),
    });

    const workflowRuntime = dependencies.createWorkflowRuntime(path.join(getStateDir(), 'workflows.db'));
    workflowRuntime.bindPi(createWorkflowSessionBindings({
      db,
      stateDir: getStateDir(),
      ensureSessionRuntime,
    }));
    cleanupActions.unshift(() => workflowRuntime.stop());
    await workflowRuntime.start();
    registerStartWorkflow(workflowRuntime.startWorkflow);
    cleanupActions.unshift(() => registerStartWorkflow(null));
    registerRollbackWorkflow(workflowRuntime.rollbackWorkflow);
    cleanupActions.unshift(() => registerRollbackWorkflow(null));
    registerWorkflowService(workflowRuntime.workflowService);
    cleanupActions.unshift(() => registerWorkflowService(null));

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
      startWorkflow: workflowRuntime.startWorkflow,
      rollbackWorkflow: workflowRuntime.rollbackWorkflow,
      workflowService: workflowRuntime.workflowService,
    });
    process.env.COVE_WORKFLOW_API_BASE_URL = resolveContainerFacingWorkflowApiBaseUrl(
      `http://${apiServer.hostname}:${apiServer.port}`,
    );
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
