import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../../src/api/app.ts';
import { migrate } from '../../src/db/migrate.ts';
import type { OutboundMessageRow } from '../../src/shared/types.ts';

const stateDirs: string[] = [];

function makeStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cove-v2-chat-'));
  stateDirs.push(dir);
  return dir;
}

function insertAgentGroup(db: Database, overrides: {
  id?: string;
  provider?: string;
  model?: string | null;
  workspace?: string | null;
  thinking?: string;
  permissions?: string;
  config?: string | null;
} = {}): void {
  const now = '2026-01-01T00:00:00.000Z';

  db.prepare(
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
    overrides.id ?? 'chat-group-1',
    'Chat Agent',
    overrides.workspace ?? '/workspace/chat-group-1',
    overrides.provider ?? 'anthropic',
    overrides.model ?? 'group-model',
    overrides.thinking ?? 'high',
    overrides.permissions ?? '{"default":"ask"}',
    'soul-chat-group-1',
    overrides.config ?? '{"api_key":"sk-chat-test","extra_env":{"CUSTOM_FLAG":"enabled"}}',
    now,
    now,
  );
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

afterEach(() => {
  delete process.env.COVE_STATE_DIR;

  for (const stateDir of stateDirs.splice(0)) {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

describe('chat completions api', () => {
  it('returns 400 when the body is not valid JSON', async () => {
    const db = new Database(':memory:');
    migrate(db);
    insertAgentGroup(db, { id: 'default' });

    try {
      const app = createApp({ db });
      const response = await app.fetch(
        new Request('http://cove.test/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{',
        }),
      );

      expect(response.status).toBe(400);
      expect(await json(response)).toEqual({ error: 'Invalid JSON body' });
    } finally {
      db.close();
    }
  });

  it('returns 400 when messages is missing, not an array, or empty', async () => {
    const db = new Database(':memory:');
    migrate(db);
    insertAgentGroup(db, { id: 'default' });

    try {
      const app = createApp({ db });

      for (const body of [{}, { messages: 'hello' }, { messages: [] }]) {
        const response = await app.fetch(
          new Request('http://cove.test/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
        );

        expect(response.status).toBe(400);
        expect(await json(response)).toEqual({
          error: 'messages is required and must be a non-empty array',
        });
      }
    } finally {
      db.close();
    }
  });

  it('returns 404 when the selected agent group does not exist', async () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    const db = new Database(':memory:');
    migrate(db);
    insertAgentGroup(db, { id: 'default' });

    try {
      const app = createApp({ db });
      const response = await app.fetch(
        new Request('http://cove.test/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent_group_id: 'unknown-group',
            messages: [{ role: 'user', content: 'Hello' }],
          }),
        }),
      );

      expect(response.status).toBe(404);
      expect(await json(response)).toEqual({ error: 'Agent group not found: unknown-group' });
    } finally {
      db.close();
    }
  });

  it('uses body model as the public agent-group selector and returns an OpenAI-compatible response', async () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    const db = new Database(':memory:');
    migrate(db);
    insertAgentGroup(db, { id: 'public-model-id' });

    try {
      const app = createApp({ db });
      const response = await createApp({
        db,
        chat: {
          async pollForResponse(): Promise<OutboundMessageRow[]> {
            return [
              {
                id: 'assistant-1',
                seq: 3,
                role: 'assistant',
                content: 'Model selector reply',
                finish_reason: 'stop',
                tool_calls: null,
                metadata: null,
                created_at: '2026-01-01T00:00:00.000Z',
              },
            ];
          },
        },
      }).fetch(
        new Request('http://cove.test/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'public-model-id',
            messages: [{ role: 'user', content: 'Hello there' }],
          }),
        }),
      );

      expect(response.status).toBe(200);

      const body = await json(response);
      expect(body.id).toBeDefined();
      expect(body.object).toBe('chat.completion');
      expect(body.created).toEqual(expect.any(Number));
      expect(body.model).toBe('public-model-id');
      expect(body.choices).toEqual([
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Model selector reply',
          },
          finish_reason: 'stop',
        },
      ]);
    } finally {
      db.close();
    }
  });

  it('writes session_config and inbound executable work before returning the non-streaming response', async () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    const db = new Database(':memory:');
    migrate(db);
    insertAgentGroup(db, { id: 'chat-group-1' });

    try {
      const response = await createApp({
        db,
        chat: {
          async pollForResponse(): Promise<OutboundMessageRow[]> {
            return [
              {
                id: 'assistant-2',
                seq: 3,
                role: 'assistant',
                content: 'Configured reply',
                finish_reason: 'stop',
                tool_calls: null,
                metadata: null,
                created_at: '2026-01-01T00:00:00.000Z',
              },
            ];
          },
        },
      }).fetch(
        new Request('http://cove.test/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent_group_id: 'chat-group-1',
            provider_model: 'request-model',
            thread_id: 'thread-42',
            messages: [{ role: 'user', content: 'Hello from the user' }],
          }),
        }),
      );

      expect(response.status).toBe(200);

      const sessionRow = db
        .prepare('SELECT id, session_file FROM sessions WHERE agent_group_id = ? AND thread_id = ?')
        .get('chat-group-1', 'thread-42') as { id: string; session_file: string | null };

      expect(sessionRow.session_file).toBeTruthy();

      const inboundDb = new Database(path.join(sessionRow.session_file!, 'inbound.db'));
      const outboundDb = new Database(path.join(sessionRow.session_file!, 'outbound.db'));
      const workingFile = path.join(sessionRow.session_file!, 'working.jsonl');

      try {
        const configRow = inboundDb.prepare(
          'SELECT provider, model, thinking_level, api_key, workspace, extra_env, permissions FROM session_config',
        ).get() as {
          provider: string;
          model: string;
          thinking_level: string | null;
          api_key: string | null;
          workspace: string | null;
          extra_env: string | null;
          permissions: string | null;
        };
        const inboundRows = inboundDb.prepare(
          'SELECT seq, role, content, metadata FROM messages_in ORDER BY seq ASC',
        ).all() as Array<{ seq: number; role: string; content: string; metadata: string | null }>;
        expect(configRow).toEqual({
          provider: 'anthropic',
          model: 'request-model',
          thinking_level: 'high',
          api_key: 'sk-chat-test',
          workspace: '/workspace/chat-group-1',
          extra_env: '{"CUSTOM_FLAG":"enabled"}',
          permissions: '{"default":"ask"}',
        });
        expect(inboundRows).toEqual([
          {
            seq: 2,
            role: 'user',
            content: 'Hello from the user',
            metadata: null,
          },
        ]);
        expect(fs.existsSync(workingFile)).toBe(true);
        const workingMessages = fs
          .readFileSync(workingFile, 'utf8')
          .trim()
          .split('\n')
          .slice(1)
          .map((line) => JSON.parse(line).message);
        expect(workingMessages).toEqual([{ role: 'user', content: 'Hello from the user' }]);
      } finally {
        inboundDb.close();
        outboundDb.close();
      }
    } finally {
      db.close();
    }
  });

  it('returns the verified assistant response and preserves metadata', async () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    const db = new Database(':memory:');
    migrate(db);
    insertAgentGroup(db, { id: 'chat-group-1' });

    try {
      const response = await createApp({
        db,
        chat: {
          async pollForResponse(): Promise<OutboundMessageRow[]> {
            return [
              {
                id: 'assistant-1',
                seq: 3,
                role: 'assistant',
                content: 'Verified answer',
                finish_reason: 'stop',
                tool_calls: null,
                metadata: '{"permission":"confirm","approval_id":"apr-123"}',
                created_at: '2026-01-01T00:00:00.000Z',
              },
            ];
          },
        },
      }).fetch(
        new Request('http://cove.test/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent_group_id: 'chat-group-1',
            thread_id: 'thread-with-output',
            messages: [{ role: 'user', content: 'Need an answer' }],
          }),
        }),
      );

      expect(response.status).toBe(200);
      const sessionRow = db
        .prepare('SELECT id FROM sessions WHERE agent_group_id = ? AND thread_id = ?')
        .get('chat-group-1', 'thread-with-output') as { id: string };
      expect(await json(response)).toEqual({
        id: `chatcmpl-${sessionRow.id}`,
        object: 'chat.completion',
        created: expect.any(Number),
        model: 'chat-group-1',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'Verified answer',
              metadata: {
                permission: 'confirm',
                approval_id: 'apr-123',
              },
            },
            finish_reason: 'stop',
          },
        ],
      });
    } finally {
      db.close();
    }
  });

  it('returns 503 when the session runtime cannot be started', async () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    const db = new Database(':memory:');
    migrate(db);
    insertAgentGroup(db, { id: 'chat-group-1' });

    try {
      const response = await createApp({
        db,
        chat: {
          async ensureSessionRuntime() {
            return false;
          },
          async pollForResponse() {
            throw new Error('pollForResponse should not run when runtime startup fails');
          },
        },
      }).fetch(
        new Request('http://cove.test/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent_group_id: 'chat-group-1',
            messages: [{ role: 'user', content: 'Hello' }],
          }),
        }),
      );

      expect(response.status).toBe(503);
      expect(await json(response)).toEqual({ error: 'Container runtime unavailable' });
    } finally {
      db.close();
    }
  });

  it('returns 504 when delivery verification times out', async () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    const db = new Database(':memory:');
    migrate(db);
    insertAgentGroup(db, { id: 'chat-group-1' });

    try {
      const response = await createApp({
        db,
        chat: {
          async pollForResponse() {
            throw new (await import('../../src/delivery.ts')).DeliveryTimeoutError({
              attempts: 2,
              hasGaps: false,
            });
          },
        },
      }).fetch(
        new Request('http://cove.test/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent_group_id: 'chat-group-1',
            messages: [{ role: 'user', content: 'Hello' }],
          }),
        }),
      );

      expect(response.status).toBe(504);
      expect(await json(response)).toEqual({
        error: 'Delivery verification timed out before response integrity was confirmed',
      });
    } finally {
      db.close();
    }
  });

  it('does not append assistant or system transcript replay rows to executable inbound work', async () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    const db = new Database(':memory:');
    migrate(db);
    insertAgentGroup(db, { id: 'chat-group-1' });

    try {
      const response = await createApp({
        db,
        chat: {
          async pollForResponse(): Promise<OutboundMessageRow[]> {
            return [
              {
                id: 'assistant-3',
                seq: 3,
                role: 'assistant',
                content: 'Transcript handled',
                finish_reason: 'stop',
                tool_calls: null,
                metadata: null,
                created_at: '2026-01-01T00:00:00.000Z',
              },
            ];
          },
        },
      }).fetch(
        new Request('http://cove.test/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent_group_id: 'chat-group-1',
            thread_id: 'thread-transcript',
            messages: [
              { role: 'system', content: 'You are helpful' },
              { role: 'assistant', content: 'Previously answered' },
              { role: 'user', content: 'What next?' },
            ],
          }),
        }),
      );

      expect(response.status).toBe(200);

      const sessionRow = db
        .prepare('SELECT session_file FROM sessions WHERE agent_group_id = ? AND thread_id = ?')
        .get('chat-group-1', 'thread-transcript') as { session_file: string | null };

      const inboundDb = new Database(path.join(sessionRow.session_file!, 'inbound.db'));
      const workingFile = path.join(sessionRow.session_file!, 'working.jsonl');

      try {
        const inboundRows = inboundDb.prepare(
          'SELECT seq, role, content FROM messages_in ORDER BY seq ASC',
        ).all() as Array<{ seq: number; role: string; content: string }>;
        const workingMessages = fs
          .readFileSync(workingFile, 'utf8')
          .trim()
          .split('\n')
          .slice(1)
          .map((line) => JSON.parse(line).message);

        expect(inboundRows).toEqual([
          {
            seq: 2,
            role: 'user',
            content: 'What next?',
          },
        ]);
        expect(workingMessages).toEqual([
          { role: 'system', content: 'You are helpful' },
          { role: 'assistant', content: 'Previously answered' },
          { role: 'user', content: 'What next?' },
        ]);
      } finally {
        inboundDb.close();
      }
    } finally {
      db.close();
    }
  });

  it('serializes MCP config into extra_env.COVE_MCP_CONFIG when agent-group config includes mcp settings', async () => {
    const expectedMcpConfig = {
      mcpServers: {
        local: {
          command: 'npx',
          args: ['-y', '@demo/mcp'],
        },
      },
    };

    for (const config of [
      JSON.stringify({
        api_key: 'sk-chat-test',
        extra_env: { CUSTOM_FLAG: 'enabled' },
        mcpServers: expectedMcpConfig.mcpServers,
      }),
      JSON.stringify({
        api_key: 'sk-chat-test',
        extra_env: { CUSTOM_FLAG: 'enabled' },
        mcp_config: JSON.stringify(expectedMcpConfig),
      }),
      JSON.stringify({
        api_key: 'sk-chat-test',
        extra_env: { CUSTOM_FLAG: 'enabled' },
        mcpConfig: expectedMcpConfig,
      }),
    ]) {
      const stateDir = makeStateDir();
      process.env.COVE_STATE_DIR = stateDir;

      const db = new Database(':memory:');
      migrate(db);
      insertAgentGroup(db, {
        id: 'chat-group-1',
        config,
      });

      try {
        const response = await createApp({
          db,
          chat: {
            async pollForResponse(): Promise<OutboundMessageRow[]> {
              return [
                {
                  id: 'assistant-mcp',
                  seq: 3,
                  role: 'assistant',
                  content: 'MCP configured',
                  finish_reason: 'stop',
                  tool_calls: null,
                  metadata: null,
                  created_at: '2026-01-01T00:00:00.000Z',
                },
              ];
            },
          },
        }).fetch(
          new Request('http://cove.test/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              agent_group_id: 'chat-group-1',
              thread_id: 'thread-mcp',
              messages: [{ role: 'user', content: 'Use MCP' }],
            }),
          }),
        );

        expect(response.status).toBe(200);

        const sessionRow = db
          .prepare('SELECT session_file FROM sessions WHERE agent_group_id = ? AND thread_id = ?')
          .get('chat-group-1', 'thread-mcp') as { session_file: string | null };

        const inboundDb = new Database(path.join(sessionRow.session_file!, 'inbound.db'));

        try {
          const configRow = inboundDb.prepare('SELECT extra_env FROM session_config').get() as {
            extra_env: string | null;
          };
          const extraEnv = JSON.parse(configRow.extra_env ?? '{}') as Record<string, string>;

          expect(extraEnv.CUSTOM_FLAG).toBe('enabled');
          expect(extraEnv.COVE_MCP_CONFIG).toBeTruthy();
          expect(JSON.parse(extraEnv.COVE_MCP_CONFIG)).toEqual(expectedMcpConfig);
        } finally {
          inboundDb.close();
        }
      } finally {
        db.close();
      }
    }
  });

  it('returns text/event-stream and SSE deltas followed by [DONE] when stream is true', async () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    const db = new Database(':memory:');
    migrate(db);
    insertAgentGroup(db, { id: 'chat-group-1' });

    try {
      const response = await createApp({
        db,
        chat: {
          async ensureSessionRuntime() {
            return true;
          },
          streamTokens: async function* () {
            yield 'Hello';
            yield ' world';
          },
        } as never,
      }).fetch(
        new Request('http://cove.test/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent_group_id: 'chat-group-1',
            stream: true,
            messages: [{ role: 'user', content: 'Stream please' }],
          }),
        }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/event-stream');

      const lines = (await response.text()).split('\n').filter((line) => line.startsWith('data: '));

      expect(lines).toEqual([
        'data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}',
        'data: {"choices":[{"delta":{"content":" world"},"index":0}]}',
        'data: [DONE]',
      ]);
    } finally {
      db.close();
    }
  });
});
