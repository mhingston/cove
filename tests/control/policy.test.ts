import { beforeEach, describe, expect, it } from 'bun:test';

import { PolicyEngine } from '../../src/control/policy.ts';
import type { ToolPermissionConfig } from '../../src/control/policy.ts';

describe('PolicyEngine defaults', () => {
  let engine: PolicyEngine;

  beforeEach(() => {
    engine = new PolicyEngine();
  });

  it('keeps read, glob, and grep on auto by default', () => {
    expect(engine.getEffectiveTier('read')).toBe('auto');
    expect(engine.getEffectiveTier('glob')).toBe('auto');
    expect(engine.getEffectiveTier('grep')).toBe('auto');
  });

  it('keeps bash on confirm and write on prompt by default', () => {
    expect(engine.getEffectiveTier('bash')).toBe('confirm');
    expect(engine.getEffectiveTier('write')).toBe('prompt');
  });

  it('defaults unknown tools to prompt', () => {
    expect(engine.getEffectiveTier('unknown-tool')).toBe('prompt');
  });

  it('treats git bash commands as auto via the default dynamic rule', () => {
    expect(engine.getEffectiveTier('bash', { command: 'git status' })).toBe('auto');
  });

  it('does not auto-approve mutating git commands by default', () => {
    expect(engine.getEffectiveTier('bash', { command: 'git push' })).toBe('confirm');
  });

  it('keeps rm bash commands on confirm via the default dynamic rule', () => {
    expect(engine.getEffectiveTier('bash', { command: 'rm -rf /tmp/demo' })).toBe('confirm');
  });
});

describe('PolicyEngine configuration and overrides', () => {
  it('merges custom overrides on top of the defaults', () => {
    const config: ToolPermissionConfig = {
      defaultTier: 'confirm',
      overrides: {
        'custom-tool': 'auto',
      },
    };
    const engine = new PolicyEngine(config);

    expect(engine.getEffectiveTier('custom-tool')).toBe('auto');
    expect(engine.getEffectiveTier('bash')).toBe('confirm');
  });

  it('uses the configured default tier for otherwise-unknown tools', () => {
    const engine = new PolicyEngine({ defaultTier: 'auto' });

    expect(engine.getEffectiveTier('brand-new-tool')).toBe('auto');
  });

  it('applies session overrides before dynamic rules and defaults', () => {
    const engine = new PolicyEngine({
      defaultTier: 'confirm',
      overrides: { bash: 'confirm' },
      dynamicRules: [
        {
          name: 'git-safe',
          toolName: 'bash',
          condition: { key: 'command', matches: 'git status' },
          tier: 'auto',
        },
      ],
    });

    engine.setSessionOverride('bash', 'prompt');

    expect(engine.getEffectiveTier('bash', { command: 'git status' })).toBe('prompt');
    expect(engine.getSessionOverrides()).toEqual({ bash: 'prompt' });
  });

  it('clears session overrides cleanly', () => {
    const engine = new PolicyEngine();

    engine.setSessionOverride('bash', 'auto');
    engine.clearSessionOverride('bash');
    expect(engine.getEffectiveTier('bash')).toBe('confirm');

    engine.setSessionOverride('bash', 'auto');
    engine.setSessionOverride('read', 'confirm');
    engine.clearSessionOverrides();
    expect(engine.getSessionOverrides()).toEqual({});
  });
});

describe('PolicyEngine conditions', () => {
  let engine: PolicyEngine;

  beforeEach(() => {
    engine = new PolicyEngine({ defaultTier: 'auto' });
  });

  it('supports exact matches, regex matches, and existence checks', () => {
    expect(engine.evaluateCondition({ key: 'cmd', matches: 'git' }, { cmd: 'git' })).toBe(true);
    expect(engine.evaluateCondition({ key: 'cmd', pattern: '\\brm\\b' }, { cmd: 'rm -rf /' })).toBe(true);
    expect(engine.evaluateCondition({ key: 'flag', exists: true }, { flag: true })).toBe(true);
    expect(engine.evaluateCondition({ key: 'missing', exists: false }, {})).toBe(true);
  });

  it('returns false when no condition branch matches', () => {
    expect(engine.evaluateCondition({ key: 'cmd' }, { cmd: 'git' })).toBe(false);
    expect(engine.evaluateCondition({ key: 'cmd', matches: 'git' }, { cmd: 'ls' })).toBe(false);
  });

  it('prefers the most restrictive matching dynamic rule', () => {
    const restrictive = new PolicyEngine({
      defaultTier: 'prompt',
      overrides: { bash: 'prompt' },
      dynamicRules: [
        {
          name: 'git-safe',
          toolName: 'bash',
          condition: { key: 'command', pattern: '\\bgit\\b' },
          tier: 'auto',
        },
        {
          name: 'git-rm-dangerous',
          toolName: 'bash',
          condition: { key: 'command', pattern: '\\brm\\b' },
          tier: 'confirm',
        },
      ],
    });

    expect(restrictive.getEffectiveTier('bash', { command: 'git rm file.txt' })).toBe('confirm');
  });
});
