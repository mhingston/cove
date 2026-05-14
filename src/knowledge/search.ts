import type { Database } from 'bun:sqlite';

import { decodeEmbedding, embedMemoryTexts, type EmbedTexts, type Memory } from '../context/external.ts';

type PersistedMemory = Omit<Memory, 'embedding'> & {
  embedding?: unknown;
};

export type ScoredMemory = Memory & {
  score: number;
};

function normalizeFtsScore(raw: number): number {
  return 1 - 1 / (1 + Math.abs(raw));
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

function tokenizeQuery(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function buildFtsQuery(queryTokens: string[]): string {
  return queryTokens
    .map((token) => {
      const escaped = token.replace(/"/g, '""');
      return escaped.includes(' ') ? `"${escaped}"` : escaped;
    })
    .join(' OR ');
}

function lexicalFallbackScore(content: string, queryTokens: string[]): number {
  if (queryTokens.length === 0) {
    return 0;
  }

  const lower = content.toLowerCase();
  let matchCount = 0;

  for (const token of queryTokens) {
    if (lower.includes(token)) {
      matchCount++;
    }
  }

  return matchCount > 0 ? matchCount / queryTokens.length : 0;
}

function hasStoredEmbeddingValue(embedding: unknown, hasEmbeddingColumn: boolean): boolean {
  if (!hasEmbeddingColumn || embedding == null) {
    return false;
  }

  if (typeof embedding === 'string') {
    return embedding.length > 0;
  }

  if (embedding instanceof Uint8Array) {
    return embedding.length > 0;
  }

  if (embedding instanceof ArrayBuffer) {
    return embedding.byteLength > 0;
  }

  return false;
}

function decodePersistedEmbedding(embedding: unknown): number[] {
  return decodeEmbedding(
    typeof embedding === 'string' || embedding instanceof Uint8Array || embedding instanceof ArrayBuffer || embedding == null
      ? embedding
      : undefined,
  );
}

export async function hybridSearch(params: {
  query: string;
  db: Database;
  agentGroupId?: string;
  maxResults?: number;
  minScore?: number;
  embeddingWeight?: number;
  embedTexts?: EmbedTexts;
  embedderKey?: string;
}): Promise<ScoredMemory[]> {
  const query = params.query.trim();

  if (!query) {
    return [];
  }

  const maxResults = params.maxResults ?? 5;
  const minScore = params.minScore ?? 0;
  const embeddingWeight = params.embeddingWeight ?? 0.7;
  const queryTokens = tokenizeQuery(query);

  if (queryTokens.length === 0) {
    return [];
  }

  const memoryColumns = params.db.prepare("PRAGMA table_info('memories')").all() as Array<{ name: string }>;
  const hasEmbeddingColumn = memoryColumns.some((column) => column.name === 'embedding');
  const memorySelectColumns = hasEmbeddingColumn
    ? 'id, content, embedding, agent_group_id, session_id, importance, created_at'
    : 'id, content, agent_group_id, session_id, importance, created_at';
  const ftsSelectColumns = hasEmbeddingColumn
    ? 'm.id, m.content, m.embedding, m.agent_group_id, m.session_id, m.importance, m.created_at'
    : 'm.id, m.content, m.agent_group_id, m.session_id, m.importance, m.created_at';

  const scopeSql = params.agentGroupId ? ' WHERE agent_group_id = ?' : '';
  const ftsScopeSql = params.agentGroupId ? ' AND m.agent_group_id = ?' : '';
  const scopeArgs = params.agentGroupId ? [params.agentGroupId] : [];
  const scored = new Map<string, { memory: PersistedMemory; vectorScore: number; lexicalScore: number }>();

  let ftsWorked = false;

  try {
    const ftsRows = params.db.prepare(
      `SELECT ${ftsSelectColumns},
              rank AS fts_rank
       FROM memories_fts f
       JOIN memories m ON m.rowid = f.rowid
       WHERE memories_fts MATCH ?${ftsScopeSql}
       ORDER BY rank
       LIMIT ?`,
    ).all(buildFtsQuery(queryTokens), ...scopeArgs, maxResults * 3) as Array<PersistedMemory & { fts_rank: number }>;

    if (ftsRows.length > 0) {
      ftsWorked = true;
    }

    for (const row of ftsRows) {
      const lexicalScore = normalizeFtsScore(row.fts_rank);
      const existing = scored.get(row.id);

      if (existing) {
        existing.lexicalScore = Math.max(existing.lexicalScore, lexicalScore);
      } else {
        scored.set(row.id, {
          memory: row,
          vectorScore: 0,
          lexicalScore,
        });
      }
    }
  } catch {
    // Fall through to lexical fallback.
  }

  if (!ftsWorked) {
    const fallbackRows = params.db.prepare(
      `SELECT ${memorySelectColumns}
       FROM memories${scopeSql}`,
    ).all(...scopeArgs) as PersistedMemory[];

    for (const row of fallbackRows) {
      const lexicalScore = lexicalFallbackScore(row.content, queryTokens);

      if (lexicalScore <= 0) {
        continue;
      }

      const existing = scored.get(row.id);

      if (existing) {
        existing.lexicalScore = Math.max(existing.lexicalScore, lexicalScore);
      } else {
        scored.set(row.id, {
          memory: row,
          vectorScore: 0,
          lexicalScore,
        });
      }
    }
  }

  const vectorRows = params.db.prepare(
    `SELECT ${memorySelectColumns}
     FROM memories${scopeSql}`,
  ).all(...scopeArgs) as PersistedMemory[];

  const queryEmbeddings = await embedMemoryTexts([query], params.embedTexts, params.embedderKey);
  const queryEmbedding = queryEmbeddings[0] ?? [];
  const storedEmbeddings = vectorRows.map((row) => decodePersistedEmbedding(row.embedding));
  const rowsNeedingEmbedding = vectorRows.filter((row, index) => {
    if (!hasStoredEmbeddingValue(row.embedding, hasEmbeddingColumn)) {
      return true;
    }

    return storedEmbeddings[index]?.length === 0;
  });
  const embeddedMissingRows = new Map<string, number[]>();

  if (rowsNeedingEmbedding.length > 0) {
    const embeddedRows = await embedMemoryTexts(
      rowsNeedingEmbedding.map((row) => row.content),
      params.embedTexts,
      params.embedderKey,
    );

    rowsNeedingEmbedding.forEach((row, index) => {
      embeddedMissingRows.set(row.id, embeddedRows[index] ?? []);
    });
  }

  if (queryEmbedding.length > 0) {
    for (const [index, row] of vectorRows.entries()) {
      const storedEmbedding = storedEmbeddings[index] ?? [];
      const embedding = storedEmbedding.length > 0 ? storedEmbedding : (embeddedMissingRows.get(row.id) ?? []);
      const vectorScore = cosineSimilarity(queryEmbedding, embedding);

      if (vectorScore <= 0) {
        continue;
      }

      const existing = scored.get(row.id);

      if (existing) {
        existing.vectorScore = Math.max(existing.vectorScore, vectorScore);
      } else {
        scored.set(row.id, {
          memory: row,
          vectorScore,
          lexicalScore: 0,
        });
      }
    }
  }

  const results: ScoredMemory[] = [];

  for (const { memory, vectorScore, lexicalScore } of scored.values()) {
    const score = vectorScore > 0 && lexicalScore > 0
      ? vectorScore * embeddingWeight + lexicalScore * (1 - embeddingWeight)
      : Math.max(vectorScore, lexicalScore);

    if (score < minScore) {
      continue;
    }

    const { embedding: _rawEmbedding, ...memoryWithoutRawEmbedding } = memory;

    results.push({
      ...memoryWithoutRawEmbedding,
      score,
    });
  }

  results.sort((left, right) => right.score - left.score || (right.importance ?? 0) - (left.importance ?? 0));
  return results.slice(0, maxResults);
}
