import { Database } from 'bun:sqlite';
import { Client, Runtime, SqliteProvider, type ActivityContext, type OrchestrationContext } from 'duroxide';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import type { ScheduleRollbackWorkflow, ScheduleStartWorkflow } from '../shared/types.ts';
import {
  createWorkflowService,
  stripWorkflowInternalEnvelope,
  type WorkflowDefinition,
  type WorkflowExecutionContext,
  type WorkflowService,
  type WorkflowSignalInput,
  type WorkflowStatus,
  type WorkflowTerminateInput,
  type WorkflowWaitInput,
} from './bridge.ts';
import {
  createDefaultWorkflowPiBindings,
  createWorkflowPiClient,
  registerWorkflowPiActivities,
  type WorkflowGeneratorContext,
  type WorkflowPiBindings,
} from './pi-client.ts';

const ORCHESTRATION_NAME = '__cove.workflow';
const ACTIVITY_NAME = '__cove.workflow.execute';
const DEFAULT_WORKFLOW_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_DURABLE_VISIBILITY_TIMEOUT_MS = 10_000;
const DEFAULT_DURABLE_VISIBILITY_POLL_INTERVAL_MS = 25;

type RegisteredWorkflowDefinition = WorkflowDefinition & {
  execute?(input: {
    input: Record<string, unknown> | null;
    context: WorkflowExecutionContext;
  }): Promise<unknown> | unknown;
  generator?(ctx: WorkflowGeneratorContext, input: Record<string, unknown> | null): Generator<unknown, unknown, unknown>;
};

export type WorkflowRuntime = {
  start(): Promise<void>;
  stop(): Promise<void>;
  registerDefinition(definition: RegisteredWorkflowDefinition): void;
  bindPi(bindings: Partial<WorkflowPiBindings>): void;
  startWorkflow: ScheduleStartWorkflow;
  rollbackWorkflow: ScheduleRollbackWorkflow;
  workflowService: WorkflowService;
};

type WorkflowInstanceRow = {
  id: string;
  name: string;
  schedule_id: string | null;
  status: string;
  custom_status: string | null;
  context_json: string | null;
  input_json: string | null;
  output_json: string | null;
  error_json: string | null;
  durable_instance_id: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  ended_at: string | null;
};

type WorkflowEnvelope = {
  name: string;
  input: Record<string, unknown> | null;
  context: WorkflowExecutionContext;
};

