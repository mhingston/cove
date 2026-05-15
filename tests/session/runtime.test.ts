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
const gatewayEnvKeys = [
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'https_proxy',
  'http_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'ONECLI_AGENT_NAME',
  'ONECLI_URL',
  'AWS_SECRET_ACCESS_KEY',
] as const;
const originalGatewayEnv = Object.fromEntries(
  gatewayEnvKeys.map((key) => [key, process.env[key]]),
) as Record<(typeof gatewayEnvKeys)[number], string | undefined>;

function restoreEnvVar(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}

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

function readAgentGroupSoul(agentGroupId: string): string | null {
  const row = db!
    .prepare('SELECT soul FROM agent_groups WHERE id = ?')
    .get(agentGroupId) as { soul: string | null };

  return row.soul;
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

  for (const key of gatewayEnvKeys) {
    restoreEnvVar(key, originalGatewayEnv[key]);
  }

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
      config: makeConfig({
        extra_env: {
          EXTRA_FLAG: '1',
          COVE_SESSION_ID: 'stale',
          COVE_WORKFLOW_API_BASE_URL: 'http://host.docker.internal:4111',
        },
      }),
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
        COVE_WORKFLOW_API_BASE_URL: 'http://host.docker.internal:4111',
        COVE_SESSION_ID: routed.session.id,
      },
    });
  });

  it('overrides any stale warm-container persona with the explicit config persona during adoption', async () => {
    const stateDir = makeStateDir();
    const warmSessionDir = path.join(stateDir, 'warm', 'warm-persona-explicit');

    db = new Database(':memory:');
    migrate(db);
    insertAgentGroup('support');
    db.prepare('UPDATE agent_groups SET soul = ? WHERE id = ?').run('db persona', 'support');

    const routed = makeRoutedRequest({ stateDir, sessionDir: path.join(stateDir, 'sessions', 'support', 'live-session') });
    insertSession(routed);
    trackContainer('warm-persona-explicit', {
      containerName: 'cove-warm-warm-persona-explicit',
      sessionDir: warmSessionDir,
      envVars: { WARM_ONLY: 'true', COVE_PERSONA: 'stale warm persona' },
    });

    const ensureSessionRuntime = createEnsureSessionRuntime({
      db,
      warmPool: makeWarmPool({
        acquire: async () => ({
          sessionId: 'warm-persona-explicit',
          containerName: 'cove-warm-warm-persona-explicit',
          sessionDir: warmSessionDir,
        }),
      }),
      imageName: 'cove-agent:latest',
      centralDbPath: '/tmp/cove.db',
    });

    const config = makeConfig({
      extra_env: {
        EXTRA_FLAG: '1',
        COVE_PERSONA: 'explicit persona',
      },
    });

    const ready = await ensureSessionRuntime({ routed, config });

    expect(ready).toBe(true);
    expect(getActiveContainers().get(routed.session.id)?.options.envVars).toMatchObject({
      WARM_ONLY: 'true',
      EXTRA_FLAG: '1',
      COVE_PERSONA: 'explicit persona',
      COVE_SESSION_ID: routed.session.id,
    });
  });

  it('overrides any stale warm-container persona with the loaded host persona during adoption', async () => {
    const stateDir = makeStateDir();
    const warmSessionDir = path.join(stateDir, 'warm', 'warm-persona-loaded');

    db = new Database(':memory:');
    migrate(db);
    insertAgentGroup('support');
    db.prepare('UPDATE agent_groups SET soul = ? WHERE id = ?').run('db persona', 'support');

    const routed = makeRoutedRequest({ stateDir, sessionDir: path.join(stateDir, 'sessions', 'support', 'live-session') });
    insertSession(routed);
    trackContainer('warm-persona-loaded', {
      containerName: 'cove-warm-warm-persona-loaded',
      sessionDir: warmSessionDir,
      envVars: { WARM_ONLY: 'true', COVE_PERSONA: 'stale warm persona' },
    });

    const ensureSessionRuntime = createEnsureSessionRuntime({
      db,
      warmPool: makeWarmPool({
        acquire: async () => ({
          sessionId: 'warm-persona-loaded',
          containerName: 'cove-warm-warm-persona-loaded',
          sessionDir: warmSessionDir,
        }),
      }),
      imageName: 'cove-agent:latest',
      centralDbPath: '/tmp/cove.db',
    });

    const config = makeConfig({
      extra_env: {
        EXTRA_FLAG: '1',
      },
    });

    const ready = await ensureSessionRuntime({ routed, config });

    expect(ready).toBe(true);
    expect(getActiveContainers().get(routed.session.id)?.options.envVars).toMatchObject({
      WARM_ONLY: 'true',
      EXTRA_FLAG: '1',
      COVE_PERSONA: 'db persona',
      COVE_SESSION_ID: routed.session.id,
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
    let capturedSpawnOptions: { envVars?: Record<string, string> } | undefined;
    const spawnContainer = mock((options) => {
      capturedSpawnOptions = options;
      return true;
    });
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
      config: makeConfig({
        workspace: '/workspace/override',
        extra_env: {
          EXTRA_FLAG: 'fallback',
          COVE_WORKFLOW_API_BASE_URL: 'http://host.docker.internal:4111',
        },
      }),
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
        COVE_WORKFLOW_API_BASE_URL: 'http://host.docker.internal:4111',
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

    let capturedSpawnOptions: { envVars?: Record<string, string> } | undefined;
    const spawnContainer = mock((options) => {
      capturedSpawnOptions = options;
      return true;
    });
    const ensureSessionRuntime = createEnsureSessionRuntime({
      db,
      warmPool: makeWarmPool(),
      imageName: 'cove-agent:latest',
      centralDbPath: '/tmp/cove.db',
      spawnContainer,
    });

    const ready = await ensureSessionRuntime({
      routed,
      config: makeConfig({
        workspace: null,
        extra_env: {
          COVE_WORKFLOW_API_BASE_URL: 'http://host.docker.internal:4111',
        },
      }),
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
        COVE_WORKFLOW_API_BASE_URL: 'http://host.docker.internal:4111',
        COVE_SESSION_ID: routed.session.id,
      },
    });
  });

  it('includes allowlisted OneCLI gateway env in cold-spawn runtime env without leaking unrelated host env', async () => {
    const stateDir = makeStateDir();
    const coldSessionDir = path.join(stateDir, 'sessions', 'support', 'live-session');

    process.env.HTTPS_PROXY = 'https://proxy.example';
    process.env.http_proxy = 'http://proxy.example';
    process.env.NODE_EXTRA_CA_CERTS = '/tmp/certs.pem';
    process.env.ONECLI_AGENT_NAME = 'cove-agent';
    process.env.ONECLI_URL = 'https://onecli.example';
    process.env.AWS_SECRET_ACCESS_KEY = 'should-not-leak';

    db = new Database(':memory:');
    migrate(db);
    insertAgentGroup('support');

    const routed = makeRoutedRequest({ stateDir, sessionDir: coldSessionDir });
    insertSession(routed);

    let capturedSpawnOptions: { envVars?: Record<string, string> } | undefined;
    const spawnContainer = mock((options) => {
      capturedSpawnOptions = options;
      return true;
    });
    const ensureSessionRuntime = createEnsureSessionRuntime({
      db,
      warmPool: makeWarmPool(),
      imageName: 'cove-agent:latest',
      centralDbPath: '/tmp/cove.db',
      spawnContainer,
    });

    const ready = await ensureSessionRuntime({
      routed,
      config: makeConfig({ extra_env: { EXTRA_FLAG: '1' } }),
    });

    expect(ready).toBe(true);
    expect(spawnContainer).toHaveBeenCalledWith(expect.objectContaining({
      envVars: {
        EXTRA_FLAG: '1',
        HTTPS_PROXY: 'https://proxy.example',
        http_proxy: 'http://proxy.example',
        NODE_EXTRA_CA_CERTS: '/tmp/certs.pem',
        ONECLI_AGENT_NAME: 'cove-agent',
        ONECLI_URL: 'https://onecli.example',
        COVE_SESSION_ID: routed.session.id,
      },
    }));
    expect(capturedSpawnOptions?.envVars).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
  });

  it('injects loaded persona into config extra_env and preserves existing values for cold spawn', async () => {
    const stateDir = makeStateDir();
    const coldSessionDir = path.join(stateDir, 'sessions', 'support', 'live-session');

    db = new Database(':memory:');
    migrate(db);
    insertAgentGroup('support');
    db.prepare('UPDATE agent_groups SET soul = ? WHERE id = ?').run('db persona', 'support');

    const routed = makeRoutedRequest({ stateDir, sessionDir: coldSessionDir });
    insertSession(routed);

    const spawnContainer = mock(() => true);
    const config = makeConfig({ extra_env: { EXTRA_FLAG: 'kept' } });
    const ensureSessionRuntime = createEnsureSessionRuntime({
      db,
      warmPool: makeWarmPool(),
      imageName: 'cove-agent:latest',
      centralDbPath: '/tmp/cove.db',
      spawnContainer,
    });

    const ready = await ensureSessionRuntime({
      routed,
      config,
    });

    expect(ready).toBe(true);
    expect(config.extra_env).toEqual({ EXTRA_FLAG: 'kept' });
    expect(spawnContainer).toHaveBeenCalledWith({
      imageName: 'cove-agent:latest',
      containerName: routed.session.id,
      sessionId: routed.session.id,
      sessionDir: coldSessionDir,
      centralDbPath: '/tmp/cove.db',
      workspaceDir: '/workspace/support',
      envVars: {
        EXTRA_FLAG: 'kept',
        COVE_PERSONA: 'db persona',
        COVE_SESSION_ID: routed.session.id,
      },
    });
    expect(readAgentGroupSoul('support')).toBe('db persona');
  });

  it('preserves inherited OneCLI gateway env during warm adoption while overriding live-session keys', async () => {
    const stateDir = makeStateDir();
    const warmSessionDir = path.join(stateDir, 'warm', 'warm-onecli');

    process.env.HTTPS_PROXY = 'https://different-host-proxy.example';
    process.env.ONECLI_URL = 'https://different-host-onecli.example';

    db = new Database(':memory:');
    migrate(db);
    insertAgentGroup('support');

    const routed = makeRoutedRequest({ stateDir, sessionDir: path.join(stateDir, 'sessions', 'support', 'live-session') });
    insertSession(routed);
    trackContainer('warm-onecli', {
      containerName: 'cove-warm-warm-onecli',
      sessionDir: warmSessionDir,
      envVars: {
        HTTPS_PROXY: 'https://warm-proxy.example',
        ONECLI_URL: 'https://warm-onecli.example',
        ONECLI_AGENT_NAME: 'warm-agent',
        COVE_SESSION_ID: 'warm-onecli',
      },
    });

    const ensureSessionRuntime = createEnsureSessionRuntime({
      db,
      warmPool: makeWarmPool({
        acquire: async () => ({
          sessionId: 'warm-onecli',
          containerName: 'cove-warm-warm-onecli',
          sessionDir: warmSessionDir,
        }),
      }),
      imageName: 'cove-agent:latest',
      centralDbPath: '/tmp/cove.db',
    });

    const ready = await ensureSessionRuntime({
      routed,
      config: makeConfig({ extra_env: { EXTRA_FLAG: '1' } }),
    });

    expect(ready).toBe(true);
    expect(getActiveContainers().get(routed.session.id)?.options.envVars).toEqual({
      HTTPS_PROXY: 'https://warm-proxy.example',
      ONECLI_URL: 'https://warm-onecli.example',
      ONECLI_AGENT_NAME: 'warm-agent',
      EXTRA_FLAG: '1',
      COVE_SESSION_ID: routed.session.id,
    });
  });

  it('does not let config extra_env override allowlisted OneCLI gateway env during cold spawn', async () => {
    const stateDir = makeStateDir();
    const coldSessionDir = path.join(stateDir, 'sessions', 'support', 'live-session');

    process.env.HTTPS_PROXY = 'https://proxy.example';
    process.env.ONECLI_AGENT_NAME = 'host-agent';
    process.env.ONECLI_URL = 'https://host-onecli.example';

    db = new Database(':memory:');
    migrate(db);
    insertAgentGroup('support');

    const routed = makeRoutedRequest({ stateDir, sessionDir: coldSessionDir });
    insertSession(routed);

    let capturedSpawnOptions: { envVars?: Record<string, string> } | undefined;
    const spawnContainer = mock((options) => {
      capturedSpawnOptions = options;
      return true;
    });
    const ensureSessionRuntime = createEnsureSessionRuntime({
      db,
      warmPool: makeWarmPool(),
      imageName: 'cove-agent:latest',
      centralDbPath: '/tmp/cove.db',
      spawnContainer,
    });

    const ready = await ensureSessionRuntime({
      routed,
      config: makeConfig({
        extra_env: {
          EXTRA_FLAG: '1',
          HTTPS_PROXY: 'https://config-proxy.example',
          ONECLI_AGENT_NAME: 'config-agent',
          ONECLI_URL: 'https://config-onecli.example',
        },
      }),
    });

    expect(ready).toBe(true);
    expect(capturedSpawnOptions?.envVars).toEqual({
      HTTPS_PROXY: 'https://proxy.example',
      ONECLI_AGENT_NAME: 'host-agent',
      ONECLI_URL: 'https://host-onecli.example',
      EXTRA_FLAG: '1',
      COVE_SESSION_ID: routed.session.id,
    });
  });

  it('does not let config extra_env override inherited OneCLI gateway env during warm adoption', async () => {
    const stateDir = makeStateDir();
    const warmSessionDir = path.join(stateDir, 'warm', 'warm-onecli-locked');

    db = new Database(':memory:');
    migrate(db);
    insertAgentGroup('support');

    const routed = makeRoutedRequest({ stateDir, sessionDir: path.join(stateDir, 'sessions', 'support', 'live-session') });
    insertSession(routed);
    trackContainer('warm-onecli-locked', {
      containerName: 'cove-warm-warm-onecli-locked',
      sessionDir: warmSessionDir,
      envVars: {
        HTTPS_PROXY: 'https://warm-proxy.example',
        ONECLI_URL: 'https://warm-onecli.example',
        ONECLI_AGENT_NAME: 'warm-agent',
        COVE_SESSION_ID: 'warm-onecli-locked',
      },
    });

    const ensureSessionRuntime = createEnsureSessionRuntime({
      db,
      warmPool: makeWarmPool({
        acquire: async () => ({
          sessionId: 'warm-onecli-locked',
          containerName: 'cove-warm-warm-onecli-locked',
          sessionDir: warmSessionDir,
        }),
      }),
      imageName: 'cove-agent:latest',
      centralDbPath: '/tmp/cove.db',
    });

    const ready = await ensureSessionRuntime({
      routed,
      config: makeConfig({
        extra_env: {
          EXTRA_FLAG: '1',
          HTTPS_PROXY: 'https://config-proxy.example',
          ONECLI_URL: 'https://config-onecli.example',
          ONECLI_AGENT_NAME: 'config-agent',
        },
      }),
    });

    expect(ready).toBe(true);
    expect(getActiveContainers().get(routed.session.id)?.options.envVars).toEqual({
      HTTPS_PROXY: 'https://warm-proxy.example',
      ONECLI_URL: 'https://warm-onecli.example',
      ONECLI_AGENT_NAME: 'warm-agent',
      EXTRA_FLAG: '1',
      COVE_SESSION_ID: routed.session.id,
    });
  });

  it('keeps an explicit config extra_env COVE_PERSONA instead of loading from the database', async () => {
    const stateDir = makeStateDir();
    const coldSessionDir = path.join(stateDir, 'sessions', 'support', 'live-session');

    db = new Database(':memory:');
    migrate(db);
    insertAgentGroup('support');
    db.prepare('UPDATE agent_groups SET soul = ? WHERE id = ?').run('db persona', 'support');

    const routed = makeRoutedRequest({ stateDir, sessionDir: coldSessionDir });
    insertSession(routed);

    const spawnContainer = mock(() => true);
    const config = makeConfig({
      extra_env: {
        EXTRA_FLAG: 'kept',
        COVE_PERSONA: 'explicit persona',
      },
    });
    const ensureSessionRuntime = createEnsureSessionRuntime({
      db,
      warmPool: makeWarmPool(),
      imageName: 'cove-agent:latest',
      centralDbPath: '/tmp/cove.db',
      spawnContainer,
    });

    const ready = await ensureSessionRuntime({
      routed,
      config,
    });

    expect(ready).toBe(true);
    expect(config.extra_env).toEqual({
      EXTRA_FLAG: 'kept',
      COVE_PERSONA: 'explicit persona',
    });
    expect(spawnContainer).toHaveBeenCalledWith(expect.objectContaining({
      envVars: {
        EXTRA_FLAG: 'kept',
        COVE_PERSONA: 'explicit persona',
        COVE_SESSION_ID: routed.session.id,
      },
    }));
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
