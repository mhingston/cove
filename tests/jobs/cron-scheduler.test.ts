import { afterEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';

import { migrate } from '../../src/db/migrate.ts';
import {
  CronScheduler,
  createScheduler,
  registerRunAgentPrompt,
  removeSchedule,
  setScheduleRuntimeSync,
  upsertSchedule,
} from '../../src/jobs/cron-scheduler.ts';
import { createSchedule, getSchedule } from '../../src/jobs/schedules.ts';

let db: Database | undefined;

function requireDb(): Database {
  if (db == null) {
    throw new Error('Test database not initialized');
  }

  return db;
}

function insertAgentGroup(id: string): void {
  requireDb().prepare(
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
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
  );
}

function setNextRunAt(id: string, nextRunAt: string | null): void {
  requireDb().prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(nextRunAt, id);
}

function createControlledSleep() {
  const calls: number[] = [];
  const resolvers: Array<() => void> = [];

  return {
    calls,
    sleep(ms: number) {
      calls.push(ms);
      return new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });
    },
    resolveNext() {
      resolvers.shift()?.();
    },
  };
}

async function waitFor(assertion: () => void | Promise<void>, attempts: number = 40): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await Promise.resolve();
    }
  }

  throw lastError;
}

afterEach(async () => {
  registerRunAgentPrompt(null);
  setScheduleRuntimeSync(null);
  mock.restore();
  db?.close();
  db = undefined;
});