function createMetadataDb(databasePath: string): Database {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const metadataPath = databasePath.endsWith('.db')
    ? databasePath.replace(/\.db$/u, '.metadata.db')
    : `${databasePath}.metadata.db`;
  const db = new Database(metadataPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_instances (
      id                  TEXT PRIMARY KEY,
      name                TEXT NOT NULL,
      schedule_id         TEXT,
      status              TEXT NOT NULL,
      custom_status       TEXT,
      context_json        TEXT,
      input_json          TEXT,
      output_json         TEXT,
      error_json          TEXT,
      durable_instance_id TEXT,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL,
      started_at          TEXT,
      ended_at            TEXT
    );

    CREATE INDEX IF NOT EXISTS workflow_instances_name_idx
    ON workflow_instances (name);

    CREATE INDEX IF NOT EXISTS workflow_instances_status_idx
    ON workflow_instances (status);
  `);
  return db;
}

function requireMetadataDb(db: Database | null): Database {
  if (db == null) {
    throw new Error('Workflow runtime is not started');
  }

  return db;
}

function requireClient(client: Client | null): Client {
  if (client == null) {
    throw new Error('Workflow runtime is not started');
  }

  return client;
}

function parseJson(value: unknown): unknown {
  if (value == null) {
    return null;
  }

  if (typeof value !== 'string') {
    return value;
  }

  if (value.trim() === '') {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function mapStoredStatus(status: string | null): WorkflowStatus {
  switch (status) {
    case 'Pending':
    case 'pending':
      return 'Pending';
    case 'Completed':
    case 'completed':
      return 'Completed';
    case 'Failed':
    case 'failed':
      return 'Failed';
    case 'Terminated':
    case 'terminated':
    case 'Canceled':
    case 'cancelled':
      return 'Terminated';
    case 'Running':
    case 'running':
    default:
      return 'Running';
  }
}

function isTerminalWorkflowStatus(status: WorkflowStatus): boolean {
  return status === 'Completed' || status === 'Failed' || status === 'Terminated';
}

function readWorkflowInstanceRow(db: Database, instanceId: string): WorkflowInstanceRow | null {
  const row = db.prepare(
    `SELECT id, name, schedule_id, status, custom_status, context_json, input_json, output_json, error_json, durable_instance_id, created_at, updated_at, started_at, ended_at
     FROM workflow_instances
     WHERE id = ?`,
  ).get(instanceId);

  return row == null ? null : (row as WorkflowInstanceRow);
}

function readWorkflowEnvelope(name: string, value: unknown): WorkflowEnvelope {
  const context: WorkflowExecutionContext = typeof value === 'object'
    && value != null
    && '__cove' in value
    && typeof value.__cove === 'object'
    && value.__cove != null
    && 'context' in value.__cove
    && typeof value.__cove.context === 'object'
    && value.__cove.context != null
      ? value.__cove.context as WorkflowExecutionContext
      : { trigger: 'api' };

  return {
    name,
    input: (stripWorkflowInternalEnvelope(value) as Record<string, unknown> | null) ?? null,
    context,
  };
}

function mapWorkflowRow(row: WorkflowInstanceRow) {
  return {
    instanceId: row.id,
    name: row.name,
    status: mapStoredStatus(row.status),
    customStatus: row.custom_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    input: (parseJson(row.input_json) as Record<string, unknown> | null) ?? null,
    output: stripWorkflowInternalEnvelope(parseJson(row.output_json)),
    error: parseJson(row.error_json) as { message: string } | null,
  };
}

function serializeError(error: unknown): { message: string } {
  if (error instanceof Error) {
    return { message: error.message };
  }

  if (typeof error === 'object' && error != null && 'message' in error && typeof error.message === 'string') {
    return { message: error.message };
  }

  return { message: String(error) };
}

function normalizeDurableError(error: unknown): { message: string } | null {
  if (error == null) {
    return null;
  }

  if (typeof error === 'string') {
    const normalized = error.includes('Error: ')
      ? error.split('Error: ').at(-1)?.split('\n')[0]?.trim() ?? error.trim()
      : error.trim();
    return { message: normalized };
  }

  const parsed = parseJson(error);
  if (typeof parsed === 'string') {
    return normalizeDurableError(parsed);
  }

  return serializeError(parsed ?? error);
}

function isDurableInstanceMissingError(error: unknown, instanceId: string): boolean {
  return error instanceof Error
    && error.message.includes(`Instance ${instanceId} not found`);
}

function isRetryableDurableInstanceError(error: unknown, instanceId: string): boolean {
  return isDurableInstanceMissingError(error, instanceId)
    || (error instanceof Error && error.message.toLowerCase().includes('database is locked'));
}

export function createWorkflowRuntime(databasePath: string): WorkflowRuntime {
  let metadataDb: Database | null = null;
  let provider: Awaited<ReturnType<typeof SqliteProvider.open>> | null = null;
  let durableRuntime: Runtime | null = null;
  let client: Client | null = null;
  let shuttingDown = false;
  const definitions = new Map<string, RegisteredWorkflowDefinition>();
  const monitors = new Set<Promise<void>>();
  let piBindings: WorkflowPiBindings = createDefaultWorkflowPiBindings();

  function trackMonitor(promise: Promise<void>): void {
    monitors.add(promise);
    void promise.then(() => {
      monitors.delete(promise);
    }, () => {
      monitors.delete(promise);
    });
  }

  async function monitorDurableWorkflow(instanceId: string): Promise<void> {
    const runtimeClient = requireClient(client);

    try {
      const status = await runtimeClient.waitForOrchestration(instanceId);

      if (shuttingDown || metadataDb == null) {
        return;
      }

      const normalizedStatus = mapStoredStatus(status.status);
      const now = new Date().toISOString();
      const output = parseJson(status.output ?? null);
      const error = normalizeDurableError(status.error ?? null);
      const runtimeDb = requireMetadataDb(metadataDb);
      const currentRow = readWorkflowInstanceRow(runtimeDb, instanceId);

      if (currentRow == null) {
        return;
      }

      runtimeDb.prepare(
        `UPDATE workflow_instances
         SET status = ?,
             custom_status = ?,
             output_json = ?,
             error_json = ?,
             updated_at = ?,
             ended_at = ?
         WHERE id = ?`,
      ).run(
        normalizedStatus,
        isTerminalWorkflowStatus(normalizedStatus) ? null : (status.customStatus ?? null),
        output == null ? null : JSON.stringify(output),
        normalizedStatus === 'Terminated'
          ? JSON.stringify({ message: 'Workflow terminated' })
          : error == null ? null : JSON.stringify(error),
        now,
        isTerminalWorkflowStatus(normalizedStatus) ? now : null,
        instanceId,
      );
    } catch (error) {
      if (shuttingDown || metadataDb == null) {
        return;
      }

      const now = new Date().toISOString();
      const runtimeDb = requireMetadataDb(metadataDb);
      runtimeDb.prepare(
        `UPDATE workflow_instances
         SET status = ?,
             error_json = ?,
             updated_at = ?,
             ended_at = ?
         WHERE id = ?
           AND status != ?`,
      ).run('Failed', JSON.stringify(serializeError(error)), now, now, instanceId, 'Terminated');
    }
  }

  async function waitForDurableInstanceVisibility(instanceId: string): Promise<void> {
    const runtimeClient = requireClient(client);
    const deadline = Date.now() + DEFAULT_DURABLE_VISIBILITY_TIMEOUT_MS;

    while (true) {
      try {
        const status = await runtimeClient.getStatus(instanceId);

        if (status != null) {
          return;
        }
      } catch (error) {
        if (!isRetryableDurableInstanceError(error, instanceId)) {
          throw error;
        }
      }

      if (Date.now() >= deadline) {
        throw new Error(`Workflow instance did not become visible: ${instanceId}`);
      }

      await sleep(Math.min(DEFAULT_DURABLE_VISIBILITY_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    }
  }

  async function runDurableInstanceCommand<T>(instanceId: string, operation: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + DEFAULT_DURABLE_VISIBILITY_TIMEOUT_MS;

    while (true) {
      try {
        return await operation();
      } catch (error) {
        if (!isRetryableDurableInstanceError(error, instanceId) || Date.now() >= deadline) {
          throw error;
        }

        await sleep(
          Math.min(DEFAULT_DURABLE_VISIBILITY_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())),
        );
      }
    }
  }

  const workflowService = createWorkflowService({
    async listDefinitions(options) {
      const rows = Array.from(definitions.values()).map(({ name, description }) => ({ name, description }));
      return options?.name == null ? rows : rows.filter((definition) => definition.name === options.name);
    },
    async listInstances(options) {
      const runtimeDb = requireMetadataDb(metadataDb);
      const filters: string[] = [];
      const values: string[] = [];

      if (options?.name != null) {
        filters.push('name = ?');
        values.push(options.name);
      }

      if (options?.status != null) {
        filters.push('status = ?');
        values.push(options.status);
      }

      const whereClause = filters.length === 0 ? '' : `WHERE ${filters.join(' AND ')}`;
      const rows = runtimeDb.prepare(
        `SELECT id, name, schedule_id, status, custom_status, context_json, input_json, output_json, error_json, durable_instance_id, created_at, updated_at, started_at, ended_at
         FROM workflow_instances
         ${whereClause}
         ORDER BY created_at ASC, id ASC`,
      ).all(...values) as WorkflowInstanceRow[];

      return rows.map(mapWorkflowRow);
    },
    async startWorkflow(input) {
      const runtimeDb = requireMetadataDb(metadataDb);
      const runtimeClient = requireClient(client);
      const definition = definitions.get(input.name);

      if (definition == null) {
        throw new Error(`Workflow definition not found: ${input.name}`);
      }

      const instanceId = input.id ?? crypto.randomUUID();
      const now = new Date().toISOString();
      const envelope = readWorkflowEnvelope(input.name, input.input);

      runtimeDb.prepare(
        `INSERT INTO workflow_instances (id, name, schedule_id, status, custom_status, context_json, input_json, output_json, error_json, durable_instance_id, created_at, updated_at, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        instanceId,
        input.name,
        typeof envelope.context.schedule_id === 'string' ? envelope.context.schedule_id : null,
        'Running',
        null,
        JSON.stringify(envelope.context),
        envelope.input == null ? null : JSON.stringify(envelope.input),
        null,
        null,
        instanceId,
        now,
        now,
        now,
        null,
      );

      try {
        await runtimeClient.startOrchestration(instanceId, ORCHESTRATION_NAME, envelope);
        await waitForDurableInstanceVisibility(instanceId);
      } catch (error) {
        try {
          await runtimeClient.deleteInstance(instanceId, true);
        } catch (deleteError) {
          if (!isDurableInstanceMissingError(deleteError, instanceId)) {
            // Best-effort cleanup only; preserve the original start failure.
          }
        }
        runtimeDb.prepare('DELETE FROM workflow_instances WHERE id = ?').run(instanceId);
        throw error;
      }

      trackMonitor(monitorDurableWorkflow(instanceId));

      return { instanceId };
    },
    async getWorkflow({ instanceId }) {
      const runtimeDb = requireMetadataDb(metadataDb);
      const row = readWorkflowInstanceRow(runtimeDb, instanceId);
      return row == null ? null : mapWorkflowRow(row);
    },
    async signalWorkflow(input: WorkflowSignalInput) {
      const runtimeDb = requireMetadataDb(metadataDb);
      const row = readWorkflowInstanceRow(runtimeDb, input.instanceId);

      if (row == null) {
        throw new Error(`Workflow instance not found: ${input.instanceId}`);
      }

      runtimeDb.prepare(
        `UPDATE workflow_instances
         SET updated_at = ?
         WHERE id = ?`,
      ).run(new Date().toISOString(), input.instanceId);

      if (row.durable_instance_id != null) {
        await runDurableInstanceCommand(
          input.instanceId,
          async () => await requireClient(client).raiseEvent(input.instanceId, input.eventName, input.data ?? null),
        );
      }
    },
    async terminateWorkflow(input: WorkflowTerminateInput) {
      const runtimeDb = requireMetadataDb(metadataDb);
      const row = readWorkflowInstanceRow(runtimeDb, input.instanceId);

      if (row == null) {
        throw new Error(`Workflow instance not found: ${input.instanceId}`);
      }

      if (row.durable_instance_id != null) {
        await runDurableInstanceCommand(
          input.instanceId,
          async () => await requireClient(client).cancelInstance(input.instanceId, 'Workflow terminated'),
        );
      }

      const now = new Date().toISOString();
      runtimeDb.prepare(
        `UPDATE workflow_instances
         SET status = ?,
             error_json = ?,
             updated_at = ?,
             ended_at = ?
         WHERE id = ?`,
      ).run('Terminated', JSON.stringify({ message: 'Workflow terminated' }), now, now, input.instanceId);
    },
    async waitForWorkflow(input: WorkflowWaitInput) {
      const timeoutMs = input.timeoutMs ?? DEFAULT_WORKFLOW_WAIT_TIMEOUT_MS;
      const pollIntervalMs = input.pollIntervalMs ?? 50;
      const deadline = Date.now() + timeoutMs;

      while (true) {
        const workflow = await workflowService.getWorkflow({ instanceId: input.instanceId });

        if (workflow == null) {
          throw new Error(`Workflow instance not found: ${input.instanceId}`);
        }

        if (isTerminalWorkflowStatus(workflow.status)) {
          return workflow;
        }

        if (Date.now() >= deadline) {
          throw new Error(`Workflow wait timed out: ${input.instanceId}`);
        }

        await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
      }
    },
    async rollbackWorkflow({ instanceId }) {
      const runtimeDb = requireMetadataDb(metadataDb);
      const row = readWorkflowInstanceRow(runtimeDb, instanceId);

      if (row?.durable_instance_id != null) {
        try {
          await runDurableInstanceCommand(
            instanceId,
            async () => await requireClient(client).deleteInstance(instanceId, true),
          );
        } catch (error) {
          if (!isDurableInstanceMissingError(error, instanceId)) {
            throw error;
          }
        }
      }

      runtimeDb.prepare('DELETE FROM workflow_instances WHERE id = ?').run(instanceId);
    },
  });

  return {
    workflowService,
    registerDefinition(definition) {
      if (definitions.has(definition.name)) {
        throw new Error(`Workflow definition already registered: ${definition.name}`);
      }

       if (definition.execute == null && definition.generator == null) {
        throw new Error(`Workflow definition must provide execute or generator: ${definition.name}`);
      }

      definitions.set(definition.name, definition);
    },
    bindPi(bindings) {
      Object.assign(piBindings, bindings);
    },
    async start() {
      if (metadataDb != null) {
        return;
      }

      shuttingDown = false;
      metadataDb = createMetadataDb(databasePath);
      provider = await SqliteProvider.open(`sqlite:${databasePath}`);
      client = new Client(provider);
      durableRuntime = new Runtime(provider);

      registerWorkflowPiActivities(durableRuntime, piBindings);

      durableRuntime.registerActivity(ACTIVITY_NAME, async (_ctx: ActivityContext, input: WorkflowEnvelope) => {
        const definition = definitions.get(input.name);

        if (definition == null || definition.execute == null) {
          throw new Error(`Workflow definition not found: ${input.name}`);
        }

        return await definition.execute({
          input: input.input,
          context: input.context,
        });
      });

      durableRuntime.registerOrchestration(ORCHESTRATION_NAME, function* (ctx: OrchestrationContext, input: WorkflowEnvelope) {
        ctx.setCustomStatus('Running');
        const definition = definitions.get(input.name);

        if (definition == null) {
          throw new Error(`Workflow definition not found: ${input.name}`);
        }

        const result = definition.generator != null
          ? yield* definition.generator(
              Object.assign(ctx, {
                pi: createWorkflowPiClient((name: string, activityInput: unknown) => ctx.scheduleActivity(name, {
                  context: input.context,
                  input: activityInput,
                })),
              }),
              input.input,
            )
          : yield ctx.scheduleActivity(ACTIVITY_NAME, input);
        if (typeof ctx.resetCustomStatus === 'function') {
          ctx.resetCustomStatus();
        }
        return result;
      });

      await durableRuntime.start();
    },
    async stop() {
      try {
        shuttingDown = true;
        await durableRuntime?.shutdown(250);
        await Promise.race([
          Promise.allSettled(Array.from(monitors)),
          sleep(300),
        ]);
      } finally {
        monitors.clear();
        metadataDb?.close();
        metadataDb = null;
        durableRuntime = null;
        client = null;
        provider = null;
        shuttingDown = false;
      }
    },
    async startWorkflow({ schedule, input }) {
      return await workflowService.startScheduledWorkflow({ schedule, input });
    },
    async rollbackWorkflow({ instanceId }) {
      await workflowService.rollbackWorkflow({ instanceId });
    },
  };
}
