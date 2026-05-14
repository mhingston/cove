import type { Database } from 'bun:sqlite';

const SCHEDULE_MODES = ['agent', 'notification', 'script', 'hybrid', 'workflow'] as const;

type ScheduleMode = typeof SCHEDULE_MODES[number];

type ParsedCronExpression = {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  dayOfMonthWildcard: boolean;
  dayOfWeekWildcard: boolean;
};

type ScheduleRow = {
  id: string;
  agent_group_id: string;
  cron_expr: string;
  prompt: string;
  mode: string;
  config: string | null;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
};

export type ScheduleRecord = {
  id: string;
  agent_group_id: string;
  cron_expr: string;
  prompt: string;
  mode: ScheduleMode;
  config: Record<string, unknown> | null;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
};

export type CreateScheduleInput = {
  agent_group_id: string;
  cron_expr: string;
  prompt: string;
  mode?: string;
  config?: Record<string, unknown> | null;
  enabled?: boolean | number | null;
};

export type UpdateScheduleInput = {
  cron_expr?: string;
  prompt?: string;
  mode?: string;
  config?: Record<string, unknown> | null;
  enabled?: boolean | number | null;
};

function normalizeIsoTimestamp(value: string | undefined): string {
  const timestamp = value ?? new Date().toISOString();
  const parsed = new Date(timestamp);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error('Invalid run timestamp');
  }

  return timestamp;
}

function normalizeText(value: string): string {
  return value.trim();
}

