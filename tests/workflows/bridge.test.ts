import { describe, expect, it } from 'bun:test';

import type { ScheduleRecord } from '../../src/jobs/schedules.ts';
import { createWorkflowService } from '../../src/workflows/bridge.ts';

type WorkflowServiceBackend = Parameters<typeof createWorkflowService>[0];
type BackendStartWorkflowInput = Parameters<WorkflowServiceBackend['startWorkflow']>[0];
type BackendListInstancesFilter = Parameters<WorkflowServiceBackend['listInstances']>[0];
type BackendListInstancesResult = Awaited<ReturnType<WorkflowServiceBackend['listInstances']>>;
type BackendSignalInput = Parameters<WorkflowServiceBackend['signalWorkflow']>[0];
type BackendWaitWorkflowResult = Awaited<ReturnType<WorkflowServiceBackend['waitForWorkflow']>>;

function buildSchedule(config: Record<string, unknown> | null): ScheduleRecord {
  return {
    id: 'schedule-1',
    agent_group_id: 'support',
    cron_expr: '0 9 * * *',
    prompt: 'Run daily summary workflow',
    mode: 'workflow',
    config,
    enabled: true,
    last_run_at: null,
    next_run_at: '2026-01-15T09:00:00.000Z',
    created_at: '2026-01-15T08:00:00.000Z',
  };
}

