import { afterEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { migrate } from '../../src/db/migrate.ts';
import type { RoutedRequest, SessionConfig } from '../../src/shared/types.ts';
import { streamDirectSessionTokens } from '../../src/session/direct-stream.ts';

const stateDirs: string[] = [];

function makeStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cove-v2-direct-stream-'));
  stateDirs.push(dir);
  return dir;
}

function makeRoutingResult(stateDir: string, overrides: Partial<RoutedRequest> & { agentGroupId?: string; sessionId?: string } = {}): RoutedRequest {
  const agentGroupId = overrides.agentGroupId ?? 'stream-group';
  const sessionId = overrides.sessionId ?? 'sess-stream-1';

  return {
    agentGroup: {
      id: agentGroupId,
      name: 'Stream Group',
      description: null,
      workspace: '/workspace/from-group',
      provider: 'anthropic',
      model: 'claude-group',
      thinking: 'medium',
      permissions: '{"default":"ask"}',
      soul: null,
      config: JSON.stringify({ api_key: 'sk-stream', extra_env: { CUSTOM_FLAG: 'enabled' } }),
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    },
    threadId: 'default',
    session: {
      id: sessionId,
      agent_group_id: agentGroupId,
      thread_id: 'default',
      session_file: path.join(stateDir, 'sessions', agentGroupId, sessionId),
      metadata: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    },
    ...overrides,
  };
}

