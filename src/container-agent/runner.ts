import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { validateToolArguments, type AssistantMessage, type TextContent, type ToolCall as AiToolCall } from '@mariozechner/pi-ai';
import { type Agent, type AgentMessage, type AgentTool, type AgentToolResult } from '@mariozechner/pi-agent-core';

import { PermissionBridgeImpl } from '../control/permissions.ts';
import { PolicyEngine } from '../control/policy.ts';
import { assembleContext } from '../context/assembly.ts';
import { loadPersona } from '../context/persona.ts';
import { parseRuntimeMcpConfig } from '../integrations/mcp.ts';
import type { ChatMessage, SessionConfig, WorkflowActionRequestMetadata, WorkflowActionResultMetadata } from '../shared/types.ts';
import { openExistingInboundDb } from '../session/inbound.ts';
import {
  getNextOutboundSeq,
  openOutboundDb,
  readProcessingAck,
  writeOutboundMessage,
  writeProcessingAck,
} from '../session/outbound.ts';
import { createCoveTools, type ToolDefinition } from './tools.ts';
import { resolveContainerAgentModel, setupContainerAgent } from './agent-setup.ts';
import { registerNineRouterProvider, isNineRouterProvider } from '../providers/9router.ts';
import type { EmbedTexts } from '../context/external.ts';

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
type BeforeAgentStartHandler = (event: { systemPrompt?: string }) => Promise<{ systemPrompt?: string } | undefined> | { systemPrompt?: string } | undefined;
type ContextHandler = (event: {
  messages?: Array<{ role: string; content?: unknown }>;
}) => Promise<{ messages?: Array<{ role: string; content: Array<{ type: 'text'; text: string }>; timestamp: number }> } | undefined>
  | { messages?: Array<{ role: string; content: Array<{ type: 'text'; text: string }>; timestamp: number }> }
  | undefined;

type ExtensionRuntime = {
  on(event: 'tool_call', handler: ToolCallHandler): void;
  on(event: 'before_agent_start', handler: BeforeAgentStartHandler): void;
  on(event: 'context', handler: ContextHandler): void;
};

type ExtensionFactory = (runtime: ExtensionRuntime) => void;

type RunnerResourceLoader = {
  cwd?: string;
  agentDir?: string;
  additionalExtensionPaths?: string[];
  noExtensions?: boolean;
  noSkills?: boolean;
  noPromptTemplates?: boolean;
  noThemes?: boolean;
  noContextFiles?: boolean;
  extensionFactories?: ExtensionFactory[];
};

type RunnerSession = {
  subscribe(handler: (event: SessionMessageUpdate) => void): () => void;
  prompt(message: string): Promise<void>;
  getLastAssistantText?(): string | undefined;
  waitForIdle?(): Promise<void>;
};

type MaterializedRunnerResourceLoader = RunnerResourceLoader & {
  reload(): Promise<void>;
  getExtensions(): unknown;
};

type RunnerSessionResult = {
  session: RunnerSession & {
    agent?: Agent;
    model?: unknown;
    resourceLoader?: RunnerResourceLoader;
    getToolDefinition?(name: string): ToolDefinition | undefined;
    getLastAssistantText?(): string | undefined;
    messages?: AgentMessage[];
    waitForIdle?(): Promise<void>;
  };
};

export type PreparedHostSession = {
  session: RunnerSessionResult['session'];
  config: SessionConfig;
  sessionId: string;
  sessionStateDir: string;
  resourceLoader: RunnerResourceLoader;
  customTools?: ToolDefinition[];
};

type CodingAgentSdkModule = {
  AuthStorage: {
    inMemory(): {
      setRuntimeApiKey(provider: string, apiKey: string): void;
    };
  };
  ModelRegistry: {
    inMemory(authStorage: {
      setRuntimeApiKey(provider: string, apiKey: string): void;
    }): {
      find(provider: string, model: string): unknown;
      registerProvider(providerName: string, config: {
        name?: string;
        baseUrl?: string;
        apiKey?: string;
        api?: string;
        authHeader?: boolean;
        models?: Array<{
          id: string;
          name: string;
          api?: string;
          reasoning: boolean;
          input: ('text' | 'image')[];
          cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
          contextWindow: number;
          maxTokens: number;
        }>;
      }): void;
    };
  };
  SessionManager: {
    inMemory(cwd?: string): unknown;
    continueRecent(cwd?: string, sessionStateDir?: string): unknown;
  };
  createAgentSession(options: {
    model?: unknown;
    sessionManager?: unknown;
    resourceLoader?: RunnerResourceLoader;
    customTools?: ToolDefinition[];
    thinkingLevel?: string | null;
    authStorage?: unknown;
    modelRegistry?: unknown;
    cwd?: string;
  }): Promise<RunnerSessionResult>;
};

type CreateSessionOptions = {
  config: SessionConfig;
  sessionId?: string;
  sessionStateDir?: string;
  resourceLoader?: RunnerResourceLoader;
  customTools?: ToolDefinition[];
  resolveInstalledPackageDir?: (packageName: string) => string | undefined;
};

