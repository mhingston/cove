import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../../src/api/app.ts';
import { migrate } from '../../src/db/migrate.ts';
import {
  createWikiEntry,
  readWikiFile,
  type WikiFileRecord,
} from '../../src/knowledge/wiki.ts';

const stateDirs: string[] = [];

function makeStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cove-v2-wiki-api-'));
  stateDirs.push(dir);
  return dir;
}

function createWikiDb(): Database {
  const db = new Database(':memory:');
  migrate(db);
  return db;
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

describe('wiki api', () => {
  it('gets wiki entries through GET /v1/wiki/:slug', async () => {
    process.env.COVE_STATE_DIR = makeStateDir();
    const db = createWikiDb();

    try {
      const entry = createWikiEntry({
        slug: 'api-lookup-page',
        title: 'API Lookup Page',
        content: 'Lookup content',
        db,
      });
      const app = createApp({ db });

      const response = await app.fetch(new Request('http://cove.test/v1/wiki/api-lookup-page'));

      expect(response.status).toBe(200);
      expect(await json<WikiFileRecord>(response)).toEqual(entry);
    } finally {
      db.close();
    }
  });

  it('returns 404 for a missing slug on GET /v1/wiki/:slug', async () => {
    process.env.COVE_STATE_DIR = makeStateDir();
    const db = createWikiDb();

    try {
      const app = createApp({ db });
      const response = await app.fetch(new Request('http://cove.test/v1/wiki/missing-page'));

      expect(response.status).toBe(404);
      expect(await json<{ error: string }>(response)).toEqual({ error: 'Not Found' });
    } finally {
      db.close();
    }
  });

  it('updates wiki entries through PUT /v1/wiki/:slug', async () => {
    process.env.COVE_STATE_DIR = makeStateDir();
    const db = createWikiDb();

    try {
      const entry = createWikiEntry({
        slug: 'api-update-page',
        title: 'Original API Title',
        content: 'Original API content',
        tags: ['original'],
        provenance: 'human',
        created_by: 'alice',
        db,
      });
      const app = createApp({ db });

      await new Promise((resolve) => setTimeout(resolve, 5));

      const response = await app.fetch(new Request('http://cove.test/v1/wiki/api-update-page', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Updated API Title',
          tags: ['updated', 'api'],
        }),
      }));

      expect(response.status).toBe(200);

      const body = await json<WikiFileRecord>(response);
      expect(body).toEqual({
        ...entry,
        title: 'Updated API Title',
        content: 'Original API content',
        tags: 'updated,api',
        updated_at: expect.any(String),
      });
      expect(body.created_at).toBe(entry.created_at);
      expect(body.updated_at).not.toBe(entry.updated_at);
      expect(readWikiFile('api-update-page')).toEqual(body);
    } finally {
      db.close();
    }
  });

  it('returns 400 for invalid JSON on PUT /v1/wiki/:slug', async () => {
    process.env.COVE_STATE_DIR = makeStateDir();
    const db = createWikiDb();

    try {
      createWikiEntry({
        slug: 'api-invalid-update-page',
        title: 'Invalid Update Page',
        content: 'Original content',
        db,
      });
      const app = createApp({ db });

      const response = await app.fetch(new Request('http://cove.test/v1/wiki/api-invalid-update-page', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      }));

      expect(response.status).toBe(400);
      expect(await json<{ error: string }>(response)).toEqual({ error: 'Invalid JSON body' });
    } finally {
      db.close();
    }
  });

  it('returns 404 when PUT /v1/wiki/:slug targets a missing entry', async () => {
    process.env.COVE_STATE_DIR = makeStateDir();
    const db = createWikiDb();

    try {
      const app = createApp({ db });
      const response = await app.fetch(new Request('http://cove.test/v1/wiki/missing-update-page', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Updated Title' }),
      }));

      expect(response.status).toBe(404);
      expect(await json<{ error: string }>(response)).toEqual({ error: 'Not Found' });
    } finally {
      db.close();
    }
  });

  it('deletes wiki entries through DELETE /v1/wiki/:slug', async () => {
    process.env.COVE_STATE_DIR = makeStateDir();
    const db = createWikiDb();

    try {
      createWikiEntry({
        slug: 'api-delete-page',
        title: 'Delete Page',
        content: 'Delete me',
        db,
      });
      const app = createApp({ db });

      const response = await app.fetch(new Request('http://cove.test/v1/wiki/api-delete-page', {
        method: 'DELETE',
      }));

      expect(response.status).toBe(204);
      expect(readWikiFile('api-delete-page')).toBeNull();

      const getAfterDelete = await app.fetch(new Request('http://cove.test/v1/wiki/api-delete-page'));
      expect(getAfterDelete.status).toBe(404);
    } finally {
      db.close();
    }
  });

  it('returns 404 when DELETE /v1/wiki/:slug targets a missing entry', async () => {
    process.env.COVE_STATE_DIR = makeStateDir();
    const db = createWikiDb();

    try {
      const app = createApp({ db });
      const response = await app.fetch(new Request('http://cove.test/v1/wiki/missing-delete-page', {
        method: 'DELETE',
      }));

      expect(response.status).toBe(404);
      expect(await json<{ error: string }>(response)).toEqual({ error: 'Not Found' });
    } finally {
      db.close();
    }
  });
});
