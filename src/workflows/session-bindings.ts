import type { Database } from 'bun:sqlite';
import type { AgentMessage, AgentToolResult } from '@mariozechner/pi-agent-core';

import { getNextOutboundSeq, openExistingOutboundDb, openOutboundDb, readProcessingAck, writeOutboundMessage, writeProcessingAck } from '../session/outbound.ts';
import { openInboundDb, writeInboundMessage } from '../session/inbound.ts';
import { ensureSessionForRuntime } from '../session/manager.ts';
import { buildAgentGroupSessionConfig } from '../session-config.ts';
import { routeRequest } from '../router.ts';
import { pollForResponse as defaultPollForResponse } from '../delivery.ts';
import type { ChatHandlerContext, ChatMessage, SessionConfig } from '../shared/types.ts';
import type { AgentGroupRow, RoutedRequest, SessionRow } from '../shared/types.ts';
import {
  executeHostLlmPrompt,
  executeHostSessionPrompt,
  executeHostToolCall,
  prepareHostSession,
  type ContainerSessionDeps,
} from '../container-agent/runner.ts';
import type { WorkflowExecutionContext } from './bridge.ts';

function resolveHostCentralDbPath(db: Database): string | undefined {
  const dbPath = db.filename?.trim();

  if (!dbPath || dbPath === ':memory:') {
    return undefined;
  }

  return dbPath;
}

function stripTimestamps<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, candidate) => {
    if (typeof candidate === 'object' && candidate != null && 'timestamp' in candidate) {
      const { timestamp: _timestamp, ...rest } = candidate as Record<string, unknown>;
      return rest;
    }

    return candidate;
  })) as T;
}

function extractTextContent(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }

  if (!Array.isArray(result)) {
    return '';
  }

  return result
    .map((part) => {
      if (part != null && typeof part === 'object' && 'type' in part && 'text' in part && part.type === 'text' && typeof part.text === 'string') {
        return part.text;
      }

      return '';
    })
    .join('');
}

