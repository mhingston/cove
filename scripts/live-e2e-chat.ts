import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startApiServer as startRuntimeApiServer } from '../src/api/server.ts';
import { getContainerRuntimeBin, isContainerRuntimeAvailable } from '../src/container/detect.ts';
import { ensureImageExists, getImageName } from '../src/container/image.ts';
import { getActiveContainers } from '../src/container/spawn.ts';
import { migrate } from '../src/db/migrate.ts';
import { boot, type BootRuntime } from '../src/index.ts';
import type { ApiServer } from '../src/shared/types.ts';

const LIVE_AGENT_GROUP_ID = 'live-agent';
const LIVE_THREAD_ID = 'live-chat-e2e';
const WARM_READY_TIMEOUT_MS = 30_000;
const WARM_READY_POLL_MS = 250;

type DisabledLiveE2eConfig = {
  enabled: false;
  reason: string;
};

type EnabledLiveE2eConfig = {
  enabled: true;
  provider: string;
  model: string;
};

type LiveE2eConfig = DisabledLiveE2eConfig | EnabledLiveE2eConfig;

type SessionRow = {
  id: string;
  session_file: string | null;
};

type OpenAiChatChoice = {
  index?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
    metadata?: unknown;
  };
  finish_reason?: unknown;
};

type OpenAiChatResponse = {
  id?: unknown;
  object?: unknown;
  created?: unknown;
  model?: unknown;
  choices?: unknown;
};

function readTrimmedEnv(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function resolveLiveE2eConfig(env: NodeJS.ProcessEnv = process.env): LiveE2eConfig {
  if (readTrimmedEnv(env.COVE_LIVE_E2E) !== '1') {
    return {
      enabled: false,
      reason: 'Set COVE_LIVE_E2E=1 to run the live chat E2E harness.',
    };
  }

  const provider = readTrimmedEnv(env.COVE_LIVE_PROVIDER) ?? 'auto';
  const model = readTrimmedEnv(env.COVE_LIVE_MODEL);

  if (model == null) {
    throw new Error('COVE_LIVE_MODEL is required when COVE_LIVE_E2E=1');
  }

  const separatorIndex = model.indexOf('/');
  const qualifiedProvider = separatorIndex <= 0 || separatorIndex === model.length - 1
    ? null
    : model.slice(0, separatorIndex);

  if (provider === 'auto' && qualifiedProvider == null) {
    throw new Error('COVE_LIVE_MODEL must include a provider prefix when COVE_LIVE_PROVIDER is unset or auto.');
  }

  if (provider !== 'auto' && qualifiedProvider != null && qualifiedProvider !== provider) {
    throw new Error('Invalid live selector combination: COVE_LIVE_PROVIDER does not match the provider prefix in COVE_LIVE_MODEL.');
  }

  return {
    enabled: true,
    provider: qualifiedProvider ?? provider,
    model,
  };
}

export function buildLiveAgentGroupConfig(): string {
  return JSON.stringify({
    extra_env: {},
  });
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(message);
  }

  return value as Record<string, unknown>;
}

export function validateLiveChatCompletionResponse(value: unknown): string {
  const response = requireRecord(value, 'Live chat response must be a JSON object') as OpenAiChatResponse;

  if (typeof response.id !== 'string' || response.id.trim() === '') {
    throw new Error('Live chat response is missing a string id');
  }

  if (response.object !== 'chat.completion') {
    throw new Error('Live chat response object must be chat.completion');
  }

  if (typeof response.created !== 'number' || !Number.isFinite(response.created)) {
    throw new Error('Live chat response is missing a numeric created timestamp');
  }

  if (typeof response.model !== 'string' || response.model.trim() === '') {
    throw new Error('Live chat response is missing a string model');
  }

  if (!Array.isArray(response.choices) || response.choices.length === 0) {
    throw new Error('Live chat response did not include any choices');
  }

  const firstChoice = requireRecord(response.choices[0], 'Live chat response choice must be an object') as OpenAiChatChoice;
  const message = requireRecord(firstChoice.message, 'Live chat response choice is missing a message');

  if (message.role !== 'assistant') {
    throw new Error('Live chat response did not include an assistant message');
  }

  if (message.metadata != null) {
    throw new Error('Live chat response returned tool or approval metadata instead of a direct assistant reply');
  }

  if (typeof message.content !== 'string' || message.content.trim() === '') {
    throw new Error('Live chat response did not include non-empty assistant content');
  }

  return message.content.trim();
}

function ensureRuntimePrerequisites(): void {
  if (!isContainerRuntimeAvailable()) {
    throw new Error(`Container runtime unavailable: ${getContainerRuntimeBin()}`);
  }

  if (getContainerRuntimeBin() !== 'docker') {
    return;
  }

  const imageStatus = ensureImageExists();

  if (imageStatus !== true) {
    throw new Error(`Container image ${getImageName()} is missing. Build it first: ${imageStatus}`);
  }
}

function seedLiveAgentGroup(options: {
  stateDir: string;
  agentGroupId: string;
  provider: string;
  model: string;
}): void {
  const dbPath = path.join(options.stateDir, 'cove.db');
  const db = new Database(dbPath);
  const now = new Date().toISOString();

  try {
    migrate(db);
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
      options.agentGroupId,
      'Live Chat E2E',
      null,
      options.provider,
      options.model,
      'medium',
      JSON.stringify({
        read: 'confirm',
        glob: 'confirm',
        grep: 'confirm',
        bash: 'confirm',
        write: 'confirm',
      }),
      'Reply directly in plain text. Never use tools or ask for approval.',
      buildLiveAgentGroupConfig(),
      now,
      now,
    );
  } finally {
    db.close();
  }
}

