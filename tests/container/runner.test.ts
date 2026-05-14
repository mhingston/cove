import { afterEach, describe, expect, it } from 'bun:test';
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
  capture?: { promptedMessages: string[] };
} = {}): ContainerSessionDeps {
  return {
    async createSession(sessionOptions) {
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
                    handlers.push(handler);
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
});