describe('CronScheduler', () => {
  it('createScheduler(db) uses the registered shared runAgentPrompt seam', async () => {
    db = new Database(':memory:');
    migrate(requireDb());
    insertAgentGroup('support');
    const schedule = createSchedule({
      db: requireDb(),
      input: {
        agent_group_id: 'support',
        cron_expr: '0 10 * * *',
        prompt: 'Daily summary',
      },
      now: '2026-01-15T08:00:00.000Z',
    });
    setNextRunAt(schedule.id, '2026-01-15T09:00:00.000Z');
    const runAgentPrompt = mock(async () => ({
      content: 'Scheduled reply',
      sessionId: 'session-1',
      threadId: `schedule:${schedule.id}`,
      lastRunAt: '2026-01-15T09:00:00.000Z',
    }));

    registerRunAgentPrompt(runAgentPrompt);
    const scheduler = createScheduler(requireDb()) as CronScheduler;

    expect(scheduler).toBeInstanceOf(CronScheduler);

    await scheduler.start();

    await waitFor(() => {
      expect(runAgentPrompt).toHaveBeenCalledTimes(1);
    });

    await scheduler.stop();
  });

  it('createScheduler(db) can start non-agent schedules without a registered runAgentPrompt seam', async () => {
    db = new Database(':memory:');
    migrate(requireDb());
    insertAgentGroup('support');
    const schedule = createSchedule({
      db: requireDb(),
      input: {
        agent_group_id: 'support',
        cron_expr: '0 10 * * *',
        prompt: 'Workflow summary',
        mode: 'workflow',
      },
      now: '2026-01-15T08:00:00.000Z',
    });
    setNextRunAt(schedule.id, '2026-01-15T09:00:00.000Z');

    const scheduler = createScheduler(requireDb()) as CronScheduler;
    expect(scheduler).toBeInstanceOf(CronScheduler);

    await scheduler.start();

    await waitFor(() => {
      const updated = getSchedule({ db: requireDb(), id: schedule.id });
      expect(updated).toMatchObject({
        id: schedule.id,
        last_run_at: expect.any(String),
      });
      expect(updated?.next_run_at).not.toBe('2026-01-15T09:00:00.000Z');
    });

    await scheduler.stop();
  });

  it('uses a default pollIntervalMs of 30_000', () => {
    db = new Database(':memory:');
    migrate(requireDb());

    const scheduler = new CronScheduler({
      db: requireDb(),
      runAgentPrompt: mock(async () => ({
        content: 'ignored',
        sessionId: 'session-1',
        threadId: 'schedule:schedule-1',
        lastRunAt: '2026-01-15T09:00:00.000Z',
      })),
    });

    expect(scheduler.pollIntervalMs).toBe(30_000);
  });

  it('supports start and stop lifecycle', async () => {
    db = new Database(':memory:');
    migrate(requireDb());
    const controlledSleep = createControlledSleep();
    const scheduler = new CronScheduler({
      db: requireDb(),
      sleep: controlledSleep.sleep,
      runAgentPrompt: mock(async () => ({
        content: 'ignored',
        sessionId: 'session-1',
        threadId: 'schedule:schedule-1',
        lastRunAt: '2026-01-15T09:00:00.000Z',
      })),
    });

    await scheduler.start();

    await waitFor(() => {
      expect(controlledSleep.calls).toEqual([30_000]);
    });

    await scheduler.stop();
  });

  it('executes a due enabled agent schedule', async () => {
    db = new Database(':memory:');
    migrate(requireDb());
    insertAgentGroup('support');
    const controlledSleep = createControlledSleep();
    const schedule = createSchedule({
      db: requireDb(),
      input: {
        agent_group_id: 'support',
        cron_expr: '0 10 * * *',
        prompt: 'Daily summary',
      },
      now: '2026-01-15T08:00:00.000Z',
    });
    setNextRunAt(schedule.id, '2026-01-15T09:00:00.000Z');
    const runAgentPrompt = mock(async () => ({
      content: 'Scheduled reply',
      sessionId: 'session-1',
      threadId: `schedule:${schedule.id}`,
      lastRunAt: '2026-01-15T09:00:00.000Z',
    }));
    const scheduler = new CronScheduler({
      db: requireDb(),
      now: () => new Date('2026-01-15T09:00:00.000Z'),
      sleep: controlledSleep.sleep,
      runAgentPrompt,
    });

    await scheduler.start();

    await waitFor(() => {
      expect(runAgentPrompt).toHaveBeenCalledTimes(1);
    });

    expect(runAgentPrompt).toHaveBeenCalledWith({
      schedule: expect.objectContaining({
        id: schedule.id,
        agent_group_id: 'support',
        prompt: 'Daily summary',
        mode: 'agent',
      }),
    });
    expect(getSchedule({ db: requireDb(), id: schedule.id })).toMatchObject({
      last_run_at: '2026-01-15T09:00:00.000Z',
      next_run_at: '2026-01-15T10:00:00.000Z',
    });

    await scheduler.stop();
  });

  it('skips disabled schedules', async () => {
    db = new Database(':memory:');
    migrate(requireDb());
    insertAgentGroup('support');
    const controlledSleep = createControlledSleep();
    const schedule = createSchedule({
      db: requireDb(),
      input: {
        agent_group_id: 'support',
        cron_expr: '0 10 * * *',
        prompt: 'Disabled summary',
        enabled: false,
      },
      now: '2026-01-15T08:00:00.000Z',
    });
    setNextRunAt(schedule.id, '2026-01-15T09:00:00.000Z');
    const runAgentPrompt = mock(async () => ({
      content: 'should not run',
      sessionId: 'session-1',
      threadId: `schedule:${schedule.id}`,
      lastRunAt: '2026-01-15T09:00:00.000Z',
    }));
    const scheduler = new CronScheduler({
      db: requireDb(),
      now: () => new Date('2026-01-15T09:00:00.000Z'),
      sleep: controlledSleep.sleep,
      runAgentPrompt,
    });

    await scheduler.start();

    await waitFor(() => {
      expect(controlledSleep.calls.length).toBeGreaterThan(0);
    });

    expect(runAgentPrompt).not.toHaveBeenCalled();
    expect(getSchedule({ db: requireDb(), id: schedule.id })).toMatchObject({
      enabled: false,
      last_run_at: null,
      next_run_at: '2026-01-15T09:00:00.000Z',
    });

    await scheduler.stop();
  });

  it('processes multiple due schedules in deterministic order', async () => {
    db = new Database(':memory:');
    migrate(requireDb());
    insertAgentGroup('support');
    const controlledSleep = createControlledSleep();
    const originalRandomUuid = crypto.randomUUID;
    const scheduledIds = [
      '00000000-0000-0000-0000-00000000000b',
      '00000000-0000-0000-0000-00000000000a',
      '00000000-0000-0000-0000-00000000000c',
    ] as const;
    let idIndex = 0;
    crypto.randomUUID = () => scheduledIds[idIndex++] ?? originalRandomUuid();
    const first = createSchedule({
      db: requireDb(),
      input: {
        agent_group_id: 'support',
        cron_expr: '0 10 * * *',
        prompt: 'First',
      },
      now: '2026-01-15T08:00:00.000Z',
    });
    const second = createSchedule({
      db: requireDb(),
      input: {
        agent_group_id: 'support',
        cron_expr: '0 10 * * *',
        prompt: 'Second',
      },
      now: '2026-01-15T08:00:00.000Z',
    });
    const third = createSchedule({
      db: requireDb(),
      input: {
        agent_group_id: 'support',
        cron_expr: '0 10 * * *',
        prompt: 'Third',
      },
      now: '2026-01-15T08:05:00.000Z',
    });
    crypto.randomUUID = originalRandomUuid;
    setNextRunAt(first.id, '2026-01-15T09:00:00.000Z');
    setNextRunAt(second.id, '2026-01-15T09:00:00.000Z');
    setNextRunAt(third.id, '2026-01-15T08:55:00.000Z');
    const seen: string[] = [];
    const runAgentPrompt = mock(async (input: { schedule: { id: string } }) => {
      seen.push(input.schedule.id);
      return {
        content: input.schedule.id,
        sessionId: `session-${input.schedule.id}`,
        threadId: `schedule:${input.schedule.id}`,
        lastRunAt: '2026-01-15T09:00:00.000Z',
      };
    });
    const scheduler = new CronScheduler({
      db: requireDb(),
      now: () => new Date('2026-01-15T09:00:00.000Z'),
      sleep: controlledSleep.sleep,
      runAgentPrompt,
    });

    await scheduler.start();

    await waitFor(() => {
      expect(seen).toEqual([third.id, second.id, first.id]);
    });

    await scheduler.stop();
  });

  it('executes due workflow schedules without using the agent seam or hot-looping', async () => {
    db = new Database(':memory:');
    migrate(requireDb());
    insertAgentGroup('support');
    const controlledSleep = createControlledSleep();
    const schedule = createSchedule({
      db: requireDb(),
      input: {
        agent_group_id: 'support',
        cron_expr: '0 10 * * *',
        prompt: 'Workflow summary',
        mode: 'workflow',
      },
      now: '2026-01-15T08:00:00.000Z',
    });
    setNextRunAt(schedule.id, '2026-01-15T09:00:00.000Z');
    const runAgentPrompt = mock(async () => ({
      content: 'should not run',
      sessionId: 'session-1',
      threadId: `schedule:${schedule.id}`,
      lastRunAt: '2026-01-15T09:00:00.000Z',
    }));
    const scheduler = new CronScheduler({
      db: requireDb(),
      now: () => new Date('2026-01-15T09:00:00.000Z'),
      sleep: controlledSleep.sleep,
      runAgentPrompt,
    });
    setScheduleRuntimeSync(scheduler);

    await scheduler.start();

    await waitFor(() => {
      expect(getSchedule({ db: requireDb(), id: schedule.id })).toMatchObject({
        last_run_at: '2026-01-15T09:00:00.000Z',
        next_run_at: '2026-01-15T10:00:00.000Z',
      });
    });

    upsertSchedule(schedule.id);
    await Promise.resolve();

    expect(runAgentPrompt).not.toHaveBeenCalled();
    expect(getSchedule({ db: requireDb(), id: schedule.id })).toMatchObject({
      last_run_at: '2026-01-15T09:00:00.000Z',
      next_run_at: '2026-01-15T10:00:00.000Z',
    });

    await scheduler.stop();
  });

  it('executes due notification schedules without using the agent seam', async () => {
    db = new Database(':memory:');
    migrate(requireDb());
    insertAgentGroup('support');
    const controlledSleep = createControlledSleep();
    const schedule = createSchedule({
      db: requireDb(),
      input: {
        agent_group_id: 'support',
        cron_expr: '0 10 * * *',
        prompt: 'Notify ops',
        mode: 'notification',
      },
      now: '2026-01-15T08:00:00.000Z',
    });
    setNextRunAt(schedule.id, '2026-01-15T09:00:00.000Z');
    const runAgentPrompt = mock(async () => ({
      content: 'should not run',
      sessionId: 'session-1',
      threadId: `schedule:${schedule.id}`,
      lastRunAt: '2026-01-15T09:00:00.000Z',
    }));
    const scheduler = new CronScheduler({
      db: requireDb(),
      now: () => new Date('2026-01-15T09:00:00.000Z'),
      sleep: controlledSleep.sleep,
      runAgentPrompt,
    });

    await scheduler.start();

    await waitFor(() => {
      expect(getSchedule({ db: requireDb(), id: schedule.id })).toMatchObject({
        last_run_at: '2026-01-15T09:00:00.000Z',
        next_run_at: '2026-01-15T10:00:00.000Z',
      });
    });

    expect(runAgentPrompt).not.toHaveBeenCalled();

    await scheduler.stop();
  });

  it('executes due script schedules without using the agent seam', async () => {
    db = new Database(':memory:');
    migrate(requireDb());
    insertAgentGroup('support');
    const controlledSleep = createControlledSleep();
    const schedule = createSchedule({
      db: requireDb(),
      input: {
        agent_group_id: 'support',
        cron_expr: '0 10 * * *',
        prompt: 'printf script-result',
        mode: 'script',
      },
      now: '2026-01-15T08:00:00.000Z',
    });
    setNextRunAt(schedule.id, '2026-01-15T09:00:00.000Z');
    const runAgentPrompt = mock(async () => ({
      content: 'should not run',
      sessionId: 'session-1',
      threadId: `schedule:${schedule.id}`,
      lastRunAt: '2026-01-15T09:00:00.000Z',
    }));
    const originalRuntime = process.env.COVE_CONTAINER_RUNTIME_BIN;
    process.env.COVE_CONTAINER_RUNTIME_BIN = 'true';

    try {
      const scheduler = new CronScheduler({
        db: requireDb(),
        now: () => new Date('2026-01-15T09:00:00.000Z'),
        sleep: controlledSleep.sleep,
        runAgentPrompt,
      });

      await scheduler.start();

      await waitFor(() => {
        expect(getSchedule({ db: requireDb(), id: schedule.id })).toMatchObject({
          last_run_at: '2026-01-15T09:00:00.000Z',
          next_run_at: '2026-01-15T10:00:00.000Z',
        });
      });

      expect(runAgentPrompt).not.toHaveBeenCalled();

      await scheduler.stop();
    } finally {
      if (originalRuntime === undefined) {
        delete process.env.COVE_CONTAINER_RUNTIME_BIN;
      } else {
        process.env.COVE_CONTAINER_RUNTIME_BIN = originalRuntime;
      }
    }
  });

  it('continues operating after one agent execution failure', async () => {
    db = new Database(':memory:');
    migrate(requireDb());
    insertAgentGroup('support');
    const controlledSleep = createControlledSleep();
    const failing = createSchedule({
      db: requireDb(),
      input: {
        agent_group_id: 'support',
        cron_expr: '0 10 * * *',
        prompt: 'Fails once',
      },
      now: '2026-01-15T08:00:00.000Z',
    });
    setNextRunAt(failing.id, '2026-01-15T09:00:00.000Z');
    const succeeding = createSchedule({
      db: requireDb(),
      input: {
        agent_group_id: 'support',
        cron_expr: '0 10 * * *',
        prompt: 'Runs later',
      },
      now: '2026-01-15T08:10:00.000Z',
    });
    const runAgentPrompt = mock(async (input: { schedule: { id: string } }) => {
      if (input.schedule.id === failing.id) {
        throw new Error('boom');
      }

      return {
        content: 'ok',
        sessionId: 'session-2',
        threadId: `schedule:${input.schedule.id}`,
        lastRunAt: '2026-01-15T09:00:00.000Z',
      };
    });
    const scheduler = new CronScheduler({
      db: requireDb(),
      now: () => new Date('2026-01-15T09:00:00.000Z'),
      sleep: controlledSleep.sleep,
      runAgentPrompt,
    });
    setScheduleRuntimeSync(scheduler);

    await scheduler.start();

    await waitFor(() => {
      expect(getSchedule({ db: requireDb(), id: failing.id })).toMatchObject({
        last_run_at: '2026-01-15T09:00:00.000Z',
        next_run_at: '2026-01-15T10:00:00.000Z',
      });
    });

    setNextRunAt(succeeding.id, '2026-01-15T09:00:00.000Z');
    upsertSchedule(succeeding.id);

    await waitFor(() => {
      expect(runAgentPrompt).toHaveBeenCalledTimes(2);
      expect(getSchedule({ db: requireDb(), id: succeeding.id })).toMatchObject({
        last_run_at: '2026-01-15T09:00:00.000Z',
        next_run_at: '2026-01-15T10:00:00.000Z',
      });
    });

    await scheduler.stop();
  });

  it('continues operating when schedule bookkeeping throws after execution', async () => {
    db = new Database(':memory:');
    migrate(requireDb());
    insertAgentGroup('support');
    const controlledSleep = createControlledSleep();
    const deletedDuringBookkeeping = createSchedule({
      db: requireDb(),
      input: {
        agent_group_id: 'support',
        cron_expr: '0 10 * * *',
        prompt: 'Delete me after run',
      },
      now: '2026-01-15T08:00:00.000Z',
    });
    const healthy = createSchedule({
      db: requireDb(),
      input: {
        agent_group_id: 'support',
        cron_expr: '0 10 * * *',
        prompt: 'Keep running',
      },
      now: '2026-01-15T08:05:00.000Z',
    });
    setNextRunAt(deletedDuringBookkeeping.id, '2026-01-15T09:00:00.000Z');
    setNextRunAt(healthy.id, '2026-01-15T09:00:00.000Z');
    const seen: string[] = [];
    const runAgentPrompt = mock(async (input: { schedule: { id: string } }) => {
      seen.push(input.schedule.id);

      if (input.schedule.id === deletedDuringBookkeeping.id) {
        requireDb().prepare('DELETE FROM schedules WHERE id = ?').run(input.schedule.id);
      }

      return {
        content: 'ok',
        sessionId: `session-${input.schedule.id}`,
        threadId: `schedule:${input.schedule.id}`,
        lastRunAt: '2026-01-15T09:00:00.000Z',
      };
    });
    const scheduler = new CronScheduler({
      db: requireDb(),
      now: () => new Date('2026-01-15T09:00:00.000Z'),
      sleep: controlledSleep.sleep,
      runAgentPrompt,
    });

    await scheduler.start();

    await waitFor(() => {
      expect(seen).toEqual([deletedDuringBookkeeping.id, healthy.id]);
    });

    expect(getSchedule({ db: requireDb(), id: healthy.id })).toMatchObject({
      last_run_at: '2026-01-15T09:00:00.000Z',
      next_run_at: '2026-01-15T10:00:00.000Z',
    });

    await scheduler.stop();
  });

  it('supports live upsertSchedule and removeSchedule hooks', async () => {
    db = new Database(':memory:');
    migrate(requireDb());
    insertAgentGroup('support');
    const controlledSleep = createControlledSleep();
    const seen: string[] = [];
    const runAgentPrompt = mock(async (input: { schedule: { id: string } }) => {
      seen.push(input.schedule.id);
      return {
        content: 'ok',
        sessionId: `session-${input.schedule.id}`,
        threadId: `schedule:${input.schedule.id}`,
        lastRunAt: '2026-01-15T09:00:00.000Z',
      };
    });
    const scheduler = new CronScheduler({
      db: requireDb(),
      now: () => new Date('2026-01-15T09:00:00.000Z'),
      sleep: controlledSleep.sleep,
      runAgentPrompt,
    });
    setScheduleRuntimeSync(scheduler);

    await scheduler.start();

    await waitFor(() => {
      expect(controlledSleep.calls).toEqual([30_000]);
    });

    const inserted = createSchedule({
      db: requireDb(),
      input: {
        agent_group_id: 'support',
        cron_expr: '0 10 * * *',
        prompt: 'Inserted while live',
      },
      now: '2026-01-15T08:30:00.000Z',
    });
    setNextRunAt(inserted.id, '2026-01-15T09:00:00.000Z');
    upsertSchedule(inserted.id);

    await waitFor(() => {
      expect(seen).toEqual([inserted.id]);
    });

    const removed = createSchedule({
      db: requireDb(),
      input: {
        agent_group_id: 'support',
        cron_expr: '0 10 * * *',
        prompt: 'Removed while live',
      },
      now: '2026-01-15T08:35:00.000Z',
    });
    setNextRunAt(removed.id, '2026-01-15T09:00:00.000Z');
    requireDb().prepare('DELETE FROM schedules WHERE id = ?').run(removed.id);
    removeSchedule(removed.id);
    await Promise.resolve();

    expect(seen).toEqual([inserted.id]);

    await scheduler.stop();
  });
});
