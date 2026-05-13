import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';

import type { InboundMessageInput, InboundMessageRow } from '../shared/types.ts';

const INBOUND_DB_NAME = 'inbound.db';
const ALLOWED_INBOUND_ROLE = 'user';

export function getInboundDbPath(sessionDir: string): string {
  return path.join(sessionDir, INBOUND_DB_NAME);
}

export function openInboundDb(sessionDir: string): Database {
  fs.mkdirSync(sessionDir, { recursive: true });

  const db = new Database(getInboundDbPath(sessionDir));
  db.exec('PRAGMA journal_mode = DELETE');
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages_in (
      id         TEXT PRIMARY KEY,
      seq        INTEGER NOT NULL UNIQUE CHECK (seq % 2 = 0),
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      metadata   TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_config (
      provider       TEXT NOT NULL,
      model          TEXT NOT NULL,
      thinking_level TEXT,
      api_key        TEXT,
      workspace      TEXT,
      extra_env      TEXT,
      permissions    TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS session_config_singleton_idx
    ON session_config ((1));
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS session_config_singleton_guard
    BEFORE INSERT ON session_config
    WHEN (SELECT COUNT(*) FROM session_config) >= 1
    BEGIN
      SELECT RAISE(FAIL, 'session_config must remain a singleton row');
    END;
  `);

  return db;
}

export function writeInboundMessage(db: Database, message: InboundMessageInput): InboundMessageRow {
  if (message.role !== ALLOWED_INBOUND_ROLE) {
    throw new Error('writeInboundMessage only accepts user executable work messages');
  }

  const maxSeqRow = db.prepare('SELECT MAX(seq) AS maxSeq FROM messages_in').get() as {
    maxSeq: number | null;
  };
  const seq = (maxSeqRow.maxSeq ?? 0) + 2;
  const createdAt = new Date().toISOString();
  const metadata = message.metadata === undefined ? null : JSON.stringify(message.metadata);

  db.prepare(
    `INSERT INTO messages_in (id, seq, role, content, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(message.id, seq, message.role, message.content, metadata, createdAt);

  return {
    id: message.id,
    seq,
    role: message.role,
    content: message.content,
    metadata,
    created_at: createdAt,
  };
}
