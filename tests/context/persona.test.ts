import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadPersona } from '../../src/context/persona.ts';

const tempDirs: string[] = [];
const databasesToClose: Database[] = [];

function makeStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cove-v2-persona-'));
  tempDirs.push(dir);
  return dir;
}

function trackDb(db: Database): Database {
  databasesToClose.push(db);
  return db;
}

function writePersonaFile(stateDir: string, agentGroupId: string, fileName: 'SOUL.md' | 'AGENTS.md', content: string): void {
  const personaDir = path.join(stateDir, 'personas', agentGroupId);
  fs.mkdirSync(personaDir, { recursive: true });
  fs.writeFileSync(path.join(personaDir, fileName), content);
}

function createAgentGroupsDb(options: { filePath?: string; withSchema?: boolean } = {}): Database {
  const db = trackDb(new Database(options.filePath ?? ':memory:'));

  if (options.withSchema !== false) {
    db.exec(`
      CREATE TABLE agent_groups (
        id TEXT PRIMARY KEY,
        soul TEXT
      );
    `);
  }

  return db;
}

function insertSoul(db: Database, agentGroupId: string, soul: string | null): void {
  db.prepare('INSERT INTO agent_groups (id, soul) VALUES (?, ?)').run(agentGroupId, soul);
}

afterEach(() => {
  for (const db of databasesToClose.splice(0)) {
    db.close();
  }

  delete process.env.COVE_STATE_DIR;

  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadPersona', () => {
  it('prefers explicit personaText over filesystem and db fallbacks when non-empty after trim', () => {
    const stateDir = makeStateDir();
    const db = createAgentGroupsDb();

    writePersonaFile(stateDir, 'support', 'SOUL.md', 'filesystem soul');
    insertSoul(db, 'support', 'db soul');

    expect(
      loadPersona('support', {
        stateDir,
        db,
        personaText: '  explicit persona  ',
      }),
    ).toBe('  explicit persona  ');
  });

  it('treats whitespace-only personaText as absent and falls through to filesystem lookup', () => {
    const stateDir = makeStateDir();

    writePersonaFile(stateDir, 'support', 'SOUL.md', 'filesystem soul');

    expect(
      loadPersona('support', {
        stateDir,
        personaText: '  \n\t  ',
      }),
    ).toBe('filesystem soul');
  });

  it('prefers SOUL.md over AGENTS.md and falls back to AGENTS.md when SOUL.md is absent', () => {
    const firstStateDir = makeStateDir();
    const secondStateDir = makeStateDir();

    writePersonaFile(firstStateDir, 'support', 'SOUL.md', 'soul persona');
    writePersonaFile(firstStateDir, 'support', 'AGENTS.md', 'agents persona');
    writePersonaFile(secondStateDir, 'support', 'AGENTS.md', 'agents-only persona');

    expect(loadPersona('support', { stateDir: firstStateDir })).toBe('soul persona');
    expect(loadPersona('support', { stateDir: secondStateDir })).toBe('agents-only persona');
  });

  it('falls back to agent_groups.soul from the provided db after filesystem misses', () => {
    const stateDir = makeStateDir();
    const db = createAgentGroupsDb();
    insertSoul(db, 'support', 'db soul');

    expect(loadPersona('support', { stateDir, db })).toBe('db soul');
  });

  it('falls back to agent_groups.soul from dbPath after filesystem and provided db miss', () => {
    const stateDir = makeStateDir();
    const db = createAgentGroupsDb();
    const dbPath = path.join(stateDir, 'persona.db');
    const fileDb = createAgentGroupsDb({ filePath: dbPath });
    insertSoul(fileDb, 'support', 'dbPath soul');

    expect(loadPersona('support', { stateDir, db, dbPath })).toBe('dbPath soul');
  });

  it('resolves agent_groups.soul from dbPath when no db is provided', () => {
    const stateDir = makeStateDir();
    const dbPath = path.join(stateDir, 'persona.db');
    const fileDb = createAgentGroupsDb({ filePath: dbPath });
    insertSoul(fileDb, 'support', 'dbPath only soul');

    expect(loadPersona('support', { dbPath })).toBe('dbPath only soul');
  });

  it('falls back to the default state-dir cove.db after filesystem misses', () => {
    const stateDir = makeStateDir();
    const defaultDb = createAgentGroupsDb({ filePath: path.join(stateDir, 'cove.db') });
    insertSoul(defaultDb, 'support', 'default db soul');

    expect(loadPersona('support', { stateDir })).toBe('default db soul');
  });

  it('uses dbPath when the provided db cannot resolve the persona', () => {
    const stateDir = makeStateDir();
    const db = createAgentGroupsDb();
    const dbPath = path.join(stateDir, 'persona.db');
    const fileDb = createAgentGroupsDb({ filePath: dbPath });
    insertSoul(fileDb, 'support', 'dbPath soul');

    insertSoul(db, 'other-group', 'other soul');

    expect(loadPersona('support', { stateDir, db, dbPath })).toBe('dbPath soul');
  });

  it('returns null when explicit text, filesystem, and db fallbacks all miss', () => {
    const stateDir = makeStateDir();
    const db = createAgentGroupsDb();

    expect(loadPersona('support', { stateDir, db })).toBeNull();
  });

  it('returns null when the db file is unavailable and does not throw', () => {
    const stateDir = makeStateDir();
    const missingDbPath = path.join(stateDir, 'missing.db');

    expect(loadPersona('support', { stateDir, dbPath: missingDbPath })).toBeNull();
  });

  it('returns null when the db is missing the agent_groups schema and does not throw', () => {
    const db = createAgentGroupsDb({ withSchema: false });

    expect(loadPersona('support', { db })).toBeNull();
  });

  it('can disable filesystem fallback so db lookup wins even when persona files exist', () => {
    const stateDir = makeStateDir();
    const db = createAgentGroupsDb();

    writePersonaFile(stateDir, 'support', 'SOUL.md', 'filesystem soul');
    insertSoul(db, 'support', 'db soul');

    expect(
      loadPersona('support', {
        stateDir,
        db,
        allowFilesystemFallback: false,
      }),
    ).toBe('db soul');
  });
});
