import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openInboundDb, writeInboundMessage } from '../../src/session/inbound.ts';
import { initSessionFolder } from '../../src/session/manager.ts';
import { openOutboundDb, writeOutboundMessage } from '../../src/session/outbound.ts';

const tempDirs: string[] = [];

function makeTempSessionDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cove-v2-session-'));
  tempDirs.push(dir);
  return dir;
}

function closeDb(db: Database | undefined): void {
  db?.close();
}

function getTableColumns(db: Database, tableName: string): { name: string; type: string; notnull: number; pk: number }[] {
  return db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .map((column) => {
      const typedColumn = column as { name: string; type: string; notnull: number; pk: number };

      return {
        name: typedColumn.name,
        type: typedColumn.type,
        notnull: typedColumn.notnull,
        pk: typedColumn.pk,
      };
    });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('session DB helpers', () => {
  it('initSessionFolder eagerly creates the session directory and both db files', () => {
    const sessionDir = path.join(makeTempSessionDir(), 'session-1');

    initSessionFolder(sessionDir);

    expect(fs.existsSync(sessionDir)).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, 'inbound.db'))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, 'outbound.db'))).toBe(true);
  });

  it('creates inbound.db with delete journal mode plus messages_in and singleton session_config tables', () => {
    const sessionDir = makeTempSessionDir();
    const db = openInboundDb(sessionDir);

    const journalModeRow = db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get();
    const tables = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string; sql: string }[];
    const sessionConfigSql = tables.find((table) => table.name === 'session_config')?.sql;
    const sessionConfigColumns = getTableColumns(db, 'session_config');

    expect(journalModeRow?.journal_mode.toLowerCase()).toBe('delete');
    expect(tables.map((table) => table.name)).toEqual(['messages_in', 'session_config']);
    expect(sessionConfigSql).toBe(`CREATE TABLE session_config (
      provider       TEXT NOT NULL,
      model          TEXT NOT NULL,
      thinking_level TEXT,
      api_key        TEXT,
      workspace      TEXT,
      extra_env      TEXT,
      permissions    TEXT
    )`);
    expect(sessionConfigColumns).toEqual([
      { name: 'provider', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'model', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'thinking_level', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'api_key', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'workspace', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'extra_env', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'permissions', type: 'TEXT', notnull: 0, pk: 0 },
    ]);

    closeDb(db);
  });

  it('enforces session_config as a singleton table', () => {
    const sessionDir = makeTempSessionDir();
    const db = openInboundDb(sessionDir);

    db.prepare(
      `INSERT INTO session_config (provider, model, thinking_level, api_key, workspace, extra_env, permissions)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('openai', 'gpt-5', 'medium', 'secret', '/workspace', '{"DEBUG":"1"}', '{"default":"auto"}');

    expect(() =>
      db.prepare(
        `INSERT INTO session_config (provider, model, thinking_level, api_key, workspace, extra_env, permissions)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('anthropic', 'claude-sonnet', null, null, null, null, null),
    ).toThrow(/singleton/i);

    const rows = db.prepare('SELECT provider, model FROM session_config').all() as {
      provider: string;
      model: string;
    }[];

    expect(rows).toEqual([{ provider: 'openai', model: 'gpt-5' }]);

    closeDb(db);
  });

  it('creates outbound.db with delete journal mode plus messages_out and processing_ack tables', () => {
    const sessionDir = makeTempSessionDir();
    const db = openOutboundDb(sessionDir);

    const journalModeRow = db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    const processingAckColumns = getTableColumns(db, 'processing_ack');

    expect(journalModeRow?.journal_mode.toLowerCase()).toBe('delete');
    expect(tables.map((table) => table.name)).toEqual(['messages_out', 'processing_ack']);
    expect(processingAckColumns).toEqual([
      { name: 'session_id', type: 'TEXT', notnull: 0, pk: 1 },
      { name: 'last_in_seq', type: 'INTEGER', notnull: 0, pk: 0 },
      { name: 'last_out_seq', type: 'INTEGER', notnull: 0, pk: 0 },
      { name: 'container_id', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'heartbeat_at', type: 'TEXT', notnull: 1, pk: 0 },
    ]);

    closeDb(db);
  });

  it('writeInboundMessage stores user executable work messages with metadata JSON and allocates even seq values starting at 2', () => {
    const sessionDir = makeTempSessionDir();
    const db = openInboundDb(sessionDir);

    const first = writeInboundMessage(db, {
      id: 'msg-1',
      role: 'user',
      content: 'Run the task',
      metadata: { executable: true, type: 'approval_resume' },
    });
    const second = writeInboundMessage(db, {
      id: 'msg-2',
      role: 'user',
      content: 'Continue',
    });

    const rows = db
      .prepare('SELECT id, seq, role, content, metadata FROM messages_in ORDER BY seq')
      .all() as {
      id: string;
      seq: number;
      role: string;
      content: string;
      metadata: string | null;
    }[];

    expect(first.seq).toBe(2);
    expect(second.seq).toBe(4);
    expect(rows).toEqual([
      {
        id: 'msg-1',
        seq: 2,
        role: 'user',
        content: 'Run the task',
        metadata: JSON.stringify({ executable: true, type: 'approval_resume' }),
      },
      {
        id: 'msg-2',
        seq: 4,
        role: 'user',
        content: 'Continue',
        metadata: null,
      },
    ]);

    closeDb(db);
  });

  it('writeInboundMessage rejects assistant, system, and tool transcript replay roles', () => {
    const sessionDir = makeTempSessionDir();
    const db = openInboundDb(sessionDir);

    expect(() =>
      writeInboundMessage(db, {
        id: 'msg-assistant',
        role: 'assistant',
        content: 'replayed assistant output',
      }),
    ).toThrow(/user/i);
    expect(() =>
      writeInboundMessage(db, {
        id: 'msg-system',
        role: 'system',
        content: 'replayed system prompt',
      }),
    ).toThrow(/user/i);
    expect(() =>
      writeInboundMessage(db, {
        id: 'msg-tool',
        role: 'tool',
        content: 'replayed tool output',
      }),
    ).toThrow(/user/i);

    const countRow = db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM messages_in').get();

    expect(countRow?.count).toBe(0);

    closeDb(db);
  });

  it('writeInboundMessage continues even sequence allocation after reopening inbound.db', () => {
    const sessionDir = makeTempSessionDir();
    const firstDb = openInboundDb(sessionDir);

    const first = writeInboundMessage(firstDb, {
      id: 'msg-1',
      role: 'user',
      content: 'First',
    });

    closeDb(firstDb);

    const secondDb = openInboundDb(sessionDir);

    const second = writeInboundMessage(secondDb, {
      id: 'msg-2',
      role: 'user',
      content: 'Second',
    });

    expect(first.seq).toBe(2);
    expect(second.seq).toBe(4);

    closeDb(secondDb);
  });

  it('rejects odd executable queue seq values in messages_in at the db boundary', () => {
    const sessionDir = makeTempSessionDir();
    const db = openInboundDb(sessionDir);

    expect(() =>
      db.prepare(
        `INSERT INTO messages_in (id, seq, role, content, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('msg-odd', 3, 'user', 'Odd seq should be rejected', null, '2026-01-01T00:00:00.000Z'),
    ).toThrow(/constraint|check/i);

    const countRow = db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM messages_in').get();

    expect(countRow?.count).toBe(0);

    closeDb(db);
  });

  it('writeOutboundMessage rejects even executable queue seq values', () => {
    const sessionDir = makeTempSessionDir();
    const db = openOutboundDb(sessionDir);

    expect(() =>
      writeOutboundMessage(db, {
        id: 'out-even',
        seq: 4,
        role: 'assistant',
        content: 'Even seq should be rejected',
      }),
    ).toThrow(/odd/i);

    const countRow = db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM messages_out').get();

    expect(countRow?.count).toBe(0);

    closeDb(db);
  });
});
