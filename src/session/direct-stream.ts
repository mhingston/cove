import type { Database } from 'bun:sqlite';
import path from 'node:path';

import {
  runContainerSession as runContainerSessionDefault,
  type ContainerSessionDeps,
} from '../container-agent/runner.ts';
import { loadPersona } from '../context/persona.ts';
import { appendWorkingMessage, ensureWorkingSession } from '../context/working.ts';
import { initSessionFolder } from './manager.ts';
import { openInboundDb, writeInboundMessage } from './inbound.ts';
import type { ChatMessage, RoutedRequest, SessionConfig } from '../shared/types.ts';

export type DirectStreamRequest = {
  centralDb: Database;
  routing: RoutedRequest;
  config: SessionConfig;
  messages: ChatMessage[];
};

export type RunContainerSessionOptions = {
  inboundPath: string;
  outboundPath: string;
  sessionId: string;
  config: SessionConfig;
};

export type DirectStreamDeps = {
  runContainerSession?: (
    options: RunContainerSessionOptions,
    onResponse?: (response: string) => void,
    deps?: ContainerSessionDeps,
    onToken?: (token: string) => void,
  ) => Promise<string>;
  runnerDeps?: ContainerSessionDeps;
  connectStream?: (request: DirectStreamRequest) => AsyncGenerator<string, void, undefined>;
};

function inboundDbPath(sessionDir: string): string {
  return path.join(sessionDir, 'inbound.db');
}

function outboundDbPath(sessionDir: string): string {
  return path.join(sessionDir, 'outbound.db');
}

function resolveHostCentralDbPath(db: Database): string | undefined {
  const dbPath = db.filename?.trim();

  if (!dbPath || dbPath === ':memory:') {
    return undefined;
  }

  return dbPath;
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

function mergePersonaIntoConfig(config: SessionConfig, agentGroupId: string, db: Database): SessionConfig {
  const explicitPersona = config.extra_env?.COVE_PERSONA;
  const persona = explicitPersona ?? loadPersona(agentGroupId, { db });

  if (persona == null) {
    return config;
  }

  return {
    ...config,
    extra_env: {
      ...(config.extra_env ?? {}),
      COVE_PERSONA: persona,
    },
  };
}

function streamQueue<T>() {
  const values: T[] = [];
  const waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  let done = false;
  let error: unknown;

  return {
    push(value: T): void {
      if (done || error) {
        return;
      }

      const waiter = waiters.shift();
      if (waiter) {
        waiter.resolve({ value, done: false });
        return;
      }

      values.push(value);
    },
    finish(): void {
      if (done || error) {
        return;
      }

      done = true;
      while (waiters.length > 0) {
        waiters.shift()?.resolve({ value: undefined, done: true });
      }
    },
    fail(nextError: unknown): void {
      if (done || error) {
        return;
      }

      error = nextError;
      while (waiters.length > 0) {
        waiters.shift()?.reject(nextError);
      }
    },
    async next(): Promise<IteratorResult<T>> {
      if (values.length > 0) {
        return { value: values.shift() as T, done: false };
      }

      if (error) {
        const nextError = error;
        error = undefined;
        throw nextError;
      }

      if (done) {
        return { value: undefined, done: true };
      }

      return new Promise<IteratorResult<T>>((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
  };
}

export async function* streamDirectSessionTokens(
  request: DirectStreamRequest,
  deps: DirectStreamDeps = {},
): AsyncGenerator<string, void, undefined> {
  const sessionDir = request.routing.session.session_file;

  if (sessionDir == null) {
    throw new Error('Session runtime is unavailable');
  }

  initSessionFolder(sessionDir);
  ensureWorkingSession(sessionDir, request.routing.session.id);

  const configWithPersona = mergePersonaIntoConfig(
    request.config,
    request.routing.agentGroup.id,
    request.centralDb,
  );
  const hostCentralDbPath = resolveHostCentralDbPath(request.centralDb);

  const mergedConfig: SessionConfig = {
    ...configWithPersona,
    extra_env: {
      ...(configWithPersona.extra_env ?? {}),
      COVE_AGENT_GROUP_ID: request.routing.agentGroup.id,
      ...(hostCentralDbPath == null ? {} : { COVE_CENTRAL_DB_PATH: hostCentralDbPath }),
      ...(configWithPersona.extra_env?.COVE_WORKFLOW_API_BASE_URL == null
        ? {}
        : { COVE_WORKFLOW_API_BASE_URL: configWithPersona.extra_env.COVE_WORKFLOW_API_BASE_URL }),
    },
  };

  const inboundDb = openInboundDb(sessionDir);

  try {
    writeSessionConfig(inboundDb, mergedConfig);

    for (const message of request.messages) {
      appendWorkingMessage(sessionDir, request.routing.session.id, message.role, message.content);

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

  const relayStream = deps.connectStream?.({
    ...request,
    config: mergedConfig,
  });

  if (relayStream) {
    yield* relayStream;
    return;
  }

  const queue = streamQueue<string>();
  const runContainerSession = deps.runContainerSession ?? runContainerSessionDefault;
  const task = runContainerSession(
    {
      inboundPath: inboundDbPath(sessionDir),
      outboundPath: outboundDbPath(sessionDir),
      sessionId: request.routing.session.id,
      config: mergedConfig,
    },
    undefined,
    deps.runnerDeps,
    (token) => {
      queue.push(token);
    },
  ).then(() => {
    queue.finish();
  }).catch((error) => {
    queue.fail(error);
  });

  try {
    while (true) {
      const next = await queue.next();

      if (next.done) {
        break;
      }

      yield next.value;
    }
  } finally {
    await task;
  }
}
