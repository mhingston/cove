import { beforeEach, describe, expect, it } from 'bun:test';

import { ApprovalStoreInMemory } from '../../src/control/approvals.ts';
import { PermissionToolWrapper, createPermissionHandler } from '../../src/control/permission-wrapper.ts';
import { PermissionBridgeImpl } from '../../src/control/permissions.ts';
import { PolicyEngine } from '../../src/control/policy.ts';
import type { ApprovalResult, PermissionRequest } from '../../src/control/permissions.ts';

describe('PermissionToolWrapper', () => {
  let bridge: PermissionBridgeImpl;
  let store: ApprovalStoreInMemory;
  let wrapper: PermissionToolWrapper;

  beforeEach(() => {
    bridge = new PermissionBridgeImpl();
    store = new ApprovalStoreInMemory();
    wrapper = new PermissionToolWrapper(bridge, store);
  });

  it('runs auto-tier tools immediately and annotates the result', async () => {
    const wrapped = wrapper.wrapTool('read', async () => ({ content: 'executed' }));

    await expect(wrapped({ path: '/tmp/demo.txt' })).resolves.toEqual({
      content: 'executed',
      permission: 'auto',
    });
  });

  it('returns a clarification message for prompt-tier tools without executing them', async () => {
    let executed = false;

    bridge.setApprovalHandler(async () => 'approved');
    bridge.setSessionOverride('write', 'prompt');

    const wrapped = wrapper.wrapTool('write', async () => {
      executed = true;
      return { content: 'written' };
    });
    const result = await wrapped({ path: '/tmp/demo.txt' });

    expect(result.permission).toBe('prompt');
    expect(result.content).toContain('requires confirmation from the user');
    expect(executed).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it('returns a pending approval message for declined confirm-tier tools without executing them', async () => {
    let executed = false;

    bridge.setApprovalHandler(async () => 'declined');
    bridge.setSessionOverride('bash', 'confirm');

    const wrapped = wrapper.wrapTool('bash', async () => {
      executed = true;
      return { content: 'executed' };
    });
    const result = await wrapped({ command: 'rm -rf /tmp/demo' });

    expect(result.permission).toBe('pending');
    expect(result.content).toContain('pending approval');
    expect(executed).toBe(false);
  });

  it('executes confirm-tier tools when the handler approves them', async () => {
    bridge.setApprovalHandler(async () => 'approved');
    bridge.setSessionOverride('bash', 'confirm');

    const wrapped = wrapper.wrapTool('bash', async () => ({ content: 'executed' }));

    await expect(wrapped({ command: 'ls -la' })).resolves.toEqual({
      content: 'executed',
      permission: 'approved',
    });
  });

  it('creates exactly one pending approval record via createPermissionHandler', async () => {
    bridge.setApprovalHandler(createPermissionHandler(store, 'group-1', 'session-1'));
    bridge.setSessionOverride('bash', 'confirm');

    const wrapped = wrapper.wrapTool('bash', async () => ({ content: 'executed' }));
    const result = await wrapped({ command: 'ls -la' });

    expect(result.permission).toBe('pending');
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]).toMatchObject({
      agent_group_id: 'group-1',
      session_id: 'session-1',
      tool_name: 'bash',
      status: 'pending',
    });
  });

  it('respects policy-driven dynamic rules when wrapping tools', async () => {
    const policy = new PolicyEngine({
      overrides: { bash: 'confirm' },
      dynamicRules: [
        {
          name: 'git-safe',
          toolName: 'bash',
          condition: { key: 'command', pattern: '^git' },
          tier: 'auto',
        },
      ],
    });
    const policyBridge = new PermissionBridgeImpl({ policy });
    policyBridge.setApprovalHandler(createPermissionHandler(store, 'group-1', 'session-1'));
    const policyWrapper = new PermissionToolWrapper(policyBridge, store);

    const wrapped = policyWrapper.wrapTool('bash', async () => ({ content: 'executed' }));

    await expect(wrapped({ command: 'git status' })).resolves.toEqual({
      content: 'executed',
      permission: 'auto',
    });
  });
});

describe('createPermissionHandler', () => {
  let store: ApprovalStoreInMemory;

  beforeEach(() => {
    store = new ApprovalStoreInMemory();
  });

  it('stores confirm-tier requests as pending approvals', async () => {
    const handler = createPermissionHandler(store, 'group-1', 'session-1');
    const request: PermissionRequest = {
      toolName: 'bash',
      args: { command: 'ls -la' },
      tier: 'confirm',
      id: 'perm-1',
      timestamp: Date.now(),
    };

    await expect(handler(request)).resolves.toBe('declined');
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.tool_args).toEqual({ command: 'ls -la' });
  });

  it('does not persist prompt-tier requests in the approval store', async () => {
    const handler = createPermissionHandler(store, 'group-1', 'session-1');
    const request: PermissionRequest = {
      toolName: 'write',
      args: { path: '/tmp/demo.txt' },
      tier: 'prompt',
      id: 'perm-2',
      timestamp: Date.now(),
    };

    const result: ApprovalResult = await handler(request);

    expect(result).toBe('declined');
    expect(store.list()).toEqual([]);
  });

  it('defensively declines auto-tier requests without persisting them', async () => {
    const handler = createPermissionHandler(store, 'group-1', 'session-1');

    await expect(
      handler({
        toolName: 'read',
        args: { path: '/tmp/demo.txt' },
        tier: 'auto',
        id: 'perm-3',
        timestamp: Date.now(),
      }),
    ).resolves.toBe('declined');
    expect(store.list()).toEqual([]);
  });
});
