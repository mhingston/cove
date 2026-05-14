import type { Database } from 'bun:sqlite';

export type EmbedTexts = (texts: string[]) => Promise<number[][]>;

export type Memory = {
  id: string;
  content: string;
  embedding?: Uint8Array;
  agent_group_id: string;
  session_id?: string;
  importance: number;
  created_at: string;
};

type PersistedMemory = Memory & {
  embedding?: Uint8Array | ArrayBuffer | string | null;
};

type RankedMemory = {
  memory: PersistedMemory;
  score: number;
};

type TransformerOutput = {
  tolist(): unknown;
};

let defaultEmbedderPromise: Promise<EmbedTexts | undefined> | undefined;
let defaultEmbedderKey: string | undefined;

function getDefaultEmbedderKey(embedderKey?: string): string | undefined {
  const centralDbPath = embedderKey?.trim() || process.env.COVE_CENTRAL_DB_PATH?.trim();
  return centralDbPath ? centralDbPath : undefined;
}

function sanitizeEmbeddings(raw: unknown): number[][] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.map((embedding) => (
    Array.isArray(embedding)
      ? embedding.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
      : []
  ));
}

function hasStoredEmbeddingValue(embedding?: Uint8Array | ArrayBuffer | string | null): boolean {
  return !isEmptyEmbeddingValue(embedding);
}

function encodeEmbedding(embedding: number[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(embedding));
}

function readTransformerOutput(output: unknown): unknown {
  if (!output || typeof output !== 'object' || !("tolist" in output)) {
    return [];
  }

  return typeof output.tolist === 'function' ? output.tolist() : [];
}

async function getEmbeddings(texts: string[], embedTexts?: EmbedTexts): Promise<number[][]> {
  if (!embedTexts || texts.length === 0) {
    return [];
  }

  const embeddings = await embedTexts(texts);
  return sanitizeEmbeddings(embeddings);
}

async function loadDefaultEmbedder(embedderKey?: string): Promise<EmbedTexts | undefined> {
  const currentKey = getDefaultEmbedderKey(embedderKey);

  if (!currentKey) {
    defaultEmbedderKey = undefined;
    defaultEmbedderPromise = undefined;
    return undefined;
  }

  if (!defaultEmbedderPromise || defaultEmbedderKey !== currentKey) {
    defaultEmbedderKey = currentKey;
    defaultEmbedderPromise = (async () => {
      try {
        const { pipeline } = await import('@xenova/transformers');
        const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');

        return async (texts: string[]) => {
          if (texts.length === 0) {
            return [];
          }

          const output = await extractor(texts, {
            pooling: 'mean',
            normalize: true,
          });

          return sanitizeEmbeddings(readTransformerOutput(output as TransformerOutput));
        };
      } catch {
        if (defaultEmbedderKey === currentKey) {
          defaultEmbedderPromise = undefined;
        }

        return undefined;
      }
    })();
  }

  return defaultEmbedderPromise;
}

function isEmptyEmbeddingValue(embedding?: Uint8Array | ArrayBuffer | string | null): boolean {
  if (!embedding) {
    return true;
  }

  if (typeof embedding === 'string' || embedding instanceof Uint8Array) {
    return embedding.length === 0;
  }

  return embedding.byteLength === 0;
}

export function decodeEmbedding(embedding?: Uint8Array | ArrayBuffer | string | null): number[] {
  if (isEmptyEmbeddingValue(embedding)) {
    return [];
  }

  try {
    if (typeof embedding !== 'string' && !embedding) {
      return [];
    }

    const raw = typeof embedding === 'string'
      ? embedding
      : new TextDecoder().decode(embedding instanceof Uint8Array ? embedding : new Uint8Array(embedding));
    const parsed = JSON.parse(raw) as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  } catch {
    return [];
  }
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < left.length; index++) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

export async function embedMemoryTexts(texts: string[], embedTexts?: EmbedTexts, embedderKey?: string): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  const resolvedEmbedTexts = embedTexts ?? await loadDefaultEmbedder(embedderKey);
  return getEmbeddings(texts, resolvedEmbedTexts);
}

