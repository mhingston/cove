import type { Database } from 'bun:sqlite';

import { NotFoundError } from '../../control/approvals.ts';
import { openInboundDb, writeInboundMessage } from '../../session/inbound.ts';
import { initSessionFolder } from '../../session/manager.ts';

const DEFAULT_APPROVAL_TTL_MS = 300_000;
const APPROVAL_RESUME_CONTENT = 'Resume approved action.';

type ApprovalStatus = 'pending' | 'approved' | 'declined' | 'expired';

type Approval = {
  id: string;
  agent_group_id: string;
  session_id: string;
  tool_name: string;
  tool_args?: Record<string, unknown>;
  status: ApprovalStatus;
  requested_at: string;
  responded_at?: string;
  expires_at: string;
};

class ExpiredApprovalError extends Error {
  constructor(public approval: Approval) {
    super(`Approval record ${approval.id} has expired`);
    this.name = 'ExpiredApprovalError';
  }
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function getTtlMs(): number {
  const value = process.env.COVE_APPROVAL_TTL_MS;

  if (value != null) {
    const parsed = Number.parseInt(value, 10);

    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return DEFAULT_APPROVAL_TTL_MS;
}

function rowToApproval(row: Record<string, unknown>): Approval {
  return {
    id: row.id as string,
    agent_group_id: row.agent_group_id as string,
    session_id: row.session_id as string,
    tool_name: row.tool_name as string,
    tool_args: typeof row.tool_args === 'string'
      ? JSON.parse(row.tool_args as string) as Record<string, unknown>
      : row.tool_args as Record<string, unknown> | undefined,
    status: row.status as ApprovalStatus,
    requested_at: row.requested_at as string,
    responded_at: (row.responded_at as string | null) ?? undefined,
    expires_at: (row.expires_at as string | null) ?? new Date(Date.now() + getTtlMs()).toISOString(),
  };
}

function isExpired(row: Record<string, unknown>): boolean {
  const expiresAt = row.expires_at as string | undefined;

  if (expiresAt == null) {
    return Date.now() - new Date(row.requested_at as string).getTime() >= getTtlMs();
  }

  return Date.now() >= new Date(expiresAt).getTime();
}

function materializeExpiredApproval(db: Database, row: Record<string, unknown>): Record<string, unknown> {
  if ((row.status as string) !== 'pending' || !isExpired(row)) {
    return row;
  }

  const respondedAt = new Date().toISOString();

  db.prepare('UPDATE approvals SET status = ?, responded_at = ? WHERE id = ?').run(
    'expired',
    respondedAt,
    row.id as string,
  );

  return db.prepare('SELECT * FROM approvals WHERE id = ?').get(row.id as string) as Record<string, unknown>;
}

function getApprovalRow(db: Database, id: string): Record<string, unknown> | undefined {
  const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Record<string, unknown> | undefined;

  return row == null ? undefined : materializeExpiredApproval(db, row);
}

function enqueueApprovalResume(db: Database, approval: Approval): void {
  const sessionRow = db.prepare('SELECT session_file FROM sessions WHERE id = ?').get(approval.session_id) as {
    session_file: string | null;
  } | null;

  if (sessionRow?.session_file == null) {
    return;
  }

  initSessionFolder(sessionRow.session_file);
  const inboundDb = openInboundDb(sessionRow.session_file);

  try {
    writeInboundMessage(inboundDb, {
      id: crypto.randomUUID(),
      role: 'user',
      content: APPROVAL_RESUME_CONTENT,
      metadata: {
        type: 'approval_resume',
        approval_id: approval.id,
        tool_name: approval.tool_name,
        tool_args: approval.tool_args,
      },
    });
  } finally {
    inboundDb.close();
  }
}

function updateApprovalStatus(db: Database, id: string, status: 'approved' | 'declined'): Approval {
  const existingRow = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Record<string, unknown> | undefined;

  if (existingRow == null) {
    throw new NotFoundError(`Approval record not found: ${id}`);
  }

  const existing = materializeExpiredApproval(db, existingRow);

  if ((existing.status as string) === 'expired') {
    throw new ExpiredApprovalError(rowToApproval(existing));
  }

  if ((existing.status as string) !== 'pending') {
    return rowToApproval(existing);
  }

  const respondedAt = new Date().toISOString();

  db.prepare('UPDATE approvals SET status = ?, responded_at = ? WHERE id = ?').run(status, respondedAt, id);

  const updated = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Record<string, unknown>;
  const approval = rowToApproval(updated);

  if (status === 'approved') {
    enqueueApprovalResume(db, approval);
  }

  return approval;
}

function findExistingApproval(db: Database, options: {
  sessionId: string;
  toolName: string;
  toolArgs: string | null;
}): Approval | null {
  const row = db.prepare(
    `SELECT *
     FROM approvals
     WHERE session_id = ?
       AND tool_name = ?
       AND COALESCE(tool_args, '') = COALESCE(?, '')
       AND status IN ('pending', 'approved')
     ORDER BY requested_at DESC, id DESC
     LIMIT 1`,
  ).get(options.sessionId, options.toolName, options.toolArgs) as Record<string, unknown> | undefined;

  if (row == null) {
    return null;
  }

  const materialized = materializeExpiredApproval(db, row);

  if ((materialized.status as string) === 'expired') {
    return null;
  }

  return rowToApproval(materialized);
}

export async function handleCreateApproval(request: Request, db: Database): Promise<Response> {
  let body: Record<string, unknown>;

  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const agentGroupId = typeof body.agent_group_id === 'string' ? body.agent_group_id : undefined;
  const sessionId = typeof body.session_id === 'string' ? body.session_id : undefined;
  const toolName = typeof body.tool_name === 'string' ? body.tool_name : undefined;

  if (agentGroupId == null || sessionId == null || toolName == null) {
    return jsonResponse({ error: 'agent_group_id, session_id, and tool_name are required' }, 400);
  }

  const id = crypto.randomUUID();
  const requestedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + getTtlMs()).toISOString();
  const serializedToolArgs = body.tool_args === undefined ? null : JSON.stringify(body.tool_args);
  const existing = findExistingApproval(db, {
    sessionId,
    toolName,
    toolArgs: serializedToolArgs,
  });

  if (existing != null) {
    return jsonResponse(existing, 201);
  }

  db.prepare(
    `INSERT INTO approvals (id, agent_group_id, session_id, tool_name, tool_args, status, requested_at, responded_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(
    id,
    agentGroupId,
    sessionId,
    toolName,
    serializedToolArgs,
    requestedAt,
    null,
    expiresAt,
  );

  return jsonResponse(rowToApproval(getApprovalRow(db, id) as Record<string, unknown>), 201);
}

export function handleGetApproval(_request: Request, db: Database, params: { id: string }): Response {
  const row = getApprovalRow(db, params.id);

  if (row == null) {
    return jsonResponse({ error: 'Not Found' }, 404);
  }

  return jsonResponse(rowToApproval(row), 200);
}

export function handleListApprovals(request: Request, db: Database): Response {
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const agentGroupId = url.searchParams.get('agent_group_id');
  const conditions: string[] = [];
  const values: string[] = [];

  if (status != null) {
    conditions.push('status = ?');
    values.push(status);
  }

  if (agentGroupId != null) {
    conditions.push('agent_group_id = ?');
    values.push(agentGroupId);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM approvals ${whereClause} ORDER BY requested_at DESC`).all(...values) as Record<string, unknown>[];

  return jsonResponse(rows.map((row) => rowToApproval(materializeExpiredApproval(db, row))), 200);
}

export function handleApproveApproval(_request: Request, db: Database, params: { id: string }): Response {
  try {
    return jsonResponse(updateApprovalStatus(db, params.id, 'approved'), 200);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return jsonResponse({ error: 'Not Found' }, 404);
    }

    if (error instanceof ExpiredApprovalError) {
      return jsonResponse({ error: 'Approval has expired', ...error.approval }, 409);
    }

    throw error;
  }
}

export function handleDeclineApproval(_request: Request, db: Database, params: { id: string }): Response {
  try {
    return jsonResponse(updateApprovalStatus(db, params.id, 'declined'), 200);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return jsonResponse({ error: 'Not Found' }, 404);
    }

    if (error instanceof ExpiredApprovalError) {
      return jsonResponse({ error: 'Approval has expired', ...error.approval }, 409);
    }

    throw error;
  }
}
