import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';

import {
  embedMemoryTexts,
  searchMemoriesByKeyword,
  searchMemoriesByVector,
  storeMemory,
  storeMemoryWithEmbedding,
} from '../../src/context/external.ts';
import { migrate } from '../../src/db/migrate.ts';

type MockTransformerOutput = {
  tolist(): unknown;
};

type MockExtractor = (texts: string[], options: Record<string, unknown>) => Promise<MockTransformerOutput>;

const originalCentralDbPath = process.env.COVE_CENTRAL_DB_PATH;

function makeExtractor(vectors: Record<string, unknown>): MockExtractor {
  return async (texts: string[]) => ({
    tolist: () => texts.map((text) => vectors[text] ?? []),
  });
}

function makeEmbedder(vectors: Record<string, number[]>): (texts: string[]) => Promise<number[][]> {
  return async (texts: string[]) => texts.map((text) => vectors[text] ?? [0, 0, 0]);
}

beforeEach(() => {
  delete process.env.COVE_CENTRAL_DB_PATH;
});

afterEach(() => {
  mock.restore();

  if (originalCentralDbPath === undefined) {
    delete process.env.COVE_CENTRAL_DB_PATH;
    return;
  }

  process.env.COVE_CENTRAL_DB_PATH = originalCentralDbPath;
});

describe('embedMemoryTexts', () => {
  it('uses an explicit embedTexts function without loading the runtime embedder', async () => {
    let importCount = 0;

    mock.module('@xenova/transformers', () => {
      importCount++;
      return {
        pipeline: async () => makeExtractor({}),
      };
    });

    const embedTexts = async (texts: string[]) => texts.map((text, index) => [text.length, index]);

    await expect(embedMemoryTexts(['alpha', 'beta'], embedTexts)).resolves.toEqual([
      [5, 0],
      [4, 1],
    ]);
    expect(importCount).toBe(0);
  });

  it('returns empty embeddings when no central db path is configured', async () => {
    let importCount = 0;

    mock.module('@xenova/transformers', () => {
      importCount++;
      return {
        pipeline: async () => makeExtractor({}),
      };
    });

    await expect(embedMemoryTexts(['alpha', 'beta'])).resolves.toEqual([]);
    expect(importCount).toBe(0);
  });

  it('returns empty embeddings for empty input without loading the runtime embedder', async () => {
    let importCount = 0;

    process.env.COVE_CENTRAL_DB_PATH = '/tmp/cove-central-empty-input.db';

    mock.module('@xenova/transformers', () => {
      importCount++;
      return {
        pipeline: async () => makeExtractor({}),
      };
    });

    await expect(embedMemoryTexts([])).resolves.toEqual([]);
    expect(importCount).toBe(0);
  });

  it('lazy-loads the runtime embedder and sanitizes numeric arrays', async () => {
    const pipelineCalls: Array<{ task: string; model: string }> = [];
    const extractorCalls: Array<{ texts: string[]; options: Record<string, unknown> }> = [];

    process.env.COVE_CENTRAL_DB_PATH = '/tmp/cove-central-sanitize.db';

    mock.module('@xenova/transformers', () => ({
      pipeline: async (task: string, model: string) => {
        pipelineCalls.push({ task, model });

        return async (texts: string[], options: Record<string, unknown>) => {
          extractorCalls.push({ texts, options });
          return {
            tolist: () => [
              [1, 2, 'skip', Infinity, 3],
              'not-an-array',
            ],
          };
        };
      },
    }));

    await expect(embedMemoryTexts(['alpha', 'beta'])).resolves.toEqual([
      [1, 2, 3],
      [],
    ]);
    expect(pipelineCalls).toEqual([
      { task: 'feature-extraction', model: 'Xenova/all-MiniLM-L6-v2' },
    ]);
    expect(extractorCalls).toEqual([
      {
        texts: ['alpha', 'beta'],
        options: { pooling: 'mean', normalize: true },
      },
    ]);
  });

  it('reuses the default embedder for repeated calls with the same central db path and reloads when the path changes', async () => {
    let pipelineCount = 0;

    mock.module('@xenova/transformers', () => ({
      pipeline: async () => {
        pipelineCount++;

        return makeExtractor({
          alpha: [1],
          beta: [2],
          gamma: [3],
        });
      },
    }));

    process.env.COVE_CENTRAL_DB_PATH = '/tmp/cove-central-reuse-a.db';
    await expect(embedMemoryTexts(['alpha'])).resolves.toEqual([[1]]);
    await expect(embedMemoryTexts(['beta'])).resolves.toEqual([[2]]);

    process.env.COVE_CENTRAL_DB_PATH = '/tmp/cove-central-reuse-b.db';
    await expect(embedMemoryTexts(['gamma'])).resolves.toEqual([[3]]);

    expect(pipelineCount).toBe(2);
  });

  it('uses an explicit embedder key when env is unset and reuses that cache key across calls', async () => {
    let pipelineCount = 0;

    mock.module('@xenova/transformers', () => ({
      pipeline: async () => {
        pipelineCount++;

        return makeExtractor({
          alpha: [1],
          beta: [2],
          gamma: [3],
        });
      },
    }));

    await expect(embedMemoryTexts(['alpha'], undefined, '/tmp/cove-central-explicit-a.db')).resolves.toEqual([[1]]);
    await expect(embedMemoryTexts(['beta'], undefined, '/tmp/cove-central-explicit-a.db')).resolves.toEqual([[2]]);
    await expect(embedMemoryTexts(['gamma'], undefined, '/tmp/cove-central-explicit-b.db')).resolves.toEqual([[3]]);

    expect(pipelineCount).toBe(2);
  });

  it('degrades to empty embeddings when transformer output exposes a non-callable tolist value', async () => {
    process.env.COVE_CENTRAL_DB_PATH = '/tmp/cove-central-malformed-output.db';

    mock.module('@xenova/transformers', () => ({
      pipeline: async () => async () => ({
        tolist: 'not-a-function',
      }),
    }));

    await expect(embedMemoryTexts(['alpha'])).resolves.toEqual([]);
  });

  it('returns empty embeddings after a transient load failure and retries on the next call', async () => {
    let attempts = 0;

    process.env.COVE_CENTRAL_DB_PATH = '/tmp/cove-central-retry.db';

    mock.module('@xenova/transformers', () => ({
      pipeline: async () => {
        attempts++;

        if (attempts === 1) {
          throw new Error('transient load failure');
        }

        return makeExtractor({ alpha: [7, 8] });
      },
    }));

    await expect(embedMemoryTexts(['alpha'])).resolves.toEqual([]);
    await expect(embedMemoryTexts(['alpha'])).resolves.toEqual([[7, 8]]);
    expect(attempts).toBe(2);
  });
});

