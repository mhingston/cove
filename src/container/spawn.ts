import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

import {
  getContainerRuntimeBin,
  hostGatewayArgs,
  isContainerRuntimeAvailable,
  stopContainer,
} from './detect.ts';
import {
  BUILT_IN_PROVIDER_CREDENTIAL_DIR_MOUNTS,
  BUILT_IN_PROVIDER_ENV_PASSTHROUGH,
  BUILT_IN_PROVIDER_FILE_ENV_PASSTHROUGH,
  type ProviderEnvPassthroughEntry,
  type ProviderFileEnvPassthroughEntry,
} from './provider-manifest.ts';

type ContainerMount = {
  hostPath: string;
  containerPath: string;
  readOnly?: boolean;
};

export type ContainerStartOptions = {
  imageName: string;
  containerName: string;
  sessionDir: string;
  sessionId?: string;
  centralDbPath?: string;
  workspaceDir?: string;
  envVars?: Record<string, string>;
  providerEnvPassthrough?: ProviderEnvPassthroughEntry[];
  providerFileEnvPassthrough?: ProviderFileEnvPassthroughEntry[];
  mounts?: ContainerMount[];
};

export type ContainerEntry = {
  process: ChildProcess;
  name: string;
  startedAt: number;
  options: ContainerStartOptions;
  running?: boolean;
};

const activeContainers = new Map<string, ContainerEntry>();

const ALLOWLISTED_GATEWAY_ENV_KEYS = [
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'https_proxy',
  'http_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'ONECLI_AGENT_NAME',
  'ONECLI_URL',
] as const;

function getContainerKey(options: ContainerStartOptions): string {
  return options.sessionId ?? options.containerName;
}

function copyOptions(options: ContainerStartOptions): ContainerStartOptions {
  return {
    ...options,
    envVars: options.envVars == null ? undefined : { ...options.envVars },
    providerEnvPassthrough: options.providerEnvPassthrough == null
      ? undefined
      : options.providerEnvPassthrough.map((entry) => ({ ...entry })),
    providerFileEnvPassthrough: options.providerFileEnvPassthrough == null
      ? undefined
      : options.providerFileEnvPassthrough.map((entry) => ({ ...entry })),
    mounts: options.mounts == null ? undefined : options.mounts.map((entry) => ({ ...entry })),
  };
}

function markEntryExited(process: ChildProcess): void {
  for (const entry of activeContainers.values()) {
    if (entry.process !== process) {
      continue;
    }

    entry.running = false;
    return;
  }
}

export function getAllowlistedOneCliGatewayEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const gatewayEnv: Record<string, string> = {};

  for (const key of ALLOWLISTED_GATEWAY_ENV_KEYS) {
    const value = env[key];

    if (value != null && value !== '') {
      gatewayEnv[key] = value;
    }
  }

  return gatewayEnv;
}

function resolveContainerEnvVars(options: ContainerStartOptions, env: NodeJS.ProcessEnv = process.env): Record<string, string> | undefined {
  const envVars = resolveContainerRuntimeOptions(options, env).envVars ?? {};

  return Object.keys(envVars).length > 0 ? envVars : undefined;
}

function resolveHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME?.trim() || os.homedir();
}

function normalizeProviderEnvPassthrough(
  entries: ProviderEnvPassthroughEntry[] | undefined,
): ProviderEnvPassthroughEntry[] | undefined {
  if (entries == null) {
    return undefined;
  }

  const normalized: ProviderEnvPassthroughEntry[] = [];
  const names = new Set<string>();

  for (const entry of entries) {
    const name = entry.name.trim();

    if (name === '') {
      throw new Error('Provider env passthrough names must be non-empty.');
    }

    if (names.has(name)) {
      throw new Error(`Duplicate provider env passthrough: ${name}`);
    }

    names.add(name);
    normalized.push({ name, required: entry.required ?? true });
  }

  return normalized;
}

function normalizeProviderFileEnvPassthrough(
  entries: ProviderFileEnvPassthroughEntry[] | undefined,
): ProviderFileEnvPassthroughEntry[] | undefined {
  if (entries == null) {
    return undefined;
  }

  const normalized: ProviderFileEnvPassthroughEntry[] = [];
  const names = new Set<string>();

  for (const entry of entries) {
    const name = entry.name.trim();

    if (name === '') {
      throw new Error('Provider file env passthrough names must be non-empty.');
    }

    if (entry.kind !== 'file' && entry.kind !== 'directory') {
      throw new Error(`Unsupported provider file env passthrough kind for ${name}: ${entry.kind}`);
    }

    if (names.has(name)) {
      throw new Error(`Duplicate provider file env passthrough: ${name}`);
    }

    names.add(name);
    normalized.push({ name, kind: entry.kind, required: entry.required ?? true });
  }

  return normalized;
}

