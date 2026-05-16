import type { Database } from 'bun:sqlite';

import { appendWorkingMessage, buildWorkingContext, ensureWorkingSession } from '../../context/working.ts';
import { DeliveryTimeoutError, pollForResponse } from '../../delivery.ts';
import { routeRequest } from '../../router.ts';
import { buildAgentGroupSessionConfig } from '../../session-config.ts';
import { streamDirectSessionTokens } from '../../session/direct-stream.ts';
import { openInboundDb, writeInboundMessage } from '../../session/inbound.ts';
import { openExistingOutboundDb } from '../../session/outbound.ts';
import type { AppContext, ChatMessage, ChatRoutingBody, SessionConfig } from '../../shared/types.ts';

type ChatRequestBody = ChatRoutingBody & {
  messages?: unknown;
  stream?: boolean;
  provider_model?: string;
};

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

function isChatMessageArray(value: unknown): value is ChatMessage[] {
  return Array.isArray(value) && value.length > 0;
}

function parseRequestBody(request: Request): Promise<ChatRequestBody> {
  return request.json() as Promise<ChatRequestBody>;
}

function normalizeText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized === '' ? null : normalized;
}

function getExplicitModelOverride(body: ChatRequestBody): string | null {
  return normalizeText(body.provider_model) ?? normalizeText(body.model);
}

function getProviderFromQualifiedModel(model: string | null): string | null {
  if (model == null) {
    return null;
  }

  const separatorIndex = model.indexOf('/');

  if (separatorIndex <= 0 || separatorIndex === model.length - 1) {
    return null;
  }

  return model.slice(0, separatorIndex);
}

function getCanonicalResolvedModel(config: SessionConfig): string {
  const model = normalizeText(config.model);

  if (model == null) {
    return '';
  }

  if (getProviderFromQualifiedModel(model) != null) {
    return model;
  }

  const provider = normalizeText(config.provider);
  return provider == null || provider === 'auto' ? model : `${provider}/${model}`;
}

function writeSessionConfig(db: Database, config: SessionConfig): void {
  const extraEnv = config.extra_env == null ? null : JSON.stringify(config.extra_env);

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
    extraEnv,
    config.permissions ?? null,
  );
}

function appendNewExecutableTurns(db: Database, messages: ChatMessage[]): void {
  const executableMessages = messages.filter((message) => message.role === 'user');
  const existingRows = db.prepare('SELECT role, content FROM messages_in ORDER BY seq ASC').all() as Array<{
    role: string;
    content: string;
  }>;
  let replayPrefixLength = 0;

  while (replayPrefixLength < existingRows.length && replayPrefixLength < executableMessages.length) {
    const existing = existingRows[replayPrefixLength];
    const incoming = executableMessages[replayPrefixLength];

    if (existing?.role !== incoming?.role || existing?.content !== incoming?.content) {
      break;
    }

    replayPrefixLength += 1;
  }

  for (const message of executableMessages.slice(replayPrefixLength)) {
    writeInboundMessage(db, {
      id: crypto.randomUUID(),
      role: message.role,
      content: message.content,
    });
  }
}

function materializeTranscriptContext(sessionDir: string, sessionId: string, messages: ChatMessage[]): void {
  ensureWorkingSession(sessionDir, sessionId);
  const existingMessages = buildWorkingContext(sessionDir);
  let replayPrefixLength = 0;

  while (replayPrefixLength < existingMessages.length && replayPrefixLength < messages.length) {
    const existing = existingMessages[replayPrefixLength];
    const incoming = messages[replayPrefixLength];

    if (existing?.role !== incoming?.role || existing?.content !== incoming?.content) {
      break;
    }

    replayPrefixLength += 1;
  }

  for (const message of messages.slice(replayPrefixLength)) {
    appendWorkingMessage(sessionDir, sessionId, message.role, message.content);
  }
}

function buildSessionConfig(routed: ReturnType<typeof routeRequest>, requestBody: ChatRequestBody): SessionConfig {
  const base = buildAgentGroupSessionConfig(routed.agentGroup);
  const explicitModelOverride = getExplicitModelOverride(requestBody);
  const explicitProvider = getProviderFromQualifiedModel(explicitModelOverride);
  const centralDbPath = typeof process.env.COVE_STATE_DIR === 'string' && process.env.COVE_STATE_DIR.trim() !== ''
    ? `${process.env.COVE_STATE_DIR}/cove.db`
    : null;
  const extraEnv = {
    ...(base.extra_env ?? {}),
    COVE_SESSION_ID: routed.session.id,
    COVE_AGENT_GROUP_ID: routed.agentGroup.id,
    ...(centralDbPath == null ? {} : { COVE_CENTRAL_DB_PATH: centralDbPath }),
  };

  return {
    ...base,
    provider: explicitProvider ?? base.provider,
    model: explicitModelOverride ?? base.model,
    extra_env: Object.keys(extraEnv).length > 0 ? extraEnv : null,
  };
}

