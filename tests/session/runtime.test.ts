import { afterEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createEnsureSessionRuntime } from '../../src/session/runtime.ts';
import { getActiveContainers } from '../../src/container/spawn.ts';
import { migrate } from '../../src/db/migrate.ts';
import type { RoutedRequest, SessionConfig, WarmPool } from '../../src/shared/types.ts';
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

function makeRoutedRequest(options: {
  stateDir: string;
  agentGroupId?: string;
  sessionId?: string;
  sessionDir?: string | null;
  workspace?: string | null;
}): RoutedRequest {
  const agentGroupId = options.agentGroupId ?? 'support';
  const sessionId = options.sessionId ?? 'live-session';

  return {
    agentGroup: {
      id: agentGroupId,
      name: `${agentGroupId} name`,
      description: null,
      workspace: options.workspace ?? '/workspace/support',
      provider: 'anthropic',
      model: 'claude-sonnet',
      thinking: 'medium',
      permissions: '{"default":"ask"}',
      soul: null,
      config: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    },
    threadId: 'thread-1',
    session: {
      id: sessionId,
      agent_group_id: agentGroupId,
      thread_id: 'thread-1',
      session_file: options.sessionDir ?? path.join(options.stateDir, 'sessions', agentGroupId, sessionId),
      metadata: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    },
  };
}