type RunnerGatewayAuthState = {
  isEnabled: boolean;
  isSupported: boolean;
  hasInheritedGatewayEnv: boolean;
};

export type ContainerSessionDeps = {
  createSession?(options: CreateSessionOptions): Promise<RunnerSessionResult>;
  createCoveTools?(db?: Database, embedTexts?: EmbedTexts, runtime?: {
    agentGroupId?: string;
    centralDbPath?: string;
    sessionId?: string;
    workflowApiBaseUrl?: string;
  }): ToolDefinition[];
  resolveInstalledPackageDir?(packageName: string): string | undefined;
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
    provider: persistedConfig.provider,
    model: persistedConfig.model,
    thinking_level: persistedConfig.thinking_level ?? runtimeConfig.thinking_level ?? null,
    api_key: persistedConfig.api_key ?? runtimeConfig.api_key ?? null,
    workspace: persistedConfig.workspace ?? runtimeConfig.workspace ?? null,
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
  return process.env.COVE_CENTRAL_DB_PATH ?? config.extra_env?.COVE_CENTRAL_DB_PATH;
}

function getAgentGroupId(config: SessionConfig): string | undefined {
  return config.extra_env?.COVE_AGENT_GROUP_ID ?? process.env.COVE_AGENT_GROUP_ID;
}

function getWorkflowApiBaseUrl(config: SessionConfig): string | undefined {
  return config.extra_env?.COVE_WORKFLOW_API_BASE_URL ?? process.env.COVE_WORKFLOW_API_BASE_URL;
}

function toText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (part != null && typeof part === 'object' && 'text' in part && typeof (part as { text: unknown }).text === 'string') {
          return (part as { text: string }).text;
        }

        return '';
      })
      .join('');
  }

  return '';
}

function resolveInstalledPackageDir(packageName: string): string | undefined {
  const candidateRoots = [
    path.join(process.cwd(), 'node_modules'),
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules'),
  ];

  for (const root of candidateRoots) {
    const candidate = path.join(root, packageName);

    try {
      if (fs.statSync(candidate).isDirectory()) {
        return fs.realpathSync(candidate);
      }
    } catch {
      // Try the next candidate root.
    }
  }

  return undefined;
}

function getInheritedGatewayEnv(): Record<string, string> {
  return {
    ONECLI_AGENT_NAME: process.env.ONECLI_AGENT_NAME ?? '',
    ONECLI_URL: process.env.ONECLI_URL ?? '',
  };
}

function isOneCliAuthEnabled(config: SessionConfig): boolean {
  const rawValue = config.extra_env?.COVE_ONECLI_AUTH ?? process.env.COVE_ONECLI_AUTH;

  if (rawValue == null) {
    return true;
  }

  const normalized = rawValue.trim().toLowerCase();
  return normalized !== '0' && normalized !== 'false' && normalized !== 'off' && normalized !== 'disabled';
}

function getGatewayAuthState(config: SessionConfig): RunnerGatewayAuthState {
  const inheritedGatewayEnv = getInheritedGatewayEnv();

  return {
    isEnabled: isOneCliAuthEnabled(config),
    isSupported: config.provider === 'anthropic' || config.provider === 'auto',
    hasInheritedGatewayEnv: inheritedGatewayEnv.ONECLI_AGENT_NAME !== '' && inheritedGatewayEnv.ONECLI_URL !== '',
  };
}

function getRunnerApiKey(config: SessionConfig): string | null {
  const apiKey = config.api_key?.trim();
  return apiKey == null || apiKey === '' ? null : apiKey;
}

function hasInheritedProviderEnvAuth(config: SessionConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  if (config.provider == null || config.model == null) {
    return false;
  }

  const resolvedModel = resolveContainerAgentModel({
    provider: config.provider,
    model: config.model,
  });

  if (resolvedModel.provider !== 'github-copilot') {
    return false;
  }

  return [env.COPILOT_GITHUB_TOKEN, env.GH_TOKEN, env.GITHUB_TOKEN].some(
    (value) => value != null && value.trim() !== '',
  );
}

function validateRunnerCredentials(config: SessionConfig): void {
  if (config.provider == null || config.model == null) {
    throw new Error('Container agent startup requires a resolved provider and model before credential validation.');
  }

  const gateway = getGatewayAuthState(config);

  if (gateway.isEnabled && gateway.isSupported && gateway.hasInheritedGatewayEnv) {
    return;
  }

  if (getRunnerApiKey(config) != null) {
    return;
  }

  if (hasInheritedProviderEnvAuth(config)) {
    return;
  }

  const resolvedModel = resolveContainerAgentModel({
    provider: config.provider,
    model: config.model,
  });
  throw new Error(`Container agent startup requires inherited OneCLI gateway auth or API_KEY for ${resolvedModel.id}.`);
}

