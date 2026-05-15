import type { Database } from 'bun:sqlite';

import { stopAndForgetContainersForAgentGroup } from '../../container/spawn.ts';
import type { AgentGroupRow } from '../../shared/types.ts';

type AgentGroupApiRow = Omit<AgentGroupRow, 'permissions' | 'config'> & {
  permissions: Record<string, unknown>;
  config: Record<string, unknown> | null;
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function parseJsonStringRecord(value: string | null, fallback: Record<string, unknown> | null): Record<string, unknown> | null {
  if (value == null || value.trim() === '') {
    return fallback;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function toAgentGroupApiRow(row: AgentGroupRow): AgentGroupApiRow {
  return {
    ...row,
    permissions: parseJsonStringRecord(row.permissions, { default: 'auto' }) ?? { default: 'auto' },
    config: parseJsonStringRecord(row.config, null),
  };
}

function normalizeNonEmptyString(value: string, fieldName: string): string {
  const normalized = value.trim();

  if (normalized === '') {
    throw new Error(`${fieldName} is required and must be a non-empty string`);
  }

  return normalized;
}

function parseOptionalNullableString(
  value: unknown,
  fieldName: string,
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string or null`);
  }

  return value;
}

function parseRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} is required and must be a string`);
  }

  return normalizeNonEmptyString(value, fieldName);
}

function parseOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }

  return value;
}

function parseRequiredJsonObject(value: unknown, fieldName: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object`);
  }

  return value;
}

function parseOptionalJsonObjectOrNull(value: unknown, fieldName: string): Record<string, unknown> | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object or null`);
  }

  return value;
}

function serializeJson(value: Record<string, unknown> | null): string | null {
  return value == null ? null : JSON.stringify(value);
}

async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new Error('Invalid JSON body');
  }
}

type CreateAgentGroupInput = {
  id: string;
  name: string;
  description: string | null;
  workspace: string | null;
  provider: string;
  model: string | null;
  thinking: string;
  permissions: Record<string, unknown>;
  soul: string | null;
  config: Record<string, unknown> | null;
};

type UpdateAgentGroupPatch = {
  name?: string;
  description?: string | null;
  workspace?: string | null;
  provider?: string;
  model?: string | null;
  thinking?: string;
  permissions?: Record<string, unknown>;
  soul?: string | null;
  config?: Record<string, unknown> | null;
};

function parseCreateBody(body: unknown): CreateAgentGroupInput {
  if (!isRecord(body)) {
    throw new Error('Agent group payload must be a JSON object');
  }

  return {
    id: parseRequiredString(body.id, 'id'),
    name: parseRequiredString(body.name, 'name'),
    description: parseOptionalNullableString(body.description, 'description') ?? null,
    workspace: parseOptionalNullableString(body.workspace, 'workspace') ?? null,
    provider: parseOptionalString(body.provider, 'provider') ?? 'auto',
    model: parseOptionalNullableString(body.model, 'model') ?? null,
    thinking: parseOptionalString(body.thinking, 'thinking') ?? 'medium',
    permissions: body.permissions === undefined
      ? { default: 'auto' }
      : parseRequiredJsonObject(body.permissions, 'permissions'),
    soul: parseOptionalNullableString(body.soul, 'soul') ?? null,
    config: parseOptionalJsonObjectOrNull(body.config, 'config') ?? null,
  };
}

