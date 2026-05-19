import type { Database } from 'bun:sqlite';

import { adoptRunningContainer as defaultAdoptRunningContainer } from '../container/adopt.ts';
import { killContainer as defaultKillContainer } from '../container/kill.ts';
import { loadPersona } from '../context/persona.ts';
import {
  getActiveContainers,
  getAllowlistedOneCliGatewayEnv,
  isContainerRunning as defaultIsContainerRunning,
  spawnContainer as defaultSpawnContainer,
  type ContainerStartOptions,
} from '../container/spawn.ts';
import {
  parseRuntimePrepConfigValue,
  type RuntimePrepConfig,
} from '../runtime-prep-config.ts';
import type { RoutedRequest, SessionConfig, WarmPool } from '../shared/types.ts';

type EnsureSessionRuntimeOptions = {
  routed: RoutedRequest;
  config: SessionConfig;
};

type EnsureSessionRuntimeDeps = {
  db: Database;
  warmPool: WarmPool;
  imageName: string;
  centralDbPath?: string;
  isContainerRunning?(sessionId: string): boolean;
  adoptRunningContainer?(
    fromSessionId: string,
    toSessionId: string,
    overrides?: Partial<ContainerStartOptions>,
  ): boolean;
  spawnContainer?(options: ContainerStartOptions): boolean;
  killContainer?(sessionId: string, reason?: string): void;
};

function requiresColdSpawn(config: SessionConfig, runtimePrep: RuntimePrepConfig): boolean {
  const hasOneCliProxy = (config.extra_env?.HTTPS_PROXY ?? config.extra_env?.https_proxy ?? '') !== ''
    || (config.extra_env?.HTTP_PROXY ?? config.extra_env?.http_proxy ?? '') !== '';

  return config.workspace != null
    || hasOneCliProxy
    || (runtimePrep.provider_env_passthrough?.length ?? 0) > 0
    || (runtimePrep.provider_file_env_passthrough?.length ?? 0) > 0;
}

function injectPersonaIntoConfig(config: SessionConfig, agentGroupId: string, db: Database): SessionConfig {
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

function buildRuntimeIdentityEnv(options: {
  agentGroupId: string;
  centralDbPath?: string;
}): Record<string, string> {
  return {
    COVE_AGENT_GROUP_ID: options.agentGroupId,
    ...(options.centralDbPath == null ? {} : { COVE_CENTRAL_DB_PATH: options.centralDbPath }),
  };
}

function buildRuntimeEnv(
  config: SessionConfig,
  sessionId: string,
  identityEnv: Record<string, string>,
): Record<string, string> {
  return {
    ...(config.extra_env ?? {}),
    ...identityEnv,
    ...getAllowlistedOneCliGatewayEnv(),
    COVE_SESSION_ID: sessionId,
  };
}

function buildAdoptedRuntimeEnv(options: {
  warmSessionId: string;
  config: SessionConfig;
  liveSessionId: string;
  identityEnv: Record<string, string>;
}): Record<string, string> {
  const warmEnv = getActiveContainers().get(options.warmSessionId)?.options.envVars ?? {};

  return {
    ...warmEnv,
    ...(options.config.extra_env ?? {}),
    ...options.identityEnv,
    ...getAllowlistedOneCliGatewayEnv(warmEnv),
    COVE_SESSION_ID: options.liveSessionId,
  };
}

function buildColdSpawnOptions(
  deps: EnsureSessionRuntimeDeps,
  options: EnsureSessionRuntimeOptions,
  runtimePrep: RuntimePrepConfig,
  identityEnv: Record<string, string>,
): ContainerStartOptions {
  return {
    imageName: deps.imageName,
    containerName: options.routed.session.id,
    sessionId: options.routed.session.id,
    sessionDir: options.routed.session.session_file!,
    centralDbPath: deps.centralDbPath,
    workspaceDir: options.config.workspace ?? undefined,
    envVars: buildRuntimeEnv(options.config, options.routed.session.id, identityEnv),
    ...(runtimePrep.provider_env_passthrough == null ? {} : { providerEnvPassthrough: runtimePrep.provider_env_passthrough }),
    ...(runtimePrep.provider_file_env_passthrough == null ? {} : { providerFileEnvPassthrough: runtimePrep.provider_file_env_passthrough }),
  };
}

export function createEnsureSessionRuntime(deps: EnsureSessionRuntimeDeps) {
  const isContainerRunning = deps.isContainerRunning ?? defaultIsContainerRunning;
  const adoptRunningContainer = deps.adoptRunningContainer ?? defaultAdoptRunningContainer;
  const spawnContainer = deps.spawnContainer ?? defaultSpawnContainer;
  const killContainer = deps.killContainer ?? defaultKillContainer;

  return async function ensureSessionRuntime(options: EnsureSessionRuntimeOptions): Promise<boolean> {
    const liveSessionId = options.routed.session.id;
    const resolvedConfig = injectPersonaIntoConfig(options.config, options.routed.agentGroup.id, deps.db);
    const runtimePrep = parseRuntimePrepConfigValue(options.routed.agentGroup.config) ?? {};
    const identityEnv = buildRuntimeIdentityEnv({
      agentGroupId: options.routed.agentGroup.id,
      centralDbPath: deps.centralDbPath,
    });

    if (isContainerRunning(liveSessionId)) {
      return true;
    }

    if (requiresColdSpawn(resolvedConfig, runtimePrep)) {
      if (options.routed.session.session_file == null) {
        return false;
      }

      return spawnContainer(buildColdSpawnOptions(deps, {
        ...options,
        config: resolvedConfig,
      }, runtimePrep, identityEnv));
    }

    const warmAllocation = await deps.warmPool.acquire();

    if (warmAllocation != null) {
      const previousSessionFile = options.routed.session.session_file;
      const adopted = adoptRunningContainer(warmAllocation.sessionId, liveSessionId, {
        sessionId: liveSessionId,
        containerName: liveSessionId,
        sessionDir: warmAllocation.sessionDir,
        envVars: buildAdoptedRuntimeEnv({
          warmSessionId: warmAllocation.sessionId,
          config: resolvedConfig,
          liveSessionId,
          identityEnv,
        }),
      });

      if (adopted) {
        try {
          const updatedAt = new Date().toISOString();
          const result = deps.db
            .prepare('UPDATE sessions SET session_file = ?, updated_at = ? WHERE id = ?')
            .run(warmAllocation.sessionDir, updatedAt, liveSessionId);

          if (result.changes !== 1) {
            throw new Error(`Expected to persist one session row for ${liveSessionId}, got ${result.changes}`);
          }

          options.routed.session.session_file = warmAllocation.sessionDir;
          options.routed.session.updated_at = updatedAt;
          deps.warmPool.consume(warmAllocation.sessionId);
          return true;
        } catch {
          killContainer(liveSessionId, 'session-file-persist-failed');
          getActiveContainers().delete(liveSessionId);
          options.routed.session.session_file = previousSessionFile;
          deps.warmPool.consume(warmAllocation.sessionId);
          return false;
        }
      }

      deps.warmPool.release(warmAllocation.sessionId);
    }

    if (options.routed.session.session_file == null) {
      return false;
    }

    return spawnContainer(buildColdSpawnOptions(deps, {
      ...options,
      config: resolvedConfig,
    }, runtimePrep, identityEnv));
  };
}