function addMount(mounts: ContainerMount[], mount: ContainerMount): void {
  if (mounts.some((entry) => entry.hostPath === mount.hostPath && entry.containerPath === mount.containerPath)) {
    return;
  }

  mounts.push(mount);
}

function requireExistingPath(envName: string, hostPath: string, kind: 'file' | 'directory'): void {
  if (!fs.existsSync(hostPath)) {
    throw new Error(`Missing required provider path for ${envName}: ${hostPath}`);
  }

  const stats = fs.statSync(hostPath);

  if (kind === 'file' && !stats.isFile()) {
    throw new Error(`Provider path for ${envName} must be a file: ${hostPath}`);
  }

  if (kind === 'directory' && !stats.isDirectory()) {
    throw new Error(`Provider path for ${envName} must be a directory: ${hostPath}`);
  }
}

function resolveHostPiAgentDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env.PI_CODING_AGENT_DIR?.trim();

  if (configured) {
    if (!fs.existsSync(configured)) {
      throw new Error(`Missing Pi agent dir: ${configured}. Initialize Pi config or set PI_CODING_AGENT_DIR.`);
    }

    return configured;
  }

  const defaultAgentDir = path.join(resolveHomeDir(env), '.pi', 'agent');
  return fs.existsSync(defaultAgentDir) ? defaultAgentDir : undefined;
}

function resolveContainerRuntimeOptions(
  options: ContainerStartOptions,
  env: NodeJS.ProcessEnv = process.env,
): ContainerStartOptions {
  if (options.mounts != null) {
    return copyOptions(options);
  }

  const envVars: Record<string, string> = { ...(options.envVars ?? {}) };
  const mounts: ContainerMount[] = [];
  const providerEnvPassthrough = normalizeProviderEnvPassthrough(options.providerEnvPassthrough);
  const providerFileEnvPassthrough = normalizeProviderFileEnvPassthrough(options.providerFileEnvPassthrough);
  const declaredProviderNames = new Set(providerEnvPassthrough?.map((entry) => entry.name) ?? []);

  for (const entry of providerFileEnvPassthrough ?? []) {
    if (declaredProviderNames.has(entry.name)) {
      throw new Error(`Duplicate provider passthrough declaration: ${entry.name}`);
    }
  }

  envVars.HOME = '/root';
  envVars.PI_CODING_AGENT_DIR = '/app/session/.pi-agent';

  if (options.centralDbPath != null) {
    envVars.COVE_CENTRAL_DB_PATH = '/app/cove.db';
  }

  const hostPiAgentDir = resolveHostPiAgentDir(env);
  if (hostPiAgentDir != null) {
    addMount(mounts, {
      hostPath: hostPiAgentDir,
      containerPath: '/app/pi-agent-base',
      readOnly: true,
    });
  }

  const devSrc = env.COVE_DEV_SRC?.trim();
  if (devSrc && fs.existsSync(devSrc)) {
    addMount(mounts, {
      hostPath: devSrc,
      containerPath: '/app/src',
      readOnly: true,
    });
  }

  const homeDir = resolveHomeDir(env);
  for (const mount of BUILT_IN_PROVIDER_CREDENTIAL_DIR_MOUNTS) {
    const hostPath = path.join(homeDir, mount.relativeHostPath);

    if (!fs.existsSync(hostPath)) {
      continue;
    }

    addMount(mounts, {
      hostPath,
      containerPath: mount.containerPath,
      readOnly: true,
    });
  }

  for (const key of BUILT_IN_PROVIDER_ENV_PASSTHROUGH) {
    const hostValue = env[key];

    if ((envVars[key] == null || envVars[key] === '') && hostValue != null && hostValue !== '') {
      envVars[key] = hostValue;
    }
  }

  for (const entry of BUILT_IN_PROVIDER_FILE_ENV_PASSTHROUGH) {
    if (envVars[entry.name] != null && envVars[entry.name] !== '') {
      continue;
    }

    const hostPath = env[entry.name]?.trim();
    if (!hostPath) {
      continue;
    }

    requireExistingPath(entry.name, hostPath, entry.kind);
    const containerPath = `/app/provider-paths/${entry.name}`;

    addMount(mounts, {
      hostPath,
      containerPath,
      readOnly: true,
    });
    envVars[entry.name] = containerPath;
  }

  for (const entry of providerEnvPassthrough ?? []) {
    if (envVars[entry.name] != null && envVars[entry.name] !== '') {
      continue;
    }

    const hostValue = env[entry.name];
    if (hostValue != null && hostValue !== '') {
      envVars[entry.name] = hostValue;
      continue;
    }

    if (entry.required !== false) {
      throw new Error(`Missing required provider env passthrough: ${entry.name}`);
    }
  }

  for (const entry of providerFileEnvPassthrough ?? []) {
    if (envVars[entry.name] != null && envVars[entry.name] !== '') {
      continue;
    }

    const hostPath = env[entry.name]?.trim();
    if (!hostPath) {
      if (entry.required !== false) {
        throw new Error(`Missing required provider file passthrough: ${entry.name}`);
      }

      continue;
    }

    requireExistingPath(entry.name, hostPath, entry.kind);
    const containerPath = `/app/provider-paths/${entry.name}`;

    addMount(mounts, {
      hostPath,
      containerPath,
      readOnly: true,
    });
    envVars[entry.name] = containerPath;
  }

  Object.assign(envVars, getAllowlistedOneCliGatewayEnv(env));

  return {
    ...options,
    envVars,
    providerEnvPassthrough,
    providerFileEnvPassthrough,
    mounts: mounts.length > 0 ? mounts : undefined,
  };
}