function prepareSessionOverlayAgentDir(config: SessionConfig, sessionStateDir: string, resolvePackageDir: (packageName: string) => string | undefined): {
  agentDir: string;
  packageDir?: string;
} {
  const agentDir = path.join(sessionStateDir, '.pi-agent');
  const mcpConfigPath = path.join(agentDir, 'mcp.json');
  const rawConfig = config.extra_env?.COVE_MCP_CONFIG ?? process.env.COVE_MCP_CONFIG;
  const mcpConfig = parseRuntimeMcpConfig(rawConfig);

  fs.mkdirSync(agentDir, { recursive: true });

  if (mcpConfig == null) {
    fs.rmSync(mcpConfigPath, { force: true });
    return { agentDir };
  }

  const packageDir = resolvePackageDir('pi-mcp-adapter');

  fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), 'utf8');

  return { agentDir, packageDir };
}

function resolveDefaultLeanCtxExtensionPackageDir(resolvePackageDir: (packageName: string) => string | undefined): string | undefined {
  const packageDir = resolvePackageDir('pi-lean-ctx');

  if (packageDir == null) {
    // pi-lean-ctx is the default extension layer, so we keep an explicit runner
    // warning when it is missing; the other Pi extensions are session-specific.
    console.error('[runner] pi-lean-ctx could not be resolved; defaulting to built-in Pi tools for this session');
  }

  return packageDir;
}

function resolvePiSessionDir(sessionStateDir: string): string {
  return path.join(sessionStateDir, '.pi-agent', 'sessions');
}