function normalizePrompt(value: string): string {
  const prompt = normalizeText(value);

  if (prompt === '') {
    throw new Error('prompt must not be empty');
  }

  return prompt;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function normalizeConfig(value: unknown): Record<string, unknown> | null {
  if (value == null) {
    return null;
  }

  if (!isPlainObject(value)) {
    throw new Error('config must be an object');
  }

  return value;
}

function parseStoredConfig(value: string | null): Record<string, unknown> | null {
  if (value == null || value.trim() === '') {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeEnabled(value: boolean | number | null | undefined, defaultValue: boolean = true): boolean {
  if (value == null) {
    return defaultValue;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (value === 0 || value === 1) {
    return value === 1;
  }

  throw new Error('enabled must be a boolean or 0/1');
}

function normalizeMode(value: string | undefined): ScheduleMode {
  const mode = value == null ? 'agent' : normalizeText(value);

  if ((SCHEDULE_MODES as readonly string[]).includes(mode)) {
    return mode as ScheduleMode;
  }

  throw new Error('Invalid schedule mode');
}

function ensureAgentGroupExists(db: Database, agentGroupId: string): void {
  const row = db.prepare('SELECT id FROM agent_groups WHERE id = ?').get(agentGroupId) as { id: string } | null;

  if (row == null) {
    throw new Error(`Agent group not found: ${agentGroupId}`);
  }
}

function parseCronPart(part: string, min: number, max: number, normalize?: (value: number) => number): number[] {
  if (part === '*') {
    const values: number[] = [];

    for (let value = min; value <= max; value += 1) {
      values.push(normalize == null ? value : normalize(value));
    }

    return values;
  }

  const stepMatch = part.match(/^(\*|\d+(?:-\d+)?)\/(\d+)$/);

  if (stepMatch != null) {
    const step = Number(stepMatch[2]);

    if (!Number.isInteger(step) || step <= 0) {
      throw new Error('Invalid cron expression');
    }

    const base = stepMatch[1];
    const [rangeStart, rangeEnd] = base === '*'
      ? [min, max]
      : (() => {
          const rangeMatch = base.match(/^(\d+)-(\d+)$/);

          if (rangeMatch == null) {
            const single = Number(base);
            return [single, max];
          }

          return [Number(rangeMatch[1]), Number(rangeMatch[2])];
        })();

    if (!Number.isInteger(rangeStart) || !Number.isInteger(rangeEnd) || rangeStart < min || rangeEnd > max || rangeStart > rangeEnd) {
      throw new Error('Invalid cron expression');
    }

    const values: number[] = [];

    for (let value = rangeStart; value <= rangeEnd; value += step) {
      values.push(normalize == null ? value : normalize(value));
    }

    return values;
  }

  const rangeMatch = part.match(/^(\d+)-(\d+)$/);

  if (rangeMatch != null) {
    const rangeStart = Number(rangeMatch[1]);
    const rangeEnd = Number(rangeMatch[2]);

    if (!Number.isInteger(rangeStart) || !Number.isInteger(rangeEnd) || rangeStart < min || rangeEnd > max || rangeStart > rangeEnd) {
      throw new Error('Invalid cron expression');
    }

    const values: number[] = [];

    for (let value = rangeStart; value <= rangeEnd; value += 1) {
      values.push(normalize == null ? value : normalize(value));
    }

    return values;
  }

  const single = Number(part);

  if (!Number.isInteger(single) || single < min || single > max) {
    throw new Error('Invalid cron expression');
  }

  return [normalize == null ? single : normalize(single)];
}

function parseCronField(field: string, min: number, max: number, normalize?: (value: number) => number): Set<number> {
  const trimmed = normalizeText(field);

  if (trimmed === '') {
    throw new Error('Invalid cron expression');
  }

  const values = new Set<number>();

  for (const part of trimmed.split(',')) {
    for (const value of parseCronPart(part, min, max, normalize)) {
      values.add(value);
    }
  }

  return values;
}

function parseCronExpression(cronExpr: string): ParsedCronExpression {
  const parts = normalizeText(cronExpr).split(/\s+/);

  if (parts.length !== 5) {
    throw new Error('Invalid cron expression');
  }

  return {
    minute: parseCronField(parts[0]!, 0, 59),
    hour: parseCronField(parts[1]!, 0, 23),
    dayOfMonth: parseCronField(parts[2]!, 1, 31),
    month: parseCronField(parts[3]!, 1, 12),
    dayOfWeek: parseCronField(parts[4]!, 0, 7, (value) => (value === 7 ? 0 : value)),
    dayOfMonthWildcard: parts[2] === '*',
    dayOfWeekWildcard: parts[4] === '*',
  };
}

function matchesCron(parsed: ParsedCronExpression, date: Date): boolean {
  const dayOfMonthMatches = parsed.dayOfMonth.has(date.getUTCDate());
  const dayOfWeekMatches = parsed.dayOfWeek.has(date.getUTCDay());
  const dayMatches = parsed.dayOfMonthWildcard && parsed.dayOfWeekWildcard
    ? true
    : parsed.dayOfMonthWildcard
      ? dayOfWeekMatches
      : parsed.dayOfWeekWildcard
        ? dayOfMonthMatches
        : dayOfMonthMatches || dayOfWeekMatches;

  return parsed.minute.has(date.getUTCMinutes())
    && parsed.hour.has(date.getUTCHours())
    && dayMatches
    && parsed.month.has(date.getUTCMonth() + 1);
}

export function computeNextRunAt(cronExpr: string, fromIso: string): string {
  const parsedCron = parseCronExpression(cronExpr);
  const reference = new Date(normalizeIsoTimestamp(fromIso));

  const candidate = new Date(reference.getTime());
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  const maxIterations = 366 * 24 * 60 * 5;

  for (let index = 0; index < maxIterations; index += 1) {
    if (matchesCron(parsedCron, candidate)) {
      return candidate.toISOString();
    }

    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }

  throw new Error('Unable to compute next run time');
}

function mapScheduleRow(row: ScheduleRow): ScheduleRecord {
  return {
    id: row.id,
    agent_group_id: row.agent_group_id,
    cron_expr: row.cron_expr,
    prompt: row.prompt,
    mode: normalizeMode(row.mode),
    config: parseStoredConfig(row.config),
    enabled: row.enabled !== 0,
    last_run_at: row.last_run_at,
    next_run_at: row.next_run_at,
    created_at: row.created_at,
  };
}

function readScheduleRow(db: Database, id: string): ScheduleRow | null {
  const row = db.prepare(
    `SELECT id, agent_group_id, cron_expr, prompt, mode, config, enabled, last_run_at, next_run_at, created_at
     FROM schedules
     WHERE id = ?`,
  ).get(id);

  return row == null ? null : (row as ScheduleRow);
}

function requireScheduleRow(db: Database, id: string): ScheduleRow {
  const row = readScheduleRow(db, id);

  if (row == null) {
    throw new Error(`Schedule not found: ${id}`);
  }

  return row;
}

function computeStoredNextRunAt(options: {
  cronExpr: string;
  enabled: boolean;
  fromIso: string;
}): string | null {
  if (!options.enabled) {
    return null;
  }

  return computeNextRunAt(options.cronExpr, options.fromIso);
}

export function createSchedule(options: {
  db: Database;
  input: CreateScheduleInput;
  now?: string;
}): ScheduleRecord {
  const now = normalizeIsoTimestamp(options.now);
  const agentGroupId = normalizeText(options.input.agent_group_id);
  const cronExpr = normalizeText(options.input.cron_expr);
  const prompt = normalizePrompt(options.input.prompt);
  const mode = normalizeMode(options.input.mode);
  const config = normalizeConfig(options.input.config);
  const enabled = normalizeEnabled(options.input.enabled, true);
  const id = crypto.randomUUID();
  const nextRunAt = computeStoredNextRunAt({ cronExpr, enabled, fromIso: now });

  ensureAgentGroupExists(options.db, agentGroupId);

  options.db.prepare(
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
    id,
    agentGroupId,
    cronExpr,
    prompt,
    mode,
    config == null ? null : JSON.stringify(config),
    enabled ? 1 : 0,
    null,
    nextRunAt,
    now,
  );

  return mapScheduleRow(requireScheduleRow(options.db, id));
}

export function listSchedules(options: { db: Database }): ScheduleRecord[] {
  const rows = options.db.prepare(
    `SELECT id, agent_group_id, cron_expr, prompt, mode, config, enabled, last_run_at, next_run_at, created_at
     FROM schedules
     ORDER BY created_at ASC, id ASC`,
  ).all() as ScheduleRow[];

  return rows.map(mapScheduleRow);
}

export function getSchedule(options: { db: Database; id: string }): ScheduleRecord | null {
  const row = readScheduleRow(options.db, options.id);
  return row == null ? null : mapScheduleRow(row);
}

export function updateSchedule(options: {
  db: Database;
  id: string;
  patch: UpdateScheduleInput;
  now?: string;
}): ScheduleRecord {
  const existing = requireScheduleRow(options.db, options.id);
  const now = normalizeIsoTimestamp(options.now);
  const cronExpr = options.patch.cron_expr == null ? existing.cron_expr : normalizeText(options.patch.cron_expr);
  const prompt = options.patch.prompt == null ? existing.prompt : normalizePrompt(options.patch.prompt);
  const mode = normalizeMode(options.patch.mode ?? existing.mode);
  const config = options.patch.config === undefined ? parseStoredConfig(existing.config) : normalizeConfig(options.patch.config);
  const enabled = options.patch.enabled === undefined ? existing.enabled !== 0 : normalizeEnabled(options.patch.enabled, existing.enabled !== 0);
  const nextRunAt = computeStoredNextRunAt({ cronExpr, enabled, fromIso: now });

  options.db.prepare(
    `UPDATE schedules
     SET cron_expr = ?,
         prompt = ?,
         mode = ?,
         config = ?,
         enabled = ?,
         next_run_at = ?
     WHERE id = ?`,
  ).run(
    cronExpr,
    prompt,
    mode,
    config == null ? null : JSON.stringify(config),
    enabled ? 1 : 0,
    nextRunAt,
    options.id,
  );

  return mapScheduleRow(requireScheduleRow(options.db, options.id));
}

export function deleteSchedule(options: { db: Database; id: string }): boolean {
  const result = options.db.prepare('DELETE FROM schedules WHERE id = ?').run(options.id);
  return result.changes > 0;
}

function markScheduleRun(options: {
  db: Database;
  id: string;
  ranAt: string;
}): ScheduleRecord {
  const existing = requireScheduleRow(options.db, options.id);
  const nextRunAt = computeStoredNextRunAt({
    cronExpr: existing.cron_expr,
    enabled: existing.enabled !== 0,
    fromIso: options.ranAt,
  });

  options.db.prepare(
    `UPDATE schedules
     SET last_run_at = ?,
         next_run_at = ?
     WHERE id = ?`,
  ).run(options.ranAt, nextRunAt, options.id);

  return mapScheduleRow(requireScheduleRow(options.db, options.id));
}

export function markScheduleRunSucceeded(options: {
  db: Database;
  id: string;
  ranAt: string;
}): ScheduleRecord {
  return markScheduleRun(options);
}

export function markScheduleRunFailed(options: {
  db: Database;
  id: string;
  ranAt: string;
}): ScheduleRecord {
  return markScheduleRun(options);
}

export function markScheduleRunNotImplemented(options: {
  db: Database;
  id: string;
  ranAt: string;
}): ScheduleRecord {
  return markScheduleRun(options);
}
