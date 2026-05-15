import type { Database } from 'bun:sqlite';

import { executeSchedule, hasWorkflowRollback } from '../../jobs/execute-schedule.ts';
import {
  getRegisteredRunAgentPrompt,
  getRegisteredRollbackWorkflow,
  getRegisteredStartWorkflow,
  removeSchedule,
  upsertSchedule,
} from '../../jobs/cron-scheduler.ts';
import {
  createSchedule,
  deleteSchedule,
  getSchedule,
  listSchedules,
  markScheduleRunFailed,
  markScheduleRunSucceeded,
  updateSchedule,
  type CreateScheduleInput,
  type UpdateScheduleInput,
} from '../../jobs/schedules.ts';
import type { AppContext } from '../../shared/types.ts';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${name} is required and must be a string`);
  }

  return value;
}

function parseOptionalConfig(value: unknown): Record<string, unknown> | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (!isRecord(value)) {
    throw new Error('config must be an object');
  }

  return value;
}

function parseCreateBody(body: unknown): CreateScheduleInput {
  if (!isRecord(body)) {
    throw new Error('Schedule payload must be a JSON object');
  }

  return {
    agent_group_id: requireString(body.agent_group_id, 'agent_group_id'),
    cron_expr: requireString(body.cron_expr, 'cron_expr'),
    prompt: requireString(body.prompt, 'prompt'),
    mode: body.mode === undefined ? undefined : requireString(body.mode, 'mode'),
    config: parseOptionalConfig(body.config),
    enabled: body.enabled as boolean | number | null | undefined,
  };
}

function parseUpdateBody(body: unknown): UpdateScheduleInput {
  if (!isRecord(body)) {
    throw new Error('Schedule payload must be a JSON object');
  }

  return {
    cron_expr: body.cron_expr === undefined ? undefined : requireString(body.cron_expr, 'cron_expr'),
    prompt: body.prompt === undefined ? undefined : requireString(body.prompt, 'prompt'),
    mode: body.mode === undefined ? undefined : requireString(body.mode, 'mode'),
    config: parseOptionalConfig(body.config),
    enabled: body.enabled as boolean | number | null | undefined,
  };
}

function mapCreateOrUpdateError(error: unknown): Response {
  const message = error instanceof Error ? error.message : 'Invalid schedule payload';

  if (/^Agent group not found: /.test(message)) {
    return jsonResponse({ error: message }, 404);
  }

  if (/^Schedule not found: /.test(message)) {
    return jsonResponse({ error: 'Not Found' }, 404);
  }

  return jsonResponse({ error: message }, 400);
}

function isKnownCreateOrUpdateValidationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';

  return /^Agent group not found: /.test(message)
    || /^Schedule not found: /.test(message)
    || message === 'Invalid cron expression'
    || message === 'Invalid schedule mode'
    || message === 'config must be an object'
    || message === 'enabled must be a boolean or 0/1'
    || message === 'prompt must not be empty';
}

async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new Error('Invalid JSON body');
  }
}

export async function handleCreateSchedule(request: Request, db: Database): Promise<Response> {
  let payload: CreateScheduleInput;

  try {
    payload = parseCreateBody(await parseJsonBody(request));
  } catch (error) {
    return mapCreateOrUpdateError(error);
  }

  try {
    const schedule = createSchedule({ db, input: payload });
    try {
      upsertSchedule(schedule.id);
    } catch {
      // The DB write already succeeded; keep the API truthful about persisted state.
    }
    return jsonResponse(schedule, 201);
  } catch (error) {
    return mapCreateOrUpdateError(error);
  }
}

export function handleListSchedules(_request: Request, db: Database): Response {
  try {
    return jsonResponse(listSchedules({ db }), 200);
  } catch {
    return jsonResponse({ error: 'Failed to load schedules' }, 500);
  }
}

export function handleGetSchedule(_request: Request, db: Database, params: { id: string }): Response {
  try {
    const schedule = getSchedule({ db, id: params.id });

    if (schedule == null) {
      return jsonResponse({ error: 'Not Found' }, 404);
    }

    return jsonResponse(schedule, 200);
  } catch {
    return jsonResponse({ error: 'Failed to load schedule' }, 500);
  }
}

export async function handleUpdateSchedule(request: Request, db: Database, params: { id: string }): Promise<Response> {
  let payload: UpdateScheduleInput;

  try {
    payload = parseUpdateBody(await parseJsonBody(request));
  } catch (error) {
    return mapCreateOrUpdateError(error);
  }

  try {
    const schedule = updateSchedule({ db, id: params.id, patch: payload });
    try {
      upsertSchedule(schedule.id);
    } catch {
      // The DB write already succeeded; keep the API truthful about persisted state.
    }
    return jsonResponse(schedule, 200);
  } catch (error) {
    return mapCreateOrUpdateError(error);
  }
}

export function handleDeleteSchedule(_request: Request, db: Database, params: { id: string }): Response {
  try {
    const deleted = deleteSchedule({ db, id: params.id });

    if (!deleted) {
      return jsonResponse({ error: 'Not Found' }, 404);
    }

    try {
      removeSchedule(params.id);
    } catch {
      // The DB delete already succeeded; keep the API truthful about persisted state.
    }
    return new Response(null, { status: 204 });
  } catch {
    return jsonResponse({ error: 'Failed to delete schedule' }, 500);
  }
}

export async function handleRunSchedule(
  _request: Request,
  context: AppContext,
  params: { id: string },
): Promise<Response> {
  const schedule = getSchedule({ db: context.db, id: params.id });

  if (schedule == null) {
    return jsonResponse({ error: 'Not Found' }, 404);
  }

  const runAgentPrompt = context.runAgentPrompt ?? getRegisteredRunAgentPrompt() ?? undefined;
  const startWorkflow = context.startWorkflow ?? getRegisteredStartWorkflow() ?? undefined;
  const rollbackWorkflow = context.rollbackWorkflow ?? getRegisteredRollbackWorkflow() ?? undefined;

  try {
    const result = await executeSchedule({ schedule, runAgentPrompt, startWorkflow, rollbackWorkflow });
    const ranAt = 'lastRunAt' in result ? result.lastRunAt : new Date().toISOString();

    try {
      markScheduleRunSucceeded({
        db: context.db,
        id: schedule.id,
        ranAt,
      });
    } catch {
      if (hasWorkflowRollback(result) && result.rollbackWorkflow != null) {
        await result.rollbackWorkflow({ instanceId: result.instanceId });
      }

      throw new Error('Failed to record schedule run');
    }

    if ('sessionId' in result) {
      return jsonResponse({
        status: 'completed',
        schedule_id: schedule.id,
        last_run_at: ranAt,
        result: {
          content: result.content,
          session_id: result.sessionId,
          thread_id: result.threadId,
          ...('notified' in result ? { notified: true } : {}),
        },
      }, 200);
    }

    return jsonResponse({
      status: 'completed',
      schedule_id: schedule.id,
      last_run_at: ranAt,
        result: {
          mode: result.mode,
          ...('instanceId' in result ? { instance_id: result.instanceId } : {}),
          ...('logged' in result ? { logged: result.logged } : {}),
          ...('stdout' in result ? {
            stdout: result.stdout,
            stderr: result.stderr,
            exit_code: result.exitCode,
          } : {}),
          ...(schedule.mode === 'workflow' ? { config: schedule.config } : {}),
        },
      }, 200);
  } catch {
    try {
      markScheduleRunFailed({
        db: context.db,
        id: schedule.id,
        ranAt: new Date().toISOString(),
      });
    } catch {
      return jsonResponse({ error: 'Failed to run schedule' }, 500);
    }

    return jsonResponse({ error: 'Failed to run schedule' }, 500);
  }
}
