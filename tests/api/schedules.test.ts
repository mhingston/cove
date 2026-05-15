import { afterEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';

import { createApp } from '../../src/api/app.ts';
import { migrate } from '../../src/db/migrate.ts';
import { registerRunAgentPrompt, setScheduleRuntimeSync } from '../../src/jobs/cron-scheduler.ts';
import { createWorkflowService } from '../../src/workflows/bridge.ts';

type RunAgentPromptFn = (options: {
  schedule: {
    id: string;
    agent_group_id: string;
    prompt: string;
    mode?: string;
  };
}) => Promise<{
  content: string;
  sessionId: string;
  threadId: string;
  lastRunAt: string;
}>;

function insertAgentGroup(db: Database, id: string): void {
  const now = '2026-01-01T00:00:00.000Z';

  db.prepare(
    `INSERT INTO agent_groups (
       id,
       name,
       workspace,
       provider,
       model,
       thinking,
       permissions,
       soul,
       config,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    `${id} name`,
    `/workspace/${id}`,
    'anthropic',
    `${id}-model`,
    'medium',
    '{"default":"ask"}',
    null,
    null,
    now,
    now,
  );
}

function createScheduleDb(): Database {
  const db = new Database(':memory:');
  migrate(db);
  insertAgentGroup(db, 'support');
  return db;
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

afterEach(() => {
  registerRunAgentPrompt(null);
  setScheduleRuntimeSync(null);
  mock.restore();
});

describe('schedules api', () => {
  it('creates schedules with defaults and normalized response dto fields', async () => {
    const db = createScheduleDb();

    try {
      const app = createApp({ db });
      const response = await app.fetch(new Request('http://cove.test/v1/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_group_id: 'support',
          cron_expr: '0 9 * * 1-5',
          prompt: '  Daily summary  ',
        }),
      }));

      expect(response.status).toBe(201);

      const body = await json<Record<string, unknown>>(response);
      expect(body).toEqual({
        id: expect.any(String),
        agent_group_id: 'support',
        cron_expr: '0 9 * * 1-5',
        prompt: 'Daily summary',
        mode: 'agent',
        config: null,
        enabled: true,
        last_run_at: null,
        next_run_at: expect.any(String),
        created_at: expect.any(String),
      });
    } finally {
      db.close();
    }
  });

  it('rejects missing required create fields and trimmed-empty prompts', async () => {
    const db = createScheduleDb();

    try {
      const app = createApp({ db });

      for (const payload of [
        { cron_expr: '0 9 * * *', prompt: 'Run' },
        { agent_group_id: 'support', prompt: 'Run' },
        { agent_group_id: 'support', cron_expr: '0 9 * * *' },
        { agent_group_id: 'support', cron_expr: '0 9 * * *', prompt: '   ' },
      ]) {
        const response = await app.fetch(new Request('http://cove.test/v1/schedules', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }));

        expect(response.status).toBe(400);
        expect(await json<Record<string, unknown>>(response)).toEqual({ error: expect.any(String) });
      }
    } finally {
      db.close();
    }
  });

  it('rejects invalid cron, config, mode, and enabled payloads with 400', async () => {
    const db = createScheduleDb();

    try {
      const app = createApp({ db });

      for (const payload of [
        {
          agent_group_id: 'support',
          cron_expr: '* * * *',
          prompt: 'Bad cron',
        },
        {
          agent_group_id: 'support',
          cron_expr: '0 9 * * *',
          prompt: 'Bad config',
          config: ['bad'],
        },
        {
          agent_group_id: 'support',
          cron_expr: '0 9 * * *',
          prompt: 'Bad mode',
          mode: 'invalid',
        },
        {
          agent_group_id: 'support',
          cron_expr: '0 9 * * *',
          prompt: 'Bad enabled string',
          enabled: 'false',
        },
        {
          agent_group_id: 'support',
          cron_expr: '0 9 * * *',
          prompt: 'Bad enabled number',
          enabled: 2,
        },
        {
          agent_group_id: 'support',
          cron_expr: '0 9 * * *',
          prompt: 'Bad enabled object',
          enabled: { on: true },
        },
        {
          agent_group_id: 'support',
          cron_expr: '0 9 * * *',
          prompt: 'Bad enabled array',
          enabled: [1],
        },
      ]) {
        const response = await app.fetch(new Request('http://cove.test/v1/schedules', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }));

        expect(response.status).toBe(400);
        expect(await json<Record<string, unknown>>(response)).toEqual({ error: expect.any(String) });
      }
    } finally {
      db.close();
    }
  });

  it('rejects invalid enabled payloads on update with 400', async () => {
    const db = createScheduleDb();

    try {
      const app = createApp({ db });
      const createResponse = await app.fetch(new Request('http://cove.test/v1/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_group_id: 'support',
          cron_expr: '0 9 * * *',
          prompt: 'Update me',
        }),
      }));
      const created = await json<Record<string, unknown>>(createResponse);

      for (const enabled of ['false', 2, { on: true }, [1]]) {
        const response = await app.fetch(new Request(`http://cove.test/v1/schedules/${created.id as string}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled }),
        }));

        expect(response.status).toBe(400);
        expect(await json<Record<string, unknown>>(response)).toEqual({
          error: 'enabled must be a boolean or 0/1',
        });
      }
    } finally {
      db.close();
    }
  });

  it('returns 404 for an unknown agent_group_id on create with the established client-safe message', async () => {
    const db = createScheduleDb();

    try {
      const app = createApp({ db });
      const response = await app.fetch(new Request('http://cove.test/v1/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_group_id: 'unknown-group',
          cron_expr: '0 9 * * *',
          prompt: 'Run',
        }),
      }));

      expect(response.status).toBe(404);
      expect(await json<Record<string, unknown>>(response)).toEqual({
        error: 'Agent group not found: unknown-group',
      });
    } finally {
      db.close();
    }
  });

  it('supports list, get, update, and delete with normalized enabled and config fields', async () => {
    const db = createScheduleDb();

    try {
      const app = createApp({ db });
      const createResponse = await app.fetch(new Request('http://cove.test/v1/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_group_id: 'support',
          cron_expr: '0 9 * * *',
          prompt: 'Run me',
          config: { notify: true },
          enabled: 0,
        }),
      }));
      const created = await json<Record<string, unknown>>(createResponse);
      const id = created.id as string;

      expect(created.enabled).toBe(false);
      expect(created.config).toEqual({ notify: true });

      const listResponse = await app.fetch(new Request('http://cove.test/v1/schedules'));
      expect(listResponse.status).toBe(200);
      expect(await json<Array<Record<string, unknown>>>(listResponse)).toEqual([created]);

      const getResponse = await app.fetch(new Request(`http://cove.test/v1/schedules/${id}`));
      expect(getResponse.status).toBe(200);
      expect(await json<Record<string, unknown>>(getResponse)).toEqual(created);

      const updateResponse = await app.fetch(new Request(`http://cove.test/v1/schedules/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: '  Updated run me  ',
          enabled: true,
          config: null,
          mode: 'workflow',
        }),
      }));
      expect(updateResponse.status).toBe(200);
      expect(await json<Record<string, unknown>>(updateResponse)).toEqual({
        ...created,
        prompt: 'Updated run me',
        enabled: true,
        config: null,
        mode: 'workflow',
        next_run_at: expect.any(String),
      });

      const deleteResponse = await app.fetch(new Request(`http://cove.test/v1/schedules/${id}`, {
        method: 'DELETE',
      }));
      expect(deleteResponse.status).toBe(204);

      const getAfterDelete = await app.fetch(new Request(`http://cove.test/v1/schedules/${id}`));
      expect(getAfterDelete.status).toBe(404);
      expect(await json<Record<string, unknown>>(getAfterDelete)).toEqual({ error: 'Not Found' });
    } finally {
      db.close();
    }
  });

  it('returns 404 for missing schedule ids across get, update, delete, and run', async () => {
    const db = createScheduleDb();

    try {
      const app = createApp({ db, runAgentPrompt: mock(async () => ({
        content: 'unused',
        sessionId: 'session-unused',
        threadId: 'schedule:missing',
        lastRunAt: '2026-01-15T09:00:00.000Z',
      })) as unknown as RunAgentPromptFn });

      for (const request of [
        new Request('http://cove.test/v1/schedules/missing-id'),
        new Request('http://cove.test/v1/schedules/missing-id', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: 'Updated' }),
        }),
        new Request('http://cove.test/v1/schedules/missing-id', { method: 'DELETE' }),
        new Request('http://cove.test/v1/schedules/missing-id/run', { method: 'POST' }),
      ]) {
        const response = await app.fetch(request);
        expect(response.status).toBe(404);
        expect(await json<Record<string, unknown>>(response)).toEqual({ error: 'Not Found' });
      }
    } finally {
      db.close();
    }
  });

  it('runs agent schedules immediately through the shared runAgentPrompt seam and updates persisted run timestamps', async () => {
    const db = createScheduleDb();

    try {
      const runAgentPrompt = mock(async (options: Parameters<RunAgentPromptFn>[0]) => ({
        content: `Ran ${options.schedule.id}`,
        sessionId: 'session-1',
        threadId: `schedule:${options.schedule.id}`,
        lastRunAt: '2026-01-15T09:00:00.000Z',
      }));
      const app = createApp({
        db,
        runAgentPrompt: runAgentPrompt as unknown as RunAgentPromptFn,
      });

      const createResponse = await app.fetch(new Request('http://cove.test/v1/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_group_id: 'support',
          cron_expr: '0 9 * * *',
          prompt: 'Run now',
        }),
      }));
      const created = await json<Record<string, unknown>>(createResponse);
      const id = created.id as string;

      const runResponse = await app.fetch(new Request(`http://cove.test/v1/schedules/${id}/run`, {
        method: 'POST',
      }));

      expect(runResponse.status).toBe(200);
      expect(runAgentPrompt).toHaveBeenCalledWith({
        schedule: expect.objectContaining({
          id,
          agent_group_id: 'support',
          prompt: 'Run now',
          mode: 'agent',
        }),
      });
      expect(await json<Record<string, unknown>>(runResponse)).toEqual({
        status: 'completed',
        schedule_id: id,
        last_run_at: '2026-01-15T09:00:00.000Z',
        result: {
          content: `Ran ${id}`,
          session_id: 'session-1',
          thread_id: `schedule:${id}`,
        },
      });

      const persistedResponse = await app.fetch(new Request(`http://cove.test/v1/schedules/${id}`));
      expect(persistedResponse.status).toBe(200);
      expect(await json<Record<string, unknown>>(persistedResponse)).toMatchObject({
        id,
        last_run_at: '2026-01-15T09:00:00.000Z',
        next_run_at: '2026-01-16T09:00:00.000Z',
      });
    } finally {
      db.close();
    }
  });

  it('returns a client-safe 500 when immediate agent execution fails', async () => {
    const db = createScheduleDb();

    try {
      const app = createApp({
        db,
        runAgentPrompt: mock(async () => {
          throw new Error('boom');
        }) as unknown as RunAgentPromptFn,
      });

      const createResponse = await app.fetch(new Request('http://cove.test/v1/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_group_id: 'support',
          cron_expr: '0 9 * * *',
          prompt: 'Run now',
        }),
      }));
      const created = await json<Record<string, unknown>>(createResponse);

      const runResponse = await app.fetch(new Request(`http://cove.test/v1/schedules/${created.id as string}/run`, {
        method: 'POST',
      }));

      expect(runResponse.status).toBe(500);
      expect(await json<Record<string, unknown>>(runResponse)).toEqual({
        error: 'Failed to run schedule',
      });

      const persistedResponse = await app.fetch(new Request(`http://cove.test/v1/schedules/${created.id as string}`));
      expect(persistedResponse.status).toBe(200);
      expect(await json<Record<string, unknown>>(persistedResponse)).toMatchObject({
        id: created.id,
        last_run_at: expect.any(String),
        next_run_at: expect.any(String),
      });
    } finally {
      db.close();
    }
  });

  it('runs workflow schedules immediately using config as workflow input', async () => {
    const db = createScheduleDb();

    try {
      const workflowConfig = {
        name: 'daily-summary',
        notify: true,
      };
      const startWorkflow = mock(async (options: {
        schedule: {
          id: string;
          agent_group_id: string;
          prompt: string;
          mode?: string;
        };
        input: Record<string, unknown> | null;
      }) => {
        expect(options.schedule).toMatchObject({
          agent_group_id: 'support',
          prompt: 'Workflow run',
          mode: 'workflow',
        });
        expect(options.input).toEqual(workflowConfig);

        return {
          instanceId: 'workflow-instance-1',
        };
      });
      const app = createApp({ db, startWorkflow });

      const createResponse = await app.fetch(new Request('http://cove.test/v1/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_group_id: 'support',
          cron_expr: '0 9 * * *',
          prompt: 'Workflow run',
          mode: 'workflow',
          config: workflowConfig,
        }),
      }));
      const created = await json<Record<string, unknown>>(createResponse);

      const runResponse = await app.fetch(new Request(`http://cove.test/v1/schedules/${created.id as string}/run`, {
        method: 'POST',
      }));

      expect(runResponse.status).toBe(200);
      expect(startWorkflow).toHaveBeenCalledTimes(1);
      expect(await json<Record<string, unknown>>(runResponse)).toEqual({
        status: 'completed',
        schedule_id: created.id,
        last_run_at: expect.any(String),
        result: {
          mode: 'workflow',
          instance_id: 'workflow-instance-1',
          config: workflowConfig,
        },
      });

      const persistedResponse = await app.fetch(new Request(`http://cove.test/v1/schedules/${created.id as string}`));
      expect(persistedResponse.status).toBe(200);
      expect(await json<Record<string, unknown>>(persistedResponse)).toMatchObject({
        id: created.id,
        last_run_at: expect.any(String),
        next_run_at: expect.any(String),
      });
    } finally {
      db.close();
    }
  });

  it('prefers workflowService.startScheduledWorkflow over the legacy startWorkflow seam for immediate workflow runs', async () => {
    const db = createScheduleDb();

    try {
      const workflowConfig = {
        name: 'daily-summary',
        workflow: 'fallback-name',
        notify: true,
      };
      const legacyStartWorkflow = mock(async () => ({
        instanceId: 'legacy-workflow-instance',
      }));
      const backendStartWorkflow = mock(async (input: { name: string; input?: { input: Record<string, unknown> | null } }) => {
        expect(input.name).toBe('daily-summary');
        expect(input.input?.input).toEqual(workflowConfig);

        return {
          instanceId: 'workflow-instance-2',
        };
      });
      const workflowService = createWorkflowService({
        async listDefinitions() {
          return [];
        },
        async listInstances() {
          return [];
        },
        startWorkflow: backendStartWorkflow,
        async getWorkflow() {
          return null;
        },
        async signalWorkflow() {},
        async terminateWorkflow() {},
        async waitForWorkflow() {
          throw new Error('not used');
        },
        async rollbackWorkflow() {},
      });
      const app = createApp({ db, startWorkflow: legacyStartWorkflow, workflowService });

      const createResponse = await app.fetch(new Request('http://cove.test/v1/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_group_id: 'support',
          cron_expr: '0 9 * * *',
          prompt: 'Workflow run',
          mode: 'workflow',
          config: workflowConfig,
        }),
      }));
      const created = await json<Record<string, unknown>>(createResponse);

      const runResponse = await app.fetch(new Request(`http://cove.test/v1/schedules/${created.id as string}/run`, {
        method: 'POST',
      }));

      expect(runResponse.status).toBe(200);
      expect(backendStartWorkflow).toHaveBeenCalledTimes(1);
      expect(legacyStartWorkflow).not.toHaveBeenCalled();
      expect(await json<Record<string, unknown>>(runResponse)).toEqual({
        status: 'completed',
        schedule_id: created.id,
        last_run_at: expect.any(String),
        result: {
          mode: 'workflow',
          instance_id: 'workflow-instance-2',
          config: workflowConfig,
        },
      });
    } finally {
      db.close();
    }
  });

  it('returns a client-safe 500 when the shared workflowService path rejects a workflow schedule with no name', async () => {
    const db = createScheduleDb();

    try {
      const workflowService = createWorkflowService({
        async listDefinitions() {
          return [];
        },
        async listInstances() {
          return [];
        },
        async startWorkflow() {
          return {
            instanceId: 'workflow-instance-3',
          };
        },
        async getWorkflow() {
          return null;
        },
        async signalWorkflow() {},
        async terminateWorkflow() {},
        async waitForWorkflow() {
          throw new Error('not used');
        },
        async rollbackWorkflow() {},
      });
      const app = createApp({ db, workflowService });

      const createResponse = await app.fetch(new Request('http://cove.test/v1/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_group_id: 'support',
          cron_expr: '0 9 * * *',
          prompt: 'Workflow run',
          mode: 'workflow',
          config: { notify: true },
        }),
      }));
      const created = await json<Record<string, unknown>>(createResponse);

      const runResponse = await app.fetch(new Request(`http://cove.test/v1/schedules/${created.id as string}/run`, {
        method: 'POST',
      }));

      expect(runResponse.status).toBe(500);
      expect(await json<Record<string, unknown>>(runResponse)).toEqual({
        error: 'Failed to run schedule',
      });

      const persistedResponse = await app.fetch(new Request(`http://cove.test/v1/schedules/${created.id as string}`));
      expect(persistedResponse.status).toBe(200);
      expect(await json<Record<string, unknown>>(persistedResponse)).toMatchObject({
        id: created.id,
        last_run_at: expect.any(String),
        next_run_at: expect.any(String),
      });
    } finally {
      db.close();
    }
  });

  it('rolls back a started workflow instance when schedule bookkeeping fails', async () => {
    const db = createScheduleDb();

    try {
      const workflowConfig = {
        name: 'daily-summary',
      };
      let createdId = '';
      const startWorkflow = mock(async () => {
        db.prepare('DELETE FROM schedules WHERE id = ?').run(createdId);
        return {
          instanceId: 'workflow-instance-1',
        };
      });
      const rollbackWorkflow = mock(async () => {});
      const app = createApp({ db, startWorkflow, rollbackWorkflow });
      const createResponse = await app.fetch(new Request('http://cove.test/v1/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_group_id: 'support',
          cron_expr: '0 9 * * *',
          prompt: 'Workflow run',
          mode: 'workflow',
          config: workflowConfig,
        }),
      }));
      const created = await json<Record<string, unknown>>(createResponse);
      createdId = created.id as string;

      const runResponse = await app.fetch(new Request(`http://cove.test/v1/schedules/${createdId}/run`, {
        method: 'POST',
      }));

      expect(runResponse.status).toBe(500);
      expect(await json<Record<string, unknown>>(runResponse)).toEqual({
        error: 'Failed to run schedule',
      });
      expect(startWorkflow).toHaveBeenCalledTimes(1);
      expect(rollbackWorkflow).toHaveBeenCalledWith({
        instanceId: 'workflow-instance-1',
      });
    } finally {
      db.close();
    }
  });

  it('returns a client-safe 500 when workflow rollback also fails after bookkeeping failure', async () => {
    const db = createScheduleDb();

    try {
      let createdId = '';
      const startWorkflow = mock(async () => {
        db.prepare('DELETE FROM schedules WHERE id = ?').run(createdId);
        return {
          instanceId: 'workflow-instance-1',
        };
      });
      const rollbackWorkflow = mock(async () => {
        throw new Error('rollback failed');
      });
      const app = createApp({ db, startWorkflow, rollbackWorkflow });
      const createResponse = await app.fetch(new Request('http://cove.test/v1/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_group_id: 'support',
          cron_expr: '0 9 * * *',
          prompt: 'Workflow run',
          mode: 'workflow',
          config: { name: 'daily-summary' },
        }),
      }));
      const created = await json<Record<string, unknown>>(createResponse);
      createdId = created.id as string;

      const runResponse = await app.fetch(new Request(`http://cove.test/v1/schedules/${createdId}/run`, {
        method: 'POST',
      }));

      expect(runResponse.status).toBe(500);
      expect(await json<Record<string, unknown>>(runResponse)).toEqual({
        error: 'Failed to run schedule',
      });
      expect(rollbackWorkflow).toHaveBeenCalledWith({
        instanceId: 'workflow-instance-1',
      });
    } finally {
      db.close();
    }
  });

  it('runs script schedules immediately and returns inspectable execution results', async () => {
    const db = createScheduleDb();
    const originalRuntime = process.env.COVE_CONTAINER_RUNTIME_BIN;
    process.env.COVE_CONTAINER_RUNTIME_BIN = 'true';

    try {
      const app = createApp({ db });
      const createResponse = await app.fetch(new Request('http://cove.test/v1/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_group_id: 'support',
          cron_expr: '0 9 * * *',
          prompt: 'printf script-result',
          mode: 'script',
        }),
      }));
      const created = await json<Record<string, unknown>>(createResponse);

      const runResponse = await app.fetch(new Request(`http://cove.test/v1/schedules/${created.id as string}/run`, {
        method: 'POST',
      }));

      expect(runResponse.status).toBe(200);
      expect(await json<Record<string, unknown>>(runResponse)).toEqual({
        status: 'completed',
        schedule_id: created.id,
        last_run_at: expect.any(String),
        result: {
          mode: 'script',
          stdout: '',
          stderr: '',
          exit_code: 0,
        },
      });
    } finally {
      if (originalRuntime === undefined) {
        delete process.env.COVE_CONTAINER_RUNTIME_BIN;
      } else {
        process.env.COVE_CONTAINER_RUNTIME_BIN = originalRuntime;
      }
      db.close();
    }
  });

  it('returns a client-safe 500 when immediate script execution fails', async () => {
    const db = createScheduleDb();
    const originalRuntime = process.env.COVE_CONTAINER_RUNTIME_BIN;
    process.env.COVE_CONTAINER_RUNTIME_BIN = 'false';

    try {
      const app = createApp({ db });
      const createResponse = await app.fetch(new Request('http://cove.test/v1/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_group_id: 'support',
          cron_expr: '0 9 * * *',
          prompt: 'printf script-failure',
          mode: 'script',
        }),
      }));
      const created = await json<Record<string, unknown>>(createResponse);

      const runResponse = await app.fetch(new Request(`http://cove.test/v1/schedules/${created.id as string}/run`, {
        method: 'POST',
      }));

      expect(runResponse.status).toBe(500);
      expect(await json<Record<string, unknown>>(runResponse)).toEqual({
        error: 'Failed to run schedule',
      });
    } finally {
      if (originalRuntime === undefined) {
        delete process.env.COVE_CONTAINER_RUNTIME_BIN;
      } else {
        process.env.COVE_CONTAINER_RUNTIME_BIN = originalRuntime;
      }
      db.close();
    }
  });

  it('runs notification schedules immediately with a completed status payload', async () => {
    const db = createScheduleDb();

    try {
      const app = createApp({ db });
      const createResponse = await app.fetch(new Request('http://cove.test/v1/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_group_id: 'support',
          cron_expr: '0 9 * * *',
          prompt: 'Notify team',
          mode: 'notification',
        }),
      }));
      const created = await json<Record<string, unknown>>(createResponse);

      const runResponse = await app.fetch(new Request(`http://cove.test/v1/schedules/${created.id as string}/run`, {
        method: 'POST',
      }));

      expect(runResponse.status).toBe(200);
      expect(await json<Record<string, unknown>>(runResponse)).toEqual({
        status: 'completed',
        schedule_id: created.id,
        last_run_at: expect.any(String),
        result: {
          mode: 'notification',
          logged: true,
        },
      });
    } finally {
      db.close();
    }
  });

  it('runs hybrid schedules immediately through the shared agent seam and marks them notified', async () => {
    const db = createScheduleDb();

    try {
      const runAgentPrompt = mock(async (options: Parameters<RunAgentPromptFn>[0]) => ({
        content: `Hybrid ${options.schedule.id}`,
        sessionId: 'session-1',
        threadId: `schedule:${options.schedule.id}`,
        lastRunAt: '2026-01-15T09:00:00.000Z',
      }));
      const app = createApp({
        db,
        runAgentPrompt: runAgentPrompt as unknown as RunAgentPromptFn,
      });
      const createResponse = await app.fetch(new Request('http://cove.test/v1/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_group_id: 'support',
          cron_expr: '0 9 * * *',
          prompt: 'Hybrid run',
          mode: 'hybrid',
        }),
      }));
      const created = await json<Record<string, unknown>>(createResponse);

      const runResponse = await app.fetch(new Request(`http://cove.test/v1/schedules/${created.id as string}/run`, {
        method: 'POST',
      }));

      expect(runResponse.status).toBe(200);
      expect(runAgentPrompt).toHaveBeenCalledTimes(1);
      expect(await json<Record<string, unknown>>(runResponse)).toEqual({
        status: 'completed',
        schedule_id: created.id,
        last_run_at: '2026-01-15T09:00:00.000Z',
        result: {
          content: `Hybrid ${created.id}`,
          session_id: 'session-1',
          thread_id: `schedule:${created.id}`,
          notified: true,
        },
      });
    } finally {
      db.close();
    }
  });

  it('calls live scheduler sync hooks on create, update, and delete', async () => {
    const db = createScheduleDb();

    try {
      const sync = {
        upsertSchedule: mock(() => {}),
        removeSchedule: mock(() => {}),
      };
      setScheduleRuntimeSync(sync);
      const app = createApp({
        db,
        runAgentPrompt: mock(async () => ({
          content: 'unused',
          sessionId: 'unused',
          threadId: 'unused',
          lastRunAt: '2026-01-15T09:00:00.000Z',
        })) as unknown as RunAgentPromptFn,
      });

      const createResponse = await app.fetch(new Request('http://cove.test/v1/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_group_id: 'support',
          cron_expr: '0 9 * * *',
          prompt: 'Sync me',
        }),
      }));
      const created = await json<Record<string, unknown>>(createResponse);
      const id = created.id as string;

      expect(sync.upsertSchedule).toHaveBeenCalledWith(id);

      const updateResponse = await app.fetch(new Request(`http://cove.test/v1/schedules/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Still synced' }),
      }));
      expect(updateResponse.status).toBe(200);
      expect(sync.upsertSchedule).toHaveBeenCalledWith(id);

      const deleteResponse = await app.fetch(new Request(`http://cove.test/v1/schedules/${id}`, {
        method: 'DELETE',
      }));
      expect(deleteResponse.status).toBe(204);
      expect(sync.removeSchedule).toHaveBeenCalledWith(id);
    } finally {
      db.close();
    }
  });

  it('returns the created schedule when create persists but live scheduler sync fails', async () => {
    const db = createScheduleDb();

    try {
      setScheduleRuntimeSync({
        upsertSchedule: mock(() => {
          throw new Error('sync failed');
        }),
        removeSchedule: mock(() => {}),
      });
      const app = createApp({ db });

      const response = await app.fetch(new Request('http://cove.test/v1/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_group_id: 'support',
          cron_expr: '0 9 * * *',
          prompt: 'Sync me',
        }),
      }));

      expect(response.status).toBe(201);
      expect(await json<Record<string, unknown>>(response)).toMatchObject({
        id: expect.any(String),
        prompt: 'Sync me',
      });
      expect(await json<Array<Record<string, unknown>>>(await app.fetch(new Request('http://cove.test/v1/schedules')))).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('returns the updated schedule when update persists but live scheduler sync fails', async () => {
    const db = createScheduleDb();

    try {
      const app = createApp({ db });
      const createResponse = await app.fetch(new Request('http://cove.test/v1/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_group_id: 'support',
          cron_expr: '0 9 * * *',
          prompt: 'Sync me',
        }),
      }));
      const created = await json<Record<string, unknown>>(createResponse);

      setScheduleRuntimeSync({
        upsertSchedule: mock(() => {
          throw new Error('sync failed');
        }),
        removeSchedule: mock(() => {}),
      });

      const response = await app.fetch(new Request(`http://cove.test/v1/schedules/${created.id as string}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Still synced' }),
      }));

      expect(response.status).toBe(200);
      expect(await json<Record<string, unknown>>(response)).toMatchObject({
        id: created.id,
        prompt: 'Still synced',
      });
      expect(await json<Record<string, unknown>>(await app.fetch(new Request(`http://cove.test/v1/schedules/${created.id as string}`)))).toMatchObject({
        id: created.id,
        prompt: 'Still synced',
      });
    } finally {
      db.close();
    }
  });

  it('returns 204 when delete persists but live scheduler sync fails', async () => {
    const db = createScheduleDb();

    try {
      const app = createApp({ db });
      const createResponse = await app.fetch(new Request('http://cove.test/v1/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_group_id: 'support',
          cron_expr: '0 9 * * *',
          prompt: 'Sync me',
        }),
      }));
      const created = await json<Record<string, unknown>>(createResponse);

      setScheduleRuntimeSync({
        upsertSchedule: mock(() => {}),
        removeSchedule: mock(() => {
          throw new Error('sync failed');
        }),
      });

      const response = await app.fetch(new Request(`http://cove.test/v1/schedules/${created.id as string}`, {
        method: 'DELETE',
      }));

      expect(response.status).toBe(204);
      expect((await app.fetch(new Request(`http://cove.test/v1/schedules/${created.id as string}`))).status).toBe(404);
    } finally {
      db.close();
    }
  });
});
