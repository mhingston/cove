import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';

import type {
  OutboundMessageInput,
  OutboundMessageRow,
  ProcessingAckInput,
  ProcessingAckRow,
} from '../shared/types.ts';

const OUTBOUND_DB_NAME = 'outbound.db';

export function getOutboundDbPath(sessionDir: string): string {
  return path.join(sessionDir, OUTBOUND_DB_NAME);
}

export function openOutboundDb(sessionDir: string): Database {
  fs.mkdirSync(sessionDir, { recursive: true });

  const db = new Database(getOutboundDbPath(sessionDir));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages_out (
      id            TEXT PRIMARY KEY,
      seq           INTEGER NOT NULL UNIQUE,
      role          TEXT NOT NULL,
      content       TEXT NOT NULL,
      finish_reason TEXT,
      tool_calls    TEXT,
      metadata      TEXT,
      created_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS processing_ack (
      session_id   TEXT PRIMARY KEY,
      last_in_seq  INTEGER,
      last_out_seq INTEGER,
      container_id TEXT,
      heartbeat_at TEXT NOT NULL
    );
  `);

  return db;
}

export function openExistingOutboundDb(sessionDir: string): Database {
  const dbPath = getOutboundDbPath(sessionDir);

  if (!fs.existsSync(dbPath)) {
    return openOutboundDb(sessionDir);
  }

  const db = new Database(dbPath);
  db.exec('PRAGMA query_only = ON');
  return db;
}

export function getNextOutboundSeq(lastOutSeq: number | null, inboundSeq: number): number {
  return Math.max((lastOutSeq ?? 1) + 2, inboundSeq + 1);
}

export function writeOutboundMessage(db: Database, message: OutboundMessageInput): OutboundMessageRow {
  if (message.seq % 2 === 0) {
    throw new Error('writeOutboundMessage only accepts odd executable queue seq values');
  }

  const createdAt = new Date().toISOString();
  const finishReason = message.finish_reason ?? null;
  const toolCalls = message.tool_calls === undefined ? null : JSON.stringify(message.tool_calls);
  const metadata = message.metadata === undefined ? null : JSON.stringify(message.metadata);

  db.prepare(
    `INSERT INTO messages_out (id, seq, role, content, finish_reason, tool_calls, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    message.id,
    message.seq,
    message.role,
    message.content,
    finishReason,
    toolCalls,
    metadata,
    createdAt,
  );

  return {
    id: message.id,
    seq: message.seq,
    role: message.role,
    content: message.content,
    finish_reason: finishReason,
    tool_calls: toolCalls,
    metadata,
    created_at: createdAt,
  };
}

export function readVisibleOutboundMessages(db: Database, baselineOutSeq: number): OutboundMessageRow[] {
  return db
    .prepare(
      `SELECT id, seq, role, content, finish_reason, tool_calls, metadata, created_at
       FROM messages_out
       WHERE seq > ?
       ORDER BY seq`,
    )
    .all(baselineOutSeq) as OutboundMessageRow[];
}

export function writeProcessingAck(db: Database, ack: ProcessingAckInput): ProcessingAckRow {
  const persistedAck: ProcessingAckRow = {
    ...ack,
    container_id: ack.container_id ?? null,
  };

  db.prepare(
    `INSERT INTO processing_ack (session_id, last_in_seq, last_out_seq, container_id, heartbeat_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       last_in_seq = CASE
         WHEN processing_ack.last_in_seq IS NULL THEN excluded.last_in_seq
         WHEN excluded.last_in_seq IS NULL THEN processing_ack.last_in_seq
         WHEN excluded.last_in_seq > processing_ack.last_in_seq THEN excluded.last_in_seq
         ELSE processing_ack.last_in_seq
       END,
       last_out_seq = CASE
         WHEN processing_ack.last_out_seq IS NULL THEN excluded.last_out_seq
         WHEN excluded.last_out_seq IS NULL THEN processing_ack.last_out_seq
         WHEN excluded.last_out_seq > processing_ack.last_out_seq THEN excluded.last_out_seq
         ELSE processing_ack.last_out_seq
       END,
       container_id = excluded.container_id,
       heartbeat_at = excluded.heartbeat_at`,
  ).run(
    persistedAck.session_id,
    persistedAck.last_in_seq,
    persistedAck.last_out_seq,
    persistedAck.container_id,
    persistedAck.heartbeat_at,
  );

  return persistedAck;
}

export function readProcessingAck(db: Database, sessionId: string): ProcessingAckRow | null {
  const row = db
    .prepare(
      `SELECT session_id, last_in_seq, last_out_seq, container_id, heartbeat_at
       FROM processing_ack
       WHERE session_id = ?`,
    )
    .get(sessionId);

  return (row as ProcessingAckRow | null) ?? null;
}
