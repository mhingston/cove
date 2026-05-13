import { spawnSync } from 'node:child_process';

export const CONTAINER_RUNTIME_BIN = 'docker';

const VALID_CONTAINER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export function getContainerRuntimeBin(): string {
  return process.env.COVE_CONTAINER_RUNTIME_BIN || CONTAINER_RUNTIME_BIN;
}

export function isContainerRuntimeAvailable(): boolean {
  const result = spawnSync(getContainerRuntimeBin(), ['--version'], {
    env: process.env,
    stdio: 'ignore',
  });
  return result.error == null && result.status === 0;
}

export function hostGatewayArgs(): string[] {
  return process.platform === 'linux' ? ['--add-host=host.docker.internal:host-gateway'] : [];
}

export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

export function stopContainer(name: string): boolean {
  if (!VALID_CONTAINER_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }

  try {
    const result = spawnSync(getContainerRuntimeBin(), ['stop', '-t', '1', name], {
      env: process.env,
      stdio: 'ignore',
    });

    return result.error == null && result.status === 0;
  } catch {
    return false;
  }
}

export function cleanupOrphans(): void {
  try {
    const result = spawnSync(
      getContainerRuntimeBin(),
      ['ps', '--filter', 'label=cove-session-id', '--format', '{{.Names}}'],
      { encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'ignore'] },
    );

    if (result.error != null || result.status !== 0) {
      return;
    }

    const stdout = result.stdout;
    const orphans = stdout
      .trim()
      .split(/\r?\n/)
      .map((name: string) => name.trim())
      .filter((name: string) => name.length > 0);

    for (const orphan of orphans) {
      try {
        stopContainer(orphan);
      } catch {
        // Invalid names or already-stopped containers are not fatal at boot.
      }
    }
  } catch {
    // A missing or failing runtime should not block process startup.
  }
}
