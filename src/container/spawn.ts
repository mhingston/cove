import { spawn, type ChildProcess } from 'node:child_process';

import {
  getContainerRuntimeBin,
  hostGatewayArgs,
  isContainerRuntimeAvailable,
  stopContainer,
} from './detect.ts';

export type ContainerStartOptions = {
  imageName: string;
  containerName: string;
  sessionDir: string;
  sessionId?: string;
  centralDbPath?: string;
  workspaceDir?: string;
  envVars?: Record<string, string>;
};

export type ContainerEntry = {
  process: ChildProcess;
  name: string;
  startedAt: number;
  options: ContainerStartOptions;
  running?: boolean;
};

const activeContainers = new Map<string, ContainerEntry>();

function getContainerKey(options: ContainerStartOptions): string {
  return options.sessionId ?? options.containerName;
}

function copyOptions(options: ContainerStartOptions): ContainerStartOptions {
  return {
    ...options,
    envVars: options.envVars == null ? undefined : { ...options.envVars },
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

export function buildContainerArgs(options: ContainerStartOptions): string[] {
  const args = ['run', '--rm', ...hostGatewayArgs(), '--name', options.containerName];
  const sessionKey = getContainerKey(options);

  args.push('--label', `cove-session-id=${sessionKey}`);
  args.push('-v', `${options.sessionDir}:/app/session`);

  if (options.centralDbPath != null) {
    args.push('-v', `${options.centralDbPath}:/app/session/cove.db`);
  }

  if (options.workspaceDir != null) {
    args.push('-v', `${options.workspaceDir}:/workspace`);
  }

  for (const [key, value] of Object.entries(options.envVars ?? {})) {
    args.push('-e', `${key}=${value}`);
  }

  args.push(options.imageName);

  return args;
}

export function spawnContainer(options: ContainerStartOptions): boolean {
  if (!isContainerRuntimeAvailable()) {
    return false;
  }

  try {
    const container = spawn(getContainerRuntimeBin(), buildContainerArgs(options), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const containerKey = getContainerKey(options);

    activeContainers.set(containerKey, {
      process: container,
      name: options.containerName,
      startedAt: Date.now(),
      options: copyOptions(options),
      running: true,
    });

    container.stderr?.on('data', (data) => {
      const lines = data.toString().trim().split('\n').filter(Boolean);

      for (const line of lines) {
        console.error(`[container ${options.containerName}] ${line}`);
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
