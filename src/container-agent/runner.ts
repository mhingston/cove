import { Database } from 'bun:sqlite';
import path from 'node:path';

import { PermissionBridgeImpl } from '../control/permissions.ts';
import { PolicyEngine } from '../control/policy.ts';
import type { SessionConfig } from '../shared/types.ts';
import { openInboundDb } from '../session/inbound.ts';
import {
  getNextOutboundSeq,
  openOutboundDb,
  readProcessingAck,
  writeOutboundMessage,
  writeProcessingAck,
} from '../session/outbound.ts';

type PermissionTier = 'auto' | 'prompt' | 'confirm';

type InboundRow = {
  id: string;
  seq: number;
  role: string;
  content: string;
  metadata: string | null;
  created_at: string;
};

type SessionMessageUpdate = {
  type: 'message_update';
  assistantMessageEvent?: {
    type: 'text_delta';
    delta: string;
  };
};

type ToolCallEvent = {
  toolName: string;
  input: Record<string, unknown>;
};

type ToolCallResult = {
  block?: boolean;
  reason?: string;
} | undefined;

type ToolCallHandler = (event: ToolCallEvent) => Promise<ToolCallResult> | ToolCallResult;

type ExtensionRuntime = {
  on(event: 'tool_call', handler: ToolCallHandler): void;
};

type ExtensionFactory = (runtime: ExtensionRuntime) => void;

type RunnerResourceLoader = {
  extensionFactories?: ExtensionFactory[];
};

type RunnerSession = {
  subscribe(handler: (event: SessionMessageUpdate) => void): () => void;
  prompt(message: string): Promise<void>;
};

type RunnerSessionResult = {
  session: RunnerSession;
};

type CreateSessionOptions = {
  config: SessionConfig;
  resourceLoader?: RunnerResourceLoader;
};

export type ContainerSessionDeps = {
  createSession?(options: CreateSessionOptions): Promise<RunnerSessionResult>;
};

export type RunContainerSessionOptions = {
  inboundPath: string;
  outboundPath: string;
  sessionId?: string;
  config: SessionConfig;
};

export type RunContainerSessionLoopOptions = {
  pollIntervalMs?: number;
  maxIterations?: number;
  sleep?: (ms: number) => Promise<void>;
};

type PromptRequiredResult = {
  permission: 'prompt';
  question: string;
  tool_name: string;
  tool_args: Record<string, unknown>;
};

type ApprovalNeededResult = {
  permission: 'confirm';
  approval_id: string;
  message: string;
  tool_name: string;
  tool_args: Record<string, unknown>;
  expires_at: string;
};

type BlockedToolResult = PromptRequiredResult | ApprovalNeededResult;

type ApprovalResumeMetadata = {
  type: 'approval_resume';
  approval_id: string;
  tool_name: string;
  tool_args: Record<string, unknown>;
};

