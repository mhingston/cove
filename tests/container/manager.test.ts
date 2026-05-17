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
  restartContainer,
  spawnContainer,
  type ContainerStartOptions,
} from '../../src/container/spawn.ts';

const tempDirs: string[] = [];
const originalRuntimeBin = process.env.COVE_CONTAINER_RUNTIME_BIN;
const gatewayEnvKeys = [
  'HOME',
  'PI_CODING_AGENT_DIR',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'https_proxy',
  'http_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'ONECLI_AGENT_NAME',
  'ONECLI_URL',
  'OPENAI_API_KEY',
  'COPILOT_GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'CUSTOM_TOKEN',
  'CUSTOM_CRED_FILE',
  'UNRELATED_HOST_SECRET',
  'AWS_SECRET_ACCESS_KEY',
] as const;
const originalGatewayEnv = Object.fromEntries(
  gatewayEnvKeys.map((key) => [key, process.env[key]]),
) as Record<(typeof gatewayEnvKeys)[number], string | undefined>;

function restoreEnvVar(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}

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

  for (const key of gatewayEnvKeys) {
    restoreEnvVar(key, originalGatewayEnv[key]);
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

  it('buildContainerArgs mounts the central db at a separate path from the session directory', () => {
    const args = buildContainerArgs({
      ...baseOptions,
      centralDbPath: '/tmp/cove-state/cove.db',
    });

    expect(args).toContain('/tmp/cove-state/cove.db:/app/cove.db');
  });

  it('buildContainerArgs exports the mounted central db path to the container runtime', () => {
    const args = buildContainerArgs({
      ...baseOptions,
      centralDbPath: '/tmp/cove-state/cove.db',
    });

    expect(args).toContain('COVE_CENTRAL_DB_PATH=/app/cove.db');
  });

  it('buildContainerArgs injects only allowlisted OneCLI gateway env from the host', () => {
    process.env.HTTPS_PROXY = 'https://proxy.example';
    process.env.http_proxy = 'http://proxy.example';
    process.env.NODE_EXTRA_CA_CERTS = '/tmp/certs.pem';
    process.env.ONECLI_AGENT_NAME = 'cove-agent';
    process.env.ONECLI_URL = 'https://onecli.example';
    process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret';
    process.env.UNRELATED_HOST_SECRET = 'should-not-leak';

    const args = buildContainerArgs({
      ...baseOptions,
      envVars: {
        COVE_SESSION_ID: 'live-1',
      },
    });

    expect(args).toContain('HTTPS_PROXY=https://proxy.example');
    expect(args).toContain('http_proxy=http://proxy.example');
    expect(args).toContain('NODE_EXTRA_CA_CERTS=/tmp/certs.pem');
    expect(args).toContain('ONECLI_AGENT_NAME=cove-agent');
    expect(args).toContain('ONECLI_URL=https://onecli.example');
    expect(args).toContain('AWS_SECRET_ACCESS_KEY=aws-secret');
    expect(args).toContain('COVE_SESSION_ID=live-1');
    expect(args).not.toContain('UNRELATED_HOST_SECRET=should-not-leak');
  });

  it('buildContainerArgs does not let container env overrides replace allowlisted host OneCLI gateway env', () => {
    process.env.HTTPS_PROXY = 'https://proxy.example';
    process.env.ONECLI_AGENT_NAME = 'cove-agent';
    process.env.ONECLI_URL = 'https://onecli.example';

    const args = buildContainerArgs({
      ...baseOptions,
      envVars: {
        HTTPS_PROXY: 'https://override-proxy.example',
        ONECLI_AGENT_NAME: 'override-agent',
        ONECLI_URL: 'https://override-onecli.example',
        COVE_SESSION_ID: 'live-1',
      },
    });

    expect(args).toContain('HTTPS_PROXY=https://proxy.example');
    expect(args).toContain('ONECLI_AGENT_NAME=cove-agent');
    expect(args).toContain('ONECLI_URL=https://onecli.example');
    expect(args).not.toContain('HTTPS_PROXY=https://override-proxy.example');
    expect(args).not.toContain('ONECLI_AGENT_NAME=override-agent');
    expect(args).not.toContain('ONECLI_URL=https://override-onecli.example');
  });

  it('buildContainerArgs mounts the shared Pi dir, credential dirs, and rewrites built-in and custom provider file env paths', () => {
    const homeDir = makeTempDir('cove-v2-manager-home-');
    const piAgentDir = path.join(homeDir, '.pi', 'agent');
    const awsDir = path.join(homeDir, '.aws');
    const gcloudDir = path.join(homeDir, '.config', 'gcloud');
    const googleCredentialsPath = path.join(homeDir, 'google-credentials.json');
    const customCredentialPath = path.join(homeDir, 'custom-credential.txt');

    fs.mkdirSync(piAgentDir, { recursive: true });
    fs.mkdirSync(awsDir, { recursive: true });
    fs.mkdirSync(gcloudDir, { recursive: true });
    fs.writeFileSync(googleCredentialsPath, '{}', 'utf8');
    fs.writeFileSync(customCredentialPath, 'secret', 'utf8');

    process.env.HOME = homeDir;
    process.env.PI_CODING_AGENT_DIR = piAgentDir;
    process.env.OPENAI_API_KEY = 'host-openai-key';
    process.env.COPILOT_GITHUB_TOKEN = 'host-copilot-token';
    process.env.GH_TOKEN = 'host-gh-token';
    process.env.GITHUB_TOKEN = 'host-github-token';
    process.env.GOOGLE_APPLICATION_CREDENTIALS = googleCredentialsPath;
    process.env.CUSTOM_TOKEN = 'custom-token';
    process.env.CUSTOM_CRED_FILE = customCredentialPath;

    const args = buildContainerArgs({
      ...baseOptions,
      envVars: {
        COVE_SESSION_ID: 'live-1',
      },
      providerEnvPassthrough: [{ name: 'CUSTOM_TOKEN' }],
      providerFileEnvPassthrough: [{ name: 'CUSTOM_CRED_FILE', kind: 'file' }],
    });

    expect(args).toContain(`${piAgentDir}:/app/pi-agent-base:ro`);
    expect(args).toContain(`${awsDir}:/root/.aws:ro`);
    expect(args).toContain(`${gcloudDir}:/root/.config/gcloud:ro`);
    expect(args).toContain(`${googleCredentialsPath}:/app/provider-paths/GOOGLE_APPLICATION_CREDENTIALS:ro`);
    expect(args).toContain(`${customCredentialPath}:/app/provider-paths/CUSTOM_CRED_FILE:ro`);
    expect(args).toContain('OPENAI_API_KEY=host-openai-key');
    expect(args).toContain('COPILOT_GITHUB_TOKEN=host-copilot-token');
    expect(args).toContain('GH_TOKEN=host-gh-token');
    expect(args).toContain('GITHUB_TOKEN=host-github-token');
    expect(args).toContain('GOOGLE_APPLICATION_CREDENTIALS=/app/provider-paths/GOOGLE_APPLICATION_CREDENTIALS');
    expect(args).toContain('CUSTOM_TOKEN=custom-token');
    expect(args).toContain('CUSTOM_CRED_FILE=/app/provider-paths/CUSTOM_CRED_FILE');
    expect(args).toContain('PI_CODING_AGENT_DIR=/app/session/.pi-agent');
    expect(args).toContain('HOME=/root');
  });

  it('buildContainerArgs throws when a required custom provider env passthrough is missing', () => {
    delete process.env.CUSTOM_TOKEN;

    expect(() => buildContainerArgs({
      ...baseOptions,
      providerEnvPassthrough: [{ name: 'CUSTOM_TOKEN' }],
    })).toThrow('Missing required provider env passthrough: CUSTOM_TOKEN');
  });

  it('spawnContainer stores effective allowlisted OneCLI gateway env on the tracked container entry', () => {
    const tmpDir = makeTempDir('cove-v2-manager-onecli-stored-env-');
    const runtimePath = path.join(tmpDir, 'fake-runtime.sh');

    fs.writeFileSync(
      runtimePath,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  exit 0\nfi\nexit 0\n',
      'utf8',
    );
    fs.chmodSync(runtimePath, 0o755);
    process.env.COVE_CONTAINER_RUNTIME_BIN = runtimePath;
    process.env.HTTPS_PROXY = 'https://proxy.example';
    process.env.ONECLI_AGENT_NAME = 'cove-agent';
    process.env.ONECLI_URL = 'https://onecli.example';
    process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret';
    process.env.UNRELATED_HOST_SECRET = 'should-not-leak';

    const ok = spawnContainer({
      imageName: 'cove-agent:latest',
      containerName: 'cove-onecli-stored-env',
      sessionId: 'sess-onecli-stored-env',
      sessionDir: '/tmp/cove-onecli-stored-env',
      envVars: { COVE_SESSION_ID: 'sess-onecli-stored-env' },
    });

    expect(ok).toBe(true);
    expect(getActiveContainers().get('sess-onecli-stored-env')?.options.envVars).toEqual({
      HOME: '/root',
      PI_CODING_AGENT_DIR: '/app/session/.pi-agent',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      HTTPS_PROXY: 'https://proxy.example',
      ONECLI_AGENT_NAME: 'cove-agent',
      ONECLI_URL: 'https://onecli.example',
      COVE_SESSION_ID: 'sess-onecli-stored-env',
    });
    expect(getActiveContainers().get('sess-onecli-stored-env')?.options.envVars).not.toHaveProperty('UNRELATED_HOST_SECRET');
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

  it('restartContainer restarts a tracked container using its stored options', () => {
    const tmpDir = makeTempDir('cove-v2-manager-restart-');
    const runtimePath = path.join(tmpDir, 'fake-runtime.sh');
    const logPath = path.join(tmpDir, 'runtime.log');

    fs.writeFileSync(
      runtimePath,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  exit 0\nfi\nprintf '%s\\n' "$@" >> "${logPath}"\nexit 0\n`,
      'utf8',
    );
    fs.chmodSync(runtimePath, 0o755);
    process.env.COVE_CONTAINER_RUNTIME_BIN = runtimePath;

    getActiveContainers().set('sess-restart', {
      name: 'tracked-container',
      startedAt: Date.now(),
      options: {
        imageName: 'cove-agent:latest',
        containerName: 'tracked-container',
        sessionDir: '/tmp/cove-restart',
        sessionId: 'sess-restart',
        envVars: { COVE_SESSION_ID: 'sess-restart' },
      },
      process: {
        kill: () => true,
      } as never,
      running: true,
    });

    const restarted = restartContainer('sess-restart', 'heartbeat stale');

    expect(restarted).toBe(true);
    expect(getActiveContainers().get('sess-restart')?.options.sessionDir).toBe('/tmp/cove-restart');
    expect(fs.readFileSync(logPath, 'utf8')).toContain('tracked-container');
  });

  it('restartContainer returns false when the session is unknown', () => {
    expect(restartContainer('missing-session')).toBe(false);
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
