import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../../src/api/app.ts';
import { getActiveContainers } from '../../src/container/spawn.ts';
import { migrate } from '../../src/db/migrate.ts';

type AgentGroupApiRow = {
  id: string;
  name: string;
  description: string | null;
  workspace: string | null;
  provider: string;
  model: string | null;
  thinking: string;
  permissions: Record<string, unknown>;
  soul: string | null;
  config: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

let db: Database | undefined;
const tempDirs: string[] = [];
const originalRuntimeBin = process.env.COVE_CONTAINER_RUNTIME_BIN;

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function requireDb(): Database {
  if (db == null) {
    throw new Error('Test database is not initialized');
  }

  return db;
}

function createAgentGroupDb(): Database {
  const created = new Database(':memory:');
  migrate(created);
  return created;
}

function insertAgentGroup(
  database: Database,
  id: string,
  overrides: Partial<{
    name: string;
    description: string | null;
    workspace: string | null;
    provider: string;
    model: string | null;
    thinking: string;
    permissions: string;
    soul: string | null;
    config: string | null;
    created_at: string;
    updated_at: string;
  }> = {},
): void {
  database.prepare(
    `INSERT INTO agent_groups (
       id,
       name,
       description,
       workspace,
       provider,
       model,
       thinking,
       permissions,
       soul,
       config,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    overrides.name ?? `${id} name`,
    overrides.description ?? null,
    overrides.workspace ?? null,
    overrides.provider ?? 'auto',
    overrides.model ?? null,
    overrides.thinking ?? 'medium',
    overrides.permissions ?? '{"default":"auto"}',
    overrides.soul ?? null,
    overrides.config ?? null,
    overrides.created_at ?? '2026-01-01T00:00:00.000Z',
    overrides.updated_at ?? '2026-01-01T00:00:00.000Z',
  );
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

afterEach(() => {
  db?.close();
  db = undefined;
  getActiveContainers().clear();

  if (originalRuntimeBin === undefined) {
    delete process.env.COVE_CONTAINER_RUNTIME_BIN;
  } else {
    process.env.COVE_CONTAINER_RUNTIME_BIN = originalRuntimeBin;
  }

  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('agent groups api', () => {
  it('creates agent groups with defaults, parsed JSON fields, and unknown create fields ignored', async () => {
    db = createAgentGroupDb();

    const app = createApp({ db: requireDb() });
    const response = await app.fetch(new Request('http://cove.test/v1/agent-groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'support',
        name: 'Support Team',
        ignored_field: 'ignored',
      }),
    }));

    expect(response.status).toBe(201);
    expect(await json<AgentGroupApiRow>(response)).toEqual({
      id: 'support',
      name: 'Support Team',
      description: null,
      workspace: null,
      provider: 'auto',
      model: null,
      thinking: 'medium',
      permissions: { default: 'auto' },
      soul: null,
      config: null,
      created_at: expect.any(String),
      updated_at: expect.any(String),
    });
  });

  it('creates agent groups with explicit optional fields and parsed config payloads', async () => {
    db = createAgentGroupDb();

    const app = createApp({ db: requireDb() });
    const response = await app.fetch(new Request('http://cove.test/v1/agent-groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'research',
        name: 'Research Team',
        description: 'Long-form investigations',
        workspace: '/workspace/research',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        thinking: 'high',
        permissions: {
          default: 'ask',
          bash: 'confirm',
        },
        soul: 'Be methodical.',
        config: {
          credential_profile: 'prod-research',
          extra_env: {
            FOO: 'bar',
          },
          provider_env_passthrough: [
            { name: 'CUSTOM_TOKEN', required: true },
          ],
          provider_file_env_passthrough: [
            { name: 'CUSTOM_CRED_FILE', kind: 'file', required: true },
          ],
        },
      }),
    }));

    expect(response.status).toBe(201);
    expect(await json<AgentGroupApiRow>(response)).toEqual({
      id: 'research',
      name: 'Research Team',
      description: 'Long-form investigations',
      workspace: '/workspace/research',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      thinking: 'high',
      permissions: {
        default: 'ask',
        bash: 'confirm',
      },
      soul: 'Be methodical.',
      config: {
        credential_profile: 'prod-research',
        extra_env: {
          FOO: 'bar',
        },
        provider_env_passthrough: [
          { name: 'CUSTOM_TOKEN', required: true },
        ],
        provider_file_env_passthrough: [
          { name: 'CUSTOM_CRED_FILE', kind: 'file', required: true },
        ],
      },
      created_at: expect.any(String),
      updated_at: expect.any(String),
    });
  });

  it('rejects invalid runtime-prep config on create and update', async () => {
    db = createAgentGroupDb();
    insertAgentGroup(requireDb(), 'support');

    const app = createApp({ db: requireDb() });

    const invalidCreateResponse = await app.fetch(new Request('http://cove.test/v1/agent-groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'invalid-create',
        name: 'Invalid Create',
        config: {
          provider_env_passthrough: [{ name: '   ' }],
        },
      }),
    }));
    expect(invalidCreateResponse.status).toBe(400);
    expect(await json<{ error: string }>(invalidCreateResponse)).toEqual({
      error: 'Invalid agent group config: provider_env_passthrough[0].name must be a non-empty string',
    });

    const invalidUpdateResponse = await app.fetch(new Request('http://cove.test/v1/agent-groups/support', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: {
          extra_env: {
            CUSTOM_CRED_FILE: 'literal-path',
          },
          provider_file_env_passthrough: [{ name: 'CUSTOM_CRED_FILE', kind: 'file' }],
        },
      }),
    }));
    expect(invalidUpdateResponse.status).toBe(400);
    expect(await json<{ error: string }>(invalidUpdateResponse)).toEqual({
      error: 'Invalid agent group config: extra_env must not define provider file passthrough name: CUSTOM_CRED_FILE',
    });
  });

  it('rejects invalid create payloads with 400', async () => {
    db = createAgentGroupDb();

    const app = createApp({ db: requireDb() });

    const invalidJsonResponse = await app.fetch(new Request('http://cove.test/v1/agent-groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    }));
    expect(invalidJsonResponse.status).toBe(400);
    expect(await json<{ error: string }>(invalidJsonResponse)).toEqual({ error: 'Invalid JSON body' });

    for (const payload of [
      [],
      {},
      { id: 'support' },
      { name: 'Support Team' },
      { id: '   ', name: 'Support Team' },
      { id: 'support', name: '   ' },
      { id: 'support', name: 'Support Team', permissions: null },
      { id: 'support', name: 'Support Team', permissions: ['bad'] },
      { id: 'support', name: 'Support Team', config: ['bad'] },
      { id: 'support', name: 'Support Team', workspace: 42 },
    ]) {
      const response = await app.fetch(new Request('http://cove.test/v1/agent-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }));

      expect(response.status).toBe(400);
      expect(await json<{ error: string }>(response)).toEqual({ error: expect.any(String) });
    }
  });

  it('rejects duplicate ids with 409', async () => {
    db = createAgentGroupDb();
    insertAgentGroup(requireDb(), 'support');

    const app = createApp({ db: requireDb() });
    const response = await app.fetch(new Request('http://cove.test/v1/agent-groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'support',
        name: 'Support Team',
      }),
    }));

    expect(response.status).toBe(409);
    expect(await json<{ error: string }>(response)).toEqual({ error: 'Agent group already exists: support' });
  });

  it('lists agent groups ordered by created_at ASC then id ASC and gets a single row by id', async () => {
    db = createAgentGroupDb();
    insertAgentGroup(requireDb(), 'zeta', {
      name: 'Zeta Team',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    insertAgentGroup(requireDb(), 'alpha', {
      name: 'Alpha Team',
      permissions: '{"default":"ask"}',
      config: '{"region":"eu"}',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    insertAgentGroup(requireDb(), 'beta', {
      name: 'Beta Team',
      created_at: '2026-01-02T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    });

    const app = createApp({ db: requireDb() });
    const listResponse = await app.fetch(new Request('http://cove.test/v1/agent-groups'));
    const getResponse = await app.fetch(new Request('http://cove.test/v1/agent-groups/alpha'));

    expect(listResponse.status).toBe(200);
    expect((await json<AgentGroupApiRow[]>(listResponse)).map((row) => row.id)).toEqual(['alpha', 'zeta', 'beta']);

    expect(getResponse.status).toBe(200);
    expect(await json<AgentGroupApiRow>(getResponse)).toEqual({
      id: 'alpha',
      name: 'Alpha Team',
      description: null,
      workspace: null,
      provider: 'auto',
      model: null,
      thinking: 'medium',
      permissions: { default: 'ask' },
      soul: null,
      config: { region: 'eu' },
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('returns 404 when getting a missing agent group', async () => {
    db = createAgentGroupDb();

    const app = createApp({ db: requireDb() });
    const response = await app.fetch(new Request('http://cove.test/v1/agent-groups/missing'));

    expect(response.status).toBe(404);
    expect(await json<{ error: string }>(response)).toEqual({ error: 'Not Found' });
  });

  it('updates agent groups with partial updates, nullable clears, and parsed JSON fields', async () => {
    db = createAgentGroupDb();
    insertAgentGroup(requireDb(), 'support', {
      name: 'Support Team',
      description: 'Handles support',
      workspace: '/workspace/support',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      thinking: 'medium',
      permissions: '{"default":"ask"}',
      soul: 'Be concise.',
      config: '{"credential_profile":"support"}',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });

    const app = createApp({ db: requireDb() });
    const response = await app.fetch(new Request('http://cove.test/v1/agent-groups/support', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Support Escalations',
        description: null,
        config: null,
        permissions: {
          default: 'auto',
          bash: 'confirm',
        },
        ignored_field: true,
      }),
    }));

    expect(response.status).toBe(200);
    expect(await json<AgentGroupApiRow>(response)).toEqual({
      id: 'support',
      name: 'Support Escalations',
      description: null,
      workspace: '/workspace/support',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      thinking: 'medium',
      permissions: {
        default: 'auto',
        bash: 'confirm',
      },
      soul: 'Be concise.',
      config: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: expect.any(String),
    });
  });

  it('treats immutable-and-unknown-only update payloads as a successful no-op', async () => {
    db = createAgentGroupDb();
    insertAgentGroup(requireDb(), 'support', {
      name: 'Support Team',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });

    const app = createApp({ db: requireDb() });
    const response = await app.fetch(new Request('http://cove.test/v1/agent-groups/support', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'changed',
        created_at: '2099-01-01T00:00:00.000Z',
        updated_at: '2099-01-01T00:00:00.000Z',
        unknown: true,
      }),
    }));

    expect(response.status).toBe(200);
    expect(await json<AgentGroupApiRow>(response)).toEqual({
      id: 'support',
      name: 'Support Team',
      description: null,
      workspace: null,
      provider: 'auto',
      model: null,
      thinking: 'medium',
      permissions: { default: 'auto' },
      soul: null,
      config: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('returns 400 for invalid update payloads and 404 for a missing row', async () => {
    db = createAgentGroupDb();
    insertAgentGroup(requireDb(), 'support');

    const app = createApp({ db: requireDb() });

    const invalidJsonResponse = await app.fetch(new Request('http://cove.test/v1/agent-groups/support', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    }));
    expect(invalidJsonResponse.status).toBe(400);
    expect(await json<{ error: string }>(invalidJsonResponse)).toEqual({ error: 'Invalid JSON body' });

    for (const payload of [
      [],
      { permissions: null },
      { permissions: ['bad'] },
      { config: ['bad'] },
      { workspace: 42 },
    ]) {
      const response = await app.fetch(new Request('http://cove.test/v1/agent-groups/support', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }));

      expect(response.status).toBe(400);
      expect(await json<{ error: string }>(response)).toEqual({ error: expect.any(String) });
    }

    const missingResponse = await app.fetch(new Request('http://cove.test/v1/agent-groups/missing', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated' }),
    }));
    expect(missingResponse.status).toBe(404);
    expect(await json<{ error: string }>(missingResponse)).toEqual({ error: 'Not Found' });
  });

  it('deletes an agent group and the row is no longer retrievable', async () => {
    db = createAgentGroupDb();
    insertAgentGroup(requireDb(), 'support');

    const app = createApp({ db: requireDb() });
    const deleteResponse = await app.fetch(new Request('http://cove.test/v1/agent-groups/support', {
      method: 'DELETE',
    }));
    const getResponse = await app.fetch(new Request('http://cove.test/v1/agent-groups/support'));

    expect(deleteResponse.status).toBe(204);
    expect(getResponse.status).toBe(404);
  });

  it('returns 404 when deleting a missing agent group', async () => {
    db = createAgentGroupDb();

    const app = createApp({ db: requireDb() });
    const response = await app.fetch(new Request('http://cove.test/v1/agent-groups/missing', {
      method: 'DELETE',
    }));

    expect(response.status).toBe(404);
    expect(await json<{ error: string }>(response)).toEqual({ error: 'Not Found' });
  });

  for (const dependency of ['sessions', 'schedules', 'approvals', 'memories'] as const) {
    it(`returns 409 when deleting an agent group with dependent ${dependency} rows`, async () => {
      db = createAgentGroupDb();
      insertAgentGroup(requireDb(), 'support');

      if (dependency === 'sessions') {
        requireDb().prepare(
          `INSERT INTO sessions (id, agent_group_id, thread_id, session_file, metadata, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          'session-1',
          'support',
          'default',
          '/tmp/session-1',
          null,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
        );
      }

      if (dependency === 'schedules') {
        requireDb().prepare(
          `INSERT INTO schedules (id, agent_group_id, cron_expr, prompt, mode, config, enabled, last_run_at, next_run_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          'schedule-1',
          'support',
          '0 9 * * *',
          'Run schedule',
          'agent',
          null,
          1,
          null,
          '2026-01-15T09:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
        );
      }

      if (dependency === 'approvals') {
        insertAgentGroup(requireDb(), 'other');
        requireDb().prepare(
          `INSERT INTO sessions (id, agent_group_id, thread_id, session_file, metadata, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          'session-other',
          'other',
          'default',
          '/tmp/session-other',
          null,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
        );
        requireDb().prepare(
          `INSERT INTO approvals (id, agent_group_id, session_id, tool_name, tool_args, status, requested_at, responded_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          'approval-1',
          'support',
          'session-other',
          'bash',
          '{"command":"git status"}',
          'pending',
          '2026-01-01T00:00:00.000Z',
          null,
          '2026-01-01T00:05:00.000Z',
        );
      }

      if (dependency === 'memories') {
        requireDb().prepare(
          `INSERT INTO memories (id, content, embedding, agent_group_id, session_id, importance, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          'memory-1',
          'Important detail',
          null,
          'support',
          null,
          0.7,
          '2026-01-01T00:00:00.000Z',
        );
      }

      const app = createApp({ db: requireDb() });
      const response = await app.fetch(new Request('http://cove.test/v1/agent-groups/support', {
        method: 'DELETE',
      }));

      expect(response.status).toBe(409);
      expect(await json<{ error: string }>(response)).toEqual({
        error: `Agent group has dependent records in: ${dependency}`,
      });

      const getResponse = await app.fetch(new Request('http://cove.test/v1/agent-groups/support'));
      expect(getResponse.status).toBe(200);
    });
  }

  it('stops and untracks active containers for a successfully deleted agent group', async () => {
    db = createAgentGroupDb();
    insertAgentGroup(requireDb(), 'support');
    insertAgentGroup(requireDb(), 'other');

    const tmpDir = makeTempDir('cove-v2-agent-groups-delete-');
    const runtimePath = path.join(tmpDir, 'fake-runtime.sh');
    const logPath = path.join(tmpDir, 'runtime.log');

    fs.writeFileSync(
      runtimePath,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  exit 0\nfi\nprintf '%s\\n' "$@" >> "${logPath}"\nexit 0\n`,
      'utf8',
    );
    fs.chmodSync(runtimePath, 0o755);
    process.env.COVE_CONTAINER_RUNTIME_BIN = runtimePath;

    getActiveContainers().set('sess-support', {
      name: 'tracked-container',
      startedAt: Date.now(),
      options: {
        imageName: 'cove-agent:latest',
        containerName: 'tracked-container',
        sessionDir: '/tmp/cove-support',
        sessionId: 'sess-support',
        envVars: {
          COVE_AGENT_GROUP_ID: 'support',
        },
      },
      process: {
        kill: () => true,
      } as never,
      running: true,
    });
    getActiveContainers().set('sess-other', {
      name: 'other-container',
      startedAt: Date.now(),
      options: {
        imageName: 'cove-agent:latest',
        containerName: 'other-container',
        sessionDir: '/tmp/cove-other',
        sessionId: 'sess-other',
        envVars: {
          COVE_AGENT_GROUP_ID: 'other',
        },
      },
      process: {
        kill: () => true,
      } as never,
      running: true,
    });

    const app = createApp({ db: requireDb() });
    const response = await app.fetch(new Request('http://cove.test/v1/agent-groups/support', {
      method: 'DELETE',
    }));

    expect(response.status).toBe(204);
    expect(getActiveContainers().has('sess-support')).toBe(false);
    expect(getActiveContainers().has('sess-other')).toBe(true);

    const log = fs.readFileSync(logPath, 'utf8');
    expect(log).toContain('stop');
    expect(log).toContain('tracked-container');
    expect(log).not.toContain('other-container');
  });
});