function parseUpdateBody(body: unknown): UpdateAgentGroupPatch {
  if (!isRecord(body)) {
    throw new Error('Agent group payload must be a JSON object');
  }

  const patch: UpdateAgentGroupPatch = {};

  if (body.name !== undefined) {
    patch.name = parseRequiredString(body.name, 'name');
  }

  if (body.description !== undefined) {
    patch.description = parseOptionalNullableString(body.description, 'description');
  }

  if (body.workspace !== undefined) {
    patch.workspace = parseOptionalNullableString(body.workspace, 'workspace');
  }

  if (body.provider !== undefined) {
    patch.provider = parseOptionalString(body.provider, 'provider');
  }

  if (body.model !== undefined) {
    patch.model = parseOptionalNullableString(body.model, 'model');
  }

  if (body.thinking !== undefined) {
    patch.thinking = parseOptionalString(body.thinking, 'thinking');
  }

  if (body.permissions !== undefined) {
    patch.permissions = parseRequiredJsonObject(body.permissions, 'permissions');
  }

  if (body.soul !== undefined) {
    patch.soul = parseOptionalNullableString(body.soul, 'soul');
  }

  if (body.config !== undefined) {
    patch.config = parseOptionalJsonObjectOrNull(body.config, 'config');
  }

  return patch;
}

function getAgentGroup(db: Database, id: string): AgentGroupRow | null {
  const row = db.prepare(
    `SELECT id, name, description, workspace, provider, model, thinking, permissions, soul, config, created_at, updated_at
     FROM agent_groups
     WHERE id = ?`,
  ).get(id);

  return row == null ? null : row as AgentGroupRow;
}

function listAgentGroups(db: Database): AgentGroupApiRow[] {
  const rows = db.prepare(
    `SELECT id, name, description, workspace, provider, model, thinking, permissions, soul, config, created_at, updated_at
     FROM agent_groups
     ORDER BY created_at ASC, id ASC`,
  ).all() as AgentGroupRow[];

  return rows.map(toAgentGroupApiRow);
}