describe('workflow bridge contract', () => {
  it('wraps direct workflow starts in the internal cove envelope and forwards optional id and context', async () => {
    let startedWith: BackendStartWorkflowInput | null = null;
    const service = createWorkflowService({
      async listDefinitions() {
        return [];
      },
      async listInstances() {
        return [];
      },
      async startWorkflow(input) {
        startedWith = input;
        return { instanceId: 'instance-direct' };
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

    const started = await service.startWorkflow({
      id: 'instance-direct',
      name: 'daily-summary',
      input: { topic: 'sales' },
      context: {
        trigger: 'api',
        agent_group_id: 'default',
        thread_id: 'workflow:instance-direct',
      },
    });

    expect(started).toEqual({ instanceId: 'instance-direct' });
    expect(startedWith!).toEqual({
      id: 'instance-direct',
      name: 'daily-summary',
      input: {
        __cove: {
          context: {
            trigger: 'api',
            agent_group_id: 'default',
            thread_id: 'workflow:instance-direct',
          },
        },
        input: {
          topic: 'sales',
        },
      },
    });
  });

  it('uses schedule config.name as the canonical workflow name', async () => {
    let startedWith: BackendStartWorkflowInput | null = null;
    const service = createWorkflowService({
      async listDefinitions() {
        return [];
      },
      async listInstances() {
        return [];
      },
      async startWorkflow(input) {
        startedWith = input;
        return { instanceId: 'instance-1' };
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

    const started = await service.startScheduledWorkflow({
      schedule: buildSchedule({ name: 'daily-summary', workflow: 'fallback-name' }),
      input: { run: 'today' },
    });

    expect(started).toEqual({ instanceId: 'instance-1' });
    expect(startedWith!).toEqual({
      name: 'daily-summary',
      input: {
        __cove: {
          context: {
            trigger: 'schedule',
            schedule_id: 'schedule-1',
            agent_group_id: 'support',
            thread_id: 'schedule:schedule-1',
          },
        },
        input: {
          run: 'today',
        },
      },
    });
  });

  it('falls back to schedule config.workflow when config.name is missing', async () => {
    let startedWith: BackendStartWorkflowInput | null = null;
    const service = createWorkflowService({
      async listDefinitions() {
        return [];
      },
      async listInstances() {
        return [];
      },
      async startWorkflow(input) {
        startedWith = input;
        return { instanceId: 'instance-2' };
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

    await service.startScheduledWorkflow({
      schedule: buildSchedule({ workflow: 'fallback-name' }),
      input: null,
    });

    expect(startedWith!).toEqual({
      name: 'fallback-name',
      input: {
        __cove: {
          context: {
            trigger: 'schedule',
            schedule_id: 'schedule-1',
            agent_group_id: 'support',
            thread_id: 'schedule:schedule-1',
          },
        },
        input: null,
      },
    });
  });

  it('fails scheduled workflow starts when neither config.name nor config.workflow is present', async () => {
    const service = createWorkflowService({
      async listDefinitions() {
        return [];
      },
      async listInstances() {
        return [];
      },
      async startWorkflow() {
        throw new Error('not used');
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

    await expect(
      service.startScheduledWorkflow({
        schedule: buildSchedule({}),
        input: { run: 'today' },
      }),
    ).rejects.toThrow('Workflow schedule config.name or config.workflow is required');
  });

  it('returns stable workflow definition and instance shapes and forwards list filters', async () => {
    let receivedFilter: BackendListInstancesFilter | null = null;
    const service = createWorkflowService({
      async listDefinitions() {
        const definition = {
          name: 'daily-summary',
          description: 'Daily summary workflow',
          internal: 'ignore-me',
        };

        return [
          definition,
        ];
      },
      async listInstances(filter) {
        receivedFilter = filter ?? null;
        return [
          {
            instanceId: 'instance-1',
            name: 'daily-summary',
            status: 'Running',
            customStatus: null,
            createdAt: '2026-01-15T08:00:00.000Z',
            updatedAt: '2026-01-15T08:01:00.000Z',
            input: {
              __cove: {
                context: {
                  trigger: 'schedule',
                  schedule_id: 'schedule-1',
                },
              },
              input: {
                topic: 'sales',
              },
            },
            output: null,
            error: null,
            raw: {
              scheduleId: 'schedule-1',
            },
          },
        ];
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
        throw new Error('not used');
      },
      async rollbackWorkflow() {},
    });

    expect(await service.listDefinitions()).toEqual([
      {
        name: 'daily-summary',
        description: 'Daily summary workflow',
      },
    ]);

    expect(await service.listInstances({ name: 'daily-summary', status: 'Running' })).toEqual([
      {
        instanceId: 'instance-1',
        name: 'daily-summary',
        status: 'Running',
        customStatus: null,
        createdAt: '2026-01-15T08:00:00.000Z',
        updatedAt: '2026-01-15T08:01:00.000Z',
        input: {
          topic: 'sales',
        },
        output: null,
        error: null,
      },
    ]);
    expect(receivedFilter!).toEqual({ name: 'daily-summary', status: 'Running' });
  });

  it('preserves legitimate non-envelope __cove payload fields', async () => {
    const service = createWorkflowService({
      async listDefinitions() {
        return [];
      },
      async listInstances() {
        return [
          {
            instanceId: 'instance-1',
            name: 'daily-summary',
            status: 'Running',
            customStatus: null,
            createdAt: '2026-01-15T08:00:00.000Z',
            updatedAt: '2026-01-15T08:01:00.000Z',
            input: {
              __cove: {
                note: 'keep-me',
              },
              topic: 'sales',
            },
            output: null,
            error: null,
          },
        ];
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
        throw new Error('not used');
      },
      async rollbackWorkflow() {},
    });

    expect(await service.listInstances({ name: 'daily-summary', status: 'Running' })).toEqual([
      {
        instanceId: 'instance-1',
        name: 'daily-summary',
        status: 'Running',
        customStatus: null,
        createdAt: '2026-01-15T08:00:00.000Z',
        updatedAt: '2026-01-15T08:01:00.000Z',
        input: {
          __cove: {
            note: 'keep-me',
          },
          topic: 'sales',
        },
        output: null,
        error: null,
      },
    ]);
  });

  it('fails fast when backend workflow data is missing required stable identifiers', async () => {
    const service = createWorkflowService({
      async listDefinitions() {
        return [];
      },
      async listInstances() {
        const instance: BackendListInstancesResult[number] = {
          name: 'daily-summary',
          status: 'Running',
          customStatus: null,
          updatedAt: '2026-01-15T08:01:00.000Z',
          input: null,
          output: null,
          error: null,
        };

        return [
          instance,
        ];
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
        throw new Error('not used');
      },
      async rollbackWorkflow() {},
    });

    await expect(service.listInstances()).rejects.toThrow('Workflow instance is missing required field: instanceId');
  });

  it('forwards the stable signal contract shape', async () => {
    let receivedSignal: BackendSignalInput | null = null;
    const service = createWorkflowService({
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
      async signalWorkflow(input) {
        receivedSignal = input;
      },
      async terminateWorkflow() {},
      async waitForWorkflow() {
        throw new Error('not used');
      },
      async rollbackWorkflow() {},
    });

    await service.signalWorkflow({
      instanceId: 'instance-1',
      eventName: 'refresh',
      data: { urgent: true },
    });

    expect(receivedSignal!).toEqual({
      instanceId: 'instance-1',
      eventName: 'refresh',
      data: { urgent: true },
    });
  });

  it('exposes signal, terminate, and wait methods and strips raw runtime internals from terminal wait results', async () => {
    const service = createWorkflowService({
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
        const workflow: BackendWaitWorkflowResult = {
          instanceId: 'instance-1',
          name: 'daily-summary',
          status: 'Completed',
          customStatus: null,
          createdAt: '2026-01-15T08:00:00.000Z',
          updatedAt: '2026-01-15T08:03:00.000Z',
          input: {
            __cove: {
              context: {
                trigger: 'schedule',
                schedule_id: 'schedule-1',
              },
            },
            input: {
              topic: 'sales',
            },
          },
          output: {
            reportId: 'report-1',
          },
          error: null,
          raw: {
            history: ['secret'],
          },
        };

        return workflow;
      },
      async rollbackWorkflow() {},
    });

    expect(typeof service.signalWorkflow).toBe('function');
    expect(typeof service.terminateWorkflow).toBe('function');
    expect(typeof service.waitForWorkflow).toBe('function');

    expect(await service.waitForWorkflow({ instanceId: 'instance-1' })).toEqual({
      instanceId: 'instance-1',
      name: 'daily-summary',
      status: 'Completed',
      customStatus: null,
      createdAt: '2026-01-15T08:00:00.000Z',
      updatedAt: '2026-01-15T08:03:00.000Z',
      input: {
        topic: 'sales',
      },
      output: {
        reportId: 'report-1',
      },
      error: null,
    });
  });

  it('fails fast when terminal wait data is missing required timestamps', async () => {
    const service = createWorkflowService({
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
        const workflow: BackendWaitWorkflowResult = {
          instanceId: 'instance-1',
          name: 'daily-summary',
          status: 'Completed',
          customStatus: null,
          input: null,
          output: null,
          error: null,
        };

        return workflow;
      },
      async rollbackWorkflow() {},
    });

    await expect(service.waitForWorkflow({ instanceId: 'instance-1' })).rejects.toThrow(
      'Workflow instance is missing required field: createdAt',
    );
  });
});