export function storeMemory(params: {
  content: string;
  agentGroupId: string;
  sessionId?: string;
  importance?: number;
  embedding?: number[];
  db: Database;
}): Memory {
  const { content, agentGroupId, sessionId, importance = 0.5, db } = params;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const embedding = params.embedding ? encodeEmbedding(params.embedding) : undefined;

  db.run(
    `INSERT INTO memories (id, content, embedding, agent_group_id, session_id, importance, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, content, embedding ?? null, agentGroupId, sessionId ?? null, importance, now],
  );

  db.run(
    `INSERT INTO memories_fts(rowid, content)
     VALUES ((SELECT rowid FROM memories WHERE id = ?), ?)`,
    [id, content],
  );

  return {
    id,
    content,
    embedding,
    agent_group_id: agentGroupId,
    session_id: sessionId,
    importance,
    created_at: now,
  };
}

export async function storeMemoryWithEmbedding(params: {
  content: string;
  agentGroupId: string;
  sessionId?: string;
  importance?: number;
  embedTexts?: EmbedTexts;
  embedderKey?: string;
  db: Database;
}): Promise<Memory> {
  const embeddings = await embedMemoryTexts([params.content], params.embedTexts, params.embedderKey);

  return storeMemory({
    content: params.content,
    agentGroupId: params.agentGroupId,
    sessionId: params.sessionId,
    importance: params.importance,
    embedding: embeddings[0],
    db: params.db,
  });
}

export function searchMemoriesByKeyword(params: {
  query: string;
  agentGroupId: string;
  limit?: number;
  db: Database;
}): Memory[] {
  const { query, agentGroupId, limit = 10, db } = params;
  const queryTokens = query.toLowerCase().split(/\s+/).filter(Boolean);

  if (queryTokens.length === 0) {
    return [];
  }

  const ftsQuery = queryTokens
    .map((token) => {
      const escaped = token.replace(/"/g, '""');
      return escaped.includes(' ') ? `"${escaped}"` : escaped;
    })
    .join(' OR ');

  try {
    return db.prepare(
      `SELECT m.id, m.content, m.agent_group_id, m.session_id, m.importance, m.created_at
       FROM memories_fts f
       JOIN memories m ON m.rowid = f.rowid
       WHERE memories_fts MATCH ?
         AND m.agent_group_id = ?
       ORDER BY rank
       LIMIT ?`,
    ).all(ftsQuery, agentGroupId, limit) as Memory[];
  } catch {
    const allRows = db.prepare(
      `SELECT id, content, agent_group_id, session_id, importance, created_at
       FROM memories
       WHERE agent_group_id = ?`,
    ).all(agentGroupId) as Memory[];

    return allRows
      .filter((memory) => {
        const lower = memory.content.toLowerCase();
        return queryTokens.some((token) => lower.includes(token));
      })
      .slice(0, limit);
  }
}

export async function searchMemoriesByVector(params: {
  query: string;
  agentGroupId: string;
  limit?: number;
  embedTexts?: EmbedTexts;
  embedderKey?: string;
  db: Database;
}): Promise<Memory[]> {
  const query = params.query.trim();

  if (!query) {
    return [];
  }

  const memoryColumns = params.db.prepare("PRAGMA table_info('memories')").all() as Array<{ name: string }>;
  const hasEmbeddingColumn = memoryColumns.some((column) => column.name === 'embedding');
  const memorySelectColumns = hasEmbeddingColumn
    ? 'id, content, embedding, agent_group_id, session_id, importance, created_at'
    : 'id, content, agent_group_id, session_id, importance, created_at';

  const rows = params.db.prepare(
    `SELECT ${memorySelectColumns}
     FROM memories
     WHERE agent_group_id = ?`,
  ).all(params.agentGroupId) as PersistedMemory[];

  const storedEmbeddings = rows.map((memory) => decodeEmbedding(memory.embedding));
  const queryEmbeddings = await embedMemoryTexts([query], params.embedTexts, params.embedderKey);
  const queryEmbedding = queryEmbeddings[0] ?? [];

  const embeddedMissingRows = new Map<string, number[]>();

  for (const memory of rows) {
    if (hasStoredEmbeddingValue(memory.embedding)) {
      continue;
    }

    const [embedded] = await embedMemoryTexts([memory.content], params.embedTexts, params.embedderKey);
    embeddedMissingRows.set(memory.id, embedded ?? []);
  }

  const ranked = queryEmbedding.length > 0
    ? (() => {
        return rows.map((memory, index) => {
          const storedEmbedding = storedEmbeddings[index] ?? [];
          const embedding = storedEmbedding.length > 0 ? storedEmbedding : (embeddedMissingRows.get(memory.id) ?? []);

          return {
            memory,
            score: cosineSimilarity(queryEmbedding, embedding),
          } satisfies RankedMemory;
        });
      })()
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score || (right.memory.importance ?? 0) - (left.memory.importance ?? 0))
        .slice(0, params.limit ?? 10)
        .map((entry) => entry.memory)
    : [];

  if (ranked.length > 0) {
    return ranked;
  }

  return searchMemoriesByKeyword({
    query: params.query,
    agentGroupId: params.agentGroupId,
    limit: params.limit,
    db: params.db,
  });
}
