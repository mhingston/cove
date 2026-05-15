import { afterEach, describe, expect, it } from 'bun:test';

import { executeSchedule } from '../../src/jobs/execute-schedule.ts';
import type { ScheduleRecord } from '../../src/jobs/schedules.ts';

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
  it('starts workflow schedules using config as workflow input', async () => {
    const schedule = createSchedule({
      mode: 'workflow',
      config: {
        workflow: 'daily-summary',
        notify: true,
      },
    });
    const startWorkflow = async ({ schedule: startedSchedule, input }: {
      schedule: ScheduleRecord;
      input: Record<string, unknown> | null;
    }) => {
      expect(startedSchedule).toBe(schedule);
      expect(input).toEqual(schedule.config);

      return {
        instanceId: 'workflow-instance-1',
      };
    };

    await expect(executeSchedule({
      schedule,
      startWorkflow,
    })).resolves.toEqual({
      mode: 'workflow',
      instanceId: 'workflow-instance-1',
    });
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