function insertSession(routed: RoutedRequest): void {
  db!.prepare(
    `INSERT INTO sessions (id, agent_group_id, thread_id, session_file, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    routed.session.id,
    routed.session.agent_group_id,
    routed.session.thread_id,
    routed.session.session_file,
    routed.session.metadata,
    routed.session.created_at,
    routed.session.updated_at,
  );
}

function readSessionFile(sessionId: string): string | null {
  const row = db!
    .prepare('SELECT session_file FROM sessions WHERE id = ?')
    .get(sessionId) as { session_file: string | null };

  return row.session_file;
}

function makeWarmPool(overrides: Partial<WarmPool> & {
  acquire?: WarmPool['acquire'];
} = {}): WarmPool {
  return {
    start: overrides.start ?? (async () => {}),
    stop: overrides.stop ?? (async () => {}),
    acquire: overrides.acquire ?? (async () => null),
    consume: overrides.consume ?? (() => {}),
    release: overrides.release ?? (() => {}),
    getStats: overrides.getStats ?? (() => ({ ready: 0, allocated: 0, starting: 0 })),
  };
}

function trackContainer(sessionId: string, options: {
  containerName?: string;
  sessionDir?: string;
  envVars?: Record<string, string>;
} = {}): void {
  getActiveContainers().set(sessionId, {
    name: options.containerName ?? `cove-${sessionId}`,
    startedAt: Date.now(),
    options: {
      imageName: 'cove-agent:latest',
      containerName: options.containerName ?? `cove-${sessionId}`,
      sessionDir: options.sessionDir ?? `/tmp/${sessionId}`,
      envVars: options.envVars,
    },
    process: {
      kill: () => true,
    } as never,
    running: true,
  });
}

function makeConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet',
    thinking_level: 'medium',
    workspace: '/workspace/support',
    extra_env: { EXTRA_FLAG: '1' },
    permissions: '{"default":"ask"}',
    ...overrides,
  };
}

afterEach(() => {
  db?.close();
  db = undefined;
  getActiveContainers().clear();
  mock.restore();

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

  it('returns true for an existing live container without touching the warm pool', async () => {
    const stateDir = makeStateDir();

    db = new Database(':memory:');
    migrate(db);
    insertAgentGroup('support');

    const routed = makeRoutedRequest({ stateDir });
    insertSession(routed);
    trackContainer(routed.session.id);

    const acquire = mock(async () => null);
    const ensureSessionRuntime = createEnsureSessionRuntime({
      db,
      warmPool: makeWarmPool({ acquire }),
      imageName: 'cove-agent:latest',
      centralDbPath: '/tmp/cove.db',
    });

    const ready = await ensureSessionRuntime({
      routed,
      config: makeConfig(),
    });

    expect(ready).toBe(true);
    expect(acquire).not.toHaveBeenCalled();
  });

  it('adopts a warm allocation, persists session_file, updates routed session, and consumes the warm entry', async () => {
    const stateDir = makeStateDir();
    const warmSessionDir = path.join(stateDir, 'warm', 'warm-1');

    db = new Database(':memory:');
    migrate(db);
    insertAgentGroup('support');

    const routed = makeRoutedRequest({ stateDir, sessionDir: path.join(stateDir, 'sessions', 'support', 'live-session') });
    insertSession(routed);
    trackContainer('warm-1', {
      containerName: 'cove-warm-warm-1',
      sessionDir: warmSessionDir,
      envVars: { WARM_ONLY: 'true' },
    });

    const consume = mock(() => {});
    const release = mock(() => {});
    const ensureSessionRuntime = createEnsureSessionRuntime({
      db,
      warmPool: makeWarmPool({
        acquire: async () => ({ sessionId: 'warm-1', containerName: 'cove-warm-warm-1', sessionDir: warmSessionDir }),
        consume,
        release,
      }),
      imageName: 'cove-agent:latest',
      centralDbPath: '/tmp/cove.db',
    });

    const ready = await ensureSessionRuntime({
      routed,
      config: makeConfig({ extra_env: { EXTRA_FLAG: '1', COVE_SESSION_ID: 'stale' } }),
    });

    expect(ready).toBe(true);
    expect(routed.session.session_file).toBe(warmSessionDir);
    expect(readSessionFile(routed.session.id)).toBe(warmSessionDir);
    expect(consume).toHaveBeenCalledWith('warm-1');
    expect(release).not.toHaveBeenCalled();
    expect(getActiveContainers().has('warm-1')).toBe(false);
    expect(getActiveContainers().get(routed.session.id)?.name).toBe('cove-warm-warm-1');
    expect(getActiveContainers().get(routed.session.id)?.options).toMatchObject({
      containerName: routed.session.id,
      sessionId: routed.session.id,
      sessionDir: warmSessionDir,
      envVars: {
        WARM_ONLY: 'true',
        EXTRA_FLAG: '1',
        COVE_SESSION_ID: routed.session.id,
      },
    });
  });

  it('releases the warm entry and falls back to cold spawn when adoption fails', async () => {
    const stateDir = makeStateDir();
    const warmSessionDir = path.join(stateDir, 'warm', 'warm-2');
    const coldSessionDir = path.join(stateDir, 'sessions', 'support', 'live-session');

    db = new Database(':memory:');
    migrate(db);
    insertAgentGroup('support');

    const routed = makeRoutedRequest({ stateDir, sessionDir: coldSessionDir });
    insertSession(routed);

    const release = mock(() => {});
    const spawnContainer = mock(() => true);
    const ensureSessionRuntime = createEnsureSessionRuntime({
      db,
      warmPool: makeWarmPool({
        acquire: async () => ({ sessionId: 'warm-2', containerName: 'cove-warm-warm-2', sessionDir: warmSessionDir }),
        release,
      }),
      imageName: 'cove-agent:latest',
      centralDbPath: '/tmp/cove.db',
      adoptRunningContainer: () => false,
      spawnContainer,
    });

    const ready = await ensureSessionRuntime({
      routed,
      config: makeConfig({ workspace: '/workspace/override', extra_env: { EXTRA_FLAG: 'fallback' } }),
    });

    expect(ready).toBe(true);
    expect(release).toHaveBeenCalledWith('warm-2');
    expect(spawnContainer).toHaveBeenCalledWith({
      imageName: 'cove-agent:latest',
      containerName: routed.session.id,
      sessionId: routed.session.id,
      sessionDir: coldSessionDir,
      centralDbPath: '/tmp/cove.db',
      workspaceDir: '/workspace/override',
      envVars: {
        EXTRA_FLAG: 'fallback',
        COVE_SESSION_ID: routed.session.id,
      },
    });
    expect(readSessionFile(routed.session.id)).toBe(coldSessionDir);
  });

  it('falls back directly to cold spawn when no warm allocation exists', async () => {
    const stateDir = makeStateDir();
    const coldSessionDir = path.join(stateDir, 'sessions', 'support', 'live-session');

    db = new Database(':memory:');
    migrate(db);
    insertAgentGroup('support');

    const routed = makeRoutedRequest({ stateDir, sessionDir: coldSessionDir, workspace: null });
    insertSession(routed);

    const spawnContainer = mock(() => true);
    const ensureSessionRuntime = createEnsureSessionRuntime({
      db,
      warmPool: makeWarmPool(),
      imageName: 'cove-agent:latest',
      centralDbPath: '/tmp/cove.db',
      spawnContainer,
    });

    const ready = await ensureSessionRuntime({
      routed,
      config: makeConfig({ workspace: null, extra_env: null }),
    });

    expect(ready).toBe(true);
    expect(spawnContainer).toHaveBeenCalledWith({
      imageName: 'cove-agent:latest',
      containerName: routed.session.id,
      sessionId: routed.session.id,
      sessionDir: coldSessionDir,
      centralDbPath: '/tmp/cove.db',
      workspaceDir: undefined,
      envVars: {
        COVE_SESSION_ID: routed.session.id,
      },
    });
  });

  it('kills and untracks the adopted live container, restores session_file, consumes the warm slot, and returns false when the post-adoption DB update fails', async () => {
    const stateDir = makeStateDir();
    const warmSessionDir = path.join(stateDir, 'warm', 'warm-3');
    const originalSessionDir = path.join(stateDir, 'sessions', 'support', 'live-session');

    db = new Database(':memory:');
    migrate(db);
    insertAgentGroup('support');

    const routed = makeRoutedRequest({ stateDir, sessionDir: originalSessionDir });
    insertSession(routed);
    trackContainer('warm-3', {
      containerName: 'cove-warm-warm-3',
      sessionDir: warmSessionDir,
    });

    const consume = mock(() => {});
    const killContainer = mock(() => {});
    const originalPrepare = db.prepare.bind(db);
    (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
      const statement = originalPrepare(sql);

      if (!sql.startsWith('UPDATE sessions SET session_file = ?')) {
        return statement;
      }

      return {
        ...statement,
        run: () => {
          throw new Error('disk full');
        },
      };
    }) as typeof db.prepare;

    try {
      const ensureSessionRuntime = createEnsureSessionRuntime({
        db,
        warmPool: makeWarmPool({
          acquire: async () => ({ sessionId: 'warm-3', containerName: 'cove-warm-warm-3', sessionDir: warmSessionDir }),
          consume,
        }),
        imageName: 'cove-agent:latest',
        centralDbPath: '/tmp/cove.db',
        killContainer,
      });

      const ready = await ensureSessionRuntime({
        routed,
        config: makeConfig(),
      });

      expect(ready).toBe(false);
      expect(consume).toHaveBeenCalledWith('warm-3');
      expect(killContainer).toHaveBeenCalledWith(routed.session.id, 'session-file-persist-failed');
      expect(routed.session.session_file).toBe(originalSessionDir);
      expect(readSessionFile(routed.session.id)).toBe(originalSessionDir);
      expect(getActiveContainers().has('warm-3')).toBe(false);
      expect(getActiveContainers().has(routed.session.id)).toBe(false);
    } finally {
      (db as unknown as { prepare: typeof db.prepare }).prepare = originalPrepare as typeof db.prepare;
    }
  });

  it('treats a zero-row post-adoption DB update as a persistence failure', async () => {
    const stateDir = makeStateDir();
    const warmSessionDir = path.join(stateDir, 'warm', 'warm-4');
    const originalSessionDir = path.join(stateDir, 'sessions', 'support', 'live-session');

    db = new Database(':memory:');
    migrate(db);
    insertAgentGroup('support');

    const routed = makeRoutedRequest({ stateDir, sessionDir: originalSessionDir });
    insertSession(routed);
    trackContainer('warm-4', {
      containerName: 'cove-warm-warm-4',
      sessionDir: warmSessionDir,
    });

    const consume = mock(() => {});
    const killContainer = mock(() => {});
    const originalPrepare = db.prepare.bind(db);
    (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
      const statement = originalPrepare(sql);

      if (!sql.startsWith('UPDATE sessions SET session_file = ?')) {
        return statement;
      }

      return {
        ...statement,
        run: () => ({ changes: 0 }),
      };
    }) as typeof db.prepare;

    try {
      const ensureSessionRuntime = createEnsureSessionRuntime({
        db,
        warmPool: makeWarmPool({
          acquire: async () => ({ sessionId: 'warm-4', containerName: 'cove-warm-warm-4', sessionDir: warmSessionDir }),
          consume,
        }),
        imageName: 'cove-agent:latest',
        centralDbPath: '/tmp/cove.db',
        killContainer,
      });

      const ready = await ensureSessionRuntime({
        routed,
        config: makeConfig(),
      });

      expect(ready).toBe(false);
      expect(consume).toHaveBeenCalledWith('warm-4');
      expect(killContainer).toHaveBeenCalledWith(routed.session.id, 'session-file-persist-failed');
      expect(routed.session.session_file).toBe(originalSessionDir);
      expect(readSessionFile(routed.session.id)).toBe(originalSessionDir);
      expect(getActiveContainers().has('warm-4')).toBe(false);
      expect(getActiveContainers().has(routed.session.id)).toBe(false);
    } finally {
      (db as unknown as { prepare: typeof db.prepare }).prepare = originalPrepare as typeof db.prepare;
    }
  });
});
