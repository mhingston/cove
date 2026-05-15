import { afterEach, describe, expect, it } from 'bun:test';

import { executeSchedule } from '../../src/jobs/execute-schedule.ts';
import type { ScheduleRecord } from '../../src/jobs/schedules.ts';
import { createWorkflowService } from '../../src/workflows/bridge.ts';

type WorkflowServiceBackend = Parameters<typeof createWorkflowService>[0];
type BackendStartWorkflowInput = Parameters<WorkflowServiceBackend['startWorkflow']>[0];

function createSchedule(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    id: 'schedule-1',
    agent_group_id: 'support',
    cron_expr: '0 9 * * *',
    prompt: 'printf ok',
    mode: 'script',
    config: null,
    enabled: true,
    last_run_at: null,
    next_run_at: '2026-01-15T09:00:00.000Z',
    created_at: '2026-01-15T08:00:00.000Z',
    ...overrides,
  };
}

const originalRuntime = process.env.COVE_CONTAINER_RUNTIME_BIN;

afterEach(() => {
  if (originalRuntime === undefined) {
    delete process.env.COVE_CONTAINER_RUNTIME_BIN;
  } else {
    process.env.COVE_CONTAINER_RUNTIME_BIN = originalRuntime;
  }
});

describe('executeSchedule', () => {
  it('starts workflow schedules through workflowService.startScheduledWorkflow using config.name as the canonical name', async () => {
    const schedule = createSchedule({
      mode: 'workflow',
      config: {
        name: 'daily-summary',
        workflow: 'fallback-name',
        notify: true,
      },
    });
    let startedWith: BackendStartWorkflowInput | null = null;
    let legacyStartWorkflowCalled = false;
    const workflowService = createWorkflowService({
      async listDefinitions() {
        return [];
      },
      async listInstances() {
        return [];
      },
      async startWorkflow(input) {
        startedWith = input;

        return {
          instanceId: 'workflow-instance-1',
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
    const startWorkflow = async () => {
      legacyStartWorkflowCalled = true;

      return {
        instanceId: 'legacy-workflow-instance',
      };
    };

    const result = await executeSchedule({
      schedule,
      startWorkflow,
      workflowService,
    });

    expect(result).toMatchObject({
      mode: 'workflow',
      instanceId: 'workflow-instance-1',
    });
    expect(typeof ('rollbackWorkflow' in result ? result.rollbackWorkflow : undefined)).toBe('function');
    expect(legacyStartWorkflowCalled).toBe(false);
    expect(startedWith).toMatchObject({
      name: 'daily-summary',
      input: {
        __cove: {
          context: {
            trigger: 'schedule',
            schedule_id: schedule.id,
            agent_group_id: schedule.agent_group_id,
            thread_id: `schedule:${schedule.id}`,
          },
        },
        input: schedule.config,
      },
    });
  });

  it('starts workflow schedules through workflowService.startScheduledWorkflow using config.workflow as a fallback alias', async () => {
    const schedule = createSchedule({
      mode: 'workflow',
      config: {
        workflow: 'daily-summary',
        notify: true,
      },
    });
    let startedWith: BackendStartWorkflowInput | null = null;
    const workflowService = createWorkflowService({
      async listDefinitions() {
        return [];
      },
      async listInstances() {
        return [];
      },
      async startWorkflow(input) {
        startedWith = input;

        return {
          instanceId: 'workflow-instance-2',
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

    const result = await executeSchedule({
      schedule,
      workflowService,
    });

    expect(result).toMatchObject({
      mode: 'workflow',
      instanceId: 'workflow-instance-2',
    });
    expect(typeof ('rollbackWorkflow' in result ? result.rollbackWorkflow : undefined)).toBe('function');
    expect(startedWith).toMatchObject({
      name: 'daily-summary',
      input: {
        input: schedule.config,
      },
    });
  });

  it('surfaces the shared missing-name validation from workflowService.startScheduledWorkflow', async () => {
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

    await expect(executeSchedule({
      schedule: createSchedule({
        mode: 'workflow',
        config: {
          notify: true,
        },
      }),
      workflowService,
    })).rejects.toThrow('Workflow schedule config.name or config.workflow is required');
  });

  it('exposes rollback via workflowService when no legacy rollback seam is provided', async () => {
    const rollbackCalls: Array<{ instanceId: string }> = [];
    const workflowService = createWorkflowService({
      async listDefinitions() {
        return [];
      },
      async listInstances() {
        return [];
      },
      async startWorkflow() {
        return {
          instanceId: 'workflow-instance-4',
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
      async rollbackWorkflow(input) {
        rollbackCalls.push(input);
      },
    });

    const result = await executeSchedule({
      schedule: createSchedule({
        mode: 'workflow',
        config: {
          name: 'daily-summary',
        },
      }),
      workflowService,
    });

    expect(result).toMatchObject({
      mode: 'workflow',
      instanceId: 'workflow-instance-4',
    });

    if (!('instanceId' in result)) {
      throw new Error('Expected workflow result');
    }

    const rollback = 'rollbackWorkflow' in result ? result.rollbackWorkflow : undefined;
    if (rollback == null) {
      throw new Error('Expected workflow rollback handler');
    }

    expect(typeof rollback).toBe('function');
    await rollback({ instanceId: result.instanceId });
    expect(rollbackCalls).toEqual([{ instanceId: 'workflow-instance-4' }]);
  });

  it('throws when a workflow schedule is missing the workflow starter dependency', async () => {
    await expect(executeSchedule({
      schedule: createSchedule({
        mode: 'workflow',
        config: {
          workflow: 'daily-summary',
        },
      }),
    })).rejects.toThrow('startWorkflow is required for workflow schedules');
  });

  it('throws when a script schedule exits non-zero', async () => {
    process.env.COVE_CONTAINER_RUNTIME_BIN = 'false';

    await expect(executeSchedule({
      schedule: createSchedule({
        prompt: 'printf broken',
      }),
    })).rejects.toThrow('Script schedule failed');
  });
});
