import type { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';

import { embedMemoryTexts, type EmbedTexts } from '../context/external.ts';
import { getStateDir } from '../db/index.ts';

export type WikiFileRecord = {
  id: string;
  slug: string;
  title: string;
  content: string;
  tags?: string;
  provenance?: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
};

export class InvalidWikiSlugError extends Error {
  constructor(slug: string) {
    super(`Invalid wiki slug: ${slug}`);
    this.name = 'InvalidWikiSlugError';
  }
}

export class InvalidWikiFieldError extends Error {
  constructor(field: string) {
    super(`Wiki field '${field}' must be a single line`);
    this.name = 'InvalidWikiFieldError';
  }
}

export class DuplicateWikiEntryError extends Error {
  constructor(slug: string) {
    super(`Wiki entry with slug '${slug}' already exists`);
    this.name = 'DuplicateWikiEntryError';
  }
}

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

function tokenizeWikiQuery(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function buildWikiFtsQuery(queryTokens: string[]): string {
  return queryTokens
    .map((token) => token.replace(/"/g, '""'))
    .join(' OR ');
}

function lexicalFallbackScore(entry: WikiFileRecord, queryTokens: string[]): number {
  if (queryTokens.length === 0) {
    return 0;
  }

  const searchable = [entry.title, entry.content, entry.tags ?? ''].join('\n').toLowerCase();
  let matchCount = 0;

  for (const token of queryTokens) {
    if (searchable.includes(token)) {
      matchCount += 1;
    }
  }

  return matchCount > 0 ? matchCount / queryTokens.length : 0;
}

function wikiEmbeddingInput(entry: WikiFileRecord): string {
  return `${entry.title}\n\n${entry.content}`;
}

function hasWikiFts(db: Database): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wiki_fts'")
    .get() as { name?: string } | undefined;

  return row?.name === 'wiki_fts';
}

function rebuildWikiFts(db: Database): void {
  if (!hasWikiFts(db)) {
    return;
  }

  db.run("INSERT INTO wiki_fts(wiki_fts) VALUES('rebuild')");
}

function sameWikiRecord(left: WikiFileRecord, right: WikiFileRecord): boolean {
  return left.id === right.id
    && left.slug === right.slug
    && left.title === right.title
    && left.content === right.content
    && (left.tags ?? null) === (right.tags ?? null)
    && (left.provenance ?? null) === (right.provenance ?? null)
    && (left.created_by ?? null) === (right.created_by ?? null)
    && left.created_at === right.created_at
    && left.updated_at === right.updated_at;
}

function syncWikiIndex(entry: WikiFileRecord, db: Database): boolean {
  const tags = entry.tags ?? null;
  const existing = db.prepare(
    `SELECT rowid, id, slug, title, content, tags, provenance, created_by, created_at, updated_at
     FROM wiki_entries
     WHERE slug = ?`,
  ).get(entry.slug) as ({ rowid: number } & WikiFileRecord) | undefined;

  if (existing) {
    if (sameWikiRecord(existing, entry)) {
      return false;
    }

    db.run(
      `UPDATE wiki_entries
       SET id = ?, title = ?, content = ?, tags = ?, provenance = ?, created_by = ?, created_at = ?, updated_at = ?
       WHERE slug = ?`,
      [
        entry.id,
        entry.title,
        entry.content,
        tags,
        entry.provenance ?? null,
        entry.created_by ?? null,
        entry.created_at,
        entry.updated_at,
        entry.slug,
      ],
    );

    return true;
  }

  db.run(
    `INSERT INTO wiki_entries (id, slug, title, content, tags, provenance, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.id,
      entry.slug,
      entry.title,
      entry.content,
      tags,
      entry.provenance ?? null,
      entry.created_by ?? null,
      entry.created_at,
      entry.updated_at,
    ],
  );

  return true;
}

function getWikiDir(): string {
  return path.join(getStateDir(), 'wiki');
}

function deleteWikiFile(slug: string): void {
  const filePath = wikiFilePath(slug);

  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath);
  }
}

function assertSafeSlug(slug: string): string {
  const normalized = slug.trim();

  if (normalized === '' || normalized.includes('/') || normalized.includes('\\') || normalized === '.' || normalized === '..' || normalized.includes('..')) {
    throw new InvalidWikiSlugError(slug);
  }

  return normalized;
}

export function wikiFilePath(slug: string): string {
  return path.join(getWikiDir(), `${assertSafeSlug(slug)}.md`);
}

function ensureWikiDir(): void {
  fs.mkdirSync(getWikiDir(), { recursive: true });
}

function escapeYaml(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function assertSingleLineYamlValue(field: string, value: string): void {
  if (value.includes('\n') || value.includes('\r')) {
    throw new InvalidWikiFieldError(field);
  }
}

function formatYamlString(value: string): string {
  return `"${escapeYaml(value)}"`;
}

function formatYamlTags(tags?: string): string | undefined {
  if (!tags) {
    return undefined;
  }

  const values = tags.split(',').map((tag) => tag.trim()).filter(Boolean);
  return values.length > 0 ? `[${values.map(formatYamlString).join(', ')}]` : undefined;
}

function parseYamlString(value: string): string {
  const trimmed = value.trim();

  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }

  return trimmed;
}

function parseYamlTags(value: string): string | undefined {
  const trimmed = value.trim();

  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    return trimmed || undefined;
  }

  const inner = trimmed.slice(1, -1).trim();

  if (!inner) {
    return undefined;
  }

  return inner
    .split(',')
    .map((tag) => parseYamlString(tag))
    .filter(Boolean)
    .join(',');
}

function normalizeTags(tags?: string[]): string | undefined {
  if (!tags) {
    return undefined;
  }

  const normalized = tags.map((tag) => tag.trim()).filter(Boolean);
  return normalized.length > 0 ? normalized.join(',') : undefined;
}

function resolveProvenance(provenance?: string, createdBy?: string): string {
  const trimmed = provenance?.trim();

  if (trimmed) {
    return trimmed;
  }

  return createdBy?.trim().toLowerCase() === 'agent' ? 'agent' : 'human';
}

export function serializeWikiFile(entry: WikiFileRecord): string {
  assertSingleLineYamlValue('id', entry.id);
  assertSingleLineYamlValue('title', entry.title);
  assertSingleLineYamlValue('created_at', entry.created_at);
  assertSingleLineYamlValue('updated_at', entry.updated_at);

  if (entry.provenance != null) {
    assertSingleLineYamlValue('provenance', entry.provenance);
  }

  if (entry.created_by != null) {
    assertSingleLineYamlValue('created_by', entry.created_by);
  }

  if (entry.tags != null) {
    assertSingleLineYamlValue('tags', entry.tags);
  }

  const frontmatter = [
    '---',
    `id: ${formatYamlString(entry.id)}`,
    `title: ${formatYamlString(entry.title)}`,
    ...(formatYamlTags(entry.tags) ? [`tags: ${formatYamlTags(entry.tags)}`] : []),
    ...(entry.provenance ? [`provenance: ${formatYamlString(entry.provenance)}`] : []),
    ...(entry.created_by ? [`created_by: ${formatYamlString(entry.created_by)}`] : []),
    `created_at: ${formatYamlString(entry.created_at)}`,
    `updated_at: ${formatYamlString(entry.updated_at)}`,
    '---',
  ];

  return `${frontmatter.join('\n')}\n${entry.content}`;
}

export function parseWikiFile(slug: string, raw: string): WikiFileRecord {
  const safeSlug = assertSafeSlug(slug);
  const normalized = raw.replace(/\r\n/g, '\n');

  if (!normalized.startsWith('---\n')) {
    throw new Error(`Wiki file '${safeSlug}' is missing frontmatter`);
  }

  const closingFenceWithBody = normalized.indexOf('\n---\n', 4);
  const closingFenceAtEof = normalized.endsWith('\n---') ? normalized.length - 4 : -1;
  const endIndex = closingFenceWithBody >= 0 ? closingFenceWithBody : closingFenceAtEof;

  if (endIndex === -1) {
    throw new Error(`Wiki file '${safeSlug}' has invalid frontmatter`);
  }

  const frontmatterBlock = normalized.slice(4, endIndex);
  const body = closingFenceWithBody >= 0 ? normalized.slice(endIndex + 5) : '';
  const fields = new Map<string, string>();

  for (const line of frontmatterBlock.split('\n')) {
    if (!line.trim()) {
      continue;
    }

    const separatorIndex = line.indexOf(':');

    if (separatorIndex === -1) {
      throw new Error(`Wiki file '${safeSlug}' has invalid frontmatter`);
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();

    if (key) {
      fields.set(key, value);
    }
  }

  const id = fields.get('id');
  const title = fields.get('title');
  const createdAt = fields.get('created_at');
  const updatedAt = fields.get('updated_at');

  if (!id || !title || !createdAt || !updatedAt) {
    throw new Error(`Wiki file '${safeSlug}' is missing required metadata`);
  }

  return {
    id: parseYamlString(id),
    slug: safeSlug,
    title: parseYamlString(title),
    content: body,
    tags: fields.has('tags') ? parseYamlTags(fields.get('tags') as string) : undefined,
    provenance: fields.has('provenance') ? parseYamlString(fields.get('provenance') as string) : undefined,
    created_by: fields.has('created_by') ? parseYamlString(fields.get('created_by') as string) : undefined,
    created_at: parseYamlString(createdAt),
    updated_at: parseYamlString(updatedAt),
  };
}

export function writeWikiFile(entry: WikiFileRecord): void {
  ensureWikiDir();
  fs.writeFileSync(wikiFilePath(entry.slug), serializeWikiFile(entry), 'utf8');
}

export function readWikiFile(slug: string): WikiFileRecord | null {
  const filePath = wikiFilePath(slug);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  return parseWikiFile(slug, fs.readFileSync(filePath, 'utf8'));
}

function listFileEntries(): WikiFileRecord[] {
  const wikiDir = getWikiDir();

  if (!fs.existsSync(wikiDir)) {
    return [];
  }

  return fs
    .readdirSync(wikiDir)
    .filter((file) => file.endsWith('.md'))
    .map((file) => parseWikiFile(file.slice(0, -3), fs.readFileSync(path.join(wikiDir, file), 'utf8')));
}

function loadIndexedEntries(db: Database): WikiFileRecord[] {
  return db.prepare(
    `SELECT id, slug, title, content, tags, provenance, created_by, created_at, updated_at
     FROM wiki_entries
     ORDER BY created_at DESC`,
  ).all() as WikiFileRecord[];
}

export function ensureFileBackedEntry(slug: string, db: Database): WikiFileRecord | null {
  const fileEntry = readWikiFile(slug);

  if (fileEntry != null) {
    if (syncWikiIndex(fileEntry, db)) {
      rebuildWikiFts(db);
    }

    return fileEntry;
  }

  const row = db.prepare(
    `SELECT id, slug, title, content, tags, provenance, created_by, created_at, updated_at
     FROM wiki_entries
     WHERE slug = ?`,
  ).get(slug) as WikiFileRecord | undefined;

  if (row == null) {
    return null;
  }

  writeWikiFile(row);

  if (syncWikiIndex(row, db)) {
    rebuildWikiFts(db);
  }

  return row;
}

export function listWikiEntries(db: Database): WikiFileRecord[] {
  const indexedEntries = loadIndexedEntries(db);
  const fileEntries = listFileEntries();
  const entriesBySlug = new Map<string, WikiFileRecord>();

  for (const entry of indexedEntries) {
    entriesBySlug.set(entry.slug, entry);
  }

  db.transaction(() => {
    let changed = false;

    for (const entry of fileEntries) {
      changed = syncWikiIndex(entry, db) || changed;
      entriesBySlug.set(entry.slug, entry);
    }

    if (changed) {
      rebuildWikiFts(db);
    }
  })();

  return Array.from(entriesBySlug.values()).sort((left, right) => right.created_at.localeCompare(left.created_at));
}

export function createWikiEntry(params: {
  slug: string;
  title: string;
  content: string;
  tags?: string[];
  provenance?: string;
  created_by?: string;
  db: Database;
}): WikiFileRecord {
  const { slug, title, content, tags, provenance, created_by, db } = params;
  const normalizedSlug = assertSafeSlug(slug);

  if (ensureFileBackedEntry(normalizedSlug, db) != null) {
    throw new DuplicateWikiEntryError(normalizedSlug);
  }

  const now = new Date().toISOString();
  const entry: WikiFileRecord = {
    id: crypto.randomUUID(),
    slug: normalizedSlug,
    title,
    content,
    tags: normalizeTags(tags),
    provenance: resolveProvenance(provenance, created_by),
    created_by: created_by || undefined,
    created_at: now,
    updated_at: now,
  };

  writeWikiFile(entry);

  if (syncWikiIndex(entry, db)) {
    rebuildWikiFts(db);
  }

  return entry;
}

export function getWikiEntry(slug: string, db: Database): WikiFileRecord | null {
  return ensureFileBackedEntry(slug, db);
}

export function updateWikiEntry(
  slug: string,
  updates: {
    title?: string;
    content?: string;
    tags?: string[];
    provenance?: string;
  },
  db: Database,
): WikiFileRecord | null {
  const existing = ensureFileBackedEntry(slug, db);

  if (existing == null) {
    return null;
  }

  const updated: WikiFileRecord = {
    ...existing,
    title: updates.title ?? existing.title,
    content: updates.content ?? existing.content,
    tags: updates.tags === undefined ? existing.tags : normalizeTags(updates.tags),
    provenance: updates.provenance === undefined ? existing.provenance : resolveProvenance(updates.provenance, existing.created_by),
    updated_at: new Date().toISOString(),
  };

  writeWikiFile(updated);

  if (syncWikiIndex(updated, db)) {
    rebuildWikiFts(db);
  }

  return updated;
}

export function deleteWikiEntry(slug: string, db: Database): boolean {
  const existing = ensureFileBackedEntry(slug, db);

  if (existing == null) {
    return false;
  }

  deleteWikiFile(existing.slug);

  const existingRow = db.prepare('SELECT rowid FROM wiki_entries WHERE slug = ?').get(existing.slug) as { rowid: number } | undefined;

  if (existingRow && hasWikiFts(db)) {
    db.run(`INSERT INTO wiki_fts(wiki_fts, rowid, title, content, tags) VALUES('delete', ?, '', '', '')`, [existingRow.rowid]);
  }

  db.run('DELETE FROM wiki_entries WHERE slug = ?', [existing.slug]);
  return true;
}

export async function hybridSearchWikiEntries(
  query: string,
  db: Database,
  limit = 10,
  options?: {
    minScore?: number;
    embeddingWeight?: number;
    embedTexts?: EmbedTexts;
  },
): Promise<WikiFileRecord[]> {
  const normalizedQuery = query.trim();

  if (!normalizedQuery) {
    return [];
  }

  const queryTokens = tokenizeWikiQuery(normalizedQuery);

  if (queryTokens.length === 0) {
    return [];
  }

  const minScore = options?.minScore ?? 0;
  const embeddingWeight = options?.embeddingWeight ?? 0.7;
  const normalizedLimit = Math.max(0, Math.trunc(limit));
  const entries = listWikiEntries(db);

  if (entries.length === 0 || normalizedLimit === 0) {
    return [];
  }

  const lexicalScores = new Map<string, number>();
  const vectorScores = new Map<string, number>();
  let shouldUseLexicalFallback = !hasWikiFts(db);

  if (!shouldUseLexicalFallback) {
    try {
      const ftsRows = db.prepare(
        `SELECT w.slug, rank AS fts_rank
         FROM wiki_fts f
         JOIN wiki_entries w ON w.rowid = f.rowid
         WHERE wiki_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      ).all(buildWikiFtsQuery(queryTokens), entries.length) as Array<{ slug: string; fts_rank: number }>;

      for (const row of ftsRows) {
        lexicalScores.set(row.slug, Math.max(lexicalScores.get(row.slug) ?? 0, normalizeFtsScore(row.fts_rank)));
      }
    } catch {
      shouldUseLexicalFallback = true;
    }
  }

  if (shouldUseLexicalFallback) {
    for (const entry of entries) {
      const score = lexicalFallbackScore(entry, queryTokens);

      if (score > 0) {
        lexicalScores.set(entry.slug, score);
      }
    }
  }

  try {
    const [queryEmbedding = []] = await embedMemoryTexts([normalizedQuery], options?.embedTexts);

    if (queryEmbedding.length > 0) {
      const entryEmbeddings = await embedMemoryTexts(entries.map(wikiEmbeddingInput), options?.embedTexts);

      entries.forEach((entry, index) => {
        const score = cosineSimilarity(queryEmbedding, entryEmbeddings[index] ?? []);

        if (score > 0) {
          vectorScores.set(entry.slug, score);
        }
      });
    }
  } catch {
    // Keep lexical-only results when embedding generation is unavailable.
  }

  return entries
    .map((entry) => {
      const lexicalScore = lexicalScores.get(entry.slug) ?? 0;
      const vectorScore = vectorScores.get(entry.slug) ?? 0;
      const finalScore = lexicalScore > 0 && vectorScore > 0
        ? vectorScore * embeddingWeight + lexicalScore * (1 - embeddingWeight)
        : Math.max(vectorScore, lexicalScore);

      return { entry, finalScore };
    })
    .filter(({ finalScore }) => finalScore > 0 && finalScore >= minScore)
    .sort((left, right) => right.finalScore - left.finalScore)
    .slice(0, normalizedLimit)
    .map(({ entry }) => entry);
}
