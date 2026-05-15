import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  resolveContainerAgentModel,
  resolveSessionManagerMode,
  setupContainerAgent,
  type ContainerAgentSetupDeps,
} from '../../src/container-agent/agent-setup.ts';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('container agent setup', () => {
  it('bootstraps in-memory auth, model, and session for runner use', async () => {
    const calls: string[] = [];
    const deps: ContainerAgentSetupDeps = {
      async createInMemoryAuth(input) {
        calls.push(`auth:${input.provider}:${input.apiKey}`);
        return { kind: 'auth', provider: input.provider, apiKey: input.apiKey };
      },
      async createModel(input) {
        calls.push(`model:${input.provider}:${input.model}`);
        return { kind: 'model', id: `${input.provider}/${input.model}` };
      },
      async createSessionManager(input) {
        calls.push(`manager:${input.mode}`);
        return { kind: 'session-manager', mode: input.mode };
      },
      async createSession(input) {
        calls.push(`session:${input.sessionManagerMode}`);
        return { kind: 'session', model: input.model, auth: input.auth };
      },
    };

    const result = await setupContainerAgent({
      provider: 'anthropic',
      model: 'claude-3-5-haiku',
      apiKey: 'test-api-key',
    }, deps);

    expect(calls).toEqual([
      'auth:anthropic:test-api-key',
      'model:anthropic:claude-3-5-haiku',
      'manager:in-memory',
      'session:in-memory',
    ]);
    expect(result.auth).toEqual({ kind: 'auth', provider: 'anthropic', apiKey: 'test-api-key' });
    expect(result.model).toEqual({ kind: 'model', id: 'anthropic/claude-3-5-haiku' });
    expect(result.sessionManagerMode).toBe('in-memory');
    expect(result.sessionManager).toEqual({ kind: 'session-manager', mode: 'in-memory' });
    expect(result.session).toEqual({
      kind: 'session',
      model: { kind: 'model', id: 'anthropic/claude-3-5-haiku' },
      auth: { kind: 'auth', provider: 'anthropic', apiKey: 'test-api-key' },
    });
  });

  it('resolves a namespaced model when provider selection is delegated to the model string', () => {
    expect(resolveContainerAgentModel({
      provider: 'auto',
      model: 'anthropic/claude-sonnet-4',
    })).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      id: 'anthropic/claude-sonnet-4',
    });
  });

  it('fails fast for unsupported or incomplete config', () => {
    expect(() => resolveContainerAgentModel({
      provider: 'openai',
      model: 'gpt-4.1',
    })).toThrow("Unsupported container agent provider 'openai'.");

    expect(() => resolveContainerAgentModel({
      provider: 'auto',
      model: 'claude-sonnet-4',
    })).toThrow("Container agent model must include an explicit provider when provider is 'auto'.");

    expect(() => resolveContainerAgentModel({
      provider: 'anthropic',
      model: 'anthropic/',
    })).toThrow('Container agent model is required.');
  });

  it('normalizes a blank api key to null before creating auth', async () => {
    let authInput: unknown;

    const deps: ContainerAgentSetupDeps = {
      async createInMemoryAuth(input) {
        authInput = input;
        return { kind: 'auth' };
      },
      async createModel() {
        return { kind: 'model' };
      },
      async createSessionManager(input) {
        return { kind: 'session-manager', mode: input.mode };
      },
      async createSession() {
        return { kind: 'session' };
      },
    };

    await setupContainerAgent({
      provider: 'anthropic',
      model: 'claude-3-5-haiku',
      apiKey: '   ',
    }, deps);

    expect(authInput).toEqual({
      provider: 'anthropic',
      apiKey: null,
    });
  });

  it('selects continueRecent when a stable session identity and state directory are available', async () => {
    const sessionStateDir = makeTempDir('cove-v2-agent-setup-continue-');
    let sessionManagerInput: unknown;

    const deps: ContainerAgentSetupDeps = {
      async createInMemoryAuth() {
        return { kind: 'auth' };
      },
      async createModel() {
        return { kind: 'model' };
      },
      async createSessionManager(input) {
        sessionManagerInput = input;
        return { kind: 'session-manager', mode: input.mode };
      },
      async createSession() {
        return { kind: 'session' };
      },
    };

    const result = await setupContainerAgent({
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      apiKey: 'test-api-key',
      sessionId: 'session-stable-1',
      sessionStateDir,
    }, deps);

    expect(resolveSessionManagerMode({ sessionId: 'session-stable-1', sessionStateDir })).toBe('continueRecent');
    expect(result.sessionManagerMode).toBe('continueRecent');
    expect(sessionManagerInput).toEqual({
      mode: 'continueRecent',
      sessionId: 'session-stable-1',
      sessionStateDir,
    });
  });

  it('does not create a session when setup fails during model resolution', async () => {
    const calls: string[] = [];

    const deps: ContainerAgentSetupDeps = {
      async createInMemoryAuth() {
        calls.push('auth');
        return { kind: 'auth' };
      },
      async createModel() {
        calls.push('model');
        return { kind: 'model' };
      },
      async createSessionManager() {
        calls.push('session-manager');
        return { kind: 'session-manager' };
      },
      async createSession() {
        calls.push('session');
        return { kind: 'session' };
      },
    };

    await expect(setupContainerAgent({
      provider: 'auto',
      model: 'missing-provider-prefix',
      apiKey: 'test-api-key',
    }, deps)).rejects.toThrow("Container agent model must include an explicit provider when provider is 'auto'.");

    expect(calls).toEqual([]);
  });

  it('selects in-memory when stable session continuation inputs are incomplete', () => {
    expect(resolveSessionManagerMode({
      sessionId: 'session-stable-1',
      sessionStateDir: path.join(os.tmpdir(), 'cove-v2-agent-setup-missing'),
    })).toBe('in-memory');

    expect(resolveSessionManagerMode({
      sessionId: '',
      sessionStateDir: makeTempDir('cove-v2-agent-setup-in-memory-'),
    })).toBe('in-memory');
  });
});