export function buildContainerArgs(options: ContainerStartOptions): string[] {
  const resolvedOptions = resolveContainerRuntimeOptions(options);
  const args = ['run', '--rm', ...hostGatewayArgs(), '--name', resolvedOptions.containerName];
  const sessionKey = getContainerKey(resolvedOptions);

  args.push('--label', `cove-session-id=${sessionKey}`);
  args.push('-v', `${resolvedOptions.sessionDir}:/app/session`);

  if (resolvedOptions.centralDbPath != null) {
    args.push('-v', `${resolvedOptions.centralDbPath}:/app/cove.db`);
  }

  if (resolvedOptions.workspaceDir != null) {
    args.push('-v', `${resolvedOptions.workspaceDir}:/workspace`);
  }

  for (const mount of resolvedOptions.mounts ?? []) {
    args.push('-v', `${mount.hostPath}:${mount.containerPath}${mount.readOnly === false ? '' : ':ro'}`);
  }

  const envVars = resolvedOptions.envVars ?? {};

  for (const [key, value] of Object.entries(envVars)) {
    args.push('-e', `${key}=${value}`);
  }

  args.push(resolvedOptions.imageName);

  return args;
}

export function spawnContainer(options: ContainerStartOptions): boolean {
  if (!isContainerRuntimeAvailable()) {
    return false;
  }

  try {
    const normalizedOptions = resolveContainerRuntimeOptions(options);
    const container = spawn(getContainerRuntimeBin(), buildContainerArgs(normalizedOptions), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const containerKey = getContainerKey(normalizedOptions);

    activeContainers.set(containerKey, {
      process: container,
      name: normalizedOptions.containerName,
      startedAt: Date.now(),
      options: copyOptions(normalizedOptions),
      running: true,
    });

    container.stderr?.on('data', (data) => {
      const lines = data.toString().trim().split('\n').filter(Boolean);

      for (const line of lines) {
        console.error(`[container ${normalizedOptions.containerName}] ${line}`);
      }
    });

    container.on('close', () => {
      markEntryExited(container);
    });

    container.on('error', () => {
      markEntryExited(container);
    });

    return true;
  } catch {
    return false;
  }
}

export function adoptRunningContainer(
  fromSessionId: string,
  toSessionId: string,
  overrides?: Partial<ContainerStartOptions>,
): boolean {
  const entry = activeContainers.get(fromSessionId);

  if (entry == null) {
    return false;
  }

  activeContainers.delete(fromSessionId);
  activeContainers.set(toSessionId, {
    ...entry,
    options: copyOptions({
      ...entry.options,
      ...overrides,
      sessionId: overrides?.sessionId ?? toSessionId,
      containerName: overrides?.containerName ?? toSessionId,
    }),
  });

  return true;
}

export function killContainer(sessionId: string, _reason?: string): void {
  const entry = activeContainers.get(sessionId);

  if (entry == null) {
    return;
  }

  const stopped = stopContainer(entry.name);

  if (!stopped) {
    try {
      entry.process.kill('SIGKILL');
    } catch {
      // The process is already gone.
    }
  }

  entry.running = false;
}

export function restartContainer(sessionId: string, reason?: string): boolean {
  const entry = activeContainers.get(sessionId);

  if (entry == null) {
    return false;
  }

  killContainer(sessionId, reason);
  return spawnContainer(entry.options);
}

export function stopAndForgetContainersForAgentGroup(agentGroupId: string): void {
  const matchingSessionIds = [...activeContainers.entries()]
    .filter(([, entry]) => entry.options.envVars?.COVE_AGENT_GROUP_ID === agentGroupId)
    .map(([sessionId]) => sessionId);

  for (const sessionId of matchingSessionIds) {
    killContainer(sessionId, `agent group deleted: ${agentGroupId}`);
    activeContainers.delete(sessionId);
  }
}

export function getActiveContainers(): Map<string, ContainerEntry> {
  return activeContainers;
}

export function isContainerRunning(sessionId: string): boolean {
  const entry = activeContainers.get(sessionId);
  return entry != null && entry.running !== false;
}

export function getActiveContainerCount(): number {
  return activeContainers.size;
}
