import { afterEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runContainerSession, type ContainerSessionDeps } from '../../src/container-agent/runner.ts';
import { migrate } from '../../src/db/migrate.ts';
import { openInboundDb, writeInboundMessage } from '../../src/session/inbound.ts';
import { openOutboundDb, readProcessingAck, writeProcessingAck } from '../../src/session/outbound.ts';
import type { SessionConfig } from '../../src/shared/types.ts';

const tempDirs: string[] = [];
const gatewayEnvKeys = [
  'ONECLI_AGENT_NAME',
  'ONECLI_URL',
  'COVE_ONECLI_AUTH',
  'GH_TOKEN',
] as const;
const originalGatewayEnv = Object.fromEntries(
  gatewayEnvKeys.map((key) => [key, process.env[key]]),
) as Record<(typeof gatewayEnvKeys)[number], string | undefined>;
const originalWorkflowApiBaseUrl = process.env.COVE_WORKFLOW_API_BASE_URL;
const originalFetch = globalThis.fetch;

type JsonTool = {
  name: string;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<{
    content: Array<{ type: 'text'; text: string }>;
  }>;
};

function restoreEnvVar(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}

function clearGatewayEnvForTest(): void {
  for (const key of gatewayEnvKeys) {
    delete process.env[key];
  }
}

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeSessionConfig(sessionDir: string, config: SessionConfig): void {
  const db = openInboundDb(sessionDir);

  try {
    db.exec('DELETE FROM session_config');
    db.prepare(
      `INSERT INTO session_config (provider, model, thinking_level, api_key, workspace, extra_env, permissions)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      config.provider,
      config.model,
      config.thinking_level ?? null,
      config.api_key ?? null,
      config.workspace ?? null,
      config.extra_env == null ? null : JSON.stringify(config.extra_env),
      config.permissions ?? null,
    );
  } finally {
    db.close();
  }
}

function writeUserMessage(sessionDir: string, content: string, metadata?: Record<string, unknown>): void {
  const db = openInboundDb(sessionDir);

  try {
    writeInboundMessage(db, {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      metadata,
    });
  } finally {
    db.close();
  }
}

function readOutboundRows(sessionDir: string): Array<{ seq: number; content: string; metadata: string | null }> {
  const db = openOutboundDb(sessionDir);

  try {
    return db.prepare('SELECT seq, content, metadata FROM messages_out ORDER BY seq ASC').all() as Array<{
      seq: number;
      content: string;
      metadata: string | null;
    }>;
  } finally {
    db.close();
  }
}

function readAck(sessionDir: string, sessionId: string) {
  const db = openOutboundDb(sessionDir);

  try {
    return readProcessingAck(db, sessionId);
  } finally {
    db.close();
  }
}

function setupCentralDb(options: {
  stateDir: string;
  sessionId: string;
  agentGroupId: string;
  sessionDir: string;
}): string {
  const dbPath = path.join(options.stateDir, 'cove.db');
  const db = new Database(dbPath);
  const now = '2026-01-01T00:00:00.000Z';

  try {
    migrate(db);
    db.prepare(
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
      options.agentGroupId,
      'Runner Group',
      null,
      '/workspace/runner',
      'auto',
      'runner-model',
      'medium',
      '{"default":"auto"}',
      null,
      null,
      now,
      now,
    );
    db.prepare(
      `INSERT INTO sessions (id, agent_group_id, thread_id, session_file, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(options.sessionId, options.agentGroupId, 'thread-1', options.sessionDir, null, now, now);
  } finally {
    db.close();
  }

  return dbPath;
}

function parseToolJson(result: { content: Array<{ type: 'text'; text: string }> } | undefined): Record<string, unknown> {
  const text = result?.content.map((part) => part.text).join('') ?? '';
  return JSON.parse(text) as Record<string, unknown>;
}

function toRequest(input: Request | string | URL, init?: RequestInit): Request {
  return input instanceof Request ? input : new Request(String(input), init);
}

function insertApproval(dbPath: string, row: {
  id: string;
  sessionId: string;
  agentGroupId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  status: string;
  requestedAt?: string;
  respondedAt?: string | null;
  expiresAt: string;
}): void {
  const db = new Database(dbPath);

  try {
    db.prepare(
      `INSERT INTO approvals (
         id,
         agent_group_id,
         session_id,
         tool_name,
         tool_args,
         status,
         requested_at,
         responded_at,
         expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.agentGroupId,
      row.sessionId,
      row.toolName,
      JSON.stringify(row.toolArgs),
      row.status,
      row.requestedAt ?? '2026-01-01T00:00:00.000Z',
      row.respondedAt ?? null,
      row.expiresAt,
    );
  } finally {
    db.close();
  }
}

function readApprovals(dbPath: string): Array<{
  id: string;
  status: string;
  tool_args: string | null;
  responded_at: string | null;
}> {
  const db = new Database(dbPath);

  try {
    return db.prepare('SELECT id, status, tool_args, responded_at FROM approvals ORDER BY requested_at ASC, id ASC').all() as Array<{
      id: string;
      status: string;
      tool_args: string | null;
      responded_at: string | null;
    }>;
  } finally {
    db.close();
  }
}

function createFakeDeps(options: {
  responseText?: string;
  toolCall?: { toolName: string; input: Record<string, unknown> };
  capture?: {
    promptedMessages: string[];
    resourceLoaders?: Array<unknown>;
    customToolsHistory?: Array<unknown>;
    configs?: SessionConfig[];
  };
} = {}): ContainerSessionDeps {
  return {
    async createSession(sessionOptions) {
      options.capture?.resourceLoaders?.push(sessionOptions.resourceLoader);
      options.capture?.customToolsHistory?.push(sessionOptions.customTools);
      options.capture?.configs?.push(sessionOptions.config);
      const listeners = new Set<(event: { type: 'message_update'; assistantMessageEvent?: { type: 'text_delta'; delta: string } }) => void>();

      return {
        session: {
          subscribe(handler) {
            listeners.add(handler);
            return () => {
              listeners.delete(handler);
            };
          },
          async prompt(message) {
            options.capture?.promptedMessages.push(message);

            const handlers: Array<(event: { toolName: string; input: Record<string, unknown> }) => Promise<{ block?: boolean; reason?: string } | undefined> | { block?: boolean; reason?: string } | undefined> = [];

            for (const factory of sessionOptions.resourceLoader?.extensionFactories ?? []) {
              factory({
                on(event, handler) {
                  if (event === 'tool_call') {
                    handlers.push(handler as (event: { toolName: string; input: Record<string, unknown> }) => Promise<{ block?: boolean; reason?: string } | undefined> | { block?: boolean; reason?: string } | undefined);
                  }
                },
              });
            }

            if (options.toolCall != null) {
              for (const handler of handlers) {
                const result = await handler(options.toolCall);

                if (result?.block) {
                  return;
                }
              }
            }

            const responseText = options.responseText ?? `Processed: ${message}`;

            for (const listener of listeners) {
              listener({
                type: 'message_update',
                assistantMessageEvent: { type: 'text_delta', delta: responseText },
              });
            }
          },
        },
      };
    },
  };
}

afterEach(() => {
  mock.restore();
  globalThis.fetch = originalFetch;
  restoreEnvVar('COVE_WORKFLOW_API_BASE_URL', originalWorkflowApiBaseUrl);

  for (const key of gatewayEnvKeys) {
    restoreEnvVar(key, originalGatewayEnv[key]);
  }

  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('container runner phase 5', () => {
  it('prefers persisted provider and model while preserving runtime-only config values', async () => {
    const sessionDir = makeTempDir('cove-v2-runner-persisted-config-');
    const sessionId = 'sess-persisted-config-1';

    writeSessionConfig(sessionDir, {
      provider: 'auto',
      model: 'anthropic/claude-persisted',
      extra_env: {
        PERSISTED_ONLY: 'persisted',
      },
    });
    writeUserMessage(sessionDir, 'Use the persisted config.');

    const captured = {
      promptedMessages: [] as string[],
      configs: [] as SessionConfig[],
    };

    await runContainerSession(
      {
        inboundPath: path.join(sessionDir, 'inbound.db'),
        outboundPath: path.join(sessionDir, 'outbound.db'),
        sessionId,
        config: {
          provider: 'anthropic',
          model: 'claude-runtime',
          api_key: 'runtime-api-key',
          workspace: '/workspace/runtime-only',
          extra_env: {
            RUNTIME_ONLY: 'runtime',
          },
        },
      },
      undefined,
      createFakeDeps({
        responseText: 'Persisted config used',
        capture: captured,
      }),
    );

    expect(captured.promptedMessages).toEqual(['Use the persisted config.']);
    expect(captured.configs).toEqual([
      {
        provider: 'auto',
        model: 'anthropic/claude-persisted',
        thinking_level: null,
        api_key: 'runtime-api-key',
        workspace: '/workspace/runtime-only',
        extra_env: {
          RUNTIME_ONLY: 'runtime',
          PERSISTED_ONLY: 'persisted',
        },
        permissions: null,
      },
    ]);
  });

  it('processes queued inbound work when inbound.db is reopened read-only', async () => {
    const sessionDir = makeTempDir('cove-v2-runner-readonly-inbound-');
    const sessionId = 'sess-readonly-inbound-1';

    writeSessionConfig(sessionDir, {
      provider: 'anthropic',
      model: 'claude-runner',
      api_key: 'runner-api-key',
    });
    writeUserMessage(sessionDir, 'Process the read-only inbound queue.');

    fs.chmodSync(path.join(sessionDir, 'inbound.db'), 0o444);

    const captured = {
      promptedMessages: [] as string[],
    };

    await runContainerSession(
      {
        inboundPath: path.join(sessionDir, 'inbound.db'),
        outboundPath: path.join(sessionDir, 'outbound.db'),
        sessionId,
        config: {
          provider: 'anthropic',
          model: 'claude-runner',
        },
      },
      undefined,
      createFakeDeps({
        responseText: 'Processed from read-only inbound',
        capture: captured,
      }),
    );

    expect(captured.promptedMessages).toEqual(['Process the read-only inbound queue.']);
    expect(readOutboundRows(sessionDir)).toEqual([
      expect.objectContaining({ seq: 3, content: 'Processed from read-only inbound' }),
    ]);
    expect(readAck(sessionDir, sessionId)).toMatchObject({
      last_in_seq: 2,
      last_out_seq: 3,
    });
  });

  it('merges extra_env with persisted values taking precedence over runtime conflicts', async () => {
    const sessionDir = makeTempDir('cove-v2-runner-extra-env-merge-');
    const sessionId = 'sess-extra-env-merge-1';

    writeSessionConfig(sessionDir, {
      provider: 'anthropic',
      model: 'claude-persisted',
      extra_env: {
        SHARED_KEY: 'persisted',
        PERSISTED_ONLY: 'persisted-only',
      },
    });
    writeUserMessage(sessionDir, 'Merge runtime env.');

    const captured = {
      promptedMessages: [] as string[],
      configs: [] as SessionConfig[],
    };

    await runContainerSession(
      {
        inboundPath: path.join(sessionDir, 'inbound.db'),
        outboundPath: path.join(sessionDir, 'outbound.db'),
        sessionId,
        config: {
          provider: 'anthropic',
          model: 'claude-runtime',
          extra_env: {
            SHARED_KEY: 'runtime',
            RUNTIME_ONLY: 'runtime-only',
          },
        },
      },
      undefined,
      createFakeDeps({
        responseText: 'Merged env used',
        capture: captured,
      }),
    );

    expect(captured.promptedMessages).toEqual(['Merge runtime env.']);
    expect(captured.configs[0]?.extra_env).toEqual({
      SHARED_KEY: 'persisted',
      RUNTIME_ONLY: 'runtime-only',
      PERSISTED_ONLY: 'persisted-only',
    });
  });

  it('preserves the warm processing_ack row when a live session adopts the session directory', async () => {
    const stateDir = makeTempDir('cove-v2-runner-adopted-warm-session-');
    const warmSessionId = 'warm-123';
    const liveSessionId = 'sess-live-123';
    const sessionDir = path.join(stateDir, 'warm', warmSessionId);

    fs.mkdirSync(sessionDir, { recursive: true });
    writeSessionConfig(sessionDir, {
      provider: 'anthropic',
      model: 'claude-runner',
      extra_env: {
        COVE_SESSION_ID: liveSessionId,
      },
    });

    const outboundDb = openOutboundDb(sessionDir);

    try {
      writeProcessingAck(outboundDb, {
        session_id: warmSessionId,
        last_in_seq: null,
        last_out_seq: null,
        heartbeat_at: '2026-01-01T00:00:00.000Z',
      });
    } finally {
      outboundDb.close();
    }

    const response = await runContainerSession({
      inboundPath: path.join(sessionDir, 'inbound.db'),
      outboundPath: path.join(sessionDir, 'outbound.db'),
      config: {
        provider: 'anthropic',
        model: 'claude-runner',
      },
    });

    expect(response).toBe('');
    expect(readAck(sessionDir, warmSessionId)).toMatchObject({
      session_id: warmSessionId,
      last_in_seq: null,
      last_out_seq: null,
    });
    expect(readAck(sessionDir, liveSessionId)).toMatchObject({
      session_id: liveSessionId,
      last_in_seq: null,
      last_out_seq: null,
    });
  });

  it('blocks prompt-tier tool calls and writes prompt metadata as a normal assistant response', async () => {
    const sessionDir = makeTempDir('cove-v2-runner-prompt-');
    const sessionId = 'sess-prompt-1';

    writeSessionConfig(sessionDir, {
      provider: 'anthropic',
      model: 'claude-runner',
      permissions: JSON.stringify({ write: 'prompt' }),
    });
    writeUserMessage(sessionDir, 'Write the file');

    const response = await runContainerSession(
      {
        inboundPath: path.join(sessionDir, 'inbound.db'),
        outboundPath: path.join(sessionDir, 'outbound.db'),
        sessionId,
        config: {
          provider: 'anthropic',
          model: 'claude-runner',
        },
      },
      undefined,
      createFakeDeps({
        toolCall: {
          toolName: 'write',
          input: { path: '/tmp/demo.txt' },
        },
      }),
    );

    expect(response).toBe("Tool 'write' requires confirmation from the user before it can run.");
    expect(readOutboundRows(sessionDir)).toEqual([
      {
        seq: 3,
        content: "Tool 'write' requires confirmation from the user before it can run.",
        metadata: JSON.stringify({
          permission: 'prompt',
          question: "Tool 'write' requires confirmation from the user before it can run.",
          tool_name: 'write',
          tool_args: { path: '/tmp/demo.txt' },
        }),
      },
    ]);
    expect(readAck(sessionDir, sessionId)).toMatchObject({
      session_id: sessionId,
      last_in_seq: 2,
      last_out_seq: 3,
    });
  });

  it('skips live custom tool creation when no central db path is configured', async () => {
    const sessionDir = makeTempDir('cove-v2-runner-no-live-tools-');
    const sessionId = 'sess-no-live-tools-1';

    writeSessionConfig(sessionDir, {
      provider: 'anthropic',
      model: 'claude-runner',
    });
    writeUserMessage(sessionDir, 'Reply without wiki or memory tools.');

    const captured: { customToolsHistory: Array<Array<{ name: string }> | undefined> } = {
      customToolsHistory: [],
    };
    const deps: ContainerSessionDeps = {
      async createSession(sessionOptions) {
        captured.customToolsHistory.push(sessionOptions.customTools as Array<{ name: string }> | undefined);
        return createFakeDeps({ responseText: 'No live tools required' }).createSession!(sessionOptions);
      },
      createCoveTools() {
        return [];
      },
    };

    const response = await runContainerSession(
      {
        inboundPath: path.join(sessionDir, 'inbound.db'),
        outboundPath: path.join(sessionDir, 'outbound.db'),
        sessionId,
        config: {
          provider: 'anthropic',
          model: 'claude-runner',
        },
      },
      undefined,
      deps,
    );

    expect(response).toBe('No live tools required');
    expect(captured.customToolsHistory).toEqual([undefined, undefined]);
  });

  it('registers workflow bridge tools and start-workflow forwards current agent and session context', async () => {
    const sessionDir = makeTempDir('cove-v2-runner-workflow-tools-');
    const sessionId = 'sess-workflow-tools-1';
    const requests: Request[] = [];
    let customTools: JsonTool[] | undefined;

    writeSessionConfig(sessionDir, {
      provider: 'anthropic',
      model: 'claude-runner',
      extra_env: {
        COVE_AGENT_GROUP_ID: 'group-workflow-tools',
        COVE_WORKFLOW_API_BASE_URL: 'http://host.docker.internal:4111',
      },
    });
    writeUserMessage(sessionDir, 'Make workflow tools available.');

    globalThis.fetch = mock(async (input: Request | string | URL, init?: RequestInit) => {
      const request = toRequest(input, init);
      requests.push(request);
      return new Response(JSON.stringify({ instanceId: 'workflow-instance-1' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    await runContainerSession(
      {
        inboundPath: path.join(sessionDir, 'inbound.db'),
        outboundPath: path.join(sessionDir, 'outbound.db'),
        sessionId,
        config: {
          provider: 'anthropic',
          model: 'claude-runner',
        },
      },
      undefined,
      {
        async createSession(sessionOptions) {
          customTools = sessionOptions.customTools as JsonTool[] | undefined;
          return createFakeDeps({ responseText: 'Workflow tools ready' }).createSession!(sessionOptions);
        },
      },
    );

    expect(customTools?.map((tool) => tool.name)).toEqual([
      'start-workflow',
      'get-workflow',
      'list-workflows',
      'signal-workflow',
      'wait-for-workflow',
    ]);

    const result = await customTools?.find((tool) => tool.name === 'start-workflow')?.execute('call-1', {
      name: 'daily-summary',
      input: { topic: 'sales' },
    });

    expect(parseToolJson(result)).toEqual({
      tool: 'start-workflow',
      instanceId: 'workflow-instance-1',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('http://host.docker.internal:4111/v1/workflows');
    expect(requests[0]?.method).toBe('POST');
    expect(JSON.parse(await requests[0]!.text())).toEqual({
      name: 'daily-summary',
      input: { topic: 'sales' },
      agent_group_id: 'group-workflow-tools',
      session_id: sessionId,
    });
  });

  it('fails clearly when workflow bridge tools run without COVE_WORKFLOW_API_BASE_URL', async () => {
    const sessionDir = makeTempDir('cove-v2-runner-workflow-tools-missing-bridge-');
    const sessionId = 'sess-workflow-tools-missing-bridge';
    const stateDir = makeTempDir('cove-v2-runner-workflow-tools-missing-bridge-state-');
    const agentGroupId = 'group-workflow-tools-missing-bridge';
    const centralDbPath = setupCentralDb({ stateDir, sessionId, agentGroupId, sessionDir });
    let customTools: JsonTool[] | undefined;

    writeSessionConfig(sessionDir, {
      provider: 'anthropic',
      model: 'claude-runner',
      extra_env: {
        COVE_AGENT_GROUP_ID: agentGroupId,
        COVE_CENTRAL_DB_PATH: centralDbPath,
      },
    });
    writeUserMessage(sessionDir, 'Try workflow tools without bridge config.');

    await runContainerSession(
      {
        inboundPath: path.join(sessionDir, 'inbound.db'),
        outboundPath: path.join(sessionDir, 'outbound.db'),
        sessionId,
        config: {
          provider: 'anthropic',
          model: 'claude-runner',
        },
      },
      undefined,
      {
        async createSession(sessionOptions) {
          customTools = sessionOptions.customTools as JsonTool[] | undefined;
          return createFakeDeps({ responseText: 'Workflow tools unavailable' }).createSession!(sessionOptions);
        },
      },
    );

    const result = await customTools?.find((tool) => tool.name === 'list-workflows')?.execute('call-2', {});

    expect(parseToolJson(result)).toEqual({
      tool: 'list-workflows',
      error: 'COVE_WORKFLOW_API_BASE_URL is required for workflow bridge tools',
    });
  });

  it('polls the host workflow bridge until wait-for-workflow reaches a terminal state', async () => {
    const sessionDir = makeTempDir('cove-v2-runner-wait-workflow-');
    const sessionId = 'sess-wait-workflow-1';
    let customTools: JsonTool[] | undefined;
    const requests: Request[] = [];
    const responses = [
      {
        instanceId: 'workflow-instance-1',
        name: 'daily-summary',
        status: 'Running',
        output: null,
        customStatus: 'step-1',
        createdAt: '2026-01-15T08:00:00.000Z',
        updatedAt: '2026-01-15T08:01:00.000Z',
      },
      {
        instanceId: 'workflow-instance-1',
        name: 'daily-summary',
        status: 'Completed',
        output: { ok: true },
        customStatus: null,
        createdAt: '2026-01-15T08:00:00.000Z',
        updatedAt: '2026-01-15T08:02:00.000Z',
      },
    ];

    writeSessionConfig(sessionDir, {
      provider: 'anthropic',
      model: 'claude-runner',
      extra_env: {
        COVE_WORKFLOW_API_BASE_URL: 'http://host.docker.internal:4111',
      },
    });
    writeUserMessage(sessionDir, 'Wait for workflow completion.');

    globalThis.fetch = mock(async (input: Request | string | URL, init?: RequestInit) => {
      const request = toRequest(input, init);
      requests.push(request);
      return new Response(JSON.stringify(responses.shift() ?? responses.at(-1)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    await runContainerSession(
      {
        inboundPath: path.join(sessionDir, 'inbound.db'),
        outboundPath: path.join(sessionDir, 'outbound.db'),
        sessionId,
        config: {
          provider: 'anthropic',
          model: 'claude-runner',
        },
      },
      undefined,
      {
        async createSession(sessionOptions) {
          customTools = sessionOptions.customTools as JsonTool[] | undefined;
          return createFakeDeps({ responseText: 'Workflow wait ready' }).createSession!(sessionOptions);
        },
      },
    );

    const result = await customTools?.find((tool) => tool.name === 'wait-for-workflow')?.execute('call-3', {
      instanceId: 'workflow-instance-1',
      timeoutMs: 50,
      pollIntervalMs: 1,
    });

    expect(parseToolJson(result)).toEqual({
      tool: 'wait-for-workflow',
      instanceId: 'workflow-instance-1',
      name: 'daily-summary',
      status: 'Completed',
      output: { ok: true },
      customStatus: null,
      createdAt: '2026-01-15T08:00:00.000Z',
      updatedAt: '2026-01-15T08:02:00.000Z',
    });
    expect(requests.filter((request) => request.url.endsWith('/v1/workflows/workflow-instance-1'))).toHaveLength(2);
  });

  it('returns the latest known workflow state plus timed_out=true when wait-for-workflow times out', async () => {
    const sessionDir = makeTempDir('cove-v2-runner-wait-workflow-timeout-');
    const sessionId = 'sess-wait-workflow-timeout-1';
    let customTools: JsonTool[] | undefined;
    const requests: Request[] = [];

    writeSessionConfig(sessionDir, {
      provider: 'anthropic',
      model: 'claude-runner',
      extra_env: {
        COVE_WORKFLOW_API_BASE_URL: 'http://host.docker.internal:4111',
      },
    });
    writeUserMessage(sessionDir, 'Wait for workflow timeout.');

    globalThis.fetch = mock(async (input: Request | string | URL, init?: RequestInit) => {
      const request = toRequest(input, init);
      requests.push(request);
      return new Response(JSON.stringify({
        instanceId: 'workflow-instance-timeout',
        name: 'daily-summary',
        status: 'Running',
        output: null,
        customStatus: 'step-1',
        createdAt: '2026-01-15T08:00:00.000Z',
        updatedAt: '2026-01-15T08:01:00.000Z',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    await runContainerSession(
      {
        inboundPath: path.join(sessionDir, 'inbound.db'),
        outboundPath: path.join(sessionDir, 'outbound.db'),
        sessionId,
        config: {
          provider: 'anthropic',
          model: 'claude-runner',
        },
      },
      undefined,
      {
        async createSession(sessionOptions) {
          customTools = sessionOptions.customTools as JsonTool[] | undefined;
          return createFakeDeps({ responseText: 'Workflow wait timeout ready' }).createSession!(sessionOptions);
        },
      },
    );

    const result = await customTools?.find((tool) => tool.name === 'wait-for-workflow')?.execute('call-4', {
      instanceId: 'workflow-instance-timeout',
      timeoutMs: 10,
      pollIntervalMs: 1,
    });

    expect(parseToolJson(result)).toEqual({
      tool: 'wait-for-workflow',
      instanceId: 'workflow-instance-timeout',
      name: 'daily-summary',
      status: 'Running',
      output: null,
      customStatus: 'step-1',
      createdAt: '2026-01-15T08:00:00.000Z',
      updatedAt: '2026-01-15T08:01:00.000Z',
      timed_out: true,
    });
    expect(requests.length).toBeGreaterThan(1);
  });

  it('rebuilds workflow bridge tools from the latest persisted session_config on each prompt cycle', async () => {
    const stateDir = makeTempDir('cove-v2-runner-workflow-tools-refresh-state-');
    const sessionDir = path.join(stateDir, 'sessions', 'group-workflow-tools-refresh', 'sess-workflow-tools-refresh');
    const sessionId = 'sess-workflow-tools-refresh';
    const agentGroupId = 'group-workflow-tools-refresh';
    const centralDbPath = setupCentralDb({ stateDir, sessionId, agentGroupId, sessionDir });
    const toolRuntimeHistory: Array<Record<string, unknown> | undefined> = [];
    let promptCount = 0;

    writeSessionConfig(sessionDir, {
      provider: 'anthropic',
      model: 'claude-runner',
      extra_env: {
        COVE_AGENT_GROUP_ID: agentGroupId,
        COVE_CENTRAL_DB_PATH: centralDbPath,
      },
    });
    writeUserMessage(sessionDir, 'First prompt cycle.');
    writeUserMessage(sessionDir, 'Second prompt cycle.');

    await runContainerSession(
      {
        inboundPath: path.join(sessionDir, 'inbound.db'),
        outboundPath: path.join(sessionDir, 'outbound.db'),
        sessionId,
        config: {
          provider: 'anthropic',
          model: 'claude-runner',
        },
      },
      undefined,
      {
        createCoveTools(_db, _embedTexts, runtime) {
          toolRuntimeHistory.push(runtime as Record<string, unknown> | undefined);
          return [{
            name: 'dummy-tool',
            description: 'dummy',
            parameters: { type: 'object', properties: {} },
            execute: async () => ({ content: [{ type: 'text', text: '{}' }], details: {} }),
          }];
        },
        async createSession() {
          return {
            session: {
              subscribe() {
                return () => {};
              },
              async prompt() {
                promptCount += 1;

                if (promptCount === 1) {
                  writeSessionConfig(sessionDir, {
                    provider: 'anthropic',
                    model: 'claude-runner',
                    extra_env: {
                      COVE_AGENT_GROUP_ID: agentGroupId,
                      COVE_CENTRAL_DB_PATH: centralDbPath,
                      COVE_WORKFLOW_API_BASE_URL: 'http://host.docker.internal:4111',
                    },
                  });
                }
              },
            },
          };
        },
      },
    );

    expect(toolRuntimeHistory).toEqual([
      {
        agentGroupId,
        centralDbPath,
        sessionId,
        workflowApiBaseUrl: undefined,
      },
      {
        agentGroupId,
        centralDbPath,
        sessionId,
        workflowApiBaseUrl: 'http://host.docker.internal:4111',
      },
    ]);
  });

  it('creates a pending approval and writes confirm metadata for blocked confirm-tier tool calls', async () => {
    const stateDir = makeTempDir('cove-v2-runner-confirm-state-');
    const sessionDir = path.join(stateDir, 'sessions', 'group-confirm-1', 'sess-confirm-1');
    const sessionId = 'sess-confirm-1';
    const agentGroupId = 'group-confirm-1';
    const centralDbPath = setupCentralDb({ stateDir, sessionId, agentGroupId, sessionDir });

    writeSessionConfig(sessionDir, {
      provider: 'anthropic',
      model: 'claude-runner',
      permissions: JSON.stringify({ bash: 'confirm' }),
      extra_env: {
        COVE_AGENT_GROUP_ID: agentGroupId,
        COVE_CENTRAL_DB_PATH: centralDbPath,
      },
    });
    writeUserMessage(sessionDir, 'Delete the file');

    const response = await runContainerSession(
      {
        inboundPath: path.join(sessionDir, 'inbound.db'),
        outboundPath: path.join(sessionDir, 'outbound.db'),
        sessionId,
        config: {
          provider: 'anthropic',
          model: 'claude-runner',
        },
      },
      undefined,
      createFakeDeps({
        toolCall: {
          toolName: 'bash',
          input: { command: 'rm -rf /tmp/demo' },
        },
      }),
    );

    const approvals = readApprovals(centralDbPath);
    const outbound = readOutboundRows(sessionDir);

    expect(response).toBe('Approval required to run bash: rm -rf /tmp/demo');
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.status).toBe('pending');
    expect(JSON.parse(approvals[0]?.tool_args ?? 'null')).toEqual({ command: 'rm -rf /tmp/demo' });

    expect(outbound).toHaveLength(1);
    expect(outbound[0]?.seq).toBe(3);
    expect(outbound[0]?.content).toBe('Approval required to run bash: rm -rf /tmp/demo');
    expect(JSON.parse(outbound[0]?.metadata ?? 'null')).toEqual({
      permission: 'confirm',
      approval_id: approvals[0]?.id,
      message: 'Approval required to run bash: rm -rf /tmp/demo',
      tool_name: 'bash',
      tool_args: { command: 'rm -rf /tmp/demo' },
      expires_at: expect.any(String),
    });
  });

  it('reuses an existing pending approval for the same session, tool, and args', async () => {
    const stateDir = makeTempDir('cove-v2-runner-reuse-state-');
    const sessionDir = path.join(stateDir, 'sessions', 'group-reuse-1', 'sess-reuse-1');
    const sessionId = 'sess-reuse-1';
    const agentGroupId = 'group-reuse-1';
    const centralDbPath = setupCentralDb({ stateDir, sessionId, agentGroupId, sessionDir });
    const approvalId = 'approval-pending-1';

    insertApproval(centralDbPath, {
      id: approvalId,
      sessionId,
      agentGroupId,
      toolName: 'bash',
      toolArgs: { command: 'rm -rf /tmp/demo' },
      status: 'pending',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });

    writeSessionConfig(sessionDir, {
      provider: 'anthropic',
      model: 'claude-runner',
      permissions: JSON.stringify({ bash: 'confirm' }),
      extra_env: {
        COVE_AGENT_GROUP_ID: agentGroupId,
        COVE_CENTRAL_DB_PATH: centralDbPath,
      },
    });
    writeUserMessage(sessionDir, 'Delete the file again');

    const response = await runContainerSession(
      {
        inboundPath: path.join(sessionDir, 'inbound.db'),
        outboundPath: path.join(sessionDir, 'outbound.db'),
        sessionId,
        config: {
          provider: 'anthropic',
          model: 'claude-runner',
        },
      },
      undefined,
      createFakeDeps({
        toolCall: {
          toolName: 'bash',
          input: { command: 'rm -rf /tmp/demo' },
        },
      }),
    );

    const approvals = readApprovals(centralDbPath);
    const outbound = readOutboundRows(sessionDir);

    expect(response).toBe('Approval required to run bash: rm -rf /tmp/demo');
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.id).toBe(approvalId);
    expect(JSON.parse(outbound[0]?.metadata ?? 'null').approval_id).toBe(approvalId);
  });

  it('materializes expired approvals before creating a fresh pending replacement', async () => {
    const stateDir = makeTempDir('cove-v2-runner-expire-state-');
    const sessionDir = path.join(stateDir, 'sessions', 'group-expire-1', 'sess-expire-1');
    const sessionId = 'sess-expire-1';
    const agentGroupId = 'group-expire-1';
    const centralDbPath = setupCentralDb({ stateDir, sessionId, agentGroupId, sessionDir });

    insertApproval(centralDbPath, {
      id: 'approval-expired-1',
      sessionId,
      agentGroupId,
      toolName: 'bash',
      toolArgs: { command: 'rm -rf /tmp/demo' },
      status: 'pending',
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });

    writeSessionConfig(sessionDir, {
      provider: 'anthropic',
      model: 'claude-runner',
      permissions: JSON.stringify({ bash: 'confirm' }),
      extra_env: {
        COVE_AGENT_GROUP_ID: agentGroupId,
        COVE_CENTRAL_DB_PATH: centralDbPath,
      },
    });
    writeUserMessage(sessionDir, 'Retry delete');

    await runContainerSession(
      {
        inboundPath: path.join(sessionDir, 'inbound.db'),
        outboundPath: path.join(sessionDir, 'outbound.db'),
        sessionId,
        config: {
          provider: 'anthropic',
          model: 'claude-runner',
        },
      },
      undefined,
      createFakeDeps({
        toolCall: {
          toolName: 'bash',
          input: { command: 'rm -rf /tmp/demo' },
        },
      }),
    );

    const approvals = readApprovals(centralDbPath);

    expect(approvals).toHaveLength(2);
    expect(approvals[0]?.status).toBe('expired');
    expect(approvals[0]?.responded_at).toBeTruthy();
    expect(approvals[1]?.status).toBe('pending');
  });

  it('parses approval_resume metadata and allows the approved tool call to continue', async () => {
    const stateDir = makeTempDir('cove-v2-runner-resume-state-');
    const sessionDir = path.join(stateDir, 'sessions', 'group-resume-1', 'sess-resume-1');
    const sessionId = 'sess-resume-1';
    const agentGroupId = 'group-resume-1';
    const centralDbPath = setupCentralDb({ stateDir, sessionId, agentGroupId, sessionDir });
    const approvalId = 'approval-approved-1';

    insertApproval(centralDbPath, {
      id: approvalId,
      sessionId,
      agentGroupId,
      toolName: 'bash',
      toolArgs: { command: 'rm -rf /tmp/demo' },
      status: 'approved',
      respondedAt: '2026-01-01T00:01:00.000Z',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });

    writeSessionConfig(sessionDir, {
      provider: 'anthropic',
      model: 'claude-runner',
      permissions: JSON.stringify({ bash: 'confirm' }),
      extra_env: {
        COVE_AGENT_GROUP_ID: agentGroupId,
        COVE_CENTRAL_DB_PATH: centralDbPath,
      },
    });
    writeUserMessage(sessionDir, 'Resume approved action.', {
      type: 'approval_resume',
      approval_id: approvalId,
      tool_name: 'bash',
      tool_args: { command: 'rm -rf /tmp/demo' },
    });

    const response = await runContainerSession(
      {
        inboundPath: path.join(sessionDir, 'inbound.db'),
        outboundPath: path.join(sessionDir, 'outbound.db'),
        sessionId,
        config: {
          provider: 'anthropic',
          model: 'claude-runner',
        },
      },
      undefined,
      createFakeDeps({
        responseText: 'Deleted file',
        toolCall: {
          toolName: 'bash',
          input: { command: 'rm -rf /tmp/demo' },
        },
      }),
    );

    expect(response).toBe('Deleted file');
    expect(readOutboundRows(sessionDir)).toEqual([
      {
        seq: 3,
        content: 'Deleted file',
        metadata: JSON.stringify({
          resumed_tool: true,
          approval_id: approvalId,
          tool_name: 'bash',
          tool_args: { command: 'rm -rf /tmp/demo' },
        }),
      },
    ]);
  });

  it('requires a fresh confirm approval when an approved row has no approval_resume metadata', async () => {
    const stateDir = makeTempDir('cove-v2-runner-approved-no-resume-');
    const sessionDir = path.join(stateDir, 'sessions', 'group-approved-no-resume', 'sess-approved-no-resume');
    const sessionId = 'sess-approved-no-resume';
    const agentGroupId = 'group-approved-no-resume';
    const centralDbPath = setupCentralDb({ stateDir, sessionId, agentGroupId, sessionDir });

    insertApproval(centralDbPath, {
      id: 'approval-approved-no-resume',
      sessionId,
      agentGroupId,
      toolName: 'bash',
      toolArgs: { command: 'rm -rf /tmp/demo' },
      status: 'approved',
      respondedAt: '2026-01-01T00:01:00.000Z',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });

    writeSessionConfig(sessionDir, {
      provider: 'anthropic',
      model: 'claude-runner',
      permissions: JSON.stringify({ bash: 'confirm' }),
      extra_env: {
        COVE_AGENT_GROUP_ID: agentGroupId,
        COVE_CENTRAL_DB_PATH: centralDbPath,
      },
    });
    writeUserMessage(sessionDir, 'Delete without resume token.');

    const response = await runContainerSession(
      {
        inboundPath: path.join(sessionDir, 'inbound.db'),
        outboundPath: path.join(sessionDir, 'outbound.db'),
        sessionId,
        config: {
          provider: 'anthropic',
          model: 'claude-runner',
        },
      },
      undefined,
      createFakeDeps({
        responseText: 'Deleted file',
        toolCall: {
          toolName: 'bash',
          input: { command: 'rm -rf /tmp/demo' },
        },
      }),
    );

    const approvals = readApprovals(centralDbPath);

    expect(response).toBe('Approval required to run bash: rm -rf /tmp/demo');
    expect(approvals).toHaveLength(2);
    expect(approvals[0]?.id).toBe('approval-approved-no-resume');
    expect(approvals[0]?.status).toBe('approved');
    expect(approvals[1]?.status).toBe('pending');
    const outbound = readOutboundRows(sessionDir);

    expect(outbound).toEqual([
      {
        seq: 3,
        content: 'Approval required to run bash: rm -rf /tmp/demo',
        metadata: expect.any(String),
      },
    ]);
    expect(JSON.parse(outbound[0]?.metadata ?? 'null')).toEqual({
      permission: 'confirm',
      approval_id: approvals[1]?.id,
      message: 'Approval required to run bash: rm -rf /tmp/demo',
      tool_name: 'bash',
      tool_args: { command: 'rm -rf /tmp/demo' },
      expires_at: expect.any(String),
    });
  });

  it('requires a fresh confirm approval when approval_resume metadata has the wrong approval id', async () => {
    const stateDir = makeTempDir('cove-v2-runner-approved-wrong-resume-');
    const sessionDir = path.join(stateDir, 'sessions', 'group-approved-wrong-resume', 'sess-approved-wrong-resume');
    const sessionId = 'sess-approved-wrong-resume';
    const agentGroupId = 'group-approved-wrong-resume';
    const centralDbPath = setupCentralDb({ stateDir, sessionId, agentGroupId, sessionDir });
    const approvalId = 'approval-approved-right-id';

    insertApproval(centralDbPath, {
      id: approvalId,
      sessionId,
      agentGroupId,
      toolName: 'bash',
      toolArgs: { command: 'rm -rf /tmp/demo' },
      status: 'approved',
      respondedAt: '2026-01-01T00:01:00.000Z',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });

    writeSessionConfig(sessionDir, {
      provider: 'anthropic',
      model: 'claude-runner',
      permissions: JSON.stringify({ bash: 'confirm' }),
      extra_env: {
        COVE_AGENT_GROUP_ID: agentGroupId,
        COVE_CENTRAL_DB_PATH: centralDbPath,
      },
    });
    writeUserMessage(sessionDir, 'Delete with wrong resume token.', {
      type: 'approval_resume',
      approval_id: 'approval-approved-wrong-id',
      tool_name: 'bash',
      tool_args: { command: 'rm -rf /tmp/demo' },
    });

    const response = await runContainerSession(
      {
        inboundPath: path.join(sessionDir, 'inbound.db'),
        outboundPath: path.join(sessionDir, 'outbound.db'),
        sessionId,
        config: {
          provider: 'anthropic',
          model: 'claude-runner',
        },
      },
      undefined,
      createFakeDeps({
        responseText: 'Deleted file',
        toolCall: {
          toolName: 'bash',
          input: { command: 'rm -rf /tmp/demo' },
        },
      }),
    );

    const approvals = readApprovals(centralDbPath);

    expect(response).toBe('Approval required to run bash: rm -rf /tmp/demo');
    expect(approvals).toHaveLength(2);
    expect(approvals[0]?.id).toBe(approvalId);
    expect(approvals[0]?.status).toBe('approved');
    expect(approvals[1]?.status).toBe('pending');
    expect(JSON.parse(readOutboundRows(sessionDir)[0]?.metadata ?? 'null').approval_id).toBe(approvals[1]?.id);
  });

  it('uses the larger outbound seq candidate from the persisted ack and inbound seq', async () => {
    const sessionDir = makeTempDir('cove-v2-runner-outseq-');
    const sessionId = 'sess-outseq-1';
    const outboundDb = openOutboundDb(sessionDir);

    try {
      writeProcessingAck(outboundDb, {
        session_id: sessionId,
        last_in_seq: 2,
        last_out_seq: 7,
        heartbeat_at: '2026-01-01T00:00:00.000Z',
      });
    } finally {
      outboundDb.close();
    }

    writeSessionConfig(sessionDir, {
      provider: 'anthropic',
      model: 'claude-runner',
    });
    writeUserMessage(sessionDir, 'Skipped while ack was ahead.');
    writeUserMessage(sessionDir, 'Process the next inbound message.');

    const response = await runContainerSession(
      {
        inboundPath: path.join(sessionDir, 'inbound.db'),
        outboundPath: path.join(sessionDir, 'outbound.db'),
        sessionId,
        config: {
          provider: 'anthropic',
          model: 'claude-runner',
        },
      },
      undefined,
      createFakeDeps({
        responseText: 'Runner kept the higher odd outbound seq',
      }),
    );

    expect(response).toBe('Runner kept the higher odd outbound seq');
    expect(readOutboundRows(sessionDir)).toEqual([
      {
        seq: 9,
        content: 'Runner kept the higher odd outbound seq',
        metadata: null,
      },
    ]);
    expect(readAck(sessionDir, sessionId)).toMatchObject({
      session_id: sessionId,
      last_in_seq: 4,
      last_out_seq: 9,
    });
  });

  it('returns an empty string and only refreshes the heartbeat when no inbound work is pending', async () => {
    const sessionDir = makeTempDir('cove-v2-runner-idle-heartbeat-');
    const sessionId = 'sess-idle-heartbeat-1';
    const outboundDb = openOutboundDb(sessionDir);

    try {
      writeProcessingAck(outboundDb, {
        session_id: sessionId,
        last_in_seq: 8,
        last_out_seq: 11,
        heartbeat_at: '2026-01-01T00:00:00.000Z',
      });
    } finally {
      outboundDb.close();
    }

    writeSessionConfig(sessionDir, {
      provider: 'anthropic',
      model: 'claude-runner',
    });

    const response = await runContainerSession(
      {
        inboundPath: path.join(sessionDir, 'inbound.db'),
        outboundPath: path.join(sessionDir, 'outbound.db'),
        sessionId,
        config: {
          provider: 'anthropic',
          model: 'claude-runner',
        },
      },
      undefined,
      {
        async createSession() {
          throw new Error('createSession should not run when the runner is idle');
        },
      },
    );

    expect(response).toBe('');
    expect(readOutboundRows(sessionDir)).toEqual([]);
    expect(readAck(sessionDir, sessionId)).toMatchObject({
      session_id: sessionId,
      last_in_seq: 8,
      last_out_seq: 11,
      heartbeat_at: expect.any(String),
    });
  });

  it('subscribes before prompting so active flows receive synchronous text deltas', async () => {
    const sessionDir = makeTempDir('cove-v2-runner-subscribe-before-prompt-');
    const sessionId = 'sess-subscribe-before-prompt-1';

    writeSessionConfig(sessionDir, {
      provider: 'anthropic',
      model: 'claude-runner',
    });
    writeUserMessage(sessionDir, 'Emit a synchronous delta.');

    const callOrder: string[] = [];

    const response = await runContainerSession(
      {
        inboundPath: path.join(sessionDir, 'inbound.db'),
        outboundPath: path.join(sessionDir, 'outbound.db'),
        sessionId,
        config: {
          provider: 'anthropic',
          model: 'claude-runner',
        },
      },
      undefined,
      {
        async createSession() {
          let subscriber: ((event: { type: 'message_update'; assistantMessageEvent?: { type: 'text_delta'; delta: string } }) => void) | undefined;

          return {
            session: {
              subscribe(handler) {
                callOrder.push('subscribe');
                subscriber = handler;
                return () => {
                  callOrder.push('unsubscribe');
                  subscriber = undefined;
                };
              },
              async prompt(message) {
                callOrder.push(`prompt:${message}`);
                subscriber?.({
                  type: 'message_update',
                  assistantMessageEvent: {
                    type: 'text_delta',
                    delta: 'Synchronous active flow response',
                  },
                });
              },
            },
          };
        },
      },
    );

    expect(response).toBe('Synchronous active flow response');
    expect(callOrder).toEqual([
      'subscribe',
      'prompt:Emit a synchronous delta.',
      'unsubscribe',
    ]);
    expect(readOutboundRows(sessionDir)).toEqual([
      {
        seq: 3,
        content: 'Synchronous active flow response',
        metadata: null,
      },
    ]);
  });

  it('reopens outbound.db for writes after the database file is replaced during prompt execution', async () => {
    const sessionDir = makeTempDir('cove-v2-runner-outbound-reopen-');
    const sessionId = 'sess-outbound-reopen-1';

    writeSessionConfig(sessionDir, {
      provider: 'anthropic',
      model: 'claude-runner',
      api_key: 'runner-api-key',
    });
    writeUserMessage(sessionDir, 'Process after outbound replacement.');

    await runContainerSession(
      {
        inboundPath: path.join(sessionDir, 'inbound.db'),
        outboundPath: path.join(sessionDir, 'outbound.db'),
        sessionId,
        config: {
          provider: 'anthropic',
          model: 'claude-runner',
        },
      },
      undefined,
      {
        async createSession() {
          const listeners = new Set<(event: { type: 'message_update'; assistantMessageEvent?: { type: 'text_delta'; delta: string } }) => void>();

          return {
            session: {
              subscribe(handler) {
                listeners.add(handler);
                return () => {
                  listeners.delete(handler);
                };
              },
              async prompt(message) {
                expect(message).toBe('Process after outbound replacement.');

                const originalPath = path.join(sessionDir, 'outbound.db');
                const replacementPath = path.join(sessionDir, 'outbound-replacement.db');
                const originalDb = openOutboundDb(sessionDir);

                try {
                  originalDb.exec('PRAGMA wal_checkpoint(FULL)');
                } finally {
                  originalDb.close();
                }

                fs.copyFileSync(originalPath, replacementPath);
                fs.renameSync(replacementPath, originalPath);

                for (const listener of listeners) {
                  listener({
                    type: 'message_update',
                    assistantMessageEvent: {
                      type: 'text_delta',
                      delta: 'Recovered after outbound replacement',
                    },
                  });
                }
              },
            },
          };
        },
      },
    );

    expect(readOutboundRows(sessionDir)).toEqual([
      {
        seq: 3,
        content: 'Recovered after outbound replacement',
        metadata: null,
      },
    ]);
    expect(readAck(sessionDir, sessionId)).toMatchObject({
      last_in_seq: 2,
      last_out_seq: 3,
    });
  });

  it('passes runtime tool scope into createCoveTools and forwards custom tools into session creation', async () => {
    const stateDir = makeTempDir('cove-v2-runner-tools-state-');
    const sessionDir = path.join(stateDir, 'sessions', 'group-tools-runtime', 'sess-tools-runtime');
    const sessionId = 'sess-tools-runtime';
    const agentGroupId = 'group-tools-runtime';
    const centralDbPath = setupCentralDb({ stateDir, sessionId, agentGroupId, sessionDir });

    writeSessionConfig(sessionDir, {
      provider: 'anthropic',
      model: 'claude-runner',
      extra_env: {
        COVE_AGENT_GROUP_ID: agentGroupId,
        COVE_CENTRAL_DB_PATH: centralDbPath,
      },
    });
    writeUserMessage(sessionDir, 'Hello from custom tools');

    const captured: { promptedMessages: string[]; createCoveToolsArgs?: unknown[]; customTools?: Array<{ name: string }> } = {
      promptedMessages: [],
    };
    const deps: ContainerSessionDeps = {
      async createSession(sessionOptions) {
        captured.customTools = sessionOptions.customTools as Array<{ name: string }> | undefined;
        return createFakeDeps({ capture: { promptedMessages: captured.promptedMessages } }).createSession!(sessionOptions);
      },
      createCoveTools(db, _embedTexts, runtime) {
        captured.createCoveToolsArgs = [db, runtime];
        return [{
          name: 'wiki_search',
          description: 'Test tool',
          parameters: { type: 'object', properties: {} },
          execute: async () => ({ content: [{ type: 'text', text: '{}' }], details: {} }),
        }];
      },
    };

    await runContainerSession(
      {
        inboundPath: path.join(sessionDir, 'inbound.db'),
        outboundPath: path.join(sessionDir, 'outbound.db'),
        sessionId,
        config: {
          provider: 'anthropic',
          model: 'claude-runner',
        },
      },
      undefined,
      deps,
    );

    expect(captured.createCoveToolsArgs?.[1]).toEqual({
      agentGroupId,
      centralDbPath,
      sessionId,
      workflowApiBaseUrl: undefined,
    });
    expect(captured.customTools?.map((tool) => tool.name)).toEqual(['wiki_search']);
  });

  it('prefers the runtime central db path over a persisted host-only session_config path for live tool scope', async () => {
    const sessionDir = makeTempDir('cove-v2-runner-runtime-central-db-');
    const sessionId = 'sess-runtime-central-db-1';
    const agentGroupId = 'group-runtime-central-db';
    const originalCentralDbPath = process.env.COVE_CENTRAL_DB_PATH;

    writeSessionConfig(sessionDir, {
      provider: 'anthropic',
      model: 'claude-runner',
      extra_env: {
        COVE_AGENT_GROUP_ID: agentGroupId,
        COVE_CENTRAL_DB_PATH: '/host-only/cove.db',
      },
    });
    writeUserMessage(sessionDir, 'Use the live tool scope.');

    const captured: { runtime?: Record<string, unknown> } = {};

    try {
      process.env.COVE_CENTRAL_DB_PATH = '/app/session/cove.db';

      await runContainerSession(
        {
          inboundPath: path.join(sessionDir, 'inbound.db'),
          outboundPath: path.join(sessionDir, 'outbound.db'),
          sessionId,
          config: {
            provider: 'anthropic',
            model: 'claude-runner',
          },
        },
        undefined,
        {
          async createSession(sessionOptions) {
            return createFakeDeps().createSession!(sessionOptions);
          },
          createCoveTools(_db, _embedTexts, runtime) {
            captured.runtime = runtime as Record<string, unknown> | undefined;
            return [{
              name: 'wiki_search',
              description: 'Test tool',
              parameters: { type: 'object', properties: {} },
              execute: async () => ({ content: [{ type: 'text', text: '{}' }], details: {} }),
            }];
          },
        },
      );
    } finally {
      restoreEnvVar('COVE_CENTRAL_DB_PATH', originalCentralDbPath);
    }

    expect(captured.runtime).toEqual({
      agentGroupId,
      centralDbPath: '/app/session/cove.db',
      sessionId,
      workflowApiBaseUrl: undefined,
    });
  });

  it('writes a session-local MCP config file and uses the session-local overlay agentDir when runtime MCP config is present', async () => {
    const sessionDir = makeTempDir('cove-v2-runner-mcp-');
    const sessionId = 'sess-mcp-1';

    writeSessionConfig(sessionDir, {
      provider: 'anthropic',
      model: 'claude-runner',
      extra_env: {
        COVE_MCP_CONFIG: JSON.stringify({
          mcpServers: {
            github: {
              command: 'npx',
              args: ['-y', '@modelcontextprotocol/server-github'],
            },
          },
        }),
      },
    });
    writeUserMessage(sessionDir, 'List MCP tools');

    const captured = {
      promptedMessages: [] as string[],
      resourceLoaders: [] as Array<unknown>,
    };
    const deps: ContainerSessionDeps = {
      ...createFakeDeps({ capture: captured }),
      resolveInstalledPackageDir(packageName) {
        return packageName === 'pi-mcp-adapter' ? `/tmp/node_modules/${packageName}` : undefined;
      },
    };

    await runContainerSession(
      {
        inboundPath: path.join(sessionDir, 'inbound.db'),
        outboundPath: path.join(sessionDir, 'outbound.db'),
        sessionId,
        config: {
          provider: 'anthropic',
          model: 'claude-runner',
        },
      },
      undefined,
      deps,
    );

    const mcpPath = path.join(sessionDir, '.pi-agent', 'mcp.json');
    expect(JSON.parse(fs.readFileSync(mcpPath, 'utf8'))).toEqual({
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
        },
      },
    });

    expect(captured.resourceLoaders).toContainEqual(expect.objectContaining({
      cwd: process.cwd(),
      agentDir: path.join(sessionDir, '.pi-agent'),
      additionalExtensionPaths: ['/tmp/node_modules/pi-mcp-adapter'],
      extensionFactories: expect.any(Array),
    }));
  });

  it('uses the session-local overlay agentDir even when runtime MCP config is absent', async () => {
    const sessionDir = makeTempDir('cove-v2-runner-overlay-agent-dir-');
    const sessionId = 'sess-overlay-agent-dir-1';

    writeSessionConfig(sessionDir, {
      provider: 'anthropic',
      model: 'claude-runner',
      api_key: 'runner-api-key',
    });
    writeUserMessage(sessionDir, 'Use overlay agent dir');

    const captured = {
      promptedMessages: [] as string[],
      resourceLoaders: [] as Array<unknown>,
    };

    await runContainerSession(
      {
        inboundPath: path.join(sessionDir, 'inbound.db'),
        outboundPath: path.join(sessionDir, 'outbound.db'),
        sessionId,
        config: {
          provider: 'anthropic',
          model: 'claude-runner',
        },
      },
      undefined,
      createFakeDeps({ capture: captured }),
    );

    expect(captured.resourceLoaders).toContainEqual(expect.objectContaining({
      cwd: process.cwd(),
      agentDir: path.join(sessionDir, '.pi-agent'),
      extensionFactories: expect.any(Array),
    }));
  });

  it('adds the installed pi-subagents package to the resource-loader when an agent group is present', async () => {
    const sessionDir = makeTempDir('cove-v2-runner-subagents-');
    const sessionId = 'sess-subagents-1';

    writeSessionConfig(sessionDir, {
      provider: 'anthropic',
      model: 'claude-runner',
      extra_env: {
        COVE_AGENT_GROUP_ID: 'group-subagents-1',
      },
    });
    writeUserMessage(sessionDir, 'Delegate this');

    const captured = {
      promptedMessages: [] as string[],
      resourceLoaders: [] as Array<unknown>,
    };
    const deps: ContainerSessionDeps = {
      ...createFakeDeps({ capture: captured }),
      resolveInstalledPackageDir(packageName) {
        return packageName === 'pi-subagents' ? `/tmp/node_modules/${packageName}` : undefined;
      },
    };

    await runContainerSession(
      {
        inboundPath: path.join(sessionDir, 'inbound.db'),
        outboundPath: path.join(sessionDir, 'outbound.db'),
        sessionId,
        config: {
          provider: 'anthropic',
          model: 'claude-runner',
        },
      },
      undefined,
      deps,
    );

    expect(captured.resourceLoaders).toContainEqual(expect.objectContaining({
      additionalExtensionPaths: ['/tmp/node_modules/pi-subagents'],
    }));
  });

  it('discovers installed extension packages through the production default resolver', async () => {
    const sessionDir = makeTempDir('cove-v2-runner-default-extension-resolution-');
    const projectDir = makeTempDir('cove-v2-runner-default-extension-project-');
    const sessionId = 'sess-default-extension-resolution-1';
    const originalCwd = process.cwd();
    const resourceLoaders: Array<unknown> = [];

    fs.mkdirSync(path.join(projectDir, 'node_modules', 'pi-mcp-adapter'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'node_modules', 'pi-mcp-adapter', 'package.json'),
      JSON.stringify({ name: 'pi-mcp-adapter', type: 'module' }),
      'utf8',
    );
    fs.writeFileSync(path.join(projectDir, 'node_modules', 'pi-mcp-adapter', 'index.js'), 'export {};\n', 'utf8');

    fs.mkdirSync(path.join(projectDir, 'node_modules', 'pi-subagents'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'node_modules', 'pi-subagents', 'package.json'),
      JSON.stringify({ name: 'pi-subagents', type: 'module' }),
      'utf8',
    );
    fs.writeFileSync(path.join(projectDir, 'node_modules', 'pi-subagents', 'index.js'), 'export {};\n', 'utf8');

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
        resourceLoader?: unknown;
      }) {
        resourceLoaders.push(sessionOptions.resourceLoader);
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
                    delta: `SDK:${message}`,
                  },
                });
              }
            },
          },
        };
      },
    }));

    writeSessionConfig(sessionDir, {
      provider: 'anthropic',
      model: 'claude-runner',
      api_key: 'runner-api-key',
      extra_env: {
        COVE_AGENT_GROUP_ID: 'group-default-extension-resolution',
        COVE_MCP_CONFIG: JSON.stringify({
          mcpServers: {
            github: {
              command: 'npx',
              args: ['-y', '@modelcontextprotocol/server-github'],
            },
          },
        }),
      },
    });
    writeUserMessage(sessionDir, 'Resolve production default extensions');

    process.chdir(projectDir);

    try {
      await runContainerSession({
        inboundPath: path.join(sessionDir, 'inbound.db'),
        outboundPath: path.join(sessionDir, 'outbound.db'),
        sessionId,
        config: {
          provider: 'anthropic',
          model: 'claude-runner',
        },
      });
    } finally {
      process.chdir(originalCwd);
    }

    expect(resourceLoaders).toContainEqual(expect.objectContaining({
      agentDir: path.join(sessionDir, '.pi-agent'),
      additionalExtensionPaths: [
        fs.realpathSync(path.join(projectDir, 'node_modules', 'pi-subagents')),
        fs.realpathSync(path.join(projectDir, 'node_modules', 'pi-mcp-adapter')),
      ],
    }));
  });

  it('fails startup when the materialized inherited extension set is unsupported', async () => {
    const sessionDir = makeTempDir('cove-v2-runner-unsupported-extension-');
    const sessionId = 'sess-unsupported-extension-1';

    writeSessionConfig(sessionDir, {
      provider: 'anthropic',
      model: 'claude-runner',
      api_key: 'runner-api-key',
      extra_env: {
        COVE_AGENT_GROUP_ID: 'group-unsupported-extension',
      },
    });
    writeUserMessage(sessionDir, 'Use inherited extensions');

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
      async createAgentSession() {
        return {
          session: {
            subscribe() {
              return () => {};
            },
            async prompt() {},
          },
        };
      },
    }));

    const packageDir = makeTempDir('cove-v2-runner-pi-coding-agent-package-');
    fs.mkdirSync(path.join(packageDir, 'dist', 'core'), { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'dist', 'config.js'), 'export function getAgentDir() { return "/tmp/pi-agent-base"; }\n', 'utf8');
    fs.writeFileSync(
      path.join(packageDir, 'dist', 'core', 'resource-loader.js'),
      `export class DefaultResourceLoader {
         constructor(options) { this.options = options; }
         async reload() {}
         getExtensions() {
           return [{ sourcePath: '/tmp/pi-agent-base/extensions/unsafe.js' }];
         }
       }
      `,
      'utf8',
    );

    const deps: ContainerSessionDeps = {
      resolveInstalledPackageDir(packageName) {
        return packageName === '@mariozechner/pi-coding-agent' ? packageDir : undefined;
      },
    };

    await expect(runContainerSession(
      {
        inboundPath: path.join(sessionDir, 'inbound.db'),
        outboundPath: path.join(sessionDir, 'outbound.db'),
        sessionId,
        config: {
          provider: 'anthropic',
          model: 'claude-runner',
        },
      },
      undefined,
      deps,
    )).rejects.toThrow('Unsupported inherited extension');
  });

  it('registers persona and assembled-context extension hooks for agent-group runtimes', async () => {
    const stateDir = makeTempDir('cove-v2-runner-context-state-');
    const sessionDir = path.join(stateDir, 'sessions', 'group-context-1', 'sess-context-1');
    const sessionId = 'sess-context-1';
    const agentGroupId = 'group-context-1';
    const centralDbPath = setupCentralDb({ stateDir, sessionId, agentGroupId, sessionDir });

    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'working.jsonl'), [
      JSON.stringify({ type: 'session', id: sessionId, timestamp: new Date().toISOString(), version: 3 }),
      JSON.stringify({
        type: 'message',
        id: 'work-1',
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'Earlier working note' },
      }),
    ].join('\n') + '\n');

    const centralDb = new Database(centralDbPath);
    try {
      centralDb.prepare('UPDATE agent_groups SET soul = ? WHERE id = ?').run('Be concise and factual.', agentGroupId);
      centralDb.prepare(
        'INSERT INTO memories (id, content, embedding, agent_group_id, session_id, importance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        'mem-1',
        'Remember the rollout checklist for this agent.',
        null,
        agentGroupId,
        null,
        0.5,
        new Date().toISOString(),
      );
      centralDb.prepare(
        'INSERT INTO memories_fts(rowid, content) VALUES ((SELECT rowid FROM memories WHERE id = ?), ?)',
      ).run('mem-1', 'Remember the rollout checklist for this agent.');
    } finally {
      centralDb.close();
    }

    writeSessionConfig(sessionDir, {
      provider: 'anthropic',
      model: 'claude-runner',
      extra_env: {
        COVE_AGENT_GROUP_ID: agentGroupId,
        COVE_CENTRAL_DB_PATH: centralDbPath,
      },
    });
    writeUserMessage(sessionDir, 'What is the rollout checklist?');

    let resolvedSystemPrompt = 'base system prompt';
    let transformedMessages: unknown[] | undefined;
    const deps: ContainerSessionDeps = {
      async createSession(sessionOptions) {
        const beforeAgentStartHandlers: Array<(event: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>> = [];
        const contextHandlers: Array<(event: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>> = [];

        for (const factory of sessionOptions.resourceLoader?.extensionFactories ?? []) {
          factory({
            on(event, handler) {
              if (event === 'before_agent_start') {
                beforeAgentStartHandlers.push(handler as never);
              }
              if (event === 'context') {
                contextHandlers.push(handler as never);
              }
            },
          });
        }

        return {
          session: {
            subscribe() {
              return () => {};
            },
            async prompt() {
              for (const handler of beforeAgentStartHandlers) {
                const result = await handler({ systemPrompt: resolvedSystemPrompt });
                if (typeof result?.systemPrompt === 'string') {
                  resolvedSystemPrompt = result.systemPrompt;
                }
              }

              let currentMessages: unknown[] = [{ role: 'user', content: [{ type: 'text', text: 'What is the rollout checklist?' }] }];
              for (const handler of contextHandlers) {
                const result = await handler({ messages: currentMessages });
                if (Array.isArray(result?.messages)) {
                  currentMessages = result.messages;
                }
              }
              transformedMessages = currentMessages;
            },
          },
        };
      },
      createCoveTools() {
        return [];
      },
    };

    await runContainerSession(
      {
        inboundPath: path.join(sessionDir, 'inbound.db'),
        outboundPath: path.join(sessionDir, 'outbound.db'),
        sessionId,
        config: {
          provider: 'anthropic',
          model: 'claude-runner',
        },
      },
      undefined,
      deps,
    );

    expect(resolvedSystemPrompt).toContain('base system prompt');
    expect(resolvedSystemPrompt).toContain('Be concise and factual.');
    expect(JSON.stringify(transformedMessages)).toContain('Earlier working note');
    expect(JSON.stringify(transformedMessages)).toContain('rollout checklist');
  });

  it('uses the real production-default setup path to create a message-scoped session', async () => {
    const sessionDir = makeTempDir('cove-v2-runner-default-setup-');
    const sessionId = 'sess-default-setup-1';

    const promptedMessages: string[] = [];
    const resourceLoaders: Array<unknown> = [];
    let capturedSessionManager: { mode: string; cwd?: string; sessionStateDir?: string } | undefined;

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
        sessionManager?: { mode: string; cwd?: string; sessionStateDir?: string };
        resourceLoader?: unknown;
      }) {
        capturedSessionManager = sessionOptions.sessionManager;
        resourceLoaders.push(sessionOptions.resourceLoader);
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
              promptedMessages.push(message);

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

    writeSessionConfig(sessionDir, {
      provider: 'anthropic',
      model: 'claude-runner',
      api_key: 'runner-api-key',
    });
    writeUserMessage(sessionDir, 'Use the production default setup path.');

    const response = await runContainerSession({
      inboundPath: path.join(sessionDir, 'inbound.db'),
      outboundPath: path.join(sessionDir, 'outbound.db'),
      sessionId,
      config: {
        provider: 'anthropic',
        model: 'claude-runner',
      },
    });

    expect(response).not.toBe('Processed: Use the production default setup path.');
    expect(response).toBe('SDK:anthropic/claude-runner:continueRecent:Use the production default setup path.');
    expect(readOutboundRows(sessionDir)).toEqual([
      {
        seq: 3,
        content: response,
        metadata: null,
      },
    ]);
    expect(readAck(sessionDir, sessionId)).toMatchObject({
      session_id: sessionId,
      last_in_seq: 2,
      last_out_seq: 3,
    });
    expect(promptedMessages).toEqual(['Use the production default setup path.']);
    expect(resourceLoaders).toHaveLength(1);
    expect(capturedSessionManager).toEqual({
      mode: 'continueRecent',
      cwd: process.cwd(),
      sessionStateDir: path.join(sessionDir, '.pi-agent', 'sessions'),
    });
  });

  it('reuses the same auth-backed model registry across the production default setup path', async () => {
    const sessionDir = makeTempDir('cove-v2-runner-default-auth-registry-');
    const sessionId = 'sess-default-auth-registry-1';
    const authInstances: Array<{ id: string; setRuntimeApiKey(provider: string, apiKey: string): void }> = [];
    const registryCalls: Array<{ auth: { id: string }; registry: { auth: { id: string } } }> = [];
    const createAgentSessionCalls: Array<{
      authStorage?: { id: string };
      modelRegistry?: { auth: { id: string } };
      model?: { provider: string; id: string; authId: string };
    }> = [];

    mock.module('@mariozechner/pi-coding-agent', () => ({
      AuthStorage: {
        inMemory() {
          const auth = {
            id: `auth-${authInstances.length + 1}`,
            setRuntimeApiKey() {},
          };
          authInstances.push(auth);
          return auth;
        },
      },
      ModelRegistry: {
        inMemory(auth: { id: string }) {
          const registry = {
            auth,
            find(provider: string, model: string) {
              return { provider, id: model, authId: auth.id };
            },
          };
          registryCalls.push({ auth, registry });
          return registry;
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
        authStorage?: { id: string };
        modelRegistry?: { auth: { id: string } };
        model?: { provider: string; id: string; authId: string };
      }) {
        createAgentSessionCalls.push(sessionOptions);
        return {
          session: {
            subscribe() {
              return () => {};
            },
            async prompt() {},
          },
        };
      },
    }));

    writeSessionConfig(sessionDir, {
      provider: 'anthropic',
      model: 'claude-runner',
      api_key: 'runner-api-key',
    });
    writeUserMessage(sessionDir, 'Verify auth-backed model registry reuse.');

    await runContainerSession({
      inboundPath: path.join(sessionDir, 'inbound.db'),
      outboundPath: path.join(sessionDir, 'outbound.db'),
      sessionId,
      config: {
        provider: 'anthropic',
        model: 'claude-runner',
      },
    });

    expect(authInstances).toHaveLength(1);
    expect(registryCalls).toHaveLength(1);
    expect(createAgentSessionCalls).toHaveLength(1);
    expect(createAgentSessionCalls[0]?.authStorage).toBe(authInstances[0]);
    expect(createAgentSessionCalls[0]?.modelRegistry).toBe(registryCalls[0]?.registry);
    expect(createAgentSessionCalls[0]?.model?.authId).toBe(authInstances[0]?.id);
  });

  it('adds pi-onecli-extension to resource-loader extension paths for inherited OneCLI gateway runs', async () => {
    const sessionDir = makeTempDir('cove-v2-runner-onecli-extension-');
    const sessionId = 'sess-onecli-extension-1';
    const resourceLoaders: Array<{
      additionalExtensionPaths?: string[];
    } | undefined> = [];

    process.env.ONECLI_AGENT_NAME = 'cove-agent';
    process.env.ONECLI_URL = 'https://onecli.example';

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
        resourceLoader?: {
          additionalExtensionPaths?: string[];
        };
      }) {
        resourceLoaders.push(sessionOptions.resourceLoader);
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
                    delta: `SDK:${message}`,
                  },
                });
              }
            },
          },
        };
      },
    }));

    writeSessionConfig(sessionDir, {
      provider: 'anthropic',
      model: 'claude-runner',
      api_key: 'runner-api-key',
    });
    writeUserMessage(sessionDir, 'Use inherited OneCLI auth.');

    await runContainerSession({
      inboundPath: path.join(sessionDir, 'inbound.db'),
      outboundPath: path.join(sessionDir, 'outbound.db'),
      sessionId,
      config: {
        provider: 'anthropic',
        model: 'claude-runner',
      },
    }, undefined, {
      resolveInstalledPackageDir(packageName) {
        return packageName === 'pi-onecli-extension' ? `/tmp/node_modules/${packageName}` : undefined;
      },
    });

    expect(resourceLoaders).toContainEqual(expect.objectContaining({
      additionalExtensionPaths: ['/tmp/node_modules/pi-onecli-extension'],
    }));
  });

  it('does not inject API key fallback for supported auto provider paths when inherited OneCLI gateway auth is active', async () => {
    const sessionDir = makeTempDir('cove-v2-runner-onecli-auto-provider-');
    const sessionId = 'sess-onecli-auto-provider-1';
    const authCalls: Array<{ provider: string; apiKey: string | null | undefined }> = [];
    let createAgentSessionCalls = 0;

    process.env.ONECLI_AGENT_NAME = 'cove-agent';
    process.env.ONECLI_URL = 'https://onecli.example';

    mock.module('@mariozechner/pi-coding-agent', () => ({
      AuthStorage: {
        inMemory() {
          return {
            setRuntimeApiKey(provider: string, apiKey: string) {
              authCalls.push({ provider, apiKey });
            },
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
      async createAgentSession() {
        createAgentSessionCalls += 1;
        return {
          session: {
            subscribe() {
              return () => {};
            },
            async prompt() {},
          },
        };
      },
    }));

    writeSessionConfig(sessionDir, {
      provider: 'auto',
      model: 'anthropic/claude-runner',
      api_key: 'runner-api-key',
    });
    writeUserMessage(sessionDir, 'Use inherited OneCLI auth for resolved provider path.');

    await runContainerSession({
      inboundPath: path.join(sessionDir, 'inbound.db'),
      outboundPath: path.join(sessionDir, 'outbound.db'),
      sessionId,
      config: {
        provider: 'anthropic',
        model: 'claude-runner',
      },
    });

    expect(createAgentSessionCalls).toBe(1);
    expect(authCalls).toEqual([]);
  });

  it('does not treat persisted ONECLI config values as inherited gateway auth', async () => {
    const sessionDir = makeTempDir('cove-v2-runner-onecli-persisted-config-only-');
    const sessionId = 'sess-onecli-persisted-config-only-1';

    clearGatewayEnvForTest();

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
      async createAgentSession() {
        return {
          session: {
            subscribe() {
              return () => {};
            },
            async prompt() {},
          },
        };
      },
    }));

    writeSessionConfig(sessionDir, {
      provider: 'anthropic',
      model: 'claude-runner',
      extra_env: {
        ONECLI_AGENT_NAME: 'persisted-agent',
        ONECLI_URL: 'https://persisted-onecli.example',
      },
    });
    writeUserMessage(sessionDir, 'This should still require credentials.');

    await expect(runContainerSession({
      inboundPath: path.join(sessionDir, 'inbound.db'),
      outboundPath: path.join(sessionDir, 'outbound.db'),
      sessionId,
      config: {
        provider: 'anthropic',
        model: 'claude-runner',
      },
    })).rejects.toThrow('Container agent startup requires inherited OneCLI gateway auth or API_KEY for anthropic/claude-runner.');
  });

  it('keeps API key fallback when inherited OneCLI gateway env is unavailable', async () => {
    const sessionDir = makeTempDir('cove-v2-runner-api-key-fallback-');
    const sessionId = 'sess-api-key-fallback-1';
    const authCalls: Array<{ provider: string; apiKey: string | null | undefined }> = [];

    clearGatewayEnvForTest();

    mock.module('@mariozechner/pi-coding-agent', () => ({
      AuthStorage: {
        inMemory() {
          return {
            setRuntimeApiKey(provider: string, apiKey: string) {
              authCalls.push({ provider, apiKey });
            },
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
      async createAgentSession() {
        return {
          session: {
            subscribe() {
              return () => {};
            },
            async prompt() {},
          },
        };
      },
    }));

    writeSessionConfig(sessionDir, {
      provider: 'anthropic',
      model: 'claude-runner',
      api_key: 'runner-api-key',
    });
    writeUserMessage(sessionDir, 'Fallback to API key.');

    await runContainerSession({
      inboundPath: path.join(sessionDir, 'inbound.db'),
      outboundPath: path.join(sessionDir, 'outbound.db'),
      sessionId,
      config: {
        provider: 'anthropic',
        model: 'claude-runner',
      },
    });

    expect(authCalls).toEqual([{ provider: 'anthropic', apiKey: 'runner-api-key' }]);
  });

  it('uses API key fallback when OneCLI auth is explicitly disabled even if inherited gateway env is present', async () => {
    const sessionDir = makeTempDir('cove-v2-runner-onecli-disabled-api-key-fallback-');
    const sessionId = 'sess-onecli-disabled-api-key-fallback-1';
    const authCalls: Array<{ provider: string; apiKey: string | null | undefined }> = [];

    process.env.ONECLI_AGENT_NAME = 'cove-agent';
    process.env.ONECLI_URL = 'https://onecli.example';

    mock.module('@mariozechner/pi-coding-agent', () => ({
      AuthStorage: {
        inMemory() {
          return {
            setRuntimeApiKey(provider: string, apiKey: string) {
              authCalls.push({ provider, apiKey });
            },
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
      async createAgentSession() {
        return {
          session: {
            subscribe() {
              return () => {};
            },
            async prompt() {},
          },
        };
      },
    }));

    writeSessionConfig(sessionDir, {
      provider: 'anthropic',
      model: 'claude-runner',
      api_key: 'runner-api-key',
      extra_env: {
        COVE_ONECLI_AUTH: 'false',
      },
    });
    writeUserMessage(sessionDir, 'Fallback to API key when OneCLI is disabled.');

    await runContainerSession({
      inboundPath: path.join(sessionDir, 'inbound.db'),
      outboundPath: path.join(sessionDir, 'outbound.db'),
      sessionId,
      config: {
        provider: 'anthropic',
        model: 'claude-runner',
      },
    });

    expect(authCalls).toEqual([{ provider: 'anthropic', apiKey: 'runner-api-key' }]);
  });

  it('fails with a clear startup error when the selected provider path has neither OneCLI gateway auth nor API key fallback', async () => {
    const sessionDir = makeTempDir('cove-v2-runner-missing-credentials-');
    const sessionId = 'sess-missing-credentials-1';

    clearGatewayEnvForTest();

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
      async createAgentSession() {
        return {
          session: {
            subscribe() {
              return () => {};
            },
            async prompt() {},
          },
        };
      },
    }));

    writeSessionConfig(sessionDir, {
      provider: 'anthropic',
      model: 'claude-runner',
    });
    writeUserMessage(sessionDir, 'This should fail without credentials.');

    await expect(runContainerSession({
      inboundPath: path.join(sessionDir, 'inbound.db'),
      outboundPath: path.join(sessionDir, 'outbound.db'),
      sessionId,
      config: {
        provider: 'anthropic',
        model: 'claude-runner',
      },
    })).rejects.toThrow('Container agent startup requires inherited OneCLI gateway auth or API_KEY for anthropic/claude-runner.');

    expect(readOutboundRows(sessionDir)).toEqual([]);
    expect(readAck(sessionDir, sessionId)).toBeNull();
  });

  it('accepts inherited GitHub Copilot env auth without requiring an API key fallback', async () => {
    const sessionDir = makeTempDir('cove-v2-runner-copilot-env-auth-');
    const sessionId = 'sess-copilot-env-auth-1';
    const authCalls: Array<{ provider: string; apiKey: string | null | undefined }> = [];

    clearGatewayEnvForTest();
    process.env.GH_TOKEN = 'gh-host-token';

    mock.module('@mariozechner/pi-coding-agent', () => ({
      AuthStorage: {
        inMemory() {
          return {
            setRuntimeApiKey(provider: string, apiKey: string) {
              authCalls.push({ provider, apiKey });
            },
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
      async createAgentSession() {
        return {
          session: {
            subscribe() {
              return () => {};
            },
            async prompt() {},
          },
        };
      },
    }));

    writeSessionConfig(sessionDir, {
      provider: 'github-copilot',
      model: 'gpt-4.1',
    });
    writeUserMessage(sessionDir, 'Use inherited GitHub Copilot env auth.');

    await expect(runContainerSession({
      inboundPath: path.join(sessionDir, 'inbound.db'),
      outboundPath: path.join(sessionDir, 'outbound.db'),
      sessionId,
      config: {
        provider: 'github-copilot',
        model: 'gpt-4.1',
      },
    })).resolves.toBe('');

    expect(authCalls).toEqual([]);
  });

  it('supports auto provider paths that resolve to non-Anthropic providers', async () => {
    const sessionDir = makeTempDir('cove-v2-runner-auto-unsupported-provider-1');
    const sessionId = 'sess-auto-unsupported-provider-1';

    process.env.ONECLI_AGENT_NAME = 'cove-agent';
    process.env.ONECLI_URL = 'https://onecli.example';

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
      }) {
        return {
          session: {
            subscribe() {
              return () => {};
            },
            async prompt() {},
            async waitForIdle() {},
            getLastAssistantText() {
              return `resolved:${sessionOptions.model?.provider}/${sessionOptions.model?.id}`;
            },
          },
        };
      },
    }));

    writeSessionConfig(sessionDir, {
      provider: 'auto',
      model: 'openai/gpt-4o-mini',
    });
    writeUserMessage(sessionDir, 'This should succeed for generic auto provider paths.');

    await expect(runContainerSession({
      inboundPath: path.join(sessionDir, 'inbound.db'),
      outboundPath: path.join(sessionDir, 'outbound.db'),
      sessionId,
      config: {
        provider: 'anthropic',
        model: 'claude-runner',
      },
    })).resolves.toBe('resolved:openai/gpt-4o-mini');

    const ack = readAck(sessionDir, sessionId);
    expect(ack?.last_in_seq).toBe(2);
    expect(ack?.last_out_seq).toBeGreaterThan(0);
    expect(readOutboundRows(sessionDir)).toEqual([
      expect.objectContaining({
        content: 'resolved:openai/gpt-4o-mini',
      }),
    ]);
  });

  it('throws setup failures without writing an assistant row or advancing ack state', async () => {
    const sessionDir = makeTempDir('cove-v2-runner-setup-failure-');
    const sessionId = 'sess-setup-failure-1';

    writeSessionConfig(sessionDir, {
      provider: 'auto',
      model: 'missing-provider-prefix',
    });
    writeUserMessage(sessionDir, 'This should fail before any outbound write.');

    await expect(runContainerSession({
      inboundPath: path.join(sessionDir, 'inbound.db'),
      outboundPath: path.join(sessionDir, 'outbound.db'),
      sessionId,
      config: {
        provider: 'anthropic',
        model: 'claude-runner',
      },
    })).rejects.toThrow("Container agent model must include an explicit provider when provider is 'auto'.");

    expect(readOutboundRows(sessionDir)).toEqual([]);
    expect(readAck(sessionDir, sessionId)).toBeNull();
  });
});
