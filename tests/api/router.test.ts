import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { migrate } from '../../src/db/migrate.ts';
import { resolveThreadId, routeRequest } from '../../src/router.ts';

let db: Database | undefined;
const stateDirs: string[] = [];

function makeStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cove-v2-router-'));
  stateDirs.push(dir);
  return dir;
}

function insertAgentGroup(id: string): void {
  db!.prepare(
    `INSERT INTO agent_groups (
       id,
       name,
       workspace,
       provider,
       model,
       thinking,
       permissions,
       soul,
       config,
       created_at,
       updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    `${id} name`,
    `/workspace/${id}`,
    'anthropic',
    `${id}-model`,
    'high',
    '{"default":"ask"}',
    `soul-${id}`,
    '{"theme":"night"}',
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
  );
}

afterEach(() => {
  db?.close();
  db = undefined;

  for (const stateDir of stateDirs.splice(0)) {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

describe('router', () => {
  it('resolveThreadId prefers body thread_id over header and default', () => {
    const request = new Request('http://cove.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Thread-Id': 'header-thread' },
      body: JSON.stringify({ thread_id: 'body-thread' }),
    });

    expect(resolveThreadId({ request, body: { thread_id: 'body-thread' } })).toBe('body-thread');
  });

  it('resolveThreadId falls back to X-Thread-Id header before default', () => {
    const request = new Request('http://cove.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'X-Thread-Id': 'header-thread' },
    });

    expect(resolveThreadId({ request, body: {} })).toBe('header-thread');
  });

  it('resolveThreadId falls back to default when body and header are absent', () => {
    const request = new Request('http://cove.test/v1/chat/completions', {
      method: 'POST',
    });

    expect(resolveThreadId({ request, body: {} })).toBe('default');
  });

  it('routeRequest resolves the agent group from the central sqlite database and creates a default-thread session folder', () => {
    const stateDir = makeStateDir();

    db = new Database(':memory:');
    migrate(db);
    insertAgentGroup('support');

    const routed = routeRequest({
      db,
      request: new Request('http://cove.test/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ agent_group_id: 'support' }),
      }),
      body: { agent_group_id: 'support' },
      stateDir,
    });

    expect(routed.agentGroup.id).toBe('support');
    expect(routed.agentGroup.workspace).toBe('/workspace/support');
    expect(routed.agentGroup.provider).toBe('anthropic');
    expect(routed.agentGroup.model).toBe('support-model');
    expect(routed.agentGroup.thinking).toBe('high');
    expect(routed.agentGroup.permissions).toBe('{"default":"ask"}');
    expect(routed.agentGroup.soul).toBe('soul-support');
    expect(routed.agentGroup.config).toBe('{"theme":"night"}');
    expect(routed.threadId).toBe('default');
    expect(routed.session.agent_group_id).toBe('support');
    expect(routed.session.thread_id).toBe('default');
    expect(routed.session.session_file).toBe(path.join(stateDir, 'sessions', 'support', routed.session.id));
    expect(fs.existsSync(routed.session.session_file!)).toBe(true);
    expect(fs.existsSync(path.join(routed.session.session_file!, 'inbound.db'))).toBe(true);
    expect(fs.existsSync(path.join(routed.session.session_file!, 'outbound.db'))).toBe(true);
  });

  it('routeRequest prefers body agent_group_id over header, model, and default', () => {
    const stateDir = makeStateDir();

    db = new Database(':memory:');
    migrate(db);
    insertAgentGroup('body-group');
    insertAgentGroup('header-group');
    insertAgentGroup('model-group');
    insertAgentGroup('default');

    const routed = routeRequest({
      db,
      request: new Request('http://cove.test/v1/chat/completions', {
        method: 'POST',
        headers: { 'X-Agent-Group-Id': 'header-group' },
        body: JSON.stringify({ agent_group_id: 'body-group', model: 'model-group' }),
      }),
      body: { agent_group_id: 'body-group', model: 'model-group' },
      stateDir,
    });

    expect(routed.agentGroup.id).toBe('body-group');
    expect(routed.session.agent_group_id).toBe('body-group');
  });

  it('routeRequest falls back to X-Agent-Group-Id before body model and default', () => {
    const stateDir = makeStateDir();

    db = new Database(':memory:');
    migrate(db);
    insertAgentGroup('header-group');
    insertAgentGroup('model-group');
    insertAgentGroup('default');

    const routed = routeRequest({
      db,
      request: new Request('http://cove.test/v1/chat/completions', {
        method: 'POST',
        headers: { 'X-Agent-Group-Id': 'header-group' },
        body: JSON.stringify({ model: 'model-group' }),
      }),
      body: { model: 'model-group' },
      stateDir,
    });

    expect(routed.agentGroup.id).toBe('header-group');
    expect(routed.session.agent_group_id).toBe('header-group');
  });

  it('routeRequest falls back to body model before default', () => {
    const stateDir = makeStateDir();

    db = new Database(':memory:');
    migrate(db);
    insertAgentGroup('model-group');
    insertAgentGroup('default');

    const routed = routeRequest({
      db,
      request: new Request('http://cove.test/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'model-group' }),
      }),
      body: { model: 'model-group' },
      stateDir,
    });

    expect(routed.agentGroup.id).toBe('model-group');
    expect(routed.session.agent_group_id).toBe('model-group');
  });

  it('routeRequest falls back to default agent group when selectors are absent', () => {
    const stateDir = makeStateDir();

    db = new Database(':memory:');
    migrate(db);
    insertAgentGroup('default');

    const routed = routeRequest({
      db,
      request: new Request('http://cove.test/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
      body: {},
      stateDir,
    });

    expect(routed.agentGroup.id).toBe('default');
    expect(routed.session.agent_group_id).toBe('default');
  });

  it('routeRequest does not adopt a legacy null-thread session when thread_id is provided', () => {
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
      null,
      path.join(stateDir, 'sessions', 'support', 'legacy-session'),
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );

    const routed = routeRequest({
      db,
      request: new Request('http://cove.test/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ agent_group_id: 'support', thread_id: 'explicit-thread' }),
      }),
      body: { agent_group_id: 'support', thread_id: 'explicit-thread' },
      stateDir,
    });

    expect(routed.session.id).not.toBe('legacy-session');
    expect(routed.session.thread_id).toBe('explicit-thread');

    const rows = db
      .prepare('SELECT id, thread_id FROM sessions WHERE agent_group_id = ? ORDER BY id')
      .all('support') as { id: string; thread_id: string | null }[];

    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual({ id: 'legacy-session', thread_id: null });
    expect(rows).toContainEqual({ id: routed.session.id, thread_id: 'explicit-thread' });
  });

  it('routeRequest adopts a legacy null-thread session when thread_id is omitted', () => {
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
      null,
      path.join(stateDir, 'sessions', 'support', 'legacy-session'),
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );

    const routed = routeRequest({
      db,
      request: new Request('http://cove.test/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ agent_group_id: 'support' }),
      }),
      body: { agent_group_id: 'support' },
      stateDir,
    });

    expect(routed.session.id).toBe('legacy-session');
    expect(routed.session.thread_id).toBe('default');

    const stored = db
      .prepare('SELECT id, thread_id FROM sessions WHERE id = ?')
      .get('legacy-session') as { id: string; thread_id: string | null };

    expect(stored).toEqual({ id: 'legacy-session', thread_id: 'default' });
  });

  it('routeRequest repairs session_file and initializes session dbs when adopting a legacy null-thread null-file session', () => {
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
      null,
      null,
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );

    const routed = routeRequest({
      db,
      request: new Request('http://cove.test/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ agent_group_id: 'support' }),
      }),
      body: { agent_group_id: 'support' },
      stateDir,
    });

    const expectedSessionDir = path.join(stateDir, 'sessions', 'support', 'legacy-session');

    expect(routed.session.id).toBe('legacy-session');
    expect(routed.session.thread_id).toBe('default');
    expect(routed.session.session_file).toBe(expectedSessionDir);
    expect(fs.existsSync(path.join(expectedSessionDir, 'inbound.db'))).toBe(true);
    expect(fs.existsSync(path.join(expectedSessionDir, 'outbound.db'))).toBe(true);

    const stored = db
      .prepare('SELECT id, thread_id, session_file FROM sessions WHERE id = ?')
      .get('legacy-session') as { id: string; thread_id: string | null; session_file: string | null };

    expect(stored).toEqual({
      id: 'legacy-session',
      thread_id: 'default',
      session_file: expectedSessionDir,
    });
  });

  it('routeRequest returns the existing default-thread session when legacy adoption hits the unique index', () => {
    const stateDir = makeStateDir();

    db = new Database(':memory:');
    migrate(db);
    insertAgentGroup('support');

    db.prepare(
      `INSERT INTO sessions (id, agent_group_id, thread_id, session_file, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`,
    ).run(
      'legacy-session',
      'support',
      null,
      path.join(stateDir, 'sessions', 'support', 'legacy-session'),
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      'default-session',
      'support',
      'default',
      path.join(stateDir, 'sessions', 'support', 'default-session'),
      '2026-01-02T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
    );

    const routed = routeRequest({
      db,
      request: new Request('http://cove.test/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ agent_group_id: 'support' }),
      }),
      body: { agent_group_id: 'support' },
      stateDir,
    });

    expect(routed.session.id).toBe('default-session');
    expect(routed.session.thread_id).toBe('default');

    const rows = db
      .prepare('SELECT id, thread_id FROM sessions WHERE agent_group_id = ? ORDER BY id')
      .all('support') as { id: string; thread_id: string | null }[];

    expect(rows).toEqual([
      { id: 'default-session', thread_id: 'default' },
      { id: 'legacy-session', thread_id: null },
    ]);
  });

  it('routeRequest repairs the winning default-thread session when legacy adoption hits the unique index and session_file is null', () => {
    const stateDir = makeStateDir();

    db = new Database(':memory:');
    migrate(db);
    insertAgentGroup('support');

    db.prepare(
      `INSERT INTO sessions (id, agent_group_id, thread_id, session_file, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`,
    ).run(
      'legacy-session',
      'support',
      null,
      path.join(stateDir, 'sessions', 'support', 'legacy-session'),
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      'default-session',
      'support',
      'default',
      null,
      '2026-01-02T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
    );

    const routed = routeRequest({
      db,
      request: new Request('http://cove.test/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ agent_group_id: 'support' }),
      }),
      body: { agent_group_id: 'support' },
      stateDir,
    });

    const expectedSessionDir = path.join(stateDir, 'sessions', 'support', 'default-session');

    expect(routed.session.id).toBe('default-session');
    expect(routed.session.thread_id).toBe('default');
    expect(routed.session.session_file).toBe(expectedSessionDir);
    expect(fs.existsSync(path.join(expectedSessionDir, 'inbound.db'))).toBe(true);
    expect(fs.existsSync(path.join(expectedSessionDir, 'outbound.db'))).toBe(true);

    const stored = db
      .prepare('SELECT id, thread_id, session_file FROM sessions WHERE id = ?')
      .get('default-session') as { id: string; thread_id: string | null; session_file: string | null };

    expect(stored).toEqual({
      id: 'default-session',
      thread_id: 'default',
      session_file: expectedSessionDir,
    });
  });
});
