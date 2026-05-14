import { afterEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';

import { migrate } from '../../src/db/migrate.ts';
import {
  computeNextRunAt,
  createSchedule,
  deleteSchedule,
  getSchedule,
  listSchedules,
  markScheduleRunFailed,
  markScheduleRunNotImplemented,
  markScheduleRunSucceeded,
  updateSchedule,
} from '../../src/jobs/schedules.ts';
import { createScheduleThreadId, createRunAgentPrompt } from '../../src/jobs/run-agent-prompt.ts';

let db: Database | undefined;

function requireDb(): Database {
  if (db == null) {
    throw new Error('Test database not initialized');
  }

  return db;
}

function insertAgentGroup(id: string): void {
  db!.prepare(
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

afterEach(() => {
  mock.restore();
  db?.close();
  db = undefined;
});

describe('schedule domain', () => {
  it('creates, lists, gets, updates, and deletes schedules with normalized dto fields', () => {
    db = new Database(':memory:');
    migrate(db);
    insertAgentGroup('support');

    const created = createSchedule({
      db,
      input: {
        agent_group_id: 'support',
        cron_expr: '0 9 * * 1-5',
        prompt: 'Daily summary',
        mode: 'agent',
        config: { notify: true },
        enabled: 1 as never,
      },
      now: '2026-01-15T08:00:00.000Z',
    });

    const createdId = created.id;

    expect(typeof createdId).toBe('string');
    expect(created).toEqual({
      id: createdId,
      agent_group_id: 'support',
      cron_expr: '0 9 * * 1-5',
      prompt: 'Daily summary',
      mode: 'agent',
      config: { notify: true },
      enabled: true,
      last_run_at: null,
      next_run_at: '2026-01-15T09:00:00.000Z',
      created_at: '2026-01-15T08:00:00.000Z',
    });

    expect(listSchedules({ db })).toEqual([created]);

    expect(getSchedule({ db, id: createdId })).toEqual(created);

    const updated = updateSchedule({
      db,
      id: created.id,
      patch: {
        cron_expr: '30 10 * * *',
        prompt: 'Updated summary',
        mode: 'workflow',
        config: null,
        enabled: false,
      },
      now: '2026-01-15T08:05:00.000Z',
    });

    expect(updated).toMatchObject({
      id: created.id,
      agent_group_id: 'support',
      cron_expr: '30 10 * * *',
      prompt: 'Updated summary',
      mode: 'workflow',
      config: null,
      enabled: false,
      last_run_at: null,
      next_run_at: null,
      created_at: '2026-01-15T08:00:00.000Z',
    });

    expect(deleteSchedule({ db, id: created.id })).toBe(true);
    expect(getSchedule({ db, id: created.id })).toBeNull();
    expect(listSchedules({ db })).toEqual([]);
  });

  it('rejects trimmed-empty prompts on create and update', () => {
    db = new Database(':memory:');
    migrate(requireDb());
    insertAgentGroup('support');

    expect(() =>
      createSchedule({
        db: requireDb(),
        input: {
          agent_group_id: 'support',
          cron_expr: '0 9 * * *',
          prompt: '   ',
        },
        now: '2026-01-15T08:00:00.000Z',
      }),
    ).toThrow('prompt must not be empty');

    const created = createSchedule({
      db: requireDb(),
      input: {
        agent_group_id: 'support',
        cron_expr: '0 9 * * *',
        prompt: 'Valid prompt',
      },
      now: '2026-01-15T08:00:00.000Z',
    });

    expect(() =>
      updateSchedule({
        db: requireDb(),
        id: created.id,
        patch: {
          prompt: '   ',
        },
        now: '2026-01-15T08:05:00.000Z',
      }),
    ).toThrow('prompt must not be empty');
  });

  it('rejects invalid cron expressions', () => {
    db = new Database(':memory:');
    migrate(requireDb());
    insertAgentGroup('support');

    expect(() =>
      createSchedule({
        db: requireDb(),
        input: {
          agent_group_id: 'support',
          cron_expr: '* * * *',
          prompt: 'Bad cron',
        },
        now: '2026-01-15T08:00:00.000Z',
      }),
    ).toThrow('Invalid cron expression');
  });

  it('uses standard cron OR semantics between restricted day-of-month and day-of-week fields', () => {
    expect(computeNextRunAt('0 9 15 * 1', '2026-06-02T09:00:00.000Z')).toBe('2026-06-08T09:00:00.000Z');
  });

  it('rejects invalid modes', () => {
    db = new Database(':memory:');
    migrate(requireDb());
    insertAgentGroup('support');

    expect(() =>
      createSchedule({
        db: requireDb(),
        input: {
          agent_group_id: 'support',
          cron_expr: '0 9 * * *',
          prompt: 'Bad mode',
          mode: 'invalid' as never,
        },
        now: '2026-01-15T08:00:00.000Z',
      }),
    ).toThrow('Invalid schedule mode');
  });

  it('rejects non-object config values and normalizes stored json text responses', () => {
    db = new Database(':memory:');
    migrate(requireDb());
    insertAgentGroup('support');

    expect(() =>
      createSchedule({
        db: requireDb(),
        input: {
          agent_group_id: 'support',
          cron_expr: '0 9 * * *',
          prompt: 'Bad config',
          config: ['not', 'an', 'object'] as never,
        },
        now: '2026-01-15T08:00:00.000Z',
      }),
    ).toThrow('config must be an object');

    requireDb().prepare(
      `INSERT INTO schedules (
         id,
         agent_group_id,
         cron_expr,
         prompt,
         mode,
         config,
         enabled,
         last_run_at,
         next_run_at,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'schedule-from-db',
      'support',
      '0 9 * * *',
      'Stored config',
      'agent',
      '{"threshold":2}',
      1,
      null,
      '2026-01-15T09:00:00.000Z',
      '2026-01-15T08:00:00.000Z',
    );

    expect(getSchedule({ db: requireDb(), id: 'schedule-from-db' })).toMatchObject({
      config: { threshold: 2 },
      enabled: true,
    });
  });

  it('normalizes enabled values and recomputes next_run_at when toggled', () => {
    db = new Database(':memory:');
    migrate(requireDb());
    insertAgentGroup('support');

    const created = createSchedule({
      db,
      input: {
        agent_group_id: 'support',
        cron_expr: '15 8 * * *',
        prompt: 'Wake up',
        enabled: 0 as never,
      },
      now: '2026-01-15T08:00:00.000Z',
    });

    expect(created.enabled).toBe(false);
    expect(created.next_run_at).toBeNull();

    const enabled = updateSchedule({
      db,
      id: created.id,
      patch: { enabled: true },
      now: '2026-01-15T08:00:00.000Z',
    });

    expect(enabled.enabled).toBe(true);
    expect(enabled.next_run_at).toBe('2026-01-15T08:15:00.000Z');
  });

  it('rejects invalid now values even when enabled is false', () => {
    db = new Database(':memory:');
    migrate(requireDb());
    insertAgentGroup('support');

    expect(() =>
      createSchedule({
        db: requireDb(),
        input: {
          agent_group_id: 'support',
          cron_expr: '15 8 * * *',
          prompt: 'Disabled create',
          enabled: false,
        },
        now: 'not-a-timestamp',
      }),
    ).toThrow('Invalid run timestamp');

    const created = createSchedule({
      db: requireDb(),
      input: {
        agent_group_id: 'support',
        cron_expr: '15 8 * * *',
        prompt: 'Disabled update',
      },
      now: '2026-01-15T08:00:00.000Z',
    });

    expect(() =>
      updateSchedule({
        db: requireDb(),
        id: created.id,
        patch: {
          enabled: false,
        },
        now: 'not-a-timestamp',
      }),
    ).toThrow('Invalid run timestamp');
  });

  it('returns a client-safe missing-agent-group error before raw sqlite foreign-key failure', () => {
    db = new Database(':memory:');
    migrate(db);

    expect(() =>
      createSchedule({
        db: requireDb(),
        input: {
          agent_group_id: 'missing-group',
          cron_expr: '0 9 * * *',
          prompt: 'No agent group',
        },
        now: '2026-01-15T08:00:00.000Z',
      }),
    ).toThrow('Agent group not found: missing-group');
  });

  it('recomputes run state for success, failure, and not-implemented outcomes', () => {
    db = new Database(':memory:');
    migrate(db);
    insertAgentGroup('support');

    const created = createSchedule({
      db,
      input: {
        agent_group_id: 'support',
        cron_expr: '0 9 * * *',
        prompt: 'Daily summary',
      },
      now: '2026-01-15T08:00:00.000Z',
    });

    expect(markScheduleRunSucceeded({
      db,
      id: created.id,
      ranAt: '2026-01-15T09:00:00.000Z',
    })).toMatchObject({
      last_run_at: '2026-01-15T09:00:00.000Z',
      next_run_at: '2026-01-16T09:00:00.000Z',
    });

    expect(markScheduleRunFailed({
      db,
      id: created.id,
      ranAt: '2026-01-16T09:00:00.000Z',
    })).toMatchObject({
      last_run_at: '2026-01-16T09:00:00.000Z',
      next_run_at: '2026-01-17T09:00:00.000Z',
    });

    expect(markScheduleRunNotImplemented({
      db,
      id: created.id,
      ranAt: '2026-01-17T09:00:00.000Z',
    })).toMatchObject({
      last_run_at: '2026-01-17T09:00:00.000Z',
      next_run_at: '2026-01-18T09:00:00.000Z',
    });
  });
});

describe('runAgentPrompt seam', () => {
  it('maps a schedule id to a deterministic thread id', () => {
    expect(createScheduleThreadId('schedule-123')).toBe('schedule:schedule-123');
    expect(createScheduleThreadId('schedule-123')).toBe('schedule:schedule-123');
  });

  it('returns a normalized execution result for scheduled prompts', async () => {
    const execute = mock(async () => ({
      content: 'Scheduled reply',
      sessionId: 'session-1',
      lastRunAt: '2026-01-15T09:00:00.000Z',
    }));
    const runAgentPrompt = createRunAgentPrompt({ execute });

    const result = await runAgentPrompt({
      schedule: {
        id: 'schedule-123',
        agent_group_id: 'support',
        prompt: 'Run now',
      },
    });

    expect(execute).toHaveBeenCalledWith({
      agent_group_id: 'support',
      thread_id: 'schedule:schedule-123',
      messages: [{ role: 'user', content: 'Run now' }],
    });
    expect(result).toEqual({
      content: 'Scheduled reply',
      sessionId: 'session-1',
      threadId: 'schedule:schedule-123',
      lastRunAt: '2026-01-15T09:00:00.000Z',
    });
  });
});
