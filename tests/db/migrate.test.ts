import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getDb } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';

const schemaPath = path.join(import.meta.dir, '../../src/db/schema.sql');
const initialMigrationPath = path.join(import.meta.dir, '../../src/db/migrations/001_initial.sql');

const tempDirs: string[] = [];

function makeTempStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cove-v2-db-'));
  tempDirs.push(dir);
  return dir;
}

function createLegacyDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(fs.readFileSync(initialMigrationPath, 'utf8'));
  db.prepare('INSERT INTO schema_version (version, name, applied) VALUES (?, ?, ?)').run(
    1,
    '001_initial',
    new Date().toISOString(),
  );
  return db;
}

afterEach(() => {
  delete process.env.COVE_STATE_DIR;

  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('DB migrations', () => {
  it('ships a canonical schema with the plan-aligned central tables and schedules.config', () => {
    const schema = fs.readFileSync(schemaPath, 'utf8');

    expect(schema).toContain('CREATE TABLE IF NOT EXISTS agent_groups');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS sessions');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS wiki_entries');
    expect(schema).toContain('CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS memories');
    expect(schema).toContain('CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS schedules');
    expect(schema).toContain('config         TEXT');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS approvals');
    expect(schema).toContain("expires_at     TEXT NOT NULL DEFAULT (datetime('now', '+5 minutes'))");
    expect(schema).not.toContain('CREATE TRIGGER IF NOT EXISTS approvals_set_expires_at_after_insert');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS schema_version');
  });

  it('tracks migrations by name instead of by file number', () => {
    const db = createLegacyDb();

    migrate(db);

    const appliedNames = db
      .prepare('SELECT name FROM schema_version ORDER BY version')
      .all() as { name: string }[];

    expect(appliedNames.map((row) => row.name)).toEqual([
      '001_initial',
      '002_approvals_expiry',
      '003_sessions_thread_uniqueness',
      '004_agent_group_defaults',
      '005_schedules_config',
    ]);

    db.close();
  });

  it('allocates the next schema version from the max applied version when history is non-contiguous', () => {
    const db = createLegacyDb();

    db.prepare('INSERT INTO schema_version (version, name, applied) VALUES (?, ?, ?)').run(
      4,
      'legacy_manual_marker',
      new Date().toISOString(),
    );

    migrate(db);

    const appliedVersions = db
      .prepare('SELECT version, name FROM schema_version ORDER BY version')
      .all() as { version: number; name: string }[];

    expect(appliedVersions).toEqual([
      { version: 1, name: '001_initial' },
      { version: 4, name: 'legacy_manual_marker' },
      { version: 5, name: '002_approvals_expiry' },
      { version: 6, name: '003_sessions_thread_uniqueness' },
      { version: 7, name: '004_agent_group_defaults' },
      { version: 8, name: '005_schedules_config' },
    ]);

    db.close();
  });

  it('migrates through schema version 5', () => {
    const db = new Database(':memory:');

    migrate(db);

    const versionRow = db
      .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
      .get() as { version: number };

    expect(versionRow.version).toBe(5);

    db.close();
  });

  it('upgrades approvals from 001 and applies the plan-aligned expires_at schema', () => {
    const db = createLegacyDb();

    db.prepare(
      `INSERT INTO agent_groups (id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run('group-1', 'Legacy group', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    db.prepare(
      `INSERT INTO sessions (id, agent_group_id, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run('session-1', 'group-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    db.prepare(
      `INSERT INTO approvals (
         id,
         agent_group_id,
         session_id,
         tool_name,
         tool_args,
         status,
         requested_at,
         responded_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'approval-1',
      'group-1',
      'session-1',
      'shell',
      '{}',
      'pending',
      '2026-01-01 10:00:00',
      null,
    );

    migrate(db);

    const upgradedApproval = db
      .prepare('SELECT expires_at FROM approvals WHERE id = ?')
      .get('approval-1') as { expires_at: string };

    expect(upgradedApproval.expires_at).toBe('2026-01-01 10:05:00');

    const approvalsColumns = db
      .query<
        { name: string; type: string; notnull: number; dflt_value: string | null },
        []
      >("PRAGMA table_info('approvals')")
      .all();
    const expiresAtColumn = approvalsColumns.find((column) => column.name === 'expires_at');

    expect(expiresAtColumn).toMatchObject({
      name: 'expires_at',
      type: 'TEXT',
      notnull: 1,
      dflt_value: "datetime('now', '+5 minutes')",
    });

    const approvalTriggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'approvals'")
      .all() as { name: string }[];

    expect(approvalTriggers).toEqual([]);

    db.prepare(
      `INSERT INTO approvals (
         id,
         agent_group_id,
         session_id,
         tool_name,
         status,
         requested_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('approval-2', 'group-1', 'session-1', 'shell', 'pending', '2026-01-01 11:00:00');

    const futureApproval = db
      .prepare('SELECT expires_at FROM approvals WHERE id = ?')
      .get('approval-2') as { expires_at: string };

    expect(futureApproval.expires_at).toEqual(expect.any(String));
    expect(futureApproval.expires_at).not.toBeNull();

    db.close();
  });

  it('preserves child foreign keys when upgrading agent_groups defaults', () => {
    const db = createLegacyDb();

    db.prepare(
      `INSERT INTO agent_groups (
         id,
         name,
         provider,
         permissions,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('group-1', 'Legacy group', 'openai', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    db.prepare(
      `INSERT INTO sessions (id, agent_group_id, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run('session-1', 'group-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    db.prepare(
      `INSERT INTO schedules (
         id,
         agent_group_id,
         cron_expr,
         prompt,
         created_at
       ) VALUES (?, ?, ?, ?, ?)`,
    ).run('schedule-1', 'group-1', '0 * * * *', 'Run task', '2026-01-01T00:00:00.000Z');
    db.prepare(
      `INSERT INTO approvals (
         id,
         agent_group_id,
         session_id,
         tool_name,
         status,
         requested_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('approval-1', 'group-1', 'session-1', 'shell', 'pending', '2026-01-01 10:00:00');

    migrate(db);

    const foreignKeyIssues = db.prepare('PRAGMA foreign_key_check').all();
    expect(foreignKeyIssues).toEqual([]);

    db.prepare(
      `INSERT INTO sessions (id, agent_group_id, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run('session-2', 'group-1', '2026-01-01T01:00:00.000Z', '2026-01-01T01:00:00.000Z');

    db.prepare(
      `INSERT INTO agent_groups (id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run('group-2', 'New group', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');

    const insertedDefaults = db
      .prepare('SELECT provider, thinking, permissions FROM agent_groups WHERE id = ?')
      .get('group-2') as { provider: string; thinking: string; permissions: string };

    expect(insertedDefaults).toEqual({
      provider: 'auto',
      thinking: 'medium',
      permissions: '{"default":"auto"}',
    });

    db.close();
  });

  it('opens the central database at <state-dir>/cove.db and creates the state dir', () => {
    const stateDir = path.join(makeTempStateDir(), 'nested-state');
    process.env.COVE_STATE_DIR = stateDir;

    expect(fs.existsSync(stateDir)).toBeFalse();

    const db = getDb();
    const dbPathRow = db
      .query<{ seq: number; name: string; file: string }, []>('PRAGMA database_list')
      .get();

    expect(fs.existsSync(stateDir)).toBeTrue();
    expect(dbPathRow).toBeDefined();
    expect(fs.realpathSync(dbPathRow!.file)).toBe(fs.realpathSync(path.join(stateDir, 'cove.db')));

    db.close();
  });

  it('enables foreign key enforcement in getDb', () => {
    const stateDir = path.join(makeTempStateDir(), 'fk-state');
    process.env.COVE_STATE_DIR = stateDir;

    const db = getDb();
    const pragmaRow = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };

    expect(pragmaRow.foreign_keys).toBe(1);

    db.exec(`
      CREATE TABLE parent (
        id TEXT PRIMARY KEY
      );

      CREATE TABLE child (
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL REFERENCES parent(id)
      );
    `);

    expect(() => {
      db.prepare('INSERT INTO child (id, parent_id) VALUES (?, ?)').run('child-1', 'missing-parent');
    }).toThrow();

    db.close();
  });
});
