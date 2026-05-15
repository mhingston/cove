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
        throw new Error('COVE_CENTRAL_DB_PATH is required for live container tools');
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
    });
    expect(captured.customTools?.map((tool) => tool.name)).toEqual(['wiki_search']);
  });

  it('writes a session-local MCP config file and passes locked-down resource-loader options when runtime MCP config is present', async () => {
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
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
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
