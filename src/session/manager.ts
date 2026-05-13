import type { Database } from 'bun:sqlite';
import path from 'node:path';

import { openInboundDb } from './inbound.ts';
import { openOutboundDb } from './outbound.ts';
import type { SessionRow } from '../shared/types.ts';

export function initSessionFolder(sessionDir: string): void {
  using inboundDb = openInboundDb(sessionDir);
  using outboundDb = openOutboundDb(sessionDir);

  void inboundDb;
  void outboundDb;
}

type CreateSessionForThreadOptions = {
  db: Database;
  stateDir: string;
  agentGroupId: string;
  threadId: string;
};

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /unique constraint failed/i.test(error.message);
}

function mapSessionRow(row: unknown): SessionRow {
  return row as SessionRow;
}

function getSessionDir(stateDir: string, agentGroupId: string, sessionId: string): string {
  return path.join(stateDir, 'sessions', agentGroupId, sessionId);
}

function getSessionByThread(db: Database, agentGroupId: string, threadId: string): SessionRow | null {
  const row = db
    .prepare(
      `SELECT id, agent_group_id, thread_id, session_file, metadata, created_at, updated_at
       FROM sessions
       WHERE agent_group_id = ? AND thread_id = ?`,
    )
    .get(agentGroupId, threadId);

  return row == null ? null : mapSessionRow(row);
}

function ensureSessionFile(options: {
  db: Database;
  stateDir: string;
  session: SessionRow;
}): SessionRow {
  if (options.session.session_file != null) {
    initSessionFolder(options.session.session_file);
    return options.session;
  }

  const sessionFile = getSessionDir(
    options.stateDir,
    options.session.agent_group_id,
    options.session.id,
  );
  const updatedAt = new Date().toISOString();

  options.db
    .prepare('UPDATE sessions SET session_file = ?, updated_at = ? WHERE id = ?')
    .run(sessionFile, updatedAt, options.session.id);

  const updatedSession: SessionRow = {
    ...options.session,
    session_file: sessionFile,
    updated_at: updatedAt,
  };

  initSessionFolder(sessionFile);

  return updatedSession;
}

export function ensureSessionForRuntime(options: {
  db: Database;
  stateDir: string;
  session: SessionRow;
}): SessionRow {
  return ensureSessionFile(options);
}

export function createSessionForThread(options: CreateSessionForThreadOptions): SessionRow {
  const existing = getSessionByThread(options.db, options.agentGroupId, options.threadId);

  if (existing != null) {
    return ensureSessionForRuntime({
      db: options.db,
      stateDir: options.stateDir,
      session: existing,
    });
  }

  const session: SessionRow = {
    id: crypto.randomUUID(),
    agent_group_id: options.agentGroupId,
    thread_id: options.threadId,
    session_file: null,
    metadata: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  session.session_file = getSessionDir(options.stateDir, options.agentGroupId, session.id);

  try {
    options.db
      .prepare(
        `INSERT INTO sessions (id, agent_group_id, thread_id, session_file, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.agent_group_id,
        session.thread_id,
        session.session_file,
        session.metadata,
        session.created_at,
        session.updated_at,
      );

    initSessionFolder(session.session_file);
    return session;
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }

    const winningSession = getSessionByThread(options.db, options.agentGroupId, options.threadId);

    if (winningSession == null) {
      throw error;
    }

    return ensureSessionForRuntime({
      db: options.db,
      stateDir: options.stateDir,
      session: winningSession,
    });
  }
}
