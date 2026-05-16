import type { Database } from 'bun:sqlite';
import { getStateDir } from './db/index.ts';
import { createSessionForThread, ensureSessionForRuntime, initSessionFolder } from './session/manager.ts';
import type { AgentGroupRow, ChatRoutingBody, RoutedRequest, SessionRow } from './shared/types.ts';

type ResolveThreadIdOptions = {
  request: Request;
  body: ChatRoutingBody;
};

type RouteRequestOptions = {
  db: Database;
  request: Request;
  body: ChatRoutingBody;
  stateDir?: string;
};

function normalizeText(value: string | null | undefined): string | undefined {
  if (value == null) {
    return undefined;
  }

  const normalized = value.trim();
  return normalized === '' ? undefined : normalized;
}

function getSessionById(db: Database, sessionId: string): SessionRow {
  const row = db
    .prepare(
      `SELECT id, agent_group_id, thread_id, session_file, metadata, created_at, updated_at
       FROM sessions
       WHERE id = ?`,
    )
    .get(sessionId);

  if (row == null) {
    throw new Error(`Session ${sessionId} not found`);
  }

  return row as SessionRow;
}

function getSessionByThread(db: Database, agentGroupId: string, threadId: string): SessionRow {
  const row = db
    .prepare(
      `SELECT id, agent_group_id, thread_id, session_file, metadata, created_at, updated_at
       FROM sessions
       WHERE agent_group_id = ? AND thread_id = ?`,
    )
    .get(agentGroupId, threadId);

  if (row == null) {
    throw new Error(`Session ${agentGroupId}/${threadId} not found`);
  }

  return row as SessionRow;
}

function resolveAgentGroupId(options: ResolveThreadIdOptions): string {
  return (
    normalizeText(options.body.agent_group_id) ??
    normalizeText(options.request.headers.get('X-Agent-Group-Id')) ??
    'default'
  );
}

function getAgentGroup(db: Database, agentGroupId: string): AgentGroupRow {
  const row = db
    .prepare(
      `SELECT id, name, description, workspace, provider, model, thinking, permissions, soul, config, created_at, updated_at
       FROM agent_groups
       WHERE id = ?`,
    )
    .get(agentGroupId);

  if (row == null) {
    throw new Error(`Agent group ${agentGroupId} not found`);
  }

  return row as AgentGroupRow;
}

function requestOmittedThreadId(options: ResolveThreadIdOptions): boolean {
  return (
    normalizeText(options.body.thread_id) == null &&
    normalizeText(options.request.headers.get('X-Thread-Id')) == null
  );
}

function getLegacySession(db: Database, agentGroupId: string): SessionRow | null {
  const row = db
    .prepare(
      `SELECT id, agent_group_id, thread_id, session_file, metadata, created_at, updated_at
       FROM sessions
       WHERE agent_group_id = ? AND thread_id IS NULL
       ORDER BY created_at ASC, id ASC
       LIMIT 1`,
    )
    .get(agentGroupId);

  return row == null ? null : (row as SessionRow);
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /unique constraint failed/i.test(error.message);
}

function adoptLegacySession(options: {
  db: Database;
  agentGroupId: string;
  threadId: string;
  stateDir: string;
  legacySession: SessionRow;
}): SessionRow {
  const updatedAt = new Date().toISOString();

  try {
    options.db
      .prepare('UPDATE sessions SET thread_id = ?, updated_at = ? WHERE id = ?')
      .run(options.threadId, updatedAt, options.legacySession.id);

    return ensureSessionForRuntime({
      db: options.db,
      stateDir: options.stateDir,
      session: {
      ...options.legacySession,
      thread_id: options.threadId,
      updated_at: updatedAt,
      },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }

    return ensureSessionForRuntime({
      db: options.db,
      stateDir: options.stateDir,
      session: getSessionByThread(options.db, options.agentGroupId, options.threadId),
    });
  }
}

export function resolveThreadId(options: ResolveThreadIdOptions): string {
  return normalizeText(options.body.thread_id) ?? normalizeText(options.request.headers.get('X-Thread-Id')) ?? 'default';
}

export function routeRequest(options: RouteRequestOptions): RoutedRequest {
  const agentGroupId = resolveAgentGroupId(options);
  const threadId = resolveThreadId(options);
  const agentGroup = getAgentGroup(options.db, agentGroupId);
  const stateDir = options.stateDir ?? getStateDir();

  const session = requestOmittedThreadId(options)
    ? (() => {
        const legacySession = getLegacySession(options.db, agentGroupId);

        if (legacySession != null) {
          return adoptLegacySession({
            db: options.db,
            agentGroupId,
            threadId,
            stateDir,
            legacySession,
          });
        }

        return createSessionForThread({
          db: options.db,
          stateDir,
          agentGroupId,
          threadId,
        });
      })()
    : createSessionForThread({
        db: options.db,
        stateDir,
        agentGroupId,
        threadId,
      });

  return {
    agentGroup,
    threadId,
    session: session.session_file == null ? getSessionById(options.db, session.id) : session,
  };
}
