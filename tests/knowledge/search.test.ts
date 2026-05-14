import { afterEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';

import { storeMemory } from '../../src/context/external.ts';
import { migrate } from '../../src/db/migrate.ts';
import { hybridSearch } from '../../src/knowledge/search.ts';

const originalCentralDbPath = process.env.COVE_CENTRAL_DB_PATH;

function createDb(): Database {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

function makeEmbedder(vectors: Record<string, number[]>): (texts: string[]) => Promise<number[][]> {
  return async (texts: string[]) => texts.map((text) => vectors[text] ?? [0, 0, 0]);
}

afterEach(() => {
  mock.restore();

  if (originalCentralDbPath === undefined) {
    delete process.env.COVE_CENTRAL_DB_PATH;
    return;
  }

  process.env.COVE_CENTRAL_DB_PATH = originalCentralDbPath;
});

describe('hybridSearch', () => {
  it('returns empty for empty query', async () => {
    const db = createDb();

    try {
      await expect(hybridSearch({ query: '', db })).resolves.toEqual([]);
    } finally {
      db.close();
    }
  });

  it('returns relevant lexical matches sorted by descending score', async () => {
    const db = createDb();

    try {
      storeMemory({ content: 'Apple pie recipe with fresh apples', agentGroupId: 'g1', db });
      storeMemory({ content: 'How to care for apple trees', agentGroupId: 'g1', db });
      storeMemory({ content: 'Carrot cake recipe with cream cheese', agentGroupId: 'g1', db });

      const results = await hybridSearch({ query: 'apple', db, maxResults: 10 });

      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results.every((result) => result.score > 0)).toBe(true);
      expect(results[0].score).toBeGreaterThanOrEqual(results[results.length - 1].score);
      expect(results.map((result) => result.content.toLowerCase())).toEqual(expect.arrayContaining([
        expect.stringContaining('apple'),
      ]));
    } finally {
      db.close();
    }
  });

  it('includes vector-only matches alongside keyword matches', async () => {
    const db = createDb();

    try {
      const keywordOnly = storeMemory({ content: 'Beach packing checklist', agentGroupId: 'g-hybrid', db });
      const vectorOnly = storeMemory({ content: 'Seaside getaway planner', agentGroupId: 'g-hybrid', db });

      const results = await hybridSearch({
        query: 'beach vacation',
        db,
        agentGroupId: 'g-hybrid',
        maxResults: 10,
        embedTexts: makeEmbedder({
          'beach vacation': [1, 0, 0],
          'Beach packing checklist': [0.2, 0, 0],
          'Seaside getaway planner': [1, 0, 0],
        }),
      });

      expect(results.map((result) => result.id)).toContain(keywordOnly.id);
      expect(results.map((result) => result.id)).toContain(vectorOnly.id);
    } finally {
      db.close();
    }
  });

  it('uses embeddingWeight 0.7 by default when lexical and vector scores both exist', async () => {
    const db = createDb();

    try {
      const target = storeMemory({
        content: 'Chocolate cake recipe with dark chocolate',
        agentGroupId: 'g-weight',
        db,
      });

      const lexicalOnly = await hybridSearch({
        query: 'chocolate cake',
        db,
        agentGroupId: 'g-weight',
        embeddingWeight: 0,
        embedTexts: makeEmbedder({
          'chocolate cake': [1, 0, 0],
          'Chocolate cake recipe with dark chocolate': [1, 0, 0],
        }),
      });
      const vectorOnly = await hybridSearch({
        query: 'chocolate cake',
        db,
        agentGroupId: 'g-weight',
        embeddingWeight: 1,
        embedTexts: makeEmbedder({
          'chocolate cake': [1, 0, 0],
          'Chocolate cake recipe with dark chocolate': [1, 0, 0],
        }),
      });
      const blended = await hybridSearch({
        query: 'chocolate cake',
        db,
        agentGroupId: 'g-weight',
        embedTexts: makeEmbedder({
          'chocolate cake': [1, 0, 0],
          'Chocolate cake recipe with dark chocolate': [1, 0, 0],
        }),
      });

      const lexicalScore = lexicalOnly.find((result) => result.id === target.id)?.score;
      const vectorScore = vectorOnly.find((result) => result.id === target.id)?.score;
      const blendedScore = blended.find((result) => result.id === target.id)?.score;

      expect(lexicalScore).toBeDefined();
      expect(vectorScore).toBeDefined();
      expect(blendedScore).toBeDefined();
      expect(blendedScore!).toBeCloseTo((vectorScore! * 0.7) + (lexicalScore! * 0.3), 6);
    } finally {
      db.close();
    }
  });

  it('preserves scoping when agentGroupId is provided and leaves results unscoped when omitted', async () => {
    const db = createDb();

    try {
      const groupA = storeMemory({ content: 'Dolphins are marine mammals', agentGroupId: 'g2', db });
      const groupB = storeMemory({ content: 'Dolphins are intelligent animals', agentGroupId: 'g3', db });

      const unscoped = await hybridSearch({ query: 'Dolphins', db, maxResults: 10 });
      const scoped = await hybridSearch({ query: 'Dolphins', db, agentGroupId: 'g2', maxResults: 10 });

      expect(unscoped.map((result) => result.id)).toEqual(expect.arrayContaining([groupA.id, groupB.id]));
      expect(scoped.map((result) => result.id)).toEqual([groupA.id]);
      expect(scoped.every((result) => result.agent_group_id === 'g2')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('falls back to lexical scoring when FTS is unavailable', async () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        agent_group_id TEXT NOT NULL,
        session_id TEXT,
        importance REAL DEFAULT 0.0,
        created_at TEXT NOT NULL
      )
    `);

    try {
      db.run(
        `INSERT INTO memories (id, content, agent_group_id, importance, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        ['nofts-1', 'This is a fallback test for LIKE search', 'g-like', 0.5, new Date().toISOString()],
      );
      db.run(
        `INSERT INTO memories (id, content, agent_group_id, importance, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        ['nofts-2', 'This does not match at all', 'g-like', 0.3, new Date().toISOString()],
      );

      const results = await hybridSearch({ query: 'fallback test', db, maxResults: 5 });

      expect(results).toHaveLength(1);
      expect(results[0].content).toContain('fallback test');
      expect(results[0].score).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('falls back to lexical scoring when FTS query execution fails', async () => {
    const db = createDb();

    try {
      storeMemory({ content: 'This is a fallback test for LIKE search', agentGroupId: 'g-like-fail', db });
      storeMemory({ content: 'This does not match at all', agentGroupId: 'g-like-fail', db });

      const failingDb = {
        prepare(sql: string) {
          if (sql.includes('FROM memories_fts')) {
            return {
              all() {
                throw new Error('simulated fts failure');
              },
            };
          }

          return db.prepare(sql);
        },
      } as unknown as Database;

      const results = await hybridSearch({ query: 'fallback test', db: failingDb, maxResults: 5 });

      expect(results).toHaveLength(1);
      expect(results[0].content).toContain('fallback test');
      expect(results[0].score).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('reuses stored embeddings and only embeds the query plus rows missing embeddings', async () => {
    const db = createDb();
    const embedRequests: string[][] = [];
    const embedTexts = async (texts: string[]) => {
      embedRequests.push(texts);

      return texts.map((text) => {
        if (text === 'beach vacation' || text === 'Missing embedding memory') {
          return [1, 0, 0];
        }

        return [0, 1, 0];
      });
    };

    try {
      storeMemory({
        content: 'Stored embedding memory',
        agentGroupId: 'g-stored',
        embedding: [1, 0, 0],
        db,
      });
      storeMemory({
        content: 'Missing embedding memory',
        agentGroupId: 'g-stored',
        db,
      });
      storeMemory({
        content: 'Another missing embedding memory',
        agentGroupId: 'g-stored',
        db,
      });

      await hybridSearch({
        query: 'beach vacation',
        db,
        agentGroupId: 'g-stored',
        maxResults: 10,
        embedTexts,
      });

      expect(embedRequests).toEqual([
        ['beach vacation'],
        ['Missing embedding memory', 'Another missing embedding memory'],
      ]);
    } finally {
      db.close();
    }
  });

  it('respects maxResults and minScore', async () => {
    const db = createDb();

    try {
      for (const content of [
        'Beach vacation guide',
        'Beach vacation itinerary',
        'Beach vacation checklist',
        'Beach vacation reminders',
        'Beach vacation planner',
        'Beach vacation notes',
      ]) {
        storeMemory({ content, agentGroupId: 'g-limit', db });
      }

      const limited = await hybridSearch({ query: 'beach vacation', db, agentGroupId: 'g-limit' });
      const filtered = await hybridSearch({
        query: 'one two three four five six seven',
        db,
        minScore: 0.9,
        maxResults: 5,
      });

      expect(limited).toHaveLength(5);
      expect(filtered).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('tolerates missing embedding columns and malformed stored embeddings', async () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        agent_group_id TEXT NOT NULL,
        session_id TEXT,
        importance REAL DEFAULT 0.0,
        created_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content,
        content=memories, content_rowid=rowid
      );
    `);

    try {
      db.run(
        `INSERT INTO memories (id, content, agent_group_id, importance, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        ['missing-col', 'fallback semantic memory', 'g-no-embedding', 0.5, new Date().toISOString()],
      );
      const missingRowId = (db.prepare('SELECT rowid FROM memories WHERE id = ?').get('missing-col') as { rowid: number }).rowid;
      db.run('INSERT INTO memories_fts(rowid, content) VALUES (?, ?)', [missingRowId, 'fallback semantic memory']);

      const noEmbeddingResults = await hybridSearch({
        query: 'fallback semantic',
        db,
        agentGroupId: 'g-no-embedding',
        embedTexts: makeEmbedder({
          'fallback semantic': [1, 0, 0],
        }),
      });

      expect(noEmbeddingResults).toHaveLength(1);

      const fullDb = createDb();

      try {
        fullDb.run(
          `INSERT INTO memories (id, content, embedding, agent_group_id, importance, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            'bad-embedding',
            'fallback semantic memory',
            JSON.stringify(['bad', 'data']),
            'g-bad-embedding',
            0.5,
            new Date().toISOString(),
          ],
        );
        const badRowId = (fullDb.prepare('SELECT rowid FROM memories WHERE id = ?').get('bad-embedding') as { rowid: number }).rowid;
        fullDb.run('INSERT INTO memories_fts(rowid, content) VALUES (?, ?)', [badRowId, 'fallback semantic memory']);

        fullDb.run(
          `INSERT INTO memories (id, content, embedding, agent_group_id, importance, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            'mismatched-embedding',
            'other memory',
            JSON.stringify([1, 0]),
            'g-bad-embedding',
            0.4,
            new Date().toISOString(),
          ],
        );

        const malformedResults = await hybridSearch({
          query: 'fallback semantic',
          db: fullDb,
          agentGroupId: 'g-bad-embedding',
          embedTexts: makeEmbedder({
            'fallback semantic': [1, 0, 0],
          }),
        });

        expect(malformedResults).toHaveLength(1);
        expect(malformedResults[0].id).toBe('bad-embedding');

        const vectorOnly = storeMemory({
          content: 'Seaside getaway planner',
          agentGroupId: 'g-bad-embedding',
          db: fullDb,
        });
        fullDb.run(
          'UPDATE memories SET embedding = ? WHERE id = ?',
          [JSON.stringify(['bad', 'data']), vectorOnly.id],
        );

        const vectorRecoveryResults = await hybridSearch({
          query: 'beach vacation',
          db: fullDb,
          agentGroupId: 'g-bad-embedding',
          embedTexts: makeEmbedder({
            'beach vacation': [1, 0, 0],
            'Seaside getaway planner': [1, 0, 0],
          }),
        });

        expect(vectorRecoveryResults.map((result) => result.id)).toContain(vectorOnly.id);
      } finally {
        fullDb.close();
      }
    } finally {
      db.close();
    }
  });

  it('handles quoted tokens in the FTS path', async () => {
    const db = createDb();

    try {
      const entry = storeMemory({
        content: 'value with "quoted" term',
        agentGroupId: 'g-quoted',
        db,
      });

      const results = await hybridSearch({
        query: '"quoted" term',
        db,
        agentGroupId: 'g-quoted',
        maxResults: 10,
      });

      expect(results.map((result) => result.id)).toContain(entry.id);
    } finally {
      db.close();
    }
  });

  it('uses the default runtime embedder when central db path is configured', async () => {
    const db = createDb();

    try {
      process.env.COVE_CENTRAL_DB_PATH = '/tmp/cove-hybrid-runtime.db';
      mock.module('@xenova/transformers', () => ({
        pipeline: async () => async (texts: string[]) => ({
          tolist: () => texts.map((text) => {
            if (text === 'beach vacation' || text === 'Seaside getaway planner') {
              return [1, 0, 0];
            }

            if (text === 'Beach packing checklist') {
              return [0.2, 0, 0];
            }

            return [0, 1, 0];
          }),
        }),
      }));

      const vectorOnly = storeMemory({ content: 'Seaside getaway planner', agentGroupId: 'g-runtime', db });
      storeMemory({ content: 'Database migration rollback steps', agentGroupId: 'g-runtime', db });

      const results = await hybridSearch({
        query: 'beach vacation',
        db,
        agentGroupId: 'g-runtime',
        maxResults: 10,
      });

      expect(results.map((result) => result.id)).toContain(vectorOnly.id);
    } finally {
      db.close();
    }
  });
});
