import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  adoptRunningContainer,
  buildContainerArgs,
  getActiveContainerCount,
  getActiveContainers,
  isContainerRunning,
  killContainer,
  spawnContainer,
  type ContainerStartOptions,
} from '../../src/container/spawn.ts';

const tempDirs: string[] = [];
const originalRuntimeBin = process.env.COVE_CONTAINER_RUNTIME_BIN;

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  getActiveContainers().clear();

  if (originalRuntimeBin === undefined) {
    delete process.env.COVE_CONTAINER_RUNTIME_BIN;
  } else {
    process.env.COVE_CONTAINER_RUNTIME_BIN = originalRuntimeBin;
  }

  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('container manager', () => {
  const baseOptions: ContainerStartOptions = {
    imageName: 'cove-agent:latest',
    containerName: 'cove-test-1',
    sessionDir: '/tmp/cove-sessions/test-group/test-sess',
    workspaceDir: '/tmp/cove-workspace',
    envVars: {
      MODEL_PROVIDER: 'openai',
      MODEL_ID: 'gpt-4',
      API_KEY: 'sk-test123',
    },
  };

  it('buildContainerArgs includes rm, name, session label, session mount, workspace mount, env vars, and image', () => {
    const args = buildContainerArgs(baseOptions);

    expect(args[0]).toBe('run');
    expect(args).toContain('--rm');
    expect(args).toContain('--name');
    expect(args).toContain('cove-session-id=cove-test-1');
    expect(args).toContain('/tmp/cove-sessions/test-group/test-sess:/app/session');
    expect(args).toContain('/tmp/cove-workspace:/workspace');
    expect(args).toContain('MODEL_PROVIDER=openai');
    expect(args.at(-1)).toBe('cove-agent:latest');
  });

  it('buildContainerArgs mounts the central db inside the session boundary when provided', () => {
    const args = buildContainerArgs({
      ...baseOptions,
      centralDbPath: '/tmp/cove-state/cove.db',
    });

    expect(args).toContain('/tmp/cove-state/cove.db:/app/session/cove.db');
  });

  it('spawnContainer returns false when the runtime binary is unavailable', () => {
    process.env.COVE_CONTAINER_RUNTIME_BIN = 'definitely-not-a-real-container-runtime';

    const ok = spawnContainer({
      imageName: 'cove-agent:latest',
      containerName: 'cove-missing-runtime',
      sessionDir: '/tmp/cove-missing-runtime',
    });

    expect(ok).toBe(false);
    expect(getActiveContainerCount()).toBe(0);
  });

  it('adoptRunningContainer rekeys a tracked container under the live session id', () => {
    getActiveContainers().set('warm-1', {
      name: 'cove-warm-warm-1',
      startedAt: Date.now(),
      options: {
        imageName: 'cove-agent:latest',
        containerName: 'cove-warm-warm-1',
        sessionDir: '/tmp/cove-warm-warm-1',
      },
      process: {
        kill: () => true,
      } as never,
      running: true,
    });

    const adopted = adoptRunningContainer('warm-1', 'live-1', {
      containerName: 'live-1',
      sessionDir: '/tmp/cove-live-1',
      envVars: { COVE_SESSION_ID: 'live-1' },
    });

    expect(adopted).toBe(true);
    expect(isContainerRunning('warm-1')).toBe(false);
    expect(isContainerRunning('live-1')).toBe(true);
    expect(getActiveContainers().get('live-1')?.name).toBe('cove-warm-warm-1');
    expect(getActiveContainers().get('live-1')?.options.containerName).toBe('live-1');
    expect(getActiveContainers().get('live-1')?.options.sessionDir).toBe('/tmp/cove-live-1');
  });

  it('killContainer does not throw when the session is unknown', () => {
    expect(() => killContainer('nonexistent-session')).not.toThrow();
  });

  it('killContainer uses the configured runtime binary for tracked containers', () => {
    const tmpDir = makeTempDir('cove-v2-manager-stop-');
    const runtimePath = path.join(tmpDir, 'fake-runtime.sh');
    const logPath = path.join(tmpDir, 'runtime.log');

    fs.writeFileSync(
      runtimePath,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  exit 0\nfi\nprintf '%s\\n' "$@" >> "${logPath}"\nexit 0\n`,
      'utf8',
    );
    fs.chmodSync(runtimePath, 0o755);
    process.env.COVE_CONTAINER_RUNTIME_BIN = runtimePath;

    getActiveContainers().set('sess-stop-runtime-bin', {
      name: 'tracked-container',
      startedAt: Date.now(),
      options: {
        imageName: 'cove-agent:latest',
        containerName: 'sess-stop-runtime-bin',
        sessionDir: '/tmp/cove-stop-runtime-bin',
      },
      process: {
        kill: () => true,
      } as never,
      running: true,
    });

    killContainer('sess-stop-runtime-bin');

    const log = fs.readFileSync(logPath, 'utf8');
    expect(log).toContain('stop');
    expect(log).toContain('tracked-container');
  });
});