afterEach(() => {
  mock.restore();

  for (const stateDir of stateDirs.splice(0)) {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

function readPersistedExtraEnv(sessionDir: string): Record<string, string> {
  const inboundDb = new Database(path.join(sessionDir, 'inbound.db'));

  try {
    const row = inboundDb.prepare('SELECT extra_env FROM session_config').get() as {
      extra_env: string | null;
    };

    return JSON.parse(row.extra_env ?? '{}') as Record<string, string>;
  } finally {
    inboundDb.close();
  }
}

function readWorkingJsonl(sessionDir: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(path.join(sessionDir, 'working.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('streamDirectSessionTokens', () => {
  it('writes merged session input and yields live tokens from the direct runner path', async () => {
    const stateDir = makeStateDir();
    const db = new Database(':memory:');
    migrate(db);

    const routing = makeRoutingResult(stateDir);
    const seen: { config?: SessionConfig; sessionId?: string } = {};
    const tokens: string[] = [];

    try {
      for await (const token of streamDirectSessionTokens(
        {
          centralDb: db,
          routing,
          config: {
            provider: 'anthropic',
            model: 'claude-request',
            thinking_level: 'high',
          },
          messages: [{ role: 'user', content: 'Hello stream' }],
        },
        {
          runContainerSession: async (options, _onResponse, _deps, onToken) => {
            seen.config = options.config;
            seen.sessionId = options.sessionId;
            onToken?.('Hello');
            onToken?.(' world');
            return 'Hello world';
          },
        },
      )) {
        tokens.push(token);
      }

      expect(tokens).toEqual(['Hello', ' world']);
      expect(seen.sessionId).toBe('sess-stream-1');
      expect(seen.config).toMatchObject({
        provider: 'anthropic',
        model: 'claude-request',
        thinking_level: 'high',
      });
    } finally {
      db.close();
    }
  });

  it('uses a relay transport instead of executing the runner directly when connectStream is supplied', async () => {
    const stateDir = makeStateDir();
    const db = new Database(':memory:');
    migrate(db);

    const routing = makeRoutingResult(stateDir, { sessionId: 'sess-stream-relay' });
    const tokens: string[] = [];
    let runnerCalled = false;

    try {
      for await (const token of streamDirectSessionTokens(
        {
          centralDb: db,
          routing,
          config: {
            provider: 'anthropic',
            model: 'claude-request',
          },
          messages: [{ role: 'user', content: 'Use relay' }],
        },
        {
          runContainerSession: async () => {
            runnerCalled = true;
            return 'host-runner';
          },
          connectStream: async function* () {
            yield 'relay';
            yield ' stream';
          },
        },
      )) {
        tokens.push(token);
      }

      expect(tokens).toEqual(['relay', ' stream']);
      expect(runnerCalled).toBe(false);
    } finally {
      db.close();
    }
  });

  it('writes request messages to working.jsonl beside the session databases in the direct-stream path', async () => {
    const stateDir = makeStateDir();
    const db = new Database(':memory:');
    migrate(db);

    const routing = makeRoutingResult(stateDir, { sessionId: 'sess-stream-working-jsonl' });

    try {
      for await (const _token of streamDirectSessionTokens(
        {
          centralDb: db,
          routing,
          config: {
            provider: 'anthropic',
            model: 'claude-request',
          },
          messages: [
            { role: 'system', content: 'You are helpful' },
            { role: 'assistant', content: 'Previous reply' },
            { role: 'user', content: 'Next question' },
          ],
        },
        {
          runContainerSession: async (_options, _onResponse, _deps, onToken) => {
            onToken?.('ok');
            return 'ok';
          },
        },
      )) {
        // consume stream
      }

      const sessionDir = routing.session.session_file!;
      const inboundFile = path.join(sessionDir, 'inbound.db');
      const outboundFile = path.join(sessionDir, 'outbound.db');
      const workingFile = path.join(sessionDir, 'working.jsonl');
      const workingEntries = readWorkingJsonl(sessionDir);

      expect(path.dirname(inboundFile)).toBe(sessionDir);
      expect(path.dirname(outboundFile)).toBe(sessionDir);
      expect(path.dirname(workingFile)).toBe(sessionDir);
      expect(path.relative(inboundFile, workingFile)).toBe('../working.jsonl');
      expect(path.relative(outboundFile, workingFile)).toBe('../working.jsonl');
      expect(fs.existsSync(inboundFile)).toBe(true);
      expect(fs.existsSync(outboundFile)).toBe(true);
      expect(fs.existsSync(workingFile)).toBe(true);
      expect(workingEntries).toHaveLength(4);
      expect(workingEntries[0]).toMatchObject({
        type: 'session',
        id: 'sess-stream-working-jsonl',
        version: 3,
      });
      expect(workingEntries.slice(1)).toEqual([
        {
          type: 'message',
          id: expect.any(String),
          parentId: null,
          timestamp: expect.any(String),
          message: { role: 'system', content: 'You are helpful' },
        },
        {
          type: 'message',
          id: expect.any(String),
          parentId: null,
          timestamp: expect.any(String),
          message: { role: 'assistant', content: 'Previous reply' },
        },
        {
          type: 'message',
          id: expect.any(String),
          parentId: null,
          timestamp: expect.any(String),
          message: { role: 'user', content: 'Next question' },
        },
      ]);
    } finally {
      db.close();
    }
  });

  it('persists loaded persona into session_config extra_env before running the direct runner', async () => {
    const stateDir = makeStateDir();
    const db = new Database(':memory:');
    migrate(db);
    db.prepare(
      `INSERT INTO agent_groups (id, name, workspace, provider, model, thinking, permissions, soul, config, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'stream-group',
      'Stream Group',
      '/workspace/from-group',
      'anthropic',
      'claude-group',
      'medium',
      '{"default":"ask"}',
      'db persona',
      null,
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );

    const routing = makeRoutingResult(stateDir);

    try {
      for await (const _token of streamDirectSessionTokens(
        {
          centralDb: db,
          routing,
          config: {
            provider: 'anthropic',
            model: 'claude-request',
            extra_env: { EXTRA_FLAG: 'kept' },
          },
          messages: [{ role: 'user', content: 'Hello stream' }],
        },
        {
          runContainerSession: async (_options, _onResponse, _deps, onToken) => {
            onToken?.('ok');
            return 'ok';
          },
        },
      )) {
        // consume stream
      }

      expect(readPersistedExtraEnv(routing.session.session_file!)).toEqual({
        EXTRA_FLAG: 'kept',
        COVE_PERSONA: 'db persona',
        COVE_AGENT_GROUP_ID: 'stream-group',
      });
    } finally {
      db.close();
    }
  });

  it('preserves an explicit config extra_env COVE_PERSONA over database lookup in persisted session_config', async () => {
    const stateDir = makeStateDir();
    const db = new Database(':memory:');
    migrate(db);
    db.prepare(
      `INSERT INTO agent_groups (id, name, workspace, provider, model, thinking, permissions, soul, config, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'stream-group',
      'Stream Group',
      '/workspace/from-group',
      'anthropic',
      'claude-group',
      'medium',
      '{"default":"ask"}',
      'db persona',
      null,
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );

    const routing = makeRoutingResult(stateDir, { sessionId: 'sess-stream-explicit-persona' });

    try {
      for await (const _token of streamDirectSessionTokens(
        {
          centralDb: db,
          routing,
          config: {
            provider: 'anthropic',
            model: 'claude-request',
            extra_env: {
              EXTRA_FLAG: 'kept',
              COVE_PERSONA: 'explicit persona',
            },
          },
          messages: [{ role: 'user', content: 'Hello stream' }],
        },
        {
          runContainerSession: async (_options, _onResponse, _deps, onToken) => {
            onToken?.('ok');
            return 'ok';
          },
        },
      )) {
        // consume stream
      }

      expect(readPersistedExtraEnv(routing.session.session_file!)).toEqual({
        EXTRA_FLAG: 'kept',
        COVE_PERSONA: 'explicit persona',
        COVE_AGENT_GROUP_ID: 'stream-group',
      });
    } finally {
      db.close();
    }
  });

  it('uses the real container-agent runner by default when no runContainerSession dep is supplied', async () => {
    const stateDir = makeStateDir();
    const db = new Database(':memory:');
    migrate(db);

    mock.module('@mariozechner/pi-coding-agent', () => ({
      AuthStorage: {
        inMemory() {
          return {
            setRuntimeApiKey() {},
          };
        },
      },
      ModelRegistry: {
        inMemory() {
          return {
            find(provider: string, model: string) {
              return { provider, id: model };
            },
          };
        },
      },
      SessionManager: {
        inMemory(cwd?: string) {
          return { mode: 'in-memory', cwd };
        },
        continueRecent(cwd?: string, sessionStateDir?: string) {
          return { mode: 'continueRecent', cwd, sessionStateDir };
        },
      },
      async createAgentSession(sessionOptions: {
        model?: { provider: string; id: string };
        sessionManager?: { mode: string };
      }) {
        const listeners = new Set<(event: { type: 'message_update'; assistantMessageEvent?: { type: 'text_delta'; delta: string } }) => void>();

        return {
          session: {
            subscribe(handler: (event: { type: 'message_update'; assistantMessageEvent?: { type: 'text_delta'; delta: string } }) => void) {
              listeners.add(handler);
              return () => {
                listeners.delete(handler);
              };
            },
            async prompt(message: string) {
              for (const listener of listeners) {
                listener({
                  type: 'message_update',
                  assistantMessageEvent: {
                    type: 'text_delta',
                    delta: `SDK:${sessionOptions.model?.provider}/${sessionOptions.model?.id}:${sessionOptions.sessionManager?.mode}:${message}`,
                  },
                });
              }
            },
          },
        };
      },
    }));

    const routing = makeRoutingResult(stateDir, { sessionId: 'sess-stream-default-runner' });
    const tokens: string[] = [];

    try {
      for await (const token of streamDirectSessionTokens({
        centralDb: db,
        routing,
        config: {
          provider: 'anthropic',
          model: 'claude-request',
          api_key: 'stream-api-key',
        },
        messages: [{ role: 'user', content: 'Use default runner' }],
      })) {
        tokens.push(token);
      }

      expect(tokens).toEqual(['SDK:anthropic/claude-request:continueRecent:Use default runner']);
    } finally {
      db.close();
    }
  });
});