function sseEvent(data: string): string {
  return `data: ${data}\n\n`;
}

async function* buildStreamingSource(
  streamTokens: (options: {
    routed: ReturnType<typeof routeRequest>;
    config: SessionConfig;
    messages: ChatMessage[];
  }) => AsyncGenerator<string, void, undefined>,
  options: {
    routed: ReturnType<typeof routeRequest>;
    config: SessionConfig;
    messages: ChatMessage[];
  },
): AsyncGenerator<string, void, undefined> {
  for await (const token of streamTokens(options)) {
    yield sseEvent(JSON.stringify({
      choices: [{ delta: { content: token }, index: 0 }],
    }));
  }

  yield sseEvent('[DONE]');
}

function createStreamingResponse(streamSource: AsyncGenerator<string, void, undefined>): Response {
  const body = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of streamSource) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

function buildOpenAiResponse(options: {
  sessionId: string;
  model: string;
  messages: Array<{ role: string; content: string; finish_reason: string | null; metadata: string | null }>;
}): Response {
  return Response.json({
    id: `chatcmpl-${options.sessionId}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: options.model,
    choices: options.messages.length > 0
      ? options.messages.map((message, index) => ({
          index,
          message: {
            role: message.role,
            content: message.content,
            ...(message.metadata == null ? {} : { metadata: JSON.parse(message.metadata) as unknown }),
          },
          finish_reason: message.finish_reason ?? 'stop',
        }))
      : [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '',
            },
            finish_reason: 'stop',
          },
        ],
  });
}

export async function handleChatCompletion(request: Request, context: AppContext): Promise<Response> {
  let body: ChatRequestBody;

  try {
    body = await parseRequestBody(request);
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  if (!isChatMessageArray(body.messages)) {
    return jsonError('messages is required and must be a non-empty array', 400);
  }

  const routeRequestImpl = context.chat?.routeRequest ?? routeRequest;
  const pollForResponseImpl = context.chat?.pollForResponse ?? pollForResponse;
  const ensureSessionRuntime = context.chat?.ensureSessionRuntime;
  const streamTokens = context.chat?.streamTokens ?? (async function* (options: {
    routed: ReturnType<typeof routeRequest>;
    config: SessionConfig;
    messages: ChatMessage[];
  }) {
    yield* streamDirectSessionTokens({
      centralDb: context.db,
      routing: options.routed,
      config: options.config,
      messages: options.messages,
    });
  });

  let routed;

  try {
    routed = routeRequestImpl({
      db: context.db,
      request,
      body,
    });
  } catch (error) {
    if (error instanceof Error && /Agent group .* not found/.test(error.message)) {
      const missingAgentGroupId = body.agent_group_id?.trim() || request.headers.get('X-Agent-Group-Id')?.trim() || 'default';
      return jsonError(`Agent group not found: ${missingAgentGroupId}`, 404);
    }

    throw error;
  }

  let sessionConfig: SessionConfig;

  try {
    sessionConfig = buildSessionConfig(routed, body);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid agent group config:')) {
      return jsonError(error.message, 400);
    }

    throw error;
  }

  if (ensureSessionRuntime != null) {
    const ready = await ensureSessionRuntime({ routed, config: sessionConfig });

    if (!ready) {
      return jsonError('Container runtime unavailable', 503);
    }
  }

  if (body.stream === true) {
    return createStreamingResponse(buildStreamingSource(streamTokens, {
      routed,
      config: sessionConfig,
      messages: body.messages,
    }));
  }

  const sessionDir = routed.session.session_file;

  if (sessionDir == null) {
    return jsonError('Session runtime is unavailable', 503);
  }

  const outboundBaselineDb = openExistingOutboundDb(sessionDir);
  let baselineSeq = 0;

  try {
    const baselineRow = outboundBaselineDb.prepare('SELECT MAX(seq) AS seq FROM messages_out').get() as {
      seq: number | null;
    };
    baselineSeq = baselineRow.seq ?? 0;
  } finally {
    outboundBaselineDb.close();
  }

  const inboundDb = openInboundDb(sessionDir);

  try {
    writeSessionConfig(inboundDb, sessionConfig);
    materializeTranscriptContext(sessionDir, routed.session.id, body.messages);
    appendNewExecutableTurns(inboundDb, body.messages);
  } finally {
    inboundDb.close();
  }

  try {
    const messages = await pollForResponseImpl({
      openDb: () => openExistingOutboundDb(sessionDir),
      sessionId: routed.session.id,
      baselineOutSeq: baselineSeq,
    });

    return buildOpenAiResponse({
      sessionId: routed.session.id,
      model: getCanonicalResolvedModel(sessionConfig),
      messages,
    });
  } catch (error) {
    if (error instanceof DeliveryTimeoutError) {
      return jsonError('Delivery verification timed out before response integrity was confirmed', 504);
    }

    throw error;
  }
}