function normalizePathForComparison(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function isPathWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function validateMaterializedExtensions(extensions: unknown, allowedRoots: string[]): void {
  if (!Array.isArray(extensions) || extensions.length === 0) {
    return;
  }

  const normalizedRoots = allowedRoots.map((root) => normalizePathForComparison(root));

  for (const extension of extensions) {
    const rawSourcePath = extension != null && typeof extension === 'object' && !Array.isArray(extension)
      ? (extension as { sourcePath?: unknown }).sourcePath
      : undefined;

    if (typeof rawSourcePath !== 'string' || rawSourcePath.trim() === '') {
      throw new Error('Unsupported inherited extension: unknown source. Inherited tool registration could not be classified.');
    }

    const sourcePath = normalizePathForComparison(rawSourcePath);

    if (normalizedRoots.some((root) => isPathWithinRoot(sourcePath, root))) {
      continue;
    }

    throw new Error(`Unsupported inherited extension: ${rawSourcePath}. This inherited tool registration is not supported for this redesign release.`);
  }
}

function resolveCustomTools(
  createCustomTools: Required<ContainerSessionDeps>['createCoveTools'],
  config: SessionConfig,
  sessionId: string,
): ToolDefinition[] | undefined {
  const runtime = {
    agentGroupId: getAgentGroupId(config),
    centralDbPath: getCentralDbPath(config),
    sessionId,
    workflowApiBaseUrl: getWorkflowApiBaseUrl(config),
  };

  if (!runtime.centralDbPath && !runtime.workflowApiBaseUrl && !runtime.agentGroupId) {
    return undefined;
  }

  return createCustomTools(undefined, undefined, runtime);
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

function toolResultText(result: AgentToolResult<unknown>): string {
  return Array.isArray(result.content)
    ? result.content
        .map((part) => part != null && typeof part === 'object' && 'text' in part && typeof (part as { text: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '')
        .join('')
    : '';
}

function parseWorkflowActionMetadata(metadata: unknown): WorkflowActionRequestMetadata | undefined {
  const record = parseJsonRecord(metadata);

  if (record?.type !== 'workflow_action') {
    return undefined;
  }

  if (typeof record.request_id !== 'string' || record.request_id.trim() === '') {
    throw new Error('Malformed workflow action metadata: request_id is required');
  }

  if (record.action === 'prompt') {
    if (typeof record.prompt !== 'string') {
      throw new Error('Malformed workflow action metadata: prompt is required');
    }

    return {
      type: 'workflow_action',
      request_id: record.request_id,
      action: 'prompt',
      prompt: record.prompt,
    };
  }

  if (record.action === 'tool') {
    if (typeof record.name !== 'string' || record.name.trim() === '') {
      throw new Error('Malformed workflow action metadata: tool name is required');
    }

    if (record.args == null || typeof record.args !== 'object' || Array.isArray(record.args)) {
      throw new Error('Malformed workflow action metadata: tool args must be an object');
    }

    return {
      type: 'workflow_action',
      request_id: record.request_id,
      action: 'tool',
      name: record.name,
      args: record.args as Record<string, unknown>,
    };
  }

  if (record.action === 'llm') {
    if (!Array.isArray(record.messages) || !record.messages.every((message) => {
      if (message == null || typeof message !== 'object' || Array.isArray(message)) {
        return false;
      }

      const candidate = message as { role?: unknown; content?: unknown };
      return typeof candidate.role === 'string'
        && 'content' in candidate
        && (typeof candidate.content === 'string' || Array.isArray(candidate.content));
    })) {
      throw new Error('Malformed workflow action metadata: llm messages must be an array of message objects');
    }

    return {
      type: 'workflow_action',
      request_id: record.request_id,
      action: 'llm',
      messages: record.messages as AgentMessage[],
    };
  }

  if (record.action === 'skill') {
    if (typeof record.name !== 'string' || record.name.trim() === '') {
      throw new Error('Malformed workflow action metadata: skill name is required');
    }

    if (typeof record.input !== 'string') {
      throw new Error('Malformed workflow action metadata: skill input is required');
    }

    return {
      type: 'workflow_action',
      request_id: record.request_id,
      action: 'skill',
      name: record.name,
      input: record.input,
    };
  }

  throw new Error('Malformed workflow action metadata: unsupported action');
}

function blockedWorkflowActionError(action: 'prompt' | 'llm' | 'skill', skillName?: string): Error {
  if (action === 'skill' && skillName != null) {
    return new Error(`Workflow skill action was blocked: ${skillName}`);
  }

  if (action === 'llm') {
    return new Error('Workflow LLM action was blocked');
  }

  return new Error(`Workflow ${action} action was blocked`);
}

function normalizeWorkflowActionResult(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

async function executeWorkflowAction(prepared: PreparedHostSession, request: WorkflowActionRequestMetadata, blockedToolResult: () => BlockedToolResult | undefined): Promise<{
  content: string;
  metadata: WorkflowActionResultMetadata;
}> {
  try {
    if (request.action === 'prompt') {
      const result = await executeHostSessionPrompt(prepared, request.prompt);

      if (blockedToolResult() != null) {
        throw blockedWorkflowActionError('prompt');
      }

      return {
        content: result,
        metadata: {
          type: 'workflow_action_result',
          request_id: request.request_id,
          action: 'prompt',
          status: 'completed',
          result,
        },
      };
    }

    if (request.action === 'skill') {
      const command = request.input === '' ? `/skill:${request.name}` : `/skill:${request.name} ${request.input}`;
      const result = await executeHostSessionPrompt(prepared, command);

      if (blockedToolResult() != null) {
        throw blockedWorkflowActionError('skill', request.name);
      }

      return {
        content: result,
        metadata: {
          type: 'workflow_action_result',
          request_id: request.request_id,
          action: 'skill',
          status: 'completed',
          result,
        },
      };
    }

    if (request.action === 'llm') {
      const result = await executeHostLlmPrompt(prepared, request.messages).catch((error) => {
        if (blockedToolResult() != null) {
          throw blockedWorkflowActionError('llm');
        }

        throw error;
      });

      if (blockedToolResult() != null) {
        throw blockedWorkflowActionError('llm');
      }

      return {
        content: toText(result.content),
        metadata: {
          type: 'workflow_action_result',
          request_id: request.request_id,
          action: 'llm',
          status: 'completed',
          result,
        },
      };
    }

    const result = await executeHostToolCall(prepared, request.name, request.args);
    const blocked = blockedToolResult();
    const content = blockedToolResultText(blocked) ?? toolResultText(result);

    if (blocked != null) {
      return {
        content,
        metadata: {
          type: 'workflow_action_result',
          request_id: request.request_id,
          action: 'tool',
          status: 'blocked',
          result: blocked,
        },
      };
    }

    return {
      content,
      metadata: {
        type: 'workflow_action_result',
        request_id: request.request_id,
        action: 'tool',
        status: 'completed',
        result: normalizeWorkflowActionResult(content),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      content: message,
      metadata: {
        type: 'workflow_action_result',
        request_id: request.request_id,
        action: request.action,
        status: 'error',
        error: { message },
      },
    };
  }
}

function resolveSessionResponseText(session: RunnerSessionResult['session'], tokens: string[]): string {
  const streamedText = tokens.join('');

  if (streamedText !== '') {
    return streamedText;
  }

  if (typeof session.getLastAssistantText === 'function') {
    return session.getLastAssistantText() ?? '';
  }

  return '';
}

function createAssistantToolCall(toolName: string, args: Record<string, unknown>): AssistantMessage {
  return {
    role: 'assistant',
    content: [{
      type: 'toolCall',
      id: crypto.randomUUID(),
      name: toolName,
      arguments: args,
    }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'workflow-host',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: 'toolUse',
    timestamp: Date.now(),
  };
}

function createTextContent(text: string): TextContent {
  return {
    type: 'text',
    text,
  };
}

function createErrorToolResult(message: string): AgentToolResult<unknown> {
  return {
    content: [createTextContent(message)],
    details: {},
  };
}

function resolveRunnerPersona(config: SessionConfig): string | undefined {
  if (config.extra_env?.COVE_PERSONA?.trim()) {
    return config.extra_env.COVE_PERSONA;
  }

  const agentGroupId = getAgentGroupId(config);
  const centralDbPath = getCentralDbPath(config);

  if (agentGroupId == null || centralDbPath == null) {
    return undefined;
  }

  return loadPersona(agentGroupId, {
    personaText: config.extra_env?.COVE_PERSONA,
    dbPath: centralDbPath,
    allowFilesystemFallback: false,
  }) ?? undefined;
}

function isMaterializedResourceLoader(value: unknown): value is {
  getExtensions(): unknown;
  reload(): Promise<void>;
} {
  return value != null
    && typeof value === 'object'
    && typeof (value as { getExtensions?: unknown }).getExtensions === 'function'
    && typeof (value as { reload?: unknown }).reload === 'function';
}

async function materializeResourceLoader(
  options: RunnerResourceLoader,
  resolvePackageDir: (packageName: string) => string | undefined = resolveInstalledPackageDir,
): Promise<RunnerResourceLoader> {
  const packageDir = resolvePackageDir('@mariozechner/pi-coding-agent');

  if (packageDir == null) {
    throw new Error('Could not locate @mariozechner/pi-coding-agent installation');
  }

  const configModule = await import(pathToFileURL(path.join(packageDir, 'dist', 'config.js')).href) as {
    getAgentDir(): string;
  };
  const module = await import(pathToFileURL(path.join(packageDir, 'dist', 'core', 'resource-loader.js')).href) as unknown as {
    DefaultResourceLoader: new (loaderOptions: RunnerResourceLoader) => MaterializedRunnerResourceLoader;
  };
  const loader = new module.DefaultResourceLoader({
    ...options,
    agentDir: options.agentDir ?? configModule.getAgentDir(),
  });
  await loader.reload();
  validateMaterializedExtensions(loader.getExtensions(), [
    options.agentDir ?? configModule.getAgentDir(),
    packageDir,
    ...(options.additionalExtensionPaths ?? []),
  ]);
  return loader;
}

function requireAgentSession(session: RunnerSessionResult['session']): RunnerSessionResult['session'] & {
  agent: Agent;
  getToolDefinition(name: string): ToolDefinition | undefined;
} {
  if (session.agent == null || typeof session.getToolDefinition !== 'function') {
    throw new Error('Host session does not expose direct tool execution hooks');
  }

  return session as RunnerSessionResult['session'] & {
    agent: Agent;
    getToolDefinition(name: string): ToolDefinition | undefined;
  };
}

export async function prepareHostSession(options: {
  config: SessionConfig;
  sessionId: string;
  sessionStateDir: string;
  deps?: ContainerSessionDeps;
  approvalResume?: ApprovalResumeMetadata;
  noSkills?: boolean;
}): Promise<PreparedHostSession> {
  const deps = options.deps ?? defaultDeps;
  const createSession = deps.createSession ?? defaultDeps.createSession;
  const createCustomTools = deps.createCoveTools ?? defaultDeps.createCoveTools;
  const resolvePackageDir = (packageName: string): string | undefined => {
    return deps.resolveInstalledPackageDir?.(packageName)
      ?? defaultDeps.resolveInstalledPackageDir(packageName);
  };
  let blockedToolResult: BlockedToolResult | undefined;
  const resourceLoader = buildResourceLoader({
    config: options.config,
    sessionId: options.sessionId,
    sessionStateDir: options.sessionStateDir,
    approvalResume: options.approvalResume,
    onBlocked(result) {
      blockedToolResult = result;
    },
    resolveInstalledPackageDir: resolvePackageDir,
  });

  if (options.noSkills !== undefined) {
    resourceLoader.noSkills = options.noSkills;
  }

  const customTools = resolveCustomTools(createCustomTools, options.config, options.sessionId);
  const sessionResult = await createSession({
    config: options.config,
    sessionId: options.sessionId,
    sessionStateDir: options.sessionStateDir,
    resourceLoader,
    customTools,
    resolveInstalledPackageDir: resolvePackageDir,
  });

  if (blockedToolResult != null) {
    throw new Error(blockedToolResultText(blockedToolResult) ?? 'Tool execution was blocked');
  }

  return {
    session: sessionResult.session,
    config: options.config,
    sessionId: options.sessionId,
    sessionStateDir: options.sessionStateDir,
    resourceLoader,
    customTools,
  };
}

export async function executeHostToolCall(prepared: PreparedHostSession, toolName: string, args: Record<string, unknown>): Promise<AgentToolResult<unknown>> {
  const session = requireAgentSession(prepared.session);
  const agent = session.agent;
  const assistantMessage = createAssistantToolCall(toolName, args);
  const toolDefinition = session.getToolDefinition(toolName);
  const toolCall = assistantMessage.content[0] as AiToolCall;

  if (toolDefinition == null) {
    throw new Error(`Tool ${toolName} not found`);
  }

  const tool = agent.state.tools.find((candidate) => candidate.name === toolName);
  if (tool == null) {
    throw new Error(`Tool ${toolName} is not active`);
  }

  const validatedArgs = validateToolArguments(toolDefinition, toolCall);
  const context = {
    systemPrompt: agent.state.systemPrompt,
    messages: [...agent.state.messages.slice(), assistantMessage],
    tools: agent.state.tools.slice(),
  };

  const beforeResult = await agent.beforeToolCall?.({
    assistantMessage,
    toolCall,
    args: validatedArgs,
    context,
  });
  if (beforeResult?.block) {
    return createErrorToolResult(beforeResult.reason ?? 'Tool execution was blocked');
  }

  let result: AgentToolResult<unknown>;
  let isError = false;
  let executionError: Error | undefined;

  try {
    result = await (tool as AgentTool).execute(toolCall.id, validatedArgs, undefined, undefined);
  } catch (error) {
    executionError = error instanceof Error ? error : new Error(String(error));
    result = createErrorToolResult(executionError.message);
    isError = true;
  }

  const afterResult = await agent.afterToolCall?.({
    assistantMessage,
    toolCall,
    args: validatedArgs,
    result,
    isError,
    context,
  });
  const finalResult = afterResult == null
    ? result
    : {
      content: afterResult.content ?? result.content,
      details: afterResult.details ?? result.details,
      terminate: afterResult.terminate ?? result.terminate,
    };

  if (executionError != null) {
    throw new Error(toolResultText(finalResult) || executionError.message);
  }

  return finalResult;
}

export async function executeHostLlmPrompt(prepared: PreparedHostSession, messages: AgentMessage[]): Promise<AssistantMessage> {
  const session = requireAgentSession(prepared.session);
  const agent = session.agent;
  const persona = resolveRunnerPersona(prepared.config);
  const baselineMessages = 'messages' in session && Array.isArray(session.messages)
    ? session.messages.length
    : agent.state.messages.length;
  const previousSystemPrompt = agent.state.systemPrompt;

  if (persona != null) {
    agent.state.systemPrompt = `${previousSystemPrompt}\n\n${persona}`.trim();
  }

  try {
    await agent.prompt(messages);
    await agent.waitForIdle();
  } finally {
    agent.state.systemPrompt = previousSystemPrompt;
  }

  const messageLog = 'messages' in session && Array.isArray(session.messages)
    ? session.messages
    : agent.state.messages;
  const assistant = messageLog
    .slice(baselineMessages)
    .findLast((message): message is AssistantMessage => message.role === 'assistant')
    ?? messageLog.findLast((message): message is AssistantMessage => message.role === 'assistant');
  if (assistant == null) {
    throw new Error('Host LLM prompt did not produce an assistant response');
  }

  return assistant;
}

export async function executeHostSessionPrompt(prepared: PreparedHostSession, prompt: string): Promise<string> {
  await prepared.session.prompt(prompt);

  if (typeof prepared.session.waitForIdle === 'function') {
    await prepared.session.waitForIdle();
  }

  if (typeof prepared.session.getLastAssistantText === 'function') {
    const text = prepared.session.getLastAssistantText();

    if (typeof text === 'string') {
      return text;
    }
  }

  throw new Error('Host session prompt did not produce assistant text');
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
  approvalId: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
): boolean {
  if (approvalResume == null) {
    return false;
  }

  return approvalResume.approval_id === approvalId
    && approvalResume.tool_name === toolName
    && JSON.stringify(approvalResume.tool_args) === JSON.stringify(toolArgs);
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

async function loadCodingAgentSdk(): Promise<CodingAgentSdkModule> {
  return await import('@mariozechner/pi-coding-agent') as CodingAgentSdkModule;
}

async function createDefaultSession(options: CreateSessionOptions): Promise<RunnerSessionResult> {
  const sdk = await loadCodingAgentSdk();
  let setupAuthStorage: ReturnType<typeof sdk.AuthStorage.inMemory> | undefined;
  let setupModelRegistry: ReturnType<typeof sdk.ModelRegistry.inMemory> | undefined;
  const gatewayAuth = getGatewayAuthState(options.config);

  validateRunnerCredentials(options.config);

  if (options.config.provider == null || options.config.model == null) {
    throw new Error('Container agent startup requires a resolved provider and model.');
  }

  const setup = await setupContainerAgent({
    provider: options.config.provider,
    model: options.config.model,
    apiKey: gatewayAuth.isEnabled && gatewayAuth.isSupported && gatewayAuth.hasInheritedGatewayEnv
      ? null
      : getRunnerApiKey(options.config),
    sessionId: options.sessionId ?? getConfiguredSessionId(options.config),
    sessionStateDir: options.sessionStateDir,
  }, {
    async createInMemoryAuth(input) {
      const authStorage = sdk.AuthStorage.inMemory();
      setupAuthStorage = authStorage;

      if (input.apiKey != null) {
        authStorage.setRuntimeApiKey(input.provider, input.apiKey);
      }

      return authStorage;
    },
    async createModel(input) {
      const authStorage = setupAuthStorage;

      if (authStorage == null) {
        throw new Error('Container agent auth storage was not initialized before model resolution.');
      }

      const modelRegistry = sdk.ModelRegistry.inMemory(authStorage);
      setupModelRegistry = modelRegistry;

      if (isNineRouterProvider(input.provider)) {
        const apiKey = getRunnerApiKey(options.config) ?? 'dummy-key-for-header';
        registerNineRouterProvider(modelRegistry, apiKey);
      }

      return modelRegistry.find(input.provider, input.model);
    },
    async createSessionManager(input) {
      const cwd = options.config.workspace ?? process.cwd();
      return input.mode === 'continueRecent'
        ? sdk.SessionManager.continueRecent(cwd, input.sessionStateDir == null ? undefined : resolvePiSessionDir(input.sessionStateDir))
        : sdk.SessionManager.inMemory(cwd);
    },
    async createSession(input) {
      const modelRegistry = setupModelRegistry ?? sdk.ModelRegistry.inMemory(input.auth as {
        setRuntimeApiKey(provider: string, apiKey: string): void;
      });

      if (input.model == null) {
        throw new Error('No model resolved for container agent session.');
      }

      const resourceLoader = options.resourceLoader == null || isMaterializedResourceLoader(options.resourceLoader)
        ? options.resourceLoader
        : await materializeResourceLoader(options.resourceLoader, options.resolveInstalledPackageDir ?? resolveInstalledPackageDir);

      return sdk.createAgentSession({
        authStorage: input.auth,
        modelRegistry,
        model: input.model,
        sessionManager: input.sessionManager,
        resourceLoader,
        customTools: options.customTools,
        thinkingLevel: options.config.thinking_level,
        cwd: options.config.workspace ?? process.cwd(),
      });
    },
  });

  return setup.session as RunnerSessionResult;
}

const defaultDeps: Required<ContainerSessionDeps> = {
  createSession: createDefaultSession,
  createCoveTools,
  resolveInstalledPackageDir,
};

function buildResourceLoader(options: {
  config: SessionConfig;
  sessionId: string;
  sessionStateDir: string;
  approvalResume?: ApprovalResumeMetadata;
  onBlocked(result: BlockedToolResult): void;
  resolveInstalledPackageDir: (packageName: string) => string | undefined;
}): RunnerResourceLoader {
  const policy = new PolicyEngine({ overrides: parsePermissionOverrides(options.config) });
  const bridge = new PermissionBridgeImpl({ policy });
  const centralDbPath = getCentralDbPath(options.config);
  const agentGroupId = getAgentGroupId(options.config);
  const sessionOverlayAgentDir = prepareSessionOverlayAgentDir(options.config, options.sessionStateDir, options.resolveInstalledPackageDir);
  const subagentPackageDir = agentGroupId == null ? undefined : options.resolveInstalledPackageDir('pi-subagents');
  const leanCtxExtensionPackageDir = resolveDefaultLeanCtxExtensionPackageDir(options.resolveInstalledPackageDir);
  const gatewayAuth = getGatewayAuthState(options.config);
  const oneCliExtensionPackageDir = gatewayAuth.isEnabled && gatewayAuth.isSupported && gatewayAuth.hasInheritedGatewayEnv
    ? options.resolveInstalledPackageDir('pi-onecli-extension')
    : undefined;
  const coveExtensionPackageDir = options.resolveInstalledPackageDir('@mhingston5/pi-cove-extension');
  const additionalExtensionPaths = [subagentPackageDir, leanCtxExtensionPackageDir, sessionOverlayAgentDir.packageDir, oneCliExtensionPackageDir, coveExtensionPackageDir]
    .filter((value): value is string => value != null);
  const persona = agentGroupId == null || centralDbPath == null
    ? undefined
    : loadPersona(agentGroupId, {
        dbPath: centralDbPath,
        allowFilesystemFallback: false,
      }) ?? undefined;

  return {
    cwd: options.config.workspace ?? process.cwd(),
    agentDir: sessionOverlayAgentDir.agentDir,
    additionalExtensionPaths,
    extensionFactories: [
      (runtime) => {
        runtime.on('before_agent_start', async (event) => {
          if (persona == null) {
            return undefined;
          }

          return {
            systemPrompt: `${event.systemPrompt ?? ''}\n\n${persona}`.trim(),
          };
        });

        runtime.on('context', async (event) => {
          if (agentGroupId == null || centralDbPath == null) {
            return undefined;
          }

          const centralDb = new Database(centralDbPath);

          try {
            const normalizedMessages: ChatMessage[] = (event.messages ?? []).map((message) => ({
              role: message.role,
              content: toText(message.content),
            })) as ChatMessage[];
            const assembled = await assembleContext({
              agentGroupId,
              sessionId: options.sessionId,
              messages: normalizedMessages,
              db: centralDb,
              sessionDir: options.sessionStateDir,
              persona,
            });
            const withoutPersona = persona == null ? assembled : assembled.slice(1);

            return {
              messages: withoutPersona.map((message) => ({
                role: message.role,
                content: [{ type: 'text', text: message.content }],
                timestamp: Date.now(),
              })),
            };
          } finally {
            centralDb.close();
          }
        });

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
              if (matchesApprovalResume(options.approvalResume, existing.id, event.toolName, toolArgs)) {
                return undefined;
              }
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

function openRunnerOutboundDb(sessionDir: string): Database {
  try {
    return openOutboundDb(sessionDir);
  } catch (error) {
    const dbPath = path.join(sessionDir, 'outbound.db');
    const sessionDirExists = fs.existsSync(sessionDir);
    const outboundPathExists = fs.existsSync(dbPath);
    const sessionDirEntries = sessionDirExists
      ? fs.readdirSync(sessionDir).sort().join(',')
      : '<missing>';
    const details = `Failed to open outbound DB at ${dbPath} (sessionDirExists=${sessionDirExists}, outboundPathExists=${outboundPathExists}, sessionDirEntries=${sessionDirEntries})`;

    if (error instanceof Error) {
      error.message = `${error.message}. ${details}`;
    }

    throw error;
  }
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
  const inboundDb = openExistingInboundDb(path.dirname(options.inboundPath));
  const outboundSessionDir = path.dirname(options.outboundPath);
  const initialOutboundDb = openRunnerOutboundDb(outboundSessionDir);
  const sessionStateDir = path.dirname(options.inboundPath);

  try {
    const persistedConfig = readSessionConfig(inboundDb);
    const effectiveConfig = mergeSessionConfig(options.config, persistedConfig);
    const sessionId = resolveSessionId(options, effectiveConfig);

    const ack = readProcessingAck(initialOutboundDb, sessionId);
    let lastProcessed = ack?.last_in_seq ?? 0;
    let lastOutSeq = ack?.last_out_seq ?? 0;
    const messages = inboundDb.prepare(
      `SELECT id, seq, role, content, metadata, created_at
       FROM messages_in
       WHERE seq > ?
       ORDER BY seq ASC`,
    ).all(lastProcessed) as InboundRow[];

    initialOutboundDb.close();

    if (messages.length === 0) {
      const outboundDb = openRunnerOutboundDb(outboundSessionDir);

      try {
        writeProcessingAck(outboundDb, {
          session_id: sessionId,
          last_in_seq: ack?.last_in_seq ?? null,
          last_out_seq: ack?.last_out_seq ?? null,
          heartbeat_at: new Date().toISOString(),
        });
      } finally {
        outboundDb.close();
      }

      return '';
    }

    const createSession = deps.createSession ?? defaultDeps.createSession;
    const createCustomTools = deps.createCoveTools ?? defaultDeps.createCoveTools;
    const resolvePackageDir = (packageName: string): string | undefined => {
      return deps.resolveInstalledPackageDir?.(packageName)
        ?? defaultDeps.resolveInstalledPackageDir(packageName);
    };
    let lastResponse = '';

    for (const message of messages) {
      const workflowAction = parseWorkflowActionMetadata(message.metadata);
      const persistedConfigForMessage = readSessionConfig(inboundDb);
      const effectiveConfigForMessage = mergeSessionConfig(options.config, persistedConfigForMessage);
      const customTools = resolveCustomTools(createCustomTools, effectiveConfigForMessage, sessionId);
      const approvalResume = workflowAction == null ? parseApprovalResumeMetadata(message.metadata) : undefined;
      let blockedToolResult: BlockedToolResult | undefined;
      const resourceLoader = buildResourceLoader({
        config: effectiveConfigForMessage,
        sessionId,
        sessionStateDir,
        approvalResume,
        onBlocked(result) {
          blockedToolResult = result;
        },
        resolveInstalledPackageDir: resolvePackageDir,
      });

      const currentSession = (
        await createSession({
          config: effectiveConfigForMessage,
          sessionId,
          sessionStateDir,
          resourceLoader,
          customTools,
          resolveInstalledPackageDir: resolvePackageDir,
        })
      ).session;

      const tokens: string[] = [];
      const unsubscribe = workflowAction == null
        ? currentSession.subscribe((event) => {
            if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
              tokens.push(event.assistantMessageEvent.delta);
              onToken?.(event.assistantMessageEvent.delta);
            }
          })
        : () => {};
      const promptStartedAt = Date.now();
      let response = '';
      let outboundMetadata: Record<string, unknown> | undefined;

      console.error(`[runner] prompt-start session=${sessionId} seq=${message.seq}`);

      try {
        if (workflowAction == null) {
          await currentSession.prompt(message.content);
        } else {
          const workflowResult = await executeWorkflowAction({
            session: currentSession,
            config: effectiveConfigForMessage,
            sessionId,
            sessionStateDir,
            resourceLoader,
            customTools,
          }, workflowAction, () => blockedToolResult);
          response = workflowResult.content;
          outboundMetadata = workflowResult.metadata;
        }
      } finally {
        unsubscribe();
      }

      console.error(`[runner] prompt-end session=${sessionId} seq=${message.seq} elapsedMs=${Date.now() - promptStartedAt} tokenChars=${tokens.join('').length}`);

      if (workflowAction == null) {
        response = blockedToolResultText(blockedToolResult) ?? resolveSessionResponseText(currentSession, tokens);
        outboundMetadata = approvalResume != null && blockedToolResult == null
          ? {
              resumed_tool: true,
              approval_id: approvalResume.approval_id,
              tool_name: approvalResume.tool_name,
              tool_args: approvalResume.tool_args,
            }
          : blockedToolResult;
      }

      lastResponse = response;
      const seq = getNextOutboundSeq(lastOutSeq, message.seq);

      const outboundDb = openRunnerOutboundDb(outboundSessionDir);

      try {
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

        console.error(`[runner] outbound-write session=${sessionId} seq=${seq}`);
      } finally {
        outboundDb.close();
      }

      onResponse?.(response);
    }

    return lastResponse;
  } finally {
    inboundDb.close();
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