describe('memory search', () => {
  function createDb(): Database {
    const db = new Database(':memory:');
    migrate(db);
    return db;
  }

  it('stores a memory and retrieves it by keyword search', () => {
    const db = createDb();

    try {
      const memory = storeMemory({
        content: 'The quick brown fox jumps over the lazy dog',
        agentGroupId: 'group-1',
        importance: 0.8,
        db,
      });

      expect(memory.id).toBeDefined();
      expect(memory.content).toBe('The quick brown fox jumps over the lazy dog');
      expect(memory.agent_group_id).toBe('group-1');
      expect(memory.importance).toBe(0.8);
      expect(memory.created_at).toBeDefined();

      const results = searchMemoriesByKeyword({
        query: 'fox',
        agentGroupId: 'group-1',
        db,
      });

      expect(results.length).toBe(1);
      expect(results[0].id).toBe(memory.id);
    } finally {
      db.close();
    }
  });

  it('stores a memory with embedding and persists the computed embedding bytes', async () => {
    const db = createDb();

    try {
      const memory = await storeMemoryWithEmbedding({
        content: 'Embedded memory content',
        agentGroupId: 'group-embedded',
        importance: 0.9,
        db,
        embedTexts: makeEmbedder({
          'Embedded memory content': [1, 0, 0],
        }),
      });

      const stored = db.prepare('SELECT embedding FROM memories WHERE id = ?').get(memory.id) as { embedding: Uint8Array | null } | undefined;

      expect(stored?.embedding).toBeTruthy();
      expect(memory.embedding).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it('returns empty array for non-matching keyword', () => {
    const db = createDb();

    try {
      storeMemory({
        content: 'The quick brown fox',
        agentGroupId: 'group-1',
        db,
      });

      const results = searchMemoriesByKeyword({
        query: 'nonexistent',
        agentGroupId: 'group-1',
        db,
      });

      expect(results).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('filters keyword search by agentGroupId', () => {
    const db = createDb();

    try {
      storeMemory({
        content: 'Secret data for group A',
        agentGroupId: 'group-a',
        db,
      });

      const results = searchMemoriesByKeyword({
        query: 'Secret',
        agentGroupId: 'group-b',
        db,
      });

      expect(results).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('returns no results for blank vector queries without calling the embedder', async () => {
    const db = createDb();
    const embedTexts = mock(async (_texts: string[]) => [[1, 0, 0]]);

    try {
      await expect(searchMemoriesByVector({
        query: '   \n\t  ',
        agentGroupId: 'group-blank',
        db,
        embedTexts,
      })).resolves.toEqual([]);
      expect(embedTexts).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('falls back to scoped keyword results when embeddings are unavailable', async () => {
    const db = createDb();

    try {
      const memory = storeMemory({
        content: 'test content',
        agentGroupId: 'group-1',
        db,
      });

      const results = await searchMemoriesByVector({
        query: 'test',
        agentGroupId: 'group-1',
        db,
      });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(memory.id);
    } finally {
      db.close();
    }
  });

  it('falls back to keyword-ranked memories scoped by agent group when vector scores are non-positive', async () => {
    const db = createDb();

    try {
      const target = storeMemory({
        content: 'Vector search should find this planning memory',
        agentGroupId: 'group-vector',
        importance: 0.9,
        db,
      });
      storeMemory({
        content: 'Vector search should ignore other agent groups',
        agentGroupId: 'group-other',
        db,
      });

      const results = await searchMemoriesByVector({
        query: 'planning memory',
        agentGroupId: 'group-vector',
        db,
        embedTexts: makeEmbedder({
          'planning memory': [1, 0, 0],
          'Vector search should find this planning memory': [0, 1, 0],
        }),
      });

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].id).toBe(target.id);
      expect(results.every((memory) => memory.agent_group_id === 'group-vector')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('returns semantic matches even when keywords do not overlap and keeps vector results scoped by agent group', async () => {
    const db = createDb();

    try {
      const target = storeMemory({
        content: 'Seaside itinerary for summer travel',
        agentGroupId: 'group-semantic',
        importance: 0.9,
        db,
      });
      storeMemory({
        content: 'Database migration rollback steps',
        agentGroupId: 'group-semantic',
        importance: 0.4,
        db,
      });
      storeMemory({
        content: 'Seaside itinerary for summer travel',
        agentGroupId: 'group-other',
        importance: 1,
        db,
      });

      const results = await searchMemoriesByVector({
        query: 'beach vacation plans',
        agentGroupId: 'group-semantic',
        db,
        embedTexts: makeEmbedder({
          'beach vacation plans': [1, 0, 0],
          'Seaside itinerary for summer travel': [1, 0, 0],
          'Database migration rollback steps': [0, 1, 0],
        }),
      });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(target.id);
      expect(results.every((memory) => memory.agent_group_id === 'group-semantic')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('uses the default runtime embedder when central db path is configured', async () => {
    const db = createDb();

    try {
      process.env.COVE_CENTRAL_DB_PATH = '/tmp/cove-central-runtime-search.db';
      mock.module('@xenova/transformers', () => ({
        pipeline: async () => async (texts: string[]) => ({
          tolist: () => texts.map((text) => {
            if (text === 'beach vacation plans' || text === 'Seaside itinerary for summer travel') {
              return [1, 0, 0];
            }

            return [0, 1, 0];
          }),
        }),
      }));

      const target = storeMemory({
        content: 'Seaside itinerary for summer travel',
        agentGroupId: 'group-runtime-semantic',
        importance: 0.9,
        db,
      });
      storeMemory({
        content: 'Database migration rollback steps',
        agentGroupId: 'group-runtime-semantic',
        importance: 0.4,
        db,
      });

      const results = await searchMemoriesByVector({
        query: 'beach vacation plans',
        agentGroupId: 'group-runtime-semantic',
        db,
      });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(target.id);
    } finally {
      db.close();
    }
  });

  it('retries default embedder initialization after a transient load failure', async () => {
    const db = createDb();

    try {
      process.env.COVE_CENTRAL_DB_PATH = '/tmp/cove-central-runtime-retry-search.db';
      let attempts = 0;
      mock.module('@xenova/transformers', () => ({
        pipeline: async () => {
          attempts++;
          if (attempts === 1) {
            throw new Error('transient load failure');
          }

          return async (texts: string[]) => ({
            tolist: () => texts.map((text) => {
              if (text === 'beach vacation plans' || text === 'Seaside itinerary for summer travel') {
                return [1, 0, 0];
              }

              return [0, 1, 0];
            }),
          });
        },
      }));

      const target = storeMemory({
        content: 'Seaside itinerary for summer travel',
        agentGroupId: 'group-runtime-retry',
        importance: 0.9,
        db,
      });
      storeMemory({
        content: 'Database migration rollback steps',
        agentGroupId: 'group-runtime-retry',
        importance: 0.4,
        db,
      });

      const firstResults = await searchMemoriesByVector({
        query: 'beach vacation plans',
        agentGroupId: 'group-runtime-retry',
        db,
      });
      const secondResults = await searchMemoriesByVector({
        query: 'beach vacation plans',
        agentGroupId: 'group-runtime-retry',
        db,
      });

      expect(firstResults).toEqual([]);
      expect(secondResults).toHaveLength(1);
      expect(secondResults[0].id).toBe(target.id);
    } finally {
      db.close();
    }
  });

  it('uses stored embeddings for persisted memories without re-embedding those rows', async () => {
    const db = createDb();
    const embedTexts = mock(async (texts: string[]) => texts.map((text) => (
      text === 'beach vacation plans' ? [1, 0, 0] : [0, 1, 0]
    )));

    try {
      const target = storeMemory({
        content: 'Seaside itinerary for summer travel',
        agentGroupId: 'group-stored-semantic',
        importance: 0.9,
        embedding: [1, 0, 0],
        db,
      });
      storeMemory({
        content: 'Database migration rollback steps',
        agentGroupId: 'group-stored-semantic',
        importance: 0.4,
        embedding: [0, 1, 0],
        db,
      });

      const results = await searchMemoriesByVector({
        query: 'beach vacation plans',
        agentGroupId: 'group-stored-semantic',
        db,
        embedTexts,
      });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(target.id);
      expect(embedTexts).toHaveBeenCalledTimes(1);
      expect(embedTexts).toHaveBeenCalledWith(['beach vacation plans']);
    } finally {
      db.close();
    }
  });

  it('orders equal vector scores by importance and respects the limit', async () => {
    const db = createDb();

    try {
      const highImportance = storeMemory({
        content: 'High priority beach itinerary',
        agentGroupId: 'group-limit',
        importance: 0.9,
        embedding: [1, 0, 0],
        db,
      });
      const mediumImportance = storeMemory({
        content: 'Medium priority beach itinerary',
        agentGroupId: 'group-limit',
        importance: 0.5,
        embedding: [1, 0, 0],
        db,
      });
      storeMemory({
        content: 'Low priority beach itinerary',
        agentGroupId: 'group-limit',
        importance: 0.1,
        embedding: [1, 0, 0],
        db,
      });

      const results = await searchMemoriesByVector({
        query: 'beach vacation plans',
        agentGroupId: 'group-limit',
        limit: 2,
        db,
        embedTexts: makeEmbedder({
          'beach vacation plans': [1, 0, 0],
        }),
      });

      expect(results).toHaveLength(2);
      expect(results.map((memory) => memory.id)).toEqual([
        highImportance.id,
        mediumImportance.id,
      ]);
    } finally {
      db.close();
    }
  });

  it('degrades gracefully when the memories table has no embedding column', async () => {
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
        ['sem-no-embedding', 'fallback semantic memory', 'group-no-embedding', 0.5, new Date().toISOString()],
      );
      const rowId = (db.prepare('SELECT rowid FROM memories WHERE id = ?').get('sem-no-embedding') as { rowid: number }).rowid;
      db.run('INSERT INTO memories_fts(rowid, content) VALUES (?, ?)', [rowId, 'fallback semantic memory']);

      const results = await searchMemoriesByVector({
        query: 'fallback semantic',
        agentGroupId: 'group-no-embedding',
        db,
        embedTexts: makeEmbedder({
          'fallback semantic': [1, 0, 0],
        }),
      });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('sem-no-embedding');
    } finally {
      db.close();
    }
  });

  it('ignores malformed or dimension-mismatched stored embeddings and falls back to keyword results when nothing ranks', async () => {
    const db = createDb();

    try {
      db.run(
        `INSERT INTO memories (id, content, embedding, agent_group_id, importance, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          'bad-embedding',
          'fallback semantic memory',
          JSON.stringify(['bad', 'data']),
          'group-bad-embedding',
          0.5,
          new Date().toISOString(),
        ],
      );
      const badRowId = (db.prepare('SELECT rowid FROM memories WHERE id = ?').get('bad-embedding') as { rowid: number }).rowid;
      db.run('INSERT INTO memories_fts(rowid, content) VALUES (?, ?)', [badRowId, 'fallback semantic memory']);

      db.run(
        `INSERT INTO memories (id, content, embedding, agent_group_id, importance, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          'mismatched-embedding',
          'other memory',
          JSON.stringify([1, 0]),
          'group-bad-embedding',
          0.4,
          new Date().toISOString(),
        ],
      );

      const results = await searchMemoriesByVector({
        query: 'fallback semantic',
        agentGroupId: 'group-bad-embedding',
        db,
        embedTexts: makeEmbedder({
          'fallback semantic': [1, 0, 0],
        }),
      });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('bad-embedding');
    } finally {
      db.close();
    }
  });

  it('only embeds rows with missing stored embeddings, not rows with present but invalid embeddings', async () => {
    const db = createDb();
    const embedRequests: string[][] = [];
    const embedTexts = async (texts: string[]) => {
      embedRequests.push(texts);

      return texts.map((text) => {
        if (text === 'beach vacation plans' || text === 'Missing embedding memory') {
          return [1, 0, 0];
        }

        return [0, 1, 0];
      });
    };

    try {
      db.run(
        `INSERT INTO memories (id, content, embedding, agent_group_id, importance, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          'invalid-present-embedding',
          'Invalid stored embedding memory',
          JSON.stringify(['bad', 'data']),
          'group-missing-only',
          0.2,
          new Date().toISOString(),
        ],
      );
      const invalidRowId = (db.prepare('SELECT rowid FROM memories WHERE id = ?').get('invalid-present-embedding') as { rowid: number }).rowid;
      db.run('INSERT INTO memories_fts(rowid, content) VALUES (?, ?)', [invalidRowId, 'Invalid stored embedding memory']);

      const target = storeMemory({
        content: 'Missing embedding memory',
        agentGroupId: 'group-missing-only',
        importance: 0.9,
        db,
      });

      const results = await searchMemoriesByVector({
        query: 'beach vacation plans',
        agentGroupId: 'group-missing-only',
        db,
        embedTexts,
      });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(target.id);
      expect(embedRequests).toEqual([
        ['beach vacation plans'],
        ['Missing embedding memory'],
      ]);
    } finally {
      db.close();
    }
  });

  it('falls back to LIKE search when FTS5 query fails', () => {
    const db = createDb();

    try {
      storeMemory({
        content: 'The quick brown fox',
        agentGroupId: 'group-fts',
        db,
      });

      const results = searchMemoriesByKeyword({
        query: 'quick',
        agentGroupId: 'group-fts',
        db,
      });

      expect(results.length).toBe(1);
      expect(results[0].content).toContain('fox');
    } finally {
      db.close();
    }
  });

  it('handles FTS5 escape for quotes in query', () => {
    const db = createDb();

    try {
      storeMemory({
        content: 'value with "quoted" term',
        agentGroupId: 'group-fts',
        db,
      });

      const results = searchMemoriesByKeyword({
        query: 'quoted term',
        agentGroupId: 'group-fts',
        db,
      });

      expect(results.length).toBe(1);
    } finally {
      db.close();
    }
  });

  it('returns empty when no keyword match exists in fallback search', () => {
    const db = createDb();

    try {
      storeMemory({
        content: 'Some content here',
        agentGroupId: 'group-fallback',
        db,
      });

      const results = searchMemoriesByKeyword({
        query: 'zzzzztotallynonexistent',
        agentGroupId: 'group-fallback',
        db,
      });

      expect(results).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('falls back to LIKE search when FTS5 is unavailable', () => {
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
        ['fid-1', 'fallback to LIKE when FTS fails', 'group-ftsfail', 0.5, new Date().toISOString()],
      );

      const results = searchMemoriesByKeyword({
        query: 'fallback LIKE',
        agentGroupId: 'group-ftsfail',
        db,
      });

      expect(results.length).toBe(1);
      expect(results[0].content).toContain('FTS fails');
    } finally {
      db.close();
    }
  });
});
