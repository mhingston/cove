import { afterEach, describe, expect, it } from 'bun:test';
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
  for (const stateDir of stateDirs.splice(0)) {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

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
});
