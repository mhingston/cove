import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { migrate } from '../../src/db/migrate.ts';
import { createSessionForThread } from '../../src/session/manager.ts';

let db: Database | undefined;
const stateDirs: string[] = [];

function makeStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cove-v2-runtime-'));
  stateDirs.push(dir);
  return dir;
}

function insertAgentGroup(id: string): void {
  db!.prepare(
    `INSERT INTO agent_groups (id, name, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).run(id, `${id} name`, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
}

afterEach(() => {
  db?.close();
  db = undefined;

  for (const stateDir of stateDirs.splice(0)) {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

describe('session runtime manager', () => {
  it('creates one unique session per non-null (agent_group_id, thread_id)', () => {
    const stateDir = makeStateDir();

    db = new Database(':memory:');
    migrate(db);
    insertAgentGroup('support');

    const first = createSessionForThread({
      db,
      stateDir,
      agentGroupId: 'support',
      threadId: 'thread-1',
    });
    const second = createSessionForThread({
      db,
      stateDir,
      agentGroupId: 'support',
      threadId: 'thread-1',
    });

    expect(second.id).toBe(first.id);
    expect(second.thread_id).toBe('thread-1');

    const rows = db
      .prepare('SELECT id, agent_group_id, thread_id FROM sessions WHERE agent_group_id = ?')
      .all('support') as { id: string; agent_group_id: string; thread_id: string | null }[];

    expect(rows).toEqual([
      {
        id: first.id,
        agent_group_id: 'support',
        thread_id: 'thread-1',
      },
    ]);
  });

  it('returns the winning existing row when session creation loses a unique-index race', () => {
    const stateDir = makeStateDir();

    db = new Database(':memory:');
    migrate(db);
    insertAgentGroup('support');

    const originalPrepare = db.prepare.bind(db);
    let injectedWinner = false;

    (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
      const statement = originalPrepare(sql);

      if (!injectedWinner || !sql.startsWith('INSERT INTO sessions')) {
        return statement;
      }

      return {
        ...statement,
        run: (...args: Parameters<typeof statement.run>) => {
          originalPrepare(
            `INSERT INTO sessions (id, agent_group_id, thread_id, session_file, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(
            'winning-session',
            'support',
            'thread-1',
            path.join(stateDir, 'sessions', 'support', 'winning-session'),
            '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z',
          );

          return statement.run(...args);
        },
      };
    }) as typeof db.prepare;

    injectedWinner = true;

    try {
      const session = createSessionForThread({
        db,
        stateDir,
        agentGroupId: 'support',
        threadId: 'thread-1',
      });

      expect(session.id).toBe('winning-session');
      expect(session.thread_id).toBe('thread-1');
    } finally {
      (db as unknown as { prepare: typeof db.prepare }).prepare = originalPrepare as typeof db.prepare;
    }
  });

  it('repairs a missing session_file for an existing thread session and initializes session dbs', () => {
    const stateDir = makeStateDir();

    db = new Database(':memory:');
    migrate(db);
    insertAgentGroup('support');

    db.prepare(
      `INSERT INTO sessions (id, agent_group_id, thread_id, session_file, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      'legacy-session',
      'support',
      'thread-1',
      null,
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );

    const session = createSessionForThread({
      db,
      stateDir,
      agentGroupId: 'support',
      threadId: 'thread-1',
    });

    const expectedSessionDir = path.join(stateDir, 'sessions', 'support', 'legacy-session');

    expect(session.id).toBe('legacy-session');
    expect(session.session_file).toBe(expectedSessionDir);
    expect(fs.existsSync(path.join(expectedSessionDir, 'inbound.db'))).toBe(true);
    expect(fs.existsSync(path.join(expectedSessionDir, 'outbound.db'))).toBe(true);

    const stored = db
      .prepare('SELECT id, session_file FROM sessions WHERE id = ?')
      .get('legacy-session') as { id: string; session_file: string | null };

    expect(stored).toEqual({
      id: 'legacy-session',
      session_file: expectedSessionDir,
    });
  });
});
