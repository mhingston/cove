import { afterEach, describe, expect, it, mock } from 'bun:test';

import { createApp } from '../../src/api/app.ts';
import { migrate } from '../../src/db/migrate.ts';
import type { WorkflowDefinition, WorkflowInstance, WorkflowService, WorkflowStatus } from '../../src/workflows/bridge.ts';
import { Database } from 'bun:sqlite';

function createDb(): Database {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

function buildDefinition(name: string): WorkflowDefinition {
  return {
    name,
    description: `${name} description`,
  };
}

function buildInstance(overrides: Partial<WorkflowInstance> = {}): WorkflowInstance {
  return {
    instanceId: overrides.instanceId ?? 'instance-1',
    name: overrides.name ?? 'daily-summary',
    status: overrides.status ?? 'Running',
    output: overrides.output ?? null,
    customStatus: overrides.customStatus ?? null,
    createdAt: overrides.createdAt ?? '2026-01-15T08:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-01-15T08:01:00.000Z',
    input: overrides.input ?? { topic: 'sales' },
    error: overrides.error ?? null,
  };
}

function createWorkflowServiceDouble(overrides: Partial<WorkflowService> = {}): WorkflowService {
  return {
    async listDefinitions() {
      return [];
    },
    async listInstances() {
      return [];
    },
    async startWorkflow() {
      return { instanceId: 'instance-1' };
    },
    async getWorkflow() {
      return null;
    },
    async signalWorkflow() {},
    async terminateWorkflow() {},
    async waitForWorkflow() {
      return buildInstance({ status: 'Completed' });
    },
    async startScheduledWorkflow() {
      return { instanceId: 'unused' };
    },
    async rollbackWorkflow() {},
    ...overrides,
  };
}

afterEach(() => {
  mock.restore();
});

describe('workflows api', () => {
  it('lists workflow definitions and instances with an empty result shape', async () => {
    const db = createDb();

    try {
      const listDefinitions = mock(async () => [] as WorkflowDefinition[]);
      const listInstances = mock(async () => [] as WorkflowInstance[]);
      const app = createApp({
        db,
        workflowService: createWorkflowServiceDouble({ listDefinitions, listInstances }),
      });

      const response = await app.fetch(new Request('http://cove.test/v1/workflows'));

      expect(response.status).toBe(200);
      expect(await json<Record<string, unknown>>(response)).toEqual({
        definitions: [],
        instances: [],
      });
      expect(listDefinitions).toHaveBeenCalledWith({});
      expect(listInstances).toHaveBeenCalledWith({});
    } finally {
      db.close();
    }
  });

  it('filters workflow definitions by name and instances by name and status', async () => {
    const db = createDb();

    try {
      const listDefinitions = mock(async (options?: { name?: string }) => [buildDefinition(options?.name ?? 'daily-summary')]);
      const listInstances = mock(async (options?: { name?: string; status?: WorkflowStatus }) => [
        buildInstance({ name: options?.name ?? 'daily-summary', status: options?.status ?? 'Running' }),
      ]);
      const app = createApp({
        db,
        workflowService: createWorkflowServiceDouble({ listDefinitions, listInstances }),
      });

      const response = await app.fetch(new Request('http://cove.test/v1/workflows?name=daily-summary&status=Running'));

      expect(response.status).toBe(200);
      expect(await json<Record<string, unknown>>(response)).toEqual({
        definitions: [buildDefinition('daily-summary')],
        instances: [buildInstance({ name: 'daily-summary', status: 'Running' })],
      });
      expect(listDefinitions).toHaveBeenCalledWith({ name: 'daily-summary' });
      expect(listInstances).toHaveBeenCalledWith({ name: 'daily-summary', status: 'Running' });
    } finally {
      db.close();
    }
  });

  it('creates workflows and applies default agent_group_id and thread_id', async () => {
    const db = createDb();

    try {
      const startWorkflow = mock(async (input: { id?: string }) => ({ instanceId: input.id ?? 'instance-create' }));
      const app = createApp({
        db,
        workflowService: createWorkflowServiceDouble({ startWorkflow }),
      });

      const response = await app.fetch(new Request('http://cove.test/v1/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'daily-summary',
          input: { topic: 'sales' },
        }),
      }));

      expect(response.status).toBe(201);
      const body = await json<Record<string, unknown>>(response);

      expect(body).toEqual({ instanceId: expect.any(String) });
      expect(startWorkflow).toHaveBeenCalledWith({
        id: body.instanceId,
        name: 'daily-summary',
        input: { topic: 'sales' },
        context: {
          trigger: 'api',
          agent_group_id: 'default',
          thread_id: `workflow:${body.instanceId as string}`,
        },
      });
    } finally {
      db.close();
    }
  });

  it('prefers session_id over thread_id when both are supplied on create', async () => {
    const db = createDb();

    try {
      const startWorkflow = mock(async () => ({ instanceId: 'instance-session' }));
      const app = createApp({
        db,
        workflowService: createWorkflowServiceDouble({ startWorkflow }),
      });

      const response = await app.fetch(new Request('http://cove.test/v1/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'caller-id',
          name: 'daily-summary',
          input: { topic: 'sales' },
          agent_group_id: 'support',
          thread_id: 'thread-123',
          session_id: 'session-123',
        }),
      }));

      expect(response.status).toBe(201);
      expect(await json<Record<string, unknown>>(response)).toEqual({ instanceId: 'instance-session' });
      expect(startWorkflow).toHaveBeenCalledWith({
        id: 'caller-id',
        name: 'daily-summary',
        input: { topic: 'sales' },
        context: {
          trigger: 'api',
          agent_group_id: 'support',
          session_id: 'session-123',
        },
      });
    } finally {
      db.close();
    }
  });

  it('rejects invalid JSON and invalid create bodies with 400', async () => {
    const db = createDb();

    try {
      const app = createApp({
        db,
        workflowService: createWorkflowServiceDouble(),
      });

      const invalidJsonResponse = await app.fetch(new Request('http://cove.test/v1/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      }));

      expect(invalidJsonResponse.status).toBe(400);
      expect(await json<Record<string, unknown>>(invalidJsonResponse)).toEqual({ error: 'Invalid JSON body' });

      for (const payload of [
        null,
        [],
        {},
        { name: 123, input: {} },
        { name: 'daily-summary' },
        { name: 'daily-summary', input: [] },
        { name: 'daily-summary', input: null },
        { name: 'daily-summary', input: {}, id: 123 },
        { name: 'daily-summary', input: {}, agent_group_id: 123 },
        { name: 'daily-summary', input: {}, thread_id: 123 },
        { name: 'daily-summary', input: {}, session_id: 123 },
      ]) {
        const response = await app.fetch(new Request('http://cove.test/v1/workflows', {
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

  it('fetches a workflow instance by id', async () => {
    const db = createDb();

    try {
      const getWorkflow = mock(async () => buildInstance({ instanceId: 'instance-1', status: 'Completed' }));
      const app = createApp({
        db,
        workflowService: createWorkflowServiceDouble({ getWorkflow }),
      });

      const response = await app.fetch(new Request('http://cove.test/v1/workflows/instance-1'));

      expect(response.status).toBe(200);
      expect(await json<Record<string, unknown>>(response)).toEqual({
        instanceId: 'instance-1',
        name: 'daily-summary',
        status: 'Completed',
        output: null,
        customStatus: null,
        createdAt: '2026-01-15T08:00:00.000Z',
        updatedAt: '2026-01-15T08:01:00.000Z',
      });
      expect(getWorkflow).toHaveBeenCalledWith({ instanceId: 'instance-1' });
    } finally {
      db.close();
    }
  });

  it('signals and terminates workflows through the public API', async () => {
    const db = createDb();

    try {
      const signalWorkflow = mock(async () => {});
      const terminateWorkflow = mock(async () => {});
      const app = createApp({
        db,
        workflowService: createWorkflowServiceDouble({ signalWorkflow, terminateWorkflow }),
      });

      const signalResponse = await app.fetch(new Request('http://cove.test/v1/workflows/instance-1/signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventName: 'resume',
          data: { approved: true },
        }),
      }));
      const terminateResponse = await app.fetch(new Request('http://cove.test/v1/workflows/instance-1/terminate', {
        method: 'POST',
      }));

      expect(signalResponse.status).toBe(200);
      expect(await json<Record<string, unknown>>(signalResponse)).toEqual({ signalled: true });
      expect(signalWorkflow).toHaveBeenCalledWith({
        instanceId: 'instance-1',
        eventName: 'resume',
        data: { approved: true },
      });

      expect(terminateResponse.status).toBe(200);
      expect(await json<Record<string, unknown>>(terminateResponse)).toEqual({ terminated: true });
      expect(terminateWorkflow).toHaveBeenCalledWith({ instanceId: 'instance-1' });
    } finally {
      db.close();
    }
  });

  it('rejects signal requests when data is missing or invalid', async () => {
    const db = createDb();

    try {
      const signalWorkflow = mock(async () => {});
      const app = createApp({
        db,
        workflowService: createWorkflowServiceDouble({ signalWorkflow }),
      });

      for (const payload of [
        { eventName: 'resume' },
        { eventName: 'resume', data: null },
        { eventName: 'resume', data: [] },
      ]) {
        const response = await app.fetch(new Request('http://cove.test/v1/workflows/instance-1/signal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }));

        expect(response.status).toBe(400);
        expect(await json<Record<string, unknown>>(response)).toEqual({ error: expect.any(String) });
      }

      expect(signalWorkflow).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('maps unknown definitions or instances to 404', async () => {
    const db = createDb();

    try {
      const app = createApp({
        db,
        workflowService: createWorkflowServiceDouble({
          startWorkflow: async () => {
            throw new Error('Workflow definition not found: missing-workflow');
          },
          getWorkflow: async () => {
            throw new Error('Workflow instance not found: missing-instance');
          },
        }),
      });

      const createResponse = await app.fetch(new Request('http://cove.test/v1/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'missing-workflow',
          input: {},
        }),
      }));
      const getResponse = await app.fetch(new Request('http://cove.test/v1/workflows/missing-instance'));

      expect(createResponse.status).toBe(404);
      expect(await json<Record<string, unknown>>(createResponse)).toEqual({ error: 'Not Found' });
      expect(getResponse.status).toBe(404);
      expect(await json<Record<string, unknown>>(getResponse)).toEqual({ error: 'Not Found' });
    } finally {
      db.close();
    }
  });

  it('maps id conflicts and lifecycle conflicts to 409', async () => {
    const db = createDb();

    try {
      const app = createApp({
        db,
        workflowService: createWorkflowServiceDouble({
          startWorkflow: async () => {
            throw new Error('Workflow instance already exists: caller-id');
          },
          signalWorkflow: async () => {
            throw new Error('Workflow instance is not in a signalable state: instance-1');
          },
        }),
      });

      const createResponse = await app.fetch(new Request('http://cove.test/v1/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'caller-id',
          name: 'daily-summary',
          input: {},
        }),
      }));
      const signalResponse = await app.fetch(new Request('http://cove.test/v1/workflows/instance-1/signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventName: 'resume', data: {} }),
      }));

      expect(createResponse.status).toBe(409);
      expect(await json<Record<string, unknown>>(createResponse)).toEqual({ error: expect.any(String) });
      expect(signalResponse.status).toBe(409);
      expect(await json<Record<string, unknown>>(signalResponse)).toEqual({ error: expect.any(String) });
    } finally {
      db.close();
    }
  });

  it('maps unavailable workflow runtime errors to 503', async () => {
    const db = createDb();

    try {
      const app = createApp({
        db,
        workflowService: createWorkflowServiceDouble({
          listInstances: async () => {
            throw new Error('Workflow runtime is not started');
          },
        }),
      });

      const response = await app.fetch(new Request('http://cove.test/v1/workflows'));

      expect(response.status).toBe(503);
      expect(await json<Record<string, unknown>>(response)).toEqual({ error: expect.any(String) });
    } finally {
      db.close();
    }
  });
});