function createAgentGroup(db: Database, input: CreateAgentGroupInput): AgentGroupApiRow {
  const now = new Date().toISOString();

  try {
    db.prepare(
      `INSERT INTO agent_groups (
         id,
         name,
         description,
         workspace,
         provider,
         model,
         thinking,
         permissions,
         soul,
         config,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.name,
      input.description,
      input.workspace,
      input.provider,
      input.model,
      input.thinking,
      JSON.stringify(input.permissions),
      input.soul,
      serializeJson(input.config),
      now,
      now,
    );
  } catch (error) {
    if (error instanceof Error && /unique constraint failed/i.test(error.message)) {
      throw new Error(`Agent group already exists: ${input.id}`);
    }

    throw error;
  }

  const created = getAgentGroup(db, input.id);
  if (created == null) {
    throw new Error('Failed to create agent group');
  }

  return toAgentGroupApiRow(created);
}

function updateAgentGroup(db: Database, id: string, patch: UpdateAgentGroupPatch): AgentGroupApiRow | null {
  const existing = getAgentGroup(db, id);
  if (existing == null) {
    return null;
  }

  const recognizedPatchEntries = Object.entries(patch).filter(([, value]) => value !== undefined);

  if (recognizedPatchEntries.length === 0) {
    return toAgentGroupApiRow(existing);
  }

  const now = new Date().toISOString();
  const existingConfig = toAgentGroupApiRow(existing);

  db.prepare(
    `UPDATE agent_groups
     SET name = ?,
         description = ?,
         workspace = ?,
         provider = ?,
         model = ?,
         thinking = ?,
         permissions = ?,
         soul = ?,
         config = ?,
         updated_at = ?
     WHERE id = ?`,
  ).run(
    patch.name ?? existing.name,
    patch.description === undefined ? existing.description : patch.description,
    patch.workspace === undefined ? existing.workspace : patch.workspace,
    patch.provider ?? existing.provider,
    patch.model === undefined ? existing.model : patch.model,
    patch.thinking ?? existing.thinking,
    JSON.stringify(patch.permissions ?? existingConfig.permissions),
    patch.soul === undefined ? existing.soul : patch.soul,
    patch.config === undefined ? serializeJson(existingConfig.config) : serializeJson(patch.config),
    now,
    id,
  );

  const updated = getAgentGroup(db, id);
  if (updated == null) {
    throw new Error('Failed to update agent group');
  }

  return toAgentGroupApiRow(updated);
}

function findDeleteDependencies(db: Database, agentGroupId: string): string[] {
  const dependencies = [
    ['sessions', 'SELECT 1 AS found FROM sessions WHERE agent_group_id = ? LIMIT 1'],
    ['schedules', 'SELECT 1 AS found FROM schedules WHERE agent_group_id = ? LIMIT 1'],
    ['approvals', 'SELECT 1 AS found FROM approvals WHERE agent_group_id = ? LIMIT 1'],
    ['memories', 'SELECT 1 AS found FROM memories WHERE agent_group_id = ? LIMIT 1'],
  ] as const;

  return dependencies
    .filter(([, sql]) => db.prepare(sql).get(agentGroupId) != null)
    .map(([name]) => name);
}

function deleteAgentGroup(db: Database, id: string): boolean {
  return db.prepare('DELETE FROM agent_groups WHERE id = ?').run(id).changes > 0;
}

function mapAgentGroupError(error: unknown): Response {
  const message = error instanceof Error ? error.message : 'Invalid agent group request';

  if (
    message === 'Invalid JSON body'
    || message === 'Agent group payload must be a JSON object'
    || message === 'id is required and must be a string'
    || message === 'id is required and must be a non-empty string'
    || message === 'name is required and must be a string'
    || message === 'name is required and must be a non-empty string'
    || message === 'description must be a string or null'
    || message === 'workspace must be a string or null'
    || message === 'provider must be a string'
    || message === 'model must be a string or null'
    || message === 'thinking must be a string'
    || message === 'permissions must be an object'
    || message === 'soul must be a string or null'
    || message === 'config must be an object or null'
  ) {
    return jsonResponse({ error: message }, 400);
  }

  if (message === 'Not Found') {
    return jsonResponse({ error: message }, 404);
  }

  if (/^Agent group already exists: /.test(message) || /^Agent group has dependent records in: /.test(message)) {
    return jsonResponse({ error: message }, 409);
  }

  return jsonResponse({ error: 'Failed to handle agent group request' }, 500);
}

export async function handleCreateAgentGroup(request: Request, db: Database): Promise<Response> {
  try {
    const created = createAgentGroup(db, parseCreateBody(await parseJsonBody(request)));
    return jsonResponse(created, 201);
  } catch (error) {
    return mapAgentGroupError(error);
  }
}

export function handleListAgentGroups(_request: Request, db: Database): Response {
  try {
    return jsonResponse(listAgentGroups(db), 200);
  } catch {
    return jsonResponse({ error: 'Failed to load agent groups' }, 500);
  }
}

export function handleGetAgentGroup(_request: Request, db: Database, params: { id: string }): Response {
  try {
    const row = getAgentGroup(db, params.id);

    if (row == null) {
      return jsonResponse({ error: 'Not Found' }, 404);
    }

    return jsonResponse(toAgentGroupApiRow(row), 200);
  } catch {
    return jsonResponse({ error: 'Failed to load agent group' }, 500);
  }
}

export async function handleUpdateAgentGroup(request: Request, db: Database, params: { id: string }): Promise<Response> {
  try {
    const updated = updateAgentGroup(db, params.id, parseUpdateBody(await parseJsonBody(request)));

    if (updated == null) {
      return jsonResponse({ error: 'Not Found' }, 404);
    }

    return jsonResponse(updated, 200);
  } catch (error) {
    return mapAgentGroupError(error);
  }
}

export function handleDeleteAgentGroup(_request: Request, db: Database, params: { id: string }): Response {
  try {
    const existing = getAgentGroup(db, params.id);

    if (existing == null) {
      return jsonResponse({ error: 'Not Found' }, 404);
    }

    const dependencies = findDeleteDependencies(db, params.id);
    if (dependencies.length > 0) {
      return jsonResponse({ error: `Agent group has dependent records in: ${dependencies.join(', ')}` }, 409);
    }

    if (!deleteAgentGroup(db, params.id)) {
      return jsonResponse({ error: 'Not Found' }, 404);
    }

    stopAndForgetContainersForAgentGroup(params.id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return mapAgentGroupError(error);
  }
}
