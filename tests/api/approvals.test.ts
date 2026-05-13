import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../../src/api/app.ts';
import { migrate } from '../../src/db/migrate.ts';
import { openInboundDb } from '../../src/session/inbound.ts';

const stateDirs: string[] = [];

function makeStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cove-v2-approvals-'));
  stateDirs.push(dir);
  return dir;
}

function insertAgentGroup(db: Database, id: string): void {
  const now = '2026-01-01T00:00:00.000Z';

  db.prepare(
    `INSERT INTO agent_groups (
       id,
       name,
       description,
       workspace,
       provider,
       model,
       thinking,
       permissions,
       soul,
       config,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    'Approvals Agent',
    null,
    '/workspace/approvals',
    'auto',
    'approvals-model',
    'medium',
    '{"default":"auto"}',
    null,
    null,
    now,
    now,
  );
}

function insertSession(db: Database, options: { id: string; agentGroupId: string; sessionFile: string }): void {
  const now = '2026-01-01T00:00:00.000Z';

  db.prepare(
    `INSERT INTO sessions (id, agent_group_id, thread_id, session_file, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(options.id, options.agentGroupId, 'thread-1', options.sessionFile, null, now, now);
}

function insertApprovalRow(db: Database, row: {
  id: string;
  agent_group_id?: string;
  session_id?: string;
  tool_name?: string;
  tool_args?: string | null;
  status?: string;
  requested_at?: string;
  responded_at?: string | null;
  expires_at?: string;
}): void {
  db.prepare(
    `INSERT INTO approvals (
       id,
       agent_group_id,
       session_id,
       tool_name,
       tool_args,
       status,
       requested_at,
       responded_at,
       expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.agent_group_id ?? 'group-1',
    row.session_id ?? 'session-1',
    row.tool_name ?? 'bash',
    row.tool_args ?? null,
    row.status ?? 'pending',
    row.requested_at ?? new Date(Date.now() - 60_000).toISOString(),
    row.responded_at ?? null,
    row.expires_at ?? new Date(Date.now() + 300_000).toISOString(),
  );
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

afterEach(() => {
  delete process.env.COVE_STATE_DIR;

  for (const stateDir of stateDirs.splice(0)) {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

describe('approvals api', () => {
  it('creates, fetches, and lists approvals through /v1/approvals', async () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    const db = new Database(':memory:');
    migrate(db);
    insertAgentGroup(db, 'group-1');
    insertSession(db, {
      id: 'session-1',
      agentGroupId: 'group-1',
      sessionFile: path.join(stateDir, 'sessions', 'group-1', 'session-1'),
    });

    try {
      const app = createApp({ db });
      const createResponse = await app.fetch(
        new Request('http://cove.test/v1/approvals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent_group_id: 'group-1',
            session_id: 'session-1',
            tool_name: 'bash',
            tool_args: { command: 'ls -la' },
          }),
        }),
      );

      expect(createResponse.status).toBe(201);
      const created = await json<Record<string, unknown>>(createResponse);
      expect(created.status).toBe('pending');
      expect(created.tool_args).toEqual({ command: 'ls -la' });

      const id = created.id as string;
      const getResponse = await app.fetch(new Request(`http://cove.test/v1/approvals/${id}`));
      expect(getResponse.status).toBe(200);
      expect((await json<Record<string, unknown>>(getResponse)).id).toBe(id);

      const listResponse = await app.fetch(new Request('http://cove.test/v1/approvals?status=pending'));
      expect(listResponse.status).toBe(200);
      const listed = await json<Array<Record<string, unknown>>>(listResponse);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.id).toBe(id);
    } finally {
      db.close();
    }
  });

  it('deduplicates repeated pending approvals for the same session, tool, and serialized args', async () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    const db = new Database(':memory:');
    migrate(db);
    insertAgentGroup(db, 'group-1');
    insertSession(db, {
      id: 'session-1',
      agentGroupId: 'group-1',
      sessionFile: path.join(stateDir, 'sessions', 'group-1', 'session-1'),
    });

    try {
      const app = createApp({ db });
      const requestBody = {
        agent_group_id: 'group-1',
        session_id: 'session-1',
        tool_name: 'bash',
        tool_args: { command: 'ls -la' },
      };

      const firstResponse = await app.fetch(
        new Request('http://cove.test/v1/approvals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        }),
      );
      const secondResponse = await app.fetch(
        new Request('http://cove.test/v1/approvals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        }),
      );

      expect(firstResponse.status).toBe(201);
      expect(secondResponse.status).toBe(201);

      const first = await json<Record<string, unknown>>(firstResponse);
      const second = await json<Record<string, unknown>>(secondResponse);

      expect(second.id).toBe(first.id);

      const countRow = db.prepare('SELECT COUNT(*) AS count FROM approvals').get() as { count: number };
      expect(countRow.count).toBe(1);
    } finally {
      db.close();
    }
  });

  it('materializes expired pending approvals on get and list', async () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    const db = new Database(':memory:');
    migrate(db);
    insertAgentGroup(db, 'group-1');
    insertSession(db, {
      id: 'session-1',
      agentGroupId: 'group-1',
      sessionFile: path.join(stateDir, 'sessions', 'group-1', 'session-1'),
    });
    insertApprovalRow(db, {
      id: 'expired-approval',
      expires_at: new Date(Date.now() - 1_000).toISOString(),
    });

    try {
      const app = createApp({ db });

      const getResponse = await app.fetch(new Request('http://cove.test/v1/approvals/expired-approval'));
      expect(getResponse.status).toBe(200);
      expect((await json<Record<string, unknown>>(getResponse)).status).toBe('expired');

      const listResponse = await app.fetch(new Request('http://cove.test/v1/approvals'));
      const approvals = await json<Array<Record<string, unknown>>>(listResponse);
      expect(approvals.find((approval) => approval.id === 'expired-approval')?.status).toBe('expired');
    } finally {
      db.close();
    }
  });

  it('approves pending approvals idempotently and enqueues a resume inbound message', async () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    const db = new Database(':memory:');
    migrate(db);
    insertAgentGroup(db, 'group-1');
    const sessionDir = path.join(stateDir, 'sessions', 'group-1', 'session-1');
    insertSession(db, {
      id: 'session-1',
      agentGroupId: 'group-1',
      sessionFile: sessionDir,
    });

    try {
      const app = createApp({ db });
      const createResponse = await app.fetch(
        new Request('http://cove.test/v1/approvals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent_group_id: 'group-1',
            session_id: 'session-1',
            tool_name: 'bash',
            tool_args: { command: 'rm -rf /tmp/demo' },
          }),
        }),
      );
      const created = await json<Record<string, unknown>>(createResponse);
      const id = created.id as string;

      const approveResponse = await app.fetch(
        new Request(`http://cove.test/v1/approvals/${id}/approve`, {
          method: 'POST',
        }),
      );
      expect(approveResponse.status).toBe(200);
      expect((await json<Record<string, unknown>>(approveResponse)).status).toBe('approved');

      const approveAgainResponse = await app.fetch(
        new Request(`http://cove.test/v1/approvals/${id}/approve`, {
          method: 'POST',
        }),
      );
      expect(approveAgainResponse.status).toBe(200);
      expect((await json<Record<string, unknown>>(approveAgainResponse)).status).toBe('approved');

      const inboundDb = openInboundDb(sessionDir);

      try {
        const messages = inboundDb.prepare('SELECT role, content, metadata FROM messages_in ORDER BY seq ASC').all() as Array<{
          role: string;
          content: string;
          metadata: string | null;
        }>;

        expect(messages).toHaveLength(1);
        expect(messages[0]).toEqual({
          role: 'user',
          content: 'Resume approved action.',
          metadata: JSON.stringify({
            type: 'approval_resume',
            approval_id: id,
            tool_name: 'bash',
            tool_args: { command: 'rm -rf /tmp/demo' },
          }),
        });
      } finally {
        inboundDb.close();
      }
    } finally {
      db.close();
    }
  });

  it('declines approvals and rejects expired approvals with 409', async () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    const db = new Database(':memory:');
    migrate(db);
    insertAgentGroup(db, 'group-1');
    insertSession(db, {
      id: 'session-1',
      agentGroupId: 'group-1',
      sessionFile: path.join(stateDir, 'sessions', 'group-1', 'session-1'),
    });
    insertApprovalRow(db, {
      id: 'expired-approval',
      expires_at: new Date(Date.now() - 1_000).toISOString(),
    });

    try {
      const app = createApp({ db });
      const createResponse = await app.fetch(
        new Request('http://cove.test/v1/approvals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent_group_id: 'group-1',
            session_id: 'session-1',
            tool_name: 'write',
          }),
        }),
      );
      const created = await json<Record<string, unknown>>(createResponse);
      const id = created.id as string;

      const declineResponse = await app.fetch(
        new Request(`http://cove.test/v1/approvals/${id}/decline`, {
          method: 'POST',
        }),
      );
      expect(declineResponse.status).toBe(200);
      expect((await json<Record<string, unknown>>(declineResponse)).status).toBe('declined');

      const approveExpiredResponse = await app.fetch(
        new Request('http://cove.test/v1/approvals/expired-approval/approve', {
          method: 'POST',
        }),
      );
      expect(approveExpiredResponse.status).toBe(409);
      expect((await json<Record<string, unknown>>(approveExpiredResponse)).error).toBe('Approval has expired');

      const declineExpiredResponse = await app.fetch(
        new Request('http://cove.test/v1/approvals/expired-approval/decline', {
          method: 'POST',
        }),
      );
      expect(declineExpiredResponse.status).toBe(409);
      expect((await json<Record<string, unknown>>(declineExpiredResponse)).error).toBe('Approval has expired');
    } finally {
      db.close();
    }
  });

  it('returns validation and not-found errors cleanly', async () => {
    const db = new Database(':memory:');
    migrate(db);
    insertAgentGroup(db, 'group-1');
    insertSession(db, {
      id: 'session-1',
      agentGroupId: 'group-1',
      sessionFile: path.join(makeStateDir(), 'sessions', 'group-1', 'session-1'),
    });

    try {
      const app = createApp({ db });

      const invalidJsonResponse = await app.fetch(
        new Request('http://cove.test/v1/approvals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{',
        }),
      );
      expect(invalidJsonResponse.status).toBe(400);
      expect(await json<Record<string, unknown>>(invalidJsonResponse)).toEqual({ error: 'Invalid JSON body' });

      const missingFieldsResponse = await app.fetch(
        new Request('http://cove.test/v1/approvals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent_group_id: 'group-1' }),
        }),
      );
      expect(missingFieldsResponse.status).toBe(400);
      expect(await json<Record<string, unknown>>(missingFieldsResponse)).toEqual({
        error: 'agent_group_id, session_id, and tool_name are required',
      });

      const missingApprovalResponse = await app.fetch(new Request('http://cove.test/v1/approvals/missing-id'));
      expect(missingApprovalResponse.status).toBe(404);
      expect(await json<Record<string, unknown>>(missingApprovalResponse)).toEqual({ error: 'Not Found' });
    } finally {
      db.close();
    }
  });
});
