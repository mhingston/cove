import { afterEach, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';

import { getDb } from '../../src/db/index.ts';
import { migrate } from '../../src/db/migrate.ts';
import { resolvePort, routeApiRequest, startApiServer } from '../../src/api/server.ts';
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
});
