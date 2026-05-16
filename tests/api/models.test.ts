import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';

import { createApp } from '../../src/api/app.ts';
import { migrate } from '../../src/db/migrate.ts';

let db: Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

describe('GET /v1/models', () => {
  it('returns an empty list when no agent groups exist', async () => {
    db = new Database(':memory:');
    migrate(db);

    const app = createApp({ db });
    const response = await app.fetch(new Request('http://cove.test/v1/models'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ object: 'list', data: [] });
  });

  it('returns agent group ids as the public model ids', async () => {
    db = new Database(':memory:');
    migrate(db);

    db.prepare(
      `INSERT INTO agent_groups (id, name, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
    ).run(
      'support-default',
      'Support Team',
      'gpt-4.1',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      'research-fast',
      'Research Team',
      'claude-sonnet-4-5',
      '2026-01-02T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
    );

    const app = createApp({ db });
    const response = await app.fetch(new Request('http://cove.test/v1/models'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      object: 'list',
      data: [
        {
          object: 'model',
          id: 'support-default',
          created: Math.floor(Date.parse('2026-01-01T00:00:00.000Z') / 1000),
          owned_by: 'cove',
        },
        {
          object: 'model',
          id: 'research-fast',
          created: Math.floor(Date.parse('2026-01-02T00:00:00.000Z') / 1000),
          owned_by: 'cove',
        },
      ],
    });
    expect(body.data.map((entry: { id: string }) => entry.id)).not.toContain('gpt-4.1');
    expect(body.data.map((entry: { id: string }) => entry.id)).not.toContain('claude-sonnet-4-5');
  });

  it('continues to expose agent-group ids even when provider/model execution identifiers differ', async () => {
    db = new Database(':memory:');
    migrate(db);

    db.prepare(
      `INSERT INTO agent_groups (id, name, provider, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      'default',
      'Default Team',
      'openai',
      'gpt-4.1-mini',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );

    const app = createApp({ db });
    const response = await app.fetch(new Request('http://cove.test/v1/models'));
    const body = await response.json() as {
      object: string;
      data: Array<{ id: string; object: string; created: number; owned_by: string }>;
    };

    expect(response.status).toBe(200);
    expect(body.object).toBe('list');
    expect(body.data).toEqual([
      {
        id: 'default',
        object: 'model',
        created: Math.floor(Date.parse('2026-01-01T00:00:00.000Z') / 1000),
        owned_by: 'cove',
      },
    ]);
    expect(body.data.map((entry) => entry.id)).not.toContain('openai/gpt-4.1-mini');
  });
});
