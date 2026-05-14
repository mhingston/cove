import { afterEach, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';

import { getDb } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { resolvePort, routeApiRequest, startApiServer } from '../../src/api/server.ts';
import { createSchedule } from '../../src/jobs/schedules.ts';
import {
  createWikiEntry,
  hybridSearchWikiEntries,
  listWikiEntries,
  readWikiFile,
  type WikiFileRecord,
} from '../../src/knowledge/wiki.ts';
import { openStreamRelay } from '../../src/stream-relay.ts';

const stateDirs: string[] = [];

afterEach(() => {
  delete process.env.COVE_STATE_DIR;

  for (const stateDir of stateDirs.splice(0)) {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

function makeStateDir(): string {
  const stateDir = Bun.pathToFileURL(Bun.env.TMPDIR ?? '/tmp').pathname;
  const dir = `${stateDir}cove-v2-api-${crypto.randomUUID()}`;
  stateDirs.push(dir);
  return dir;
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

function createWikiDb(): ReturnType<typeof getDb> {
  process.env.COVE_STATE_DIR = makeStateDir();

  const db = getDb();
  migrate(db);
  return db;
}

describe('API server', () => {
  it('routes GET /healthz via the server routing entry point', async () => {
    const response = await routeApiRequest(new Request('http://cove.test/healthz'), {
      db: {} as ReturnType<typeof getDb>,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, phase: 'Phase 5' });
  });

  it('returns the plan-aligned health payload from GET /healthz', async () => {
    process.env.COVE_STATE_DIR = makeStateDir();

    const db = getDb();
    migrate(db);

    const server = startApiServer({ db, port: 0 });

    try {
      const response = await fetch(`http://${server.hostname}:${server.port}/healthz`);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, phase: 'Phase 5' });
    } finally {
      await server.stop();
      db.close();
    }
  });

  it('returns the not found payload for an unknown path', async () => {
    process.env.COVE_STATE_DIR = makeStateDir();

    const db = getDb();
    migrate(db);

    const server = startApiServer({ db, port: 0 });

    try {
      const response = await fetch(`http://${server.hostname}:${server.port}/unknown`);

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Not Found' });
    } finally {
      await server.stop();
      db.close();
    }
  });

  it('returns the not found payload for the wrong method on a known route', async () => {
    process.env.COVE_STATE_DIR = makeStateDir();

    const db = getDb();
    migrate(db);

    const server = startApiServer({ db, port: 0 });

    try {
      const response = await fetch(`http://${server.hostname}:${server.port}/healthz`, {
        method: 'POST',
      });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Not Found' });
    } finally {
      await server.stop();
      db.close();
    }
  });

  it('routes the schedule CRUD and run endpoints through the server routing entry point', async () => {
    process.env.COVE_STATE_DIR = makeStateDir();

    const db = getDb();
    migrate(db);
    db.prepare(
      `INSERT INTO agent_groups (
         id,
         name,
         workspace,
         provider,
         model,
         thinking,
         permissions,
         soul,
         config,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'support',
      'Support Agent',
      '/workspace/support',
      'anthropic',
      'support-model',
      'medium',
      '{"default":"ask"}',
      null,
      null,
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );
    const schedule = createSchedule({
      db,
      input: {
        agent_group_id: 'support',
        cron_expr: '0 9 * * *',
        prompt: 'Server test schedule',
      },
      now: '2026-01-15T08:00:00.000Z',
    });

    try {
      const listResponse = await routeApiRequest(new Request('http://cove.test/v1/schedules', { method: 'GET' }), { db });
      const createResponse = await routeApiRequest(new Request('http://cove.test/v1/schedules', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent_group_id: 'support',
            cron_expr: '0 10 * * *',
            prompt: 'Created through route test',
          }),
        }), { db });
      const getResponse = await routeApiRequest(new Request(`http://cove.test/v1/schedules/${schedule.id}`, { method: 'GET' }), {
        db,
      });
      const updateResponse = await routeApiRequest(new Request(`http://cove.test/v1/schedules/${schedule.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: 'Updated through route test' }),
        }), { db });
      const runResponse = await routeApiRequest(new Request(`http://cove.test/v1/schedules/${schedule.id}/run`, { method: 'POST' }), {
        db,
        runAgentPrompt: async (options) => ({
          content: `Ran ${options.schedule.id}`,
          sessionId: 'session-1',
          threadId: `schedule:${options.schedule.id}`,
          lastRunAt: '2026-01-15T09:00:00.000Z',
        }),
      });
      const deleteResponse = await routeApiRequest(new Request(`http://cove.test/v1/schedules/${schedule.id}`, { method: 'DELETE' }), {
        db,
      });

      expect([
        listResponse.status,
        createResponse.status,
        getResponse.status,
        updateResponse.status,
        runResponse.status,
        deleteResponse.status,
      ]).toEqual([200, 201, 200, 200, 200, 204]);
    } finally {
      db.close();
    }
  });

  it('accepts internal relay chunk, complete, and error callbacks through the API surface', async () => {
    process.env.COVE_STATE_DIR = makeStateDir();

    const db = getDb();
    migrate(db);

    const relay = openStreamRelay('http://127.0.0.1:4111');
    const iterator = relay.stream[Symbol.asyncIterator]();

    try {
      const chunkResponse = await routeApiRequest(
        new Request(`http://cove.test/internal/streams/${relay.id}/chunk`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: 'Hello' }),
        }),
        { db },
      );

      expect(chunkResponse.status).toBe(204);
      expect(await iterator.next()).toEqual({ value: 'Hello', done: false });

      const completeResponse = await routeApiRequest(
        new Request(`http://cove.test/internal/streams/${relay.id}/complete`, {
          method: 'POST',
        }),
        { db },
      );

      expect(completeResponse.status).toBe(204);
      expect(await iterator.next()).toEqual({ value: undefined, done: true });
    } finally {
      db.close();
    }
  });

  it('resolves PORT first, then COVE_PORT, then defaults to 4111', () => {
    expect(resolvePort({})).toBe(4111);
    expect(resolvePort({ COVE_PORT: '4222' })).toBe(4222);
    expect(resolvePort({ PORT: '4333', COVE_PORT: '4222' })).toBe(4333);
  });

  it('falls back to 4111 for malformed, negative, and out-of-range ports', () => {
    expect(resolvePort({ PORT: 'abc' })).toBe(4111);
    expect(resolvePort({ PORT: '-1' })).toBe(4111);
    expect(resolvePort({ PORT: '0' })).toBe(4111);
    expect(resolvePort({ PORT: '65536' })).toBe(4111);
    expect(resolvePort({ PORT: '4111abc' })).toBe(4111);
  });

  it('falls back to a valid COVE_PORT when PORT is invalid, empty, or whitespace', () => {
    expect(resolvePort({ PORT: 'abc', COVE_PORT: '4222' })).toBe(4222);
    expect(resolvePort({ PORT: '', COVE_PORT: '4222' })).toBe(4222);
    expect(resolvePort({ PORT: '   ', COVE_PORT: '4222' })).toBe(4222);
  });

  it('returns a client-safe hostname for callers', async () => {
    process.env.COVE_STATE_DIR = makeStateDir();

    const db = getDb();
    migrate(db);

    const server = startApiServer({ db, port: 0 });

    try {
      expect(server.hostname).toBe('127.0.0.1');
    } finally {
      await server.stop();
      db.close();
    }
  });

  it('binds the API server to loopback when reporting a loopback hostname', async () => {
    const stop = mock(() => Promise.resolve());
    const serveSpy = mock((options: { port: number; hostname?: string }) => ({
      port: 4111,
      stop,
    }));
    const originalServe = Bun.serve;

    Bun.serve = serveSpy as unknown as typeof Bun.serve;

    try {
      const server = startApiServer({ db: {} as ReturnType<typeof getDb>, port: 0 });

      expect(server.hostname).toBe('127.0.0.1');
      expect(serveSpy).toHaveBeenCalledWith(
        expect.objectContaining({ hostname: '127.0.0.1', port: 0 }),
      );

      await server.stop();
    } finally {
      Bun.serve = originalServe;
    }
  });

  it('stops serving requests after stop is called', async () => {
    process.env.COVE_STATE_DIR = makeStateDir();

    const db = getDb();
    migrate(db);

    const server = startApiServer({ db, port: 0 });
    const url = `http://${server.hostname}:${server.port}/healthz`;

    try {
      const response = await fetch(url);
      expect(response.status).toBe(200);
    } finally {
      await server.stop();
    }

    try {
      await expect(fetch(url)).rejects.toThrow();
    } finally {
      db.close();
    }
  });

  it('threads optional chat context into routed API requests', async () => {
    process.env.COVE_STATE_DIR = makeStateDir();

    const db = getDb();
    migrate(db);
    db.prepare(
      `INSERT INTO agent_groups (
         id,
         name,
         workspace,
         provider,
         model,
         thinking,
         permissions,
         soul,
         config,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'default',
      'Default Agent',
      '/workspace/default',
      'anthropic',
      'group-model',
      'medium',
      '{"default":"ask"}',
      'soul-default',
      '{"api_key":"sk-test"}',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );

    const server = startApiServer({
      db,
      port: 0,
      chat: {
        async ensureSessionRuntime() {
          return false;
        },
      },
    });

    try {
      const response = await fetch(`http://${server.hostname}:${server.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      });

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'Container runtime unavailable' });
    } finally {
      await server.stop();
      db.close();
    }
  });

  describe('wiki routes', () => {
    it('returns 201 and the unchanged WikiFileRecord JSON shape from POST /v1/wiki', async () => {
      const db = createWikiDb();

      try {
        const response = await routeApiRequest(
          new Request('http://cove.test/v1/wiki', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              slug: 'beach-guide',
              title: 'Beach Guide',
              content: 'Packing and planning notes',
              tags: ['travel', 'beach'],
              provenance: 'human',
              created_by: 'alice',
            }),
          }),
          { db },
        );

        expect(response.status).toBe(201);
        const createdEntry = readWikiFile('beach-guide');

        if (createdEntry == null) {
          throw new Error('Expected POST /v1/wiki to create a file-backed wiki entry');
        }

        expect(await json<WikiFileRecord>(response)).toEqual(createdEntry);
      } finally {
        db.close();
      }
    });

    it('returns 409 with a JSON error when POST /v1/wiki attempts to create a duplicate slug', async () => {
      const db = createWikiDb();

      try {
        createWikiEntry({
          slug: 'beach-guide',
          title: 'Beach Guide',
          content: 'Packing and planning notes',
          db,
        });

        const response = await routeApiRequest(
          new Request('http://cove.test/v1/wiki', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              slug: 'beach-guide',
              title: 'Duplicate Beach Guide',
              content: 'Duplicate content',
            }),
          }),
          { db },
        );

        expect(response.status).toBe(409);
        expect(await json<{ error: string }>(response)).toEqual({ error: expect.any(String) });
      } finally {
        db.close();
      }
    });

    it('returns 400 with a JSON error when POST /v1/wiki receives invalid JSON', async () => {
      const db = createWikiDb();

      try {
        const response = await routeApiRequest(
          new Request('http://cove.test/v1/wiki', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{"slug":"beach-guide"',
          }),
          { db },
        );

        expect(response.status).toBe(400);
        expect(await json<{ error: string }>(response)).toEqual({ error: expect.any(String) });
      } finally {
        db.close();
      }
    });

    it('returns 400 when POST /v1/wiki receives a null payload', async () => {
      const db = createWikiDb();

      try {
        const response = await routeApiRequest(
          new Request('http://cove.test/v1/wiki', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(null),
          }),
          { db },
        );

        expect(response.status).toBe(400);
        expect(await json<{ error: string }>(response)).toEqual({ error: expect.any(String) });
      } finally {
        db.close();
      }
    });

    it('returns 400 when POST /v1/wiki receives an array or other non-object payload', async () => {
      const db = createWikiDb();

      try {
        for (const payload of [[], 'beach-guide', 42, true]) {
          const response = await routeApiRequest(
            new Request('http://cove.test/v1/wiki', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            }),
            { db },
          );

          expect(response.status).toBe(400);
          expect(await json<{ error: string }>(response)).toEqual({ error: expect.any(String) });
        }
      } finally {
        db.close();
      }
    });

    it('returns 400 when POST /v1/wiki receives missing required fields or wrong field types', async () => {
      const db = createWikiDb();

      try {
        for (const payload of [
          { slug: 'beach-guide', content: 'Packing and planning notes' },
          { slug: 123, title: 'Beach Guide', content: 'Packing and planning notes' },
          { slug: 'beach-guide', title: false, content: 'Packing and planning notes' },
          { slug: 'beach-guide', title: 'Beach Guide', content: { body: 'notes' } },
        ]) {
          const response = await routeApiRequest(
            new Request('http://cove.test/v1/wiki', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            }),
            { db },
          );

          expect(response.status).toBe(400);
          expect(await json<{ error: string }>(response)).toEqual({ error: expect.any(String) });
        }
      } finally {
        db.close();
      }
    });

    it('returns 400 when POST /v1/wiki receives non-string provenance or created_by', async () => {
      const db = createWikiDb();

      try {
        for (const payload of [
          {
            slug: 'beach-guide',
            title: 'Beach Guide',
            content: 'Packing and planning notes',
            provenance: { source: 'human' },
          },
          {
            slug: 'beach-guide',
            title: 'Beach Guide',
            content: 'Packing and planning notes',
            created_by: ['alice'],
          },
        ]) {
          const response = await routeApiRequest(
            new Request('http://cove.test/v1/wiki', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            }),
            { db },
          );

          expect(response.status).toBe(400);
          expect(await json<{ error: string }>(response)).toEqual({ error: expect.any(String) });
        }
      } finally {
        db.close();
      }
    });

    it('returns 400 when POST /v1/wiki receives invalid tags shapes or content', async () => {
      const db = createWikiDb();

      try {
        for (const payload of [
          {
            slug: 'beach-guide',
            title: 'Beach Guide',
            content: 'Packing and planning notes',
            tags: 'travel',
          },
          {
            slug: 'beach-guide',
            title: 'Beach Guide',
            content: 'Packing and planning notes',
            tags: ['travel', 123],
          },
        ]) {
          const response = await routeApiRequest(
            new Request('http://cove.test/v1/wiki', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            }),
            { db },
          );

          expect(response.status).toBe(400);
          expect(await json<{ error: string }>(response)).toEqual({ error: expect.any(String) });
        }
      } finally {
        db.close();
      }
    });

    it('returns 400 when POST /v1/wiki receives multiline metadata fields', async () => {
      const db = createWikiDb();

      try {
        for (const payload of [
          {
            slug: 'beach-guide-title',
            title: 'Beach\nGuide',
            content: 'Packing and planning notes',
          },
          {
            slug: 'beach-guide-provenance',
            title: 'Beach Guide',
            content: 'Packing and planning notes',
            provenance: 'human\nsource',
          },
          {
            slug: 'beach-guide-created-by',
            title: 'Beach Guide',
            content: 'Packing and planning notes',
            created_by: 'alice\nbob',
          },
          {
            slug: 'beach-guide-tags',
            title: 'Beach Guide',
            content: 'Packing and planning notes',
            tags: ['travel', 'beach\ntrip'],
          },
        ]) {
          const response = await routeApiRequest(
            new Request('http://cove.test/v1/wiki', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            }),
            { db },
          );

          expect(response.status).toBe(400);
          expect(await json<{ error: string }>(response)).toEqual({ error: expect.any(String) });
        }
      } finally {
        db.close();
      }
    });

    it('returns 400 when POST /v1/wiki receives an unsafe slug', async () => {
      const db = createWikiDb();

      try {
        for (const slug of ['../x', 'nested/path']) {
          const response = await routeApiRequest(
            new Request('http://cove.test/v1/wiki', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                slug,
                title: 'Unsafe Wiki',
                content: 'Packing and planning notes',
              }),
            }),
            { db },
          );

          expect(response.status).toBe(400);
          expect(await json<{ error: string }>(response)).toEqual({ error: expect.any(String) });
        }
      } finally {
        db.close();
      }
    });

    it('returns 500 with a client-safe JSON error when POST /v1/wiki hits an unexpected create failure', async () => {
      const db = createWikiDb();
      db.close();

      const response = await routeApiRequest(
        new Request('http://cove.test/v1/wiki', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            slug: 'beach-guide',
            title: 'Beach Guide',
            content: 'Packing and planning notes',
          }),
        }),
        { db },
      );

      expect(response.status).toBe(500);
      expect(await json<{ error: string }>(response)).toEqual({ error: expect.any(String) });
    });

    it('returns the list order from listWikiEntries on GET /v1/wiki without q', async () => {
      const db = createWikiDb();

      try {
        createWikiEntry({
          slug: 'beach-guide',
          title: 'Beach Guide',
          content: 'Packing and planning notes',
          db,
        });
        createWikiEntry({
          slug: 'mountain-guide',
          title: 'Mountain Guide',
          content: 'Layering and route notes',
          db,
        });

        const response = await routeApiRequest(new Request('http://cove.test/v1/wiki'), { db });

        expect(response.status).toBe(200);
        expect(await json<WikiFileRecord[]>(response)).toEqual(listWikiEntries(db));
      } finally {
        db.close();
      }
    });

    it('returns the search order from hybridSearchWikiEntries on GET /v1/wiki with a non-blank q', async () => {
      const db = createWikiDb();

      try {
        createWikiEntry({
          slug: 'beach-guide',
          title: 'Beach Guide',
          content: 'Packing and planning notes',
          tags: ['travel', 'beach'],
          db,
        });
        createWikiEntry({
          slug: 'beach-workout',
          title: 'Beach Workout',
          content: 'Sand sprints and beach conditioning',
          tags: ['fitness'],
          db,
        });
        createWikiEntry({
          slug: 'mountain-guide',
          title: 'Mountain Guide',
          content: 'Layering and route notes',
          tags: ['travel'],
          db,
        });

        const expected = await hybridSearchWikiEntries('beach', db);
        const response = await routeApiRequest(new Request('http://cove.test/v1/wiki?q=beach'), { db });

        expect(expected.length).toBeGreaterThan(0);
        expect(response.status).toBe(200);
        expect(await json<WikiFileRecord[]>(response)).toEqual(expected);
      } finally {
        db.close();
      }
    });

    it('treats blank and whitespace q values on GET /v1/wiki as list behavior', async () => {
      const db = createWikiDb();

      try {
        createWikiEntry({
          slug: 'beach-guide',
          title: 'Beach Guide',
          content: 'Packing and planning notes',
          db,
        });
        createWikiEntry({
          slug: 'mountain-guide',
          title: 'Mountain Guide',
          content: 'Layering and route notes',
          db,
        });

        const expected = listWikiEntries(db);

        for (const url of [
          'http://cove.test/v1/wiki?q=',
          'http://cove.test/v1/wiki?q=%20%20%20',
        ]) {
          const response = await routeApiRequest(new Request(url), { db });

          expect(response.status).toBe(200);
          expect(await json<WikiFileRecord[]>(response)).toEqual(expected);
        }
      } finally {
        db.close();
      }
    });

    it('matches GET /v1/wiki?q=... when GET /v1/wiki/search receives a non-blank q', async () => {
      const db = createWikiDb();

      try {
        createWikiEntry({
          slug: 'beach-guide',
          title: 'Beach Guide',
          content: 'Packing and planning notes',
          tags: ['travel', 'beach'],
          db,
        });
        createWikiEntry({
          slug: 'beach-workout',
          title: 'Beach Workout',
          content: 'Sand sprints and beach conditioning',
          db,
        });

        const listSearchResponse = await routeApiRequest(new Request('http://cove.test/v1/wiki?q=beach'), { db });
        const aliasSearchResponse = await routeApiRequest(new Request('http://cove.test/v1/wiki/search?q=beach'), {
          db,
        });

        expect(listSearchResponse.status).toBe(200);
        expect(aliasSearchResponse.status).toBe(200);
        expect(await json<WikiFileRecord[]>(aliasSearchResponse)).toEqual(
          await json<WikiFileRecord[]>(listSearchResponse),
        );
      } finally {
        db.close();
      }
    });

    it('treats blank and whitespace q values on GET /v1/wiki/search as list behavior', async () => {
      const db = createWikiDb();

      try {
        createWikiEntry({
          slug: 'beach-guide',
          title: 'Beach Guide',
          content: 'Packing and planning notes',
          db,
        });
        createWikiEntry({
          slug: 'mountain-guide',
          title: 'Mountain Guide',
          content: 'Layering and route notes',
          db,
        });

        const expected = listWikiEntries(db);

        for (const url of [
          'http://cove.test/v1/wiki/search',
          'http://cove.test/v1/wiki/search?q=',
          'http://cove.test/v1/wiki/search?q=%20%20%20',
        ]) {
          const response = await routeApiRequest(new Request(url), { db });

          expect(response.status).toBe(200);
          expect(await json<WikiFileRecord[]>(response)).toEqual(expected);
        }
      } finally {
        db.close();
      }
    });

    it('returns 500 with a client-safe JSON error when GET wiki routes hit unexpected failures', async () => {
      const db = createWikiDb();
      db.close();

      for (const url of [
        'http://cove.test/v1/wiki',
        'http://cove.test/v1/wiki?q=beach',
        'http://cove.test/v1/wiki/search?q=beach',
      ]) {
        const response = await routeApiRequest(new Request(url), { db });

        expect(response.status).toBe(500);
        expect(await json<{ error: string }>(response)).toEqual({ error: expect.any(String) });
      }
    });
  });
});