function decodeToolResult(result: AgentToolResult<unknown>): unknown {
  const text = extractTextContent(result.content);

  if (text.trim() !== '') {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return {
    details: result.details,
    ...(result.terminate === undefined ? {} : { terminate: result.terminate }),
  };
}

function buildWorkflowSessionConfig(options: {
  db: Database;
  routed: RoutedRequest;
  modelOverride?: string;
}): SessionConfig {
  const base = buildScheduledSessionConfig(options.routed.agentGroup);
  const hostCentralDbPath = resolveHostCentralDbPath(options.db);

  return {
    ...base,
    ...(options.modelOverride == null ? {} : { model: options.modelOverride }),
    extra_env: {
      ...(base.extra_env ?? {}),
      COVE_AGENT_GROUP_ID: options.routed.agentGroup.id,
      ...(hostCentralDbPath == null ? {} : { COVE_CENTRAL_DB_PATH: hostCentralDbPath }),
      ...(base.extra_env?.COVE_WORKFLOW_API_BASE_URL == null
        ? {}
        : { COVE_WORKFLOW_API_BASE_URL: base.extra_env.COVE_WORKFLOW_API_BASE_URL }),
    },
  };
}

function buildScheduledSessionConfig(agentGroup: AgentGroupRow): SessionConfig {
  return buildAgentGroupSessionConfig(agentGroup);
}

function writeSessionConfig(db: Database, config: SessionConfig): void {
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
}

function resolveAgentGroup(db: Database, agentGroupId: string): AgentGroupRow {
  const row = db.prepare(
    `SELECT id, name, description, workspace, provider, model, thinking, permissions, soul, config, created_at, updated_at
     FROM agent_groups
     WHERE id = ?`,
  ).get(agentGroupId);

  if (row == null) {
    throw new Error(`Agent group ${agentGroupId} not found`);
  }

  return row as AgentGroupRow;
}

function resolveSessionById(db: Database, sessionId: string): SessionRow {
  const row = db.prepare(
    `SELECT id, agent_group_id, thread_id, session_file, metadata, created_at, updated_at
     FROM sessions
     WHERE id = ?`,
  ).get(sessionId);

  if (row == null) {
    throw new Error(`Session ${sessionId} not found`);
  }

  return row as SessionRow;
}

function resolveWorkflowRouting(options: {
  db: Database;
  stateDir: string;
  context: WorkflowExecutionContext;
}): RoutedRequest {
  if (typeof options.context.session_id === 'string' && options.context.session_id.trim() !== '') {
    const session = ensureSessionForRuntime({
      db: options.db,
      stateDir: options.stateDir,
      session: resolveSessionById(options.db, options.context.session_id),
    });
    const agentGroup = resolveAgentGroup(options.db, session.agent_group_id);

    return {
      agentGroup,
      threadId: session.thread_id ?? options.context.thread_id ?? `workflow:${session.id}`,
      session,
    };
  }

  const agentGroupId = typeof options.context.agent_group_id === 'string' && options.context.agent_group_id.trim() !== ''
    ? options.context.agent_group_id
    : 'default';
  const threadId = typeof options.context.thread_id === 'string' && options.context.thread_id.trim() !== ''
    ? options.context.thread_id
    : `workflow:${crypto.randomUUID()}`;

  return routeRequest({
    db: options.db,
    request: new Request('http://workflow.local/internal/workflows/pi'),
    body: {
      agent_group_id: agentGroupId,
      thread_id: threadId,
    },
    stateDir: options.stateDir,
  });
}

export function createWorkflowSessionBindings(options: {
  db: Database;
  stateDir: string;
  ensureSessionRuntime?: NonNullable<ChatHandlerContext['ensureSessionRuntime']>;
  pollForResponse?: NonNullable<ChatHandlerContext['pollForResponse']>;
  runnerDeps?: ContainerSessionDeps;
  createCoveTools?: ContainerSessionDeps['createCoveTools'];
}) {
  const pollForResponse = options.pollForResponse ?? defaultPollForResponse;

  async function promptWithRouting(args: {
    routed: RoutedRequest;
    messages: ChatMessage[];
    modelOverride?: string;
  }): Promise<string> {
    const config = buildWorkflowSessionConfig({
      db: options.db,
      routed: args.routed,
      modelOverride: args.modelOverride,
    });

    if (options.ensureSessionRuntime != null) {
      const ready = await options.ensureSessionRuntime({ routed: args.routed, config });

      if (!ready) {
        throw new Error('Container runtime unavailable');
      }
    }

    const sessionDir = args.routed.session.session_file;
    if (sessionDir == null) {
      throw new Error('Session runtime is unavailable');
    }

    const outboundBaselineDb = openExistingOutboundDb(sessionDir);
    let baselineOutSeq = 0;

    try {
      const row = outboundBaselineDb.prepare('SELECT MAX(seq) AS seq FROM messages_out').get() as { seq: number | null };
      baselineOutSeq = row.seq ?? 0;
    } finally {
      outboundBaselineDb.close();
    }

    const inboundDb = openInboundDb(sessionDir);

    try {
      writeSessionConfig(inboundDb, config);
      for (const message of args.messages) {
        if (message.role !== 'user') {
          continue;
        }

        writeInboundMessage(inboundDb, {
          id: crypto.randomUUID(),
          role: message.role,
          content: message.content,
        });
      }
    } finally {
      inboundDb.close();
    }

    const messages = await pollForResponse({
      openDb: () => openExistingOutboundDb(sessionDir),
      sessionId: args.routed.session.id,
      baselineOutSeq,
    });

    return messages.map((message) => message.content).join('');
  }

  async function prepareWorkflowHostSession(args: {
    context: WorkflowExecutionContext;
    modelOverride?: string;
    noSkills?: boolean;
  }) {
    const routed = resolveWorkflowRouting({
      db: options.db,
      stateDir: options.stateDir,
      context: args.context,
    });
    const config = buildWorkflowSessionConfig({
      db: options.db,
      routed,
      modelOverride: args.modelOverride,
    });

    if (options.ensureSessionRuntime != null) {
      const ready = await options.ensureSessionRuntime({ routed, config });

      if (!ready) {
        throw new Error('Container runtime unavailable');
      }
    }

    const sessionStateDir = routed.session.session_file;
    if (sessionStateDir == null) {
      throw new Error('Session runtime is unavailable');
    }

    return await prepareHostSession({
      config,
      sessionId: routed.session.id,
      sessionStateDir,
      noSkills: args.noSkills,
      deps: {
        ...(options.runnerDeps ?? {}),
        ...(options.createCoveTools == null ? {} : { createCoveTools: options.createCoveTools }),
      },
    });
  }

  return {
    async llm(context: WorkflowExecutionContext, messages: unknown[], llmOptions?: { model?: string; tools?: unknown[] }): Promise<unknown> {
      const prepared = await prepareWorkflowHostSession({
        context,
        modelOverride: llmOptions?.model,
        noSkills: true,
      });
      const response = await executeHostLlmPrompt(prepared, stripTimestamps(messages) as AgentMessage[]);

      return stripTimestamps(response);
    },
    async tool(context: WorkflowExecutionContext, name: string, args: unknown): Promise<unknown> {
      if (args == null || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error(`Tool ${name} requires object arguments`);
      }

      const prepared = await prepareWorkflowHostSession({
        context,
        noSkills: true,
      });
      const result = await executeHostToolCall(prepared, name, args as Record<string, unknown>);

      return decodeToolResult(result);
    },
    async skill(context: WorkflowExecutionContext, name: string, input: string): Promise<string> {
      const prepared = await prepareWorkflowHostSession({
        context,
        noSkills: false,
      });

      return await executeHostSessionPrompt(prepared, `/skill:${name} ${input}`.trim());
    },
    async prompt(context: WorkflowExecutionContext, prompt: string, promptOptions?: { model?: string }): Promise<string> {
      return await promptWithRouting({
        routed: resolveWorkflowRouting({
          db: options.db,
          stateDir: options.stateDir,
          context,
        }),
        messages: [{ role: 'user', content: prompt }],
        modelOverride: promptOptions?.model,
      });
    },
    async sendMessage(context: WorkflowExecutionContext, content: string): Promise<void> {
      const routed = resolveWorkflowRouting({
        db: options.db,
        stateDir: options.stateDir,
        context,
      });
      const sessionDir = routed.session.session_file;
      if (sessionDir == null) {
        throw new Error('Session runtime is unavailable');
      }

      const outboundDb = openOutboundDb(sessionDir);

      try {
        const ack = readProcessingAck(outboundDb, routed.session.id);
        const seq = getNextOutboundSeq(ack?.last_out_seq ?? null, ack?.last_in_seq ?? 0);

        writeOutboundMessage(outboundDb, {
          id: crypto.randomUUID(),
          seq,
          role: 'assistant',
          content,
        });
        writeProcessingAck(outboundDb, {
          session_id: routed.session.id,
          last_in_seq: ack?.last_in_seq ?? null,
          last_out_seq: seq,
          heartbeat_at: new Date().toISOString(),
        });
      } finally {
        outboundDb.close();
      }
    },
  };
}