const DEFAULT_APPROVAL_TTL_MS = 300_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPermissionTier(value: unknown): value is PermissionTier {
  return value === 'auto' || value === 'prompt' || value === 'confirm';
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (value == null) {
    return null;
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }

  return typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readSessionConfig(db: Database): SessionConfig | null {
  const row = db.prepare(
    `SELECT provider, model, thinking_level, api_key, workspace, extra_env, permissions
     FROM session_config
     LIMIT 1`,
  ).get() as {
    provider: string;
    model: string;
    thinking_level: string | null;
    api_key: string | null;
    workspace: string | null;
    extra_env: string | null;
    permissions: string | null;
  } | null;

  if (row == null) {
    return null;
  }

  const extraEnv = parseJsonRecord(row.extra_env);

  return {
    provider: row.provider,
    model: row.model,
    thinking_level: row.thinking_level,
    api_key: row.api_key,
    workspace: row.workspace,
    extra_env: extraEnv == null
      ? null
      : Object.fromEntries(
          Object.entries(extraEnv).map(([key, value]) => [key, String(value)]),
        ) as Record<string, string>,
    permissions: row.permissions,
  };
}

function mergeSessionConfig(runtimeConfig: SessionConfig, persistedConfig: SessionConfig | null): SessionConfig {
  if (persistedConfig == null) {
    return runtimeConfig;
  }

  return {
    ...runtimeConfig,
    ...persistedConfig,
    extra_env: {
      ...(runtimeConfig.extra_env ?? {}),
      ...(persistedConfig.extra_env ?? {}),
    },
    permissions: persistedConfig.permissions ?? runtimeConfig.permissions ?? null,
  };
}

function getConfiguredSessionId(config: SessionConfig): string | undefined {
  return config.extra_env?.COVE_SESSION_ID ?? process.env.COVE_SESSION_ID;
}

function getCentralDbPath(config: SessionConfig): string | undefined {
  return config.extra_env?.COVE_CENTRAL_DB_PATH ?? process.env.COVE_CENTRAL_DB_PATH;
}

function getAgentGroupId(config: SessionConfig): string | undefined {
  return config.extra_env?.COVE_AGENT_GROUP_ID ?? process.env.COVE_AGENT_GROUP_ID;
}

function getApprovalTtlMs(): number {
  const candidate = process.env.COVE_APPROVAL_TTL_MS;

  if (candidate != null) {
    const parsed = Number.parseInt(candidate, 10);

    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return DEFAULT_APPROVAL_TTL_MS;
}

function parsePermissionOverrides(config: SessionConfig): Record<string, PermissionTier> | undefined {
  const record = parseJsonRecord(config.permissions ?? config.extra_env?.COVE_PERMISSIONS ?? process.env.COVE_PERMISSIONS);

  if (record == null) {
    return undefined;
  }

  const explicit = Object.entries(record).filter(
    (entry): entry is [string, PermissionTier] => entry[0] !== 'default' && isPermissionTier(entry[1]),
  );

  return explicit.length > 0 ? Object.fromEntries(explicit) : undefined;
}

function buildPromptRequiredResult(toolName: string, toolArgs: Record<string, unknown>): PromptRequiredResult {
  return {
    permission: 'prompt',
    question: `Tool '${toolName}' requires confirmation from the user before it can run.`,
    tool_name: toolName,
    tool_args: toolArgs,
  };
}

function summarizeToolArgs(toolName: string, toolArgs: Record<string, unknown>): string {
  if (toolName === 'bash' && typeof toolArgs.command === 'string') {
    return toolArgs.command;
  }

  return JSON.stringify(toolArgs);
}

function buildApprovalNeededResult(
  approvalId: string,
  expiresAt: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
): ApprovalNeededResult {
  return {
    permission: 'confirm',
    approval_id: approvalId,
    message: `Approval required to run ${toolName}: ${summarizeToolArgs(toolName, toolArgs)}`,
    tool_name: toolName,
    tool_args: toolArgs,
    expires_at: expiresAt,
  };
}

function blockedToolResultText(result: BlockedToolResult | undefined): string | undefined {
  if (result == null) {
    return undefined;
  }

  return result.permission === 'confirm' ? result.message : result.question;
}

function parseApprovalResumeMetadata(metadata: unknown): ApprovalResumeMetadata | undefined {
  const record = parseJsonRecord(metadata);

  if (record?.type !== 'approval_resume') {
    return undefined;
  }

  if (typeof record.approval_id !== 'string' || typeof record.tool_name !== 'string') {
    return undefined;
  }

  if (record.tool_args == null || typeof record.tool_args !== 'object' || Array.isArray(record.tool_args)) {
    return undefined;
  }

  return {
    type: 'approval_resume',
    approval_id: record.approval_id,
    tool_name: record.tool_name,
    tool_args: record.tool_args as Record<string, unknown>,
  };
}

function matchesApprovalResume(
  approvalResume: ApprovalResumeMetadata | undefined,
  toolName: string,
  toolArgs: Record<string, unknown>,
): boolean {
  if (approvalResume == null) {
    return false;
  }

  return approvalResume.tool_name === toolName && JSON.stringify(approvalResume.tool_args) === JSON.stringify(toolArgs);
}

function isExpired(expiresAt: string): boolean {
  return Date.now() >= new Date(expiresAt).getTime();
}

function findExistingApproval(db: Database, options: {
  sessionId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
}): {
  id: string;
  status: string;
  expires_at: string;
} | undefined {
  return db.prepare(
    `SELECT id, status, expires_at
     FROM approvals
     WHERE session_id = ?
       AND tool_name = ?
       AND status IN ('pending', 'approved')
       AND COALESCE(tool_args, '') = COALESCE(?, '')
     ORDER BY requested_at DESC, id DESC
     LIMIT 1`,
  ).get(options.sessionId, options.toolName, JSON.stringify(options.toolArgs)) as {
    id: string;
    status: string;
    expires_at: string;
  } | undefined;
}

function materializeExpiredApproval(db: Database, approvalId: string): void {
  db.prepare('UPDATE approvals SET status = ?, responded_at = ? WHERE id = ?').run(
    'expired',
    new Date().toISOString(),
    approvalId,
  );
}

function createPendingApproval(db: Database, options: {
  agentGroupId: string;
  sessionId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
}): {
  id: string;
  expires_at: string;
} {
  const id = crypto.randomUUID();
  const requestedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + getApprovalTtlMs()).toISOString();

  db.prepare(
    `INSERT INTO approvals (id, agent_group_id, session_id, tool_name, tool_args, status, requested_at, responded_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(
    id,
    options.agentGroupId,
    options.sessionId,
    options.toolName,
    JSON.stringify(options.toolArgs),
    requestedAt,
    null,
    expiresAt,
  );

  return { id, expires_at: expiresAt };
}

function createDefaultSession(): Promise<RunnerSessionResult> {
  const listeners = new Set<(event: SessionMessageUpdate) => void>();

  return Promise.resolve({
    session: {
      subscribe(handler) {
        listeners.add(handler);
        return () => {
          listeners.delete(handler);
        };
      },
      async prompt(message) {
        const response = `Processed: ${message}`;

        for (const listener of listeners) {
          listener({
            type: 'message_update',
            assistantMessageEvent: {
              type: 'text_delta',
              delta: response,
            },
          });
        }
      },
    },
  });
}

const defaultDeps: Required<ContainerSessionDeps> = {
  createSession: createDefaultSession,
};

function buildResourceLoader(options: {
  config: SessionConfig;
  sessionId: string;
  approvalResume?: ApprovalResumeMetadata;
  onBlocked(result: BlockedToolResult): void;
}): RunnerResourceLoader {
  const policy = new PolicyEngine({ overrides: parsePermissionOverrides(options.config) });
  const bridge = new PermissionBridgeImpl({ policy });
  const centralDbPath = getCentralDbPath(options.config);
  const agentGroupId = getAgentGroupId(options.config);

  return {
    extensionFactories: [
      (runtime) => {
        runtime.on('tool_call', async (event) => {
          const toolArgs = event.input;
          const tier = bridge.getTier(event.toolName, toolArgs);

          if (tier === 'auto') {
            return undefined;
          }

          if (tier === 'prompt') {
            const result = buildPromptRequiredResult(event.toolName, toolArgs);
            options.onBlocked(result);
            return { block: true, reason: result.question };
          }

          if (centralDbPath == null || agentGroupId == null) {
            const result = buildApprovalNeededResult(
              'missing-approval-context',
              new Date(Date.now() + getApprovalTtlMs()).toISOString(),
              event.toolName,
              toolArgs,
            );
            options.onBlocked(result);
            return { block: true, reason: result.message };
          }

          const db = new Database(centralDbPath);

          try {
            const existing = findExistingApproval(db, {
              sessionId: options.sessionId,
              toolName: event.toolName,
              toolArgs,
            });

            if (existing != null && isExpired(existing.expires_at)) {
              materializeExpiredApproval(db, existing.id);
            } else if (existing?.status === 'approved') {
              if (matchesApprovalResume(options.approvalResume, event.toolName, toolArgs)) {
                return undefined;
              }

              return undefined;
            } else if (existing?.status === 'pending') {
              const result = buildApprovalNeededResult(existing.id, existing.expires_at, event.toolName, toolArgs);
              options.onBlocked(result);
              return { block: true, reason: result.message };
            }

            const created = createPendingApproval(db, {
              agentGroupId,
              sessionId: options.sessionId,
              toolName: event.toolName,
              toolArgs,
            });
            const result = buildApprovalNeededResult(created.id, created.expires_at, event.toolName, toolArgs);
            options.onBlocked(result);

            return { block: true, reason: result.message };
          } finally {
            db.close();
          }
        });
      },
    ],
  };
}

function resolveSessionId(options: RunContainerSessionOptions, effectiveConfig: SessionConfig): string {
  return options.sessionId
    ?? getConfiguredSessionId(effectiveConfig)
    ?? path.basename(path.dirname(options.inboundPath));
}

export function resolveSessionDbPaths(): { inboundPath: string; outboundPath: string } {
  const sessionDir = process.env.COVE_SESSION_DIR ?? '/app/session';

  return {
    inboundPath: process.env.INBOUND_DB_PATH ?? path.join(sessionDir, 'inbound.db'),
    outboundPath: process.env.OUTBOUND_DB_PATH ?? path.join(sessionDir, 'outbound.db'),
  };
}

export async function runContainerSession(
  options: RunContainerSessionOptions,
  onResponse?: (response: string) => void,
  deps: ContainerSessionDeps = defaultDeps,
  onToken?: (token: string) => void,
): Promise<string> {
  const inboundDb = openInboundDb(path.dirname(options.inboundPath));
  const outboundDb = openOutboundDb(path.dirname(options.outboundPath));

  try {
    const persistedConfig = readSessionConfig(inboundDb);
    const effectiveConfig = mergeSessionConfig(options.config, persistedConfig);
    const sessionId = resolveSessionId(options, effectiveConfig);
    const derivedPathSessionId = path.basename(path.dirname(options.inboundPath));

    if (sessionId !== derivedPathSessionId) {
      outboundDb.prepare('DELETE FROM processing_ack WHERE session_id != ?').run(sessionId);
    }

    const ack = readProcessingAck(outboundDb, sessionId);
    let lastProcessed = ack?.last_in_seq ?? 0;
    let lastOutSeq = ack?.last_out_seq ?? 0;
    const messages = inboundDb.prepare(
      `SELECT id, seq, role, content, metadata, created_at
       FROM messages_in
       WHERE seq > ?
       ORDER BY seq ASC`,
    ).all(lastProcessed) as InboundRow[];

    if (messages.length === 0) {
      writeProcessingAck(outboundDb, {
        session_id: sessionId,
        last_in_seq: ack?.last_in_seq ?? null,
        last_out_seq: ack?.last_out_seq ?? null,
        heartbeat_at: new Date().toISOString(),
      });
      return '';
    }

    const createSession = deps.createSession ?? defaultDeps.createSession;
    const { session } = await createSession({
      config: effectiveConfig,
      resourceLoader: { extensionFactories: [] },
    });
    let lastResponse = '';

    for (const message of messages) {
      const approvalResume = parseApprovalResumeMetadata(message.metadata);
      let blockedToolResult: BlockedToolResult | undefined;
      const resourceLoader = buildResourceLoader({
        config: effectiveConfig,
        sessionId,
        approvalResume,
        onBlocked(result) {
          blockedToolResult = result;
        },
      });

      const currentSession = (
        await createSession({
          config: effectiveConfig,
          resourceLoader,
        })
      ).session;

      const tokens: string[] = [];
      const unsubscribe = currentSession.subscribe((event) => {
        if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
          tokens.push(event.assistantMessageEvent.delta);
          onToken?.(event.assistantMessageEvent.delta);
        }
      });

      try {
        await currentSession.prompt(message.content);
      } finally {
        unsubscribe();
      }

      const response = blockedToolResultText(blockedToolResult) ?? tokens.join('');
      lastResponse = response;
      const seq = getNextOutboundSeq(lastOutSeq, message.seq);
      const outboundMetadata = approvalResume != null && blockedToolResult == null
        ? {
            resumed_tool: true,
            approval_id: approvalResume.approval_id,
            tool_name: approvalResume.tool_name,
            tool_args: approvalResume.tool_args,
          }
        : blockedToolResult;

      writeOutboundMessage(outboundDb, {
        id: crypto.randomUUID(),
        seq,
        role: 'assistant',
        content: response,
        metadata: outboundMetadata,
      });

      lastProcessed = message.seq;
      lastOutSeq = seq;

      writeProcessingAck(outboundDb, {
        session_id: sessionId,
        last_in_seq: lastProcessed,
        last_out_seq: lastOutSeq,
        heartbeat_at: new Date().toISOString(),
      });

      onResponse?.(response);
    }

    void session;

    return lastResponse;
  } finally {
    inboundDb.close();
    outboundDb.close();
  }
}

export async function runContainerSessionLoop(
  options: RunContainerSessionOptions,
  deps: ContainerSessionDeps = defaultDeps,
  loopOptions: RunContainerSessionLoopOptions = {},
): Promise<void> {
  const pollIntervalMs = loopOptions.pollIntervalMs ?? 1000;
  const pause = loopOptions.sleep ?? sleep;
  let iterations = 0;

  while (loopOptions.maxIterations === undefined || iterations < loopOptions.maxIterations) {
    await runContainerSession(options, undefined, deps);
    iterations += 1;

    if (loopOptions.maxIterations !== undefined && iterations >= loopOptions.maxIterations) {
      break;
    }

    await pause(pollIntervalMs);
  }
}

if (import.meta.main) {
  const { inboundPath, outboundPath } = resolveSessionDbPaths();

  await runContainerSessionLoop({
    inboundPath,
    outboundPath,
    config: {
      provider: process.env.PROVIDER ?? 'auto',
      model: process.env.MODEL ?? 'default',
      thinking_level: process.env.THINKING_LEVEL ?? null,
      api_key: process.env.API_KEY ?? null,
      workspace: process.env.WORKSPACE ?? null,
      extra_env: null,
      permissions: process.env.COVE_PERMISSIONS ?? null,
    },
  });
}