function readWarmAckSessionId(sessionDir: string): string | null {
  const outboundPath = path.join(sessionDir, 'outbound.db');

  if (!fs.existsSync(outboundPath)) {
    return null;
  }

  const db = new Database(outboundPath, { readonly: true });

  try {
    const row = db.prepare('SELECT session_id FROM processing_ack LIMIT 1').get() as { session_id: string } | null;
    return row?.session_id ?? null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

async function waitForWarmReady(stateDir: string): Promise<void> {
  const deadline = Date.now() + WARM_READY_TIMEOUT_MS;
  const warmDir = path.join(stateDir, 'warm');

  while (Date.now() < deadline) {
    if (fs.existsSync(warmDir)) {
      const sessionIds = fs.readdirSync(warmDir);

      for (const sessionId of sessionIds) {
        const sessionDir = path.join(warmDir, sessionId);
        if (readWarmAckSessionId(sessionDir) != null) {
          return;
        }
      }
    }

    await Bun.sleep(WARM_READY_POLL_MS);
  }

  throw new Error(`Warm pool did not become ready within ${WARM_READY_TIMEOUT_MS}ms`);
}

function requireSessionArtifacts(options: {
  stateDir: string;
  agentGroupId: string;
  threadId: string;
}): SessionRow & { session_file: string } {
  const db = new Database(path.join(options.stateDir, 'cove.db'), { readonly: true });

  try {
    const row = db.prepare(
      `SELECT id, session_file
       FROM sessions
       WHERE agent_group_id = ? AND thread_id = ?`,
    ).get(options.agentGroupId, options.threadId) as SessionRow | null;

    if (row == null) {
      throw new Error('Live chat run did not persist a session row');
    }

    if (typeof row.session_file !== 'string' || row.session_file.trim() === '') {
      throw new Error('Live chat session row is missing session_file');
    }

    for (const requiredPath of [
      row.session_file,
      path.join(row.session_file, 'inbound.db'),
      path.join(row.session_file, 'outbound.db'),
    ]) {
      if (!fs.existsSync(requiredPath)) {
        throw new Error(`Expected live chat artifact to exist: ${requiredPath}`);
      }
    }

    return {
      ...row,
      session_file: row.session_file,
    };
  } finally {
    db.close();
  }
}

function restoreEnv(savedEnv: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }
}

export function buildLiveChatRequestBody(): {
  agent_group_id: string;
  thread_id: string;
  messages: Array<{ role: 'user'; content: string }>;
} {
  return {
    agent_group_id: LIVE_AGENT_GROUP_ID,
    thread_id: LIVE_THREAD_ID,
    messages: [
      {
        role: 'user',
        content: 'Reply with exactly LIVE_E2E_OK and nothing else. Do not use any tools.',
      },
    ],
  };
}

async function requestLiveChat(server: ApiServer): Promise<string> {
  const response = await fetch(`http://${server.hostname}:${server.port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildLiveChatRequestBody()),
  });
  const rawBody = await response.text();

  if (response.status !== 200) {
    throw new Error(`Live chat request failed with status ${response.status}: ${rawBody}`);
  }

  let parsedBody: unknown;

  try {
    parsedBody = JSON.parse(rawBody) as unknown;
  } catch {
    throw new Error('Live chat response was not valid JSON');
  }

  return validateLiveChatCompletionResponse(parsedBody);
}

function logActiveContainers(label: string): void {
  const entries = [...getActiveContainers().entries()].map(([sessionId, entry]) => ({
    sessionId,
    containerName: entry.name,
    running: entry.running !== false,
    sessionDir: entry.options.sessionDir,
    envSessionId: entry.options.envVars?.COVE_SESSION_ID,
  }));

  console.log(`[live-e2e] ${label}: ${JSON.stringify(entries)}`);
}

export async function runLiveChatE2e(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = resolveLiveE2eConfig(env);

  if (!config.enabled) {
    console.log(config.reason);
    return;
  }

  ensureRuntimePrerequisites();

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cove-v2-live-e2e-'));
  const savedEnv = {
    COVE_STATE_DIR: process.env.COVE_STATE_DIR,
    COVE_POOL_MIN: process.env.COVE_POOL_MIN,
    COVE_POOL_MAX: process.env.COVE_POOL_MAX,
    COVE_WORKFLOW_API_BASE_URL: process.env.COVE_WORKFLOW_API_BASE_URL,
  };
  let runtime: BootRuntime | undefined;
  let apiServer: ApiServer | undefined;

  try {
    process.env.COVE_STATE_DIR = stateDir;
    process.env.COVE_POOL_MIN = '1';
    process.env.COVE_POOL_MAX = '1';
    delete process.env.COVE_WORKFLOW_API_BASE_URL;

    seedLiveAgentGroup({
      stateDir,
      agentGroupId: LIVE_AGENT_GROUP_ID,
      provider: config.provider,
      model: config.model,
    });

    runtime = await boot({
      async cleanupOrphans() {},
      startApiServer(options) {
        apiServer = startRuntimeApiServer({ ...options, port: 0 });
        return apiServer;
      },
    });

    if (apiServer == null) {
      throw new Error('Live API server did not start');
    }

    await waitForWarmReady(stateDir);
    logActiveContainers('before-request');
    const assistantContent = await requestLiveChat(apiServer);
    logActiveContainers('after-request');
    const session = requireSessionArtifacts({
      stateDir,
      agentGroupId: LIVE_AGENT_GROUP_ID,
      threadId: LIVE_THREAD_ID,
    });

    console.log(`Live chat E2E passed for session ${session.id}: ${assistantContent}`);
  } finally {
    if (runtime != null) {
      await runtime.stop();
    }

    restoreEnv(savedEnv);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    await runLiveChatE2e();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
