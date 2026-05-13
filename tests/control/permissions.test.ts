import { beforeEach, describe, expect, it } from 'bun:test';

import { PermissionBridgeImpl } from '../../src/control/permissions.ts';
import type {
  ApprovalHandler,
  ApprovalResult,
  PermissionRequest,
  PermissionTier,
} from '../../src/control/permissions.ts';

describe('PermissionBridgeImpl', () => {
  let bridge: PermissionBridgeImpl;

  beforeEach(() => {
    bridge = new PermissionBridgeImpl();
  });

  it('allows auto-tier tools without an approval handler', async () => {
    await expect(bridge.check('read', { path: '/tmp/demo.txt' })).resolves.toBe(true);
  });

  it('routes confirm-tier tools through the approval handler', async () => {
    let captured: PermissionRequest | undefined;

    bridge.setApprovalHandler(async (request) => {
      captured = request;
      return 'approved';
    });

    await expect(bridge.check('bash', { command: 'ls -la' })).resolves.toBe(true);
    expect(captured?.toolName).toBe('bash');
    expect(captured?.tier).toBe('confirm');
    expect(captured?.args).toEqual({ command: 'ls -la' });
  });

  it('returns false when a non-auto tool is declined', async () => {
    bridge.setApprovalHandler(async () => 'declined');

    await expect(bridge.check('bash', { command: 'rm -rf /tmp/demo' })).resolves.toBe(false);
  });

  it('uses session overrides when resolving a tier', () => {
    bridge.setSessionOverride('bash', 'auto');

    expect(bridge.getTier('bash')).toBe('auto');
    expect(bridge.getSessionOverrides()).toEqual({ bash: 'auto' });
  });

  it('clears a single override and falls back to the builtin tier', () => {
    bridge.setSessionOverride('bash', 'auto');
    bridge.clearSessionOverride('bash');

    expect(bridge.getTier('bash')).toBe('confirm');
  });

  it('clears all overrides at once', () => {
    bridge.setSessionOverride('bash', 'auto');
    bridge.setSessionOverride('read', 'confirm');
    bridge.clearSessionOverrides();

    expect(bridge.getSessionOverrides()).toEqual({});
  });

  it('throws for non-auto checks when no approval handler is configured', async () => {
    await expect(bridge.check('bash', { command: 'pwd' })).rejects.toThrow('No approval handler set');
  });

  it('requestApproval forwards the explicit request to the handler', async () => {
    let captured: PermissionRequest | undefined;

    bridge.setApprovalHandler(async (request) => {
      captured = request;
      return 'approved';
    });

    await expect(
      bridge.requestApproval({
        toolName: 'bash',
        args: { command: 'pwd' },
        tier: 'confirm',
        id: 'perm-1',
        timestamp: 123,
      }),
    ).resolves.toBe('approved');
    expect(captured?.id).toBe('perm-1');
  });

  it('requestApproval bypasses the handler when autoApprove is true', async () => {
    let called = false;

    bridge.setApprovalHandler(async () => {
      called = true;
      return 'approved';
    });

    await expect(
      bridge.requestApproval(
        {
          toolName: 'bash',
          args: { command: 'pwd' },
          tier: 'confirm',
          id: 'perm-1',
          timestamp: 123,
        },
        true,
      ),
    ).resolves.toBe('approved');
    expect(called).toBe(false);
  });

  it('emits fresh unique request ids for handler-backed checks', async () => {
    const requests: PermissionRequest[] = [];

    bridge.setApprovalHandler(async (request) => {
      requests.push(request);
      return 'approved';
    });

    bridge.setSessionOverride('tool-a', 'confirm');
    bridge.setSessionOverride('tool-b', 'confirm');

    await bridge.check('tool-a', {});
    await bridge.check('tool-b', {});

    expect(requests).toHaveLength(2);
    expect(requests[0]?.id).not.toBe(requests[1]?.id);
    expect(typeof requests[0]?.timestamp).toBe('number');
  });

  it('accepts replacing the approval handler', async () => {
    const first: ApprovalHandler = async () => 'declined';
    const second: ApprovalHandler = async () => 'approved';

    bridge.setApprovalHandler(first);
    bridge.setApprovalHandler(second);
    bridge.setSessionOverride('custom-tool', 'confirm');

    await expect(bridge.check('custom-tool', {})).resolves.toBe(true);
  });

  it('passes prompt-tier requests through the handler with the prompt tier attached', async () => {
    let receivedTier: PermissionTier | undefined;

    bridge.setApprovalHandler(async (request) => {
      receivedTier = request.tier;
      return 'approved';
    });
    bridge.setSessionOverride('write', 'prompt');

    await bridge.check('write', { path: '/tmp/demo.txt' });

    expect(receivedTier).toBe('prompt');
  });

  it('supports ApprovalResult typing in handlers', async () => {
    const results: ApprovalResult[] = [];

    bridge.setApprovalHandler(async () => {
      results.push('approved');
      return 'approved';
    });
    bridge.setSessionOverride('custom-tool', 'confirm');

    await bridge.check('custom-tool', {});

    expect(results).toEqual(['approved']);
  });
});
