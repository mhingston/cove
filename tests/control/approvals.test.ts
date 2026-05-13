import { beforeEach, describe, expect, it } from 'bun:test';

import { ApprovalStoreInMemory, NotFoundError } from '../../src/control/approvals.ts';
import type { ApprovalRecord } from '../../src/control/approvals.ts';

describe('ApprovalStoreInMemory', () => {
  let store: ApprovalStoreInMemory;

  beforeEach(() => {
    store = new ApprovalStoreInMemory();
  });

  it('creates pending approval records with the provided tool details', () => {
    const record = store.create({
      agent_group_id: 'group-1',
      session_id: 'session-1',
      tool_name: 'bash',
      tool_args: { command: 'ls -la' },
    });

    expect(record.id).toBeTruthy();
    expect(record.status).toBe('pending');
    expect(record.tool_args).toEqual({ command: 'ls -la' });
    expect(record.responded_at).toBeUndefined();
  });

  it('gets and lists records with optional filters', () => {
    const first = store.create({ agent_group_id: 'group-1', session_id: 'session-1', tool_name: 'bash' });
    store.create({ agent_group_id: 'group-2', session_id: 'session-2', tool_name: 'write' });

    expect(store.get(first.id)?.id).toBe(first.id);
    expect(store.get('missing-id')).toBeNull();
    expect(store.list()).toHaveLength(2);
    expect(store.list({ agent_group_id: 'group-1' })).toHaveLength(1);
    expect(store.list({ status: 'pending' })).toHaveLength(2);
  });

  it('approves and declines pending records exactly once', async () => {
    const approvedRecord = store.create({
      agent_group_id: 'group-1',
      session_id: 'session-1',
      tool_name: 'bash',
    });
    const approved = store.approve(approvedRecord.id);

    expect(approved.status).toBe('approved');
    expect(approved.responded_at).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 5));
    const approvedAgain = store.approve(approvedRecord.id);
    expect(approvedAgain.responded_at).toBe(approved.responded_at);

    const declinedRecord = store.create({
      agent_group_id: 'group-1',
      session_id: 'session-1',
      tool_name: 'write',
    });
    const declined = store.decline(declinedRecord.id);

    expect(declined.status).toBe('declined');
    expect(declined.responded_at).toBeTruthy();
    expect(store.decline(declinedRecord.id).responded_at).toBe(declined.responded_at);
  });

  it('preserves an already-approved record when decline is called later', () => {
    const record = store.create({
      agent_group_id: 'group-1',
      session_id: 'session-1',
      tool_name: 'bash',
    });
    const approved = store.approve(record.id);
    const declined = store.decline(record.id);

    expect(declined.status).toBe('approved');
    expect(declined.responded_at).toBe(approved.responded_at);
  });

  it('throws NotFoundError for missing ids', () => {
    expect(() => store.approve('missing-id')).toThrow(NotFoundError);
    expect(() => store.decline('missing-id')).toThrow(NotFoundError);
  });

  it('treats old pending records as expired', () => {
    const oldRecord: ApprovalRecord = {
      id: 'old-id',
      agent_group_id: 'group-1',
      session_id: 'session-1',
      tool_name: 'bash',
      status: 'pending',
      requested_at: new Date(Date.now() - 600_000).toISOString(),
    };

    expect(store.isExpired(oldRecord)).toBe(true);
  });

  it('throws when trying to respond to expired records', () => {
    const record = store.create({
      agent_group_id: 'group-1',
      session_id: 'session-1',
      tool_name: 'bash',
    });

    store.isExpired = () => true;

    expect(() => store.approve(record.id)).toThrow(/expired/i);
    expect(() => store.decline(record.id)).toThrow(/expired/i);
  });
});
