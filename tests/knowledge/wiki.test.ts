import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as wikiModule from '../../src/knowledge/wiki.ts';

import {
  createWikiEntry,
  deleteWikiEntry,
  ensureFileBackedEntry,
  getWikiEntry,
  listWikiEntries,
  parseWikiFile,
  readWikiFile,
  serializeWikiFile,
  updateWikiEntry,
  wikiFilePath,
  writeWikiFile,
} from '../../src/knowledge/wiki.ts';

type EmbedTexts = (texts: string[]) => Promise<number[][]>;

type HybridSearchOptions = {
  minScore?: number;
  embeddingWeight?: number;
  embedTexts?: EmbedTexts;
};

type HybridSearchWikiEntries = (
  query: string,
  db: Database,
  limit?: number,
  options?: HybridSearchOptions,
) => Promise<WikiFileRow[]>;

const hybridSearchWikiEntries = (wikiModule as typeof wikiModule & {
  hybridSearchWikiEntries?: HybridSearchWikiEntries;
}).hybridSearchWikiEntries;

type WikiFileRow = {
  id: string;
  slug: string;
  title: string;
  content: string;
  tags?: string | null;
  provenance?: string | null;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
};

const tempDirs: string[] = [];

function makeStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cove-v2-wiki-'));
  tempDirs.push(dir);
  return dir;
}

function createWikiDb(options?: { withFts?: boolean }): Database {
  const db = new Database(':memory:');
  const withFts = options?.withFts ?? true;

  db.exec(`
    CREATE TABLE wiki_entries (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT,
      provenance TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    ${withFts ? `
    CREATE VIRTUAL TABLE wiki_fts USING fts5(
      title, content, tags,
      content=wiki_entries, content_rowid=rowid
    );
    ` : ''}
  `);

  return db;
}

function makeEmbedder(vectors: Record<string, number[]>, calls?: string[][]): EmbedTexts {
  return async (texts) => {
    calls?.push([...texts]);
    return texts.map((text) => vectors[text] ?? []);
  };
}

async function runHybridSearchWikiEntries(
  query: string,
  db: Database,
  limit?: number,
  options?: HybridSearchOptions,
): Promise<WikiFileRow[]> {
  if (typeof hybridSearchWikiEntries !== 'function') {
    throw new Error('hybridSearchWikiEntries is not implemented');
  }

  return hybridSearchWikiEntries(query, db, limit, options);
}

afterEach(() => {
  delete process.env.COVE_STATE_DIR;

  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('wiki file primitives', () => {
  it('maps a safe slug to <state-dir>/wiki/<slug>.md', () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    expect(wikiFilePath('safe-slug')).toBe(path.join(stateDir, 'wiki', 'safe-slug.md'));
  });

  it('rejects unsafe slugs that would escape the wiki directory', () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    expect(() => wikiFilePath('../escape')).toThrow();
    expect(() => wikiFilePath('nested/path')).toThrow();
    expect(() => wikiFilePath('')).toThrow();
  });

  it('serializes wiki records to YAML frontmatter plus markdown body', () => {
    const serialized = serializeWikiFile({
      id: 'wiki-1',
      slug: 'test-page',
      title: 'Test Page',
      content: '# Heading\n\nBody text',
      tags: 'docs,example',
      provenance: 'human',
      created_by: 'alice',
      created_at: '2026-05-11T00:00:00.000Z',
      updated_at: '2026-05-11T01:00:00.000Z',
    });

    expect(serialized).toContain('---\n');
    expect(serialized).toContain('id: "wiki-1"');
    expect(serialized).toContain('title: "Test Page"');
    expect(serialized).toContain('tags: ["docs", "example"]');
    expect(serialized).toContain('provenance: "human"');
    expect(serialized).toContain('created_by: "alice"');
    expect(serialized.endsWith('# Heading\n\nBody text')).toBe(true);
  });

  it('parses a serialized wiki file back into the same metadata and body', () => {
    const raw = serializeWikiFile({
      id: 'wiki-1',
      slug: 'test-page',
      title: 'Test Page',
      content: '# Heading\n\nBody text',
      tags: 'docs,example',
      provenance: 'human',
      created_by: 'alice',
      created_at: '2026-05-11T00:00:00.000Z',
      updated_at: '2026-05-11T01:00:00.000Z',
    });

    expect(parseWikiFile('test-page', raw)).toEqual({
      id: 'wiki-1',
      slug: 'test-page',
      title: 'Test Page',
      content: '# Heading\n\nBody text',
      tags: 'docs,example',
      provenance: 'human',
      created_by: 'alice',
      created_at: '2026-05-11T00:00:00.000Z',
      updated_at: '2026-05-11T01:00:00.000Z',
    });
  });

  it('rejects missing or malformed frontmatter', () => {
    expect(() => parseWikiFile('broken', '# No frontmatter')).toThrow();
    expect(() => parseWikiFile('broken', '---\nid: "x"\n# Missing closing fence')).toThrow();
    expect(() => parseWikiFile('broken', '---\nid: "x"\n---\nBody')).toThrow();
    expect(() => parseWikiFile(
      'broken',
      [
        '---',
        'id: "x"',
        'title: "Valid title"',
        'not-a-valid-line',
        'created_at: "2026-05-11T00:00:00.000Z"',
        'updated_at: "2026-05-11T01:00:00.000Z"',
        '---',
        'Body',
      ].join('\n'),
    )).toThrow();
  });

  it('rejects metadata values containing newlines during serialization', () => {
    expect(() => serializeWikiFile({
      id: 'wiki-1',
      slug: 'test-page',
      title: 'Line 1\nLine 2',
      content: 'Body text',
      created_at: '2026-05-11T00:00:00.000Z',
      updated_at: '2026-05-11T01:00:00.000Z',
    })).toThrow();
  });

  it('parses a valid frontmatter block that ends at EOF with an empty body', () => {
    const raw = [
      '---',
      'id: "wiki-1"',
      'title: "Test Page"',
      'created_at: "2026-05-11T00:00:00.000Z"',
      'updated_at: "2026-05-11T01:00:00.000Z"',
      '---',
    ].join('\n');

    expect(parseWikiFile('test-page', raw)).toEqual({
      id: 'wiki-1',
      slug: 'test-page',
      title: 'Test Page',
      content: '',
      created_at: '2026-05-11T00:00:00.000Z',
      updated_at: '2026-05-11T01:00:00.000Z',
    });
  });

  it('writes wiki files by creating the wiki directory on demand and reads them back', () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    writeWikiFile({
      id: 'wiki-1',
      slug: 'disk-page',
      title: 'Disk Page',
      content: 'Disk-backed content',
      tags: 'docs,manual',
      provenance: 'human',
      created_by: 'alice',
      created_at: '2026-05-11T00:00:00.000Z',
      updated_at: '2026-05-11T01:00:00.000Z',
    });

    expect(fs.existsSync(path.join(stateDir, 'wiki', 'disk-page.md'))).toBe(true);
    expect(readWikiFile('disk-page')).toEqual({
      id: 'wiki-1',
      slug: 'disk-page',
      title: 'Disk Page',
      content: 'Disk-backed content',
      tags: 'docs,manual',
      provenance: 'human',
      created_by: 'alice',
      created_at: '2026-05-11T00:00:00.000Z',
      updated_at: '2026-05-11T01:00:00.000Z',
    });
  });

  it('returns null when reading a missing wiki file', () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    expect(readWikiFile('missing-page')).toBeNull();
  });

  it('hydrates sqlite from the file when the markdown file exists', () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE wiki_entries (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT,
        provenance TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE wiki_fts USING fts5(
        title, content, tags,
        content=wiki_entries, content_rowid=rowid
      );
    `);

    try {
      writeWikiFile({
        id: 'file-backed-id',
        slug: 'file-backed-page',
        title: 'File Backed Page',
        content: 'File authoritative content',
        tags: 'docs,manual',
        provenance: 'human',
        created_by: 'alice',
        created_at: '2026-05-11T00:00:00.000Z',
        updated_at: '2026-05-11T01:00:00.000Z',
      });

      const hydrated = ensureFileBackedEntry('file-backed-page', db);
      const row = db.prepare(
        `SELECT id, slug, title, content, tags, provenance, created_by, created_at, updated_at
         FROM wiki_entries WHERE slug = ?`,
      ).get('file-backed-page') as WikiFileRow | null;

      expect(hydrated).toEqual({
        id: 'file-backed-id',
        slug: 'file-backed-page',
        title: 'File Backed Page',
        content: 'File authoritative content',
        tags: 'docs,manual',
        provenance: 'human',
        created_by: 'alice',
        created_at: '2026-05-11T00:00:00.000Z',
        updated_at: '2026-05-11T01:00:00.000Z',
      });
      expect(row).toEqual(hydrated);
    } finally {
      db.close();
    }
  });

  it('materializes a sqlite row to disk when the file is absent', () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE wiki_entries (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT,
        provenance TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE wiki_fts USING fts5(
        title, content, tags,
        content=wiki_entries, content_rowid=rowid
      );
    `);
    db.run(
      `INSERT INTO wiki_entries (id, slug, title, content, tags, provenance, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'db-only-id',
        'db-only-page',
        'DB Only Page',
        'Row-backed content',
        'sql,only',
        'human',
        'bob',
        '2026-05-11T00:00:00.000Z',
        '2026-05-11T01:00:00.000Z',
      ],
    );

    try {
      const hydrated = ensureFileBackedEntry('db-only-page', db);

      expect(hydrated).toEqual({
        id: 'db-only-id',
        slug: 'db-only-page',
        title: 'DB Only Page',
        content: 'Row-backed content',
        tags: 'sql,only',
        provenance: 'human',
        created_by: 'bob',
        created_at: '2026-05-11T00:00:00.000Z',
        updated_at: '2026-05-11T01:00:00.000Z',
      });
      expect(readWikiFile('db-only-page')).toEqual(hydrated);
    } finally {
      db.close();
    }
  });

  it('keeps the file authoritative when file and sqlite row differ', () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE wiki_entries (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT,
        provenance TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE wiki_fts USING fts5(
        title, content, tags,
        content=wiki_entries, content_rowid=rowid
      );
    `);
    db.run(
      `INSERT INTO wiki_entries (id, slug, title, content, tags, provenance, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'db-id',
        'conflict-page',
        'DB Title',
        'Stale DB content',
        'stale',
        'human',
        'bob',
        '2026-05-11T00:00:00.000Z',
        '2026-05-11T01:00:00.000Z',
      ],
    );
    writeWikiFile({
      id: 'file-id',
      slug: 'conflict-page',
      title: 'File Title',
      content: 'Fresh file content',
      tags: 'fresh,file',
      provenance: 'human',
      created_by: 'alice',
      created_at: '2026-05-11T02:00:00.000Z',
      updated_at: '2026-05-11T03:00:00.000Z',
    });

    try {
      const hydrated = ensureFileBackedEntry('conflict-page', db);
      const row = db.prepare(
        `SELECT id, slug, title, content, tags, provenance, created_by, created_at, updated_at
         FROM wiki_entries WHERE slug = ?`,
      ).get('conflict-page') as WikiFileRow | null;

      expect(hydrated).toEqual({
        id: 'file-id',
        slug: 'conflict-page',
        title: 'File Title',
        content: 'Fresh file content',
        tags: 'fresh,file',
        provenance: 'human',
        created_by: 'alice',
        created_at: '2026-05-11T02:00:00.000Z',
        updated_at: '2026-05-11T03:00:00.000Z',
      });
      expect(row).toEqual(hydrated);
    } finally {
      db.close();
    }
  });

  it('throws on malformed file and does not fall back to the sqlite row', () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE wiki_entries (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT,
        provenance TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.run(
      `INSERT INTO wiki_entries (id, slug, title, content, tags, provenance, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['db-id', 'broken-page', 'DB Title', 'DB content', null, null, null, '2026-05-11T00:00:00.000Z', '2026-05-11T01:00:00.000Z'],
    );
    fs.mkdirSync(path.join(stateDir, 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'wiki', 'broken-page.md'), '# Missing frontmatter', 'utf8');

    try {
      expect(() => ensureFileBackedEntry('broken-page', db)).toThrow();
      const row = db.prepare('SELECT title, content FROM wiki_entries WHERE slug = ?').get('broken-page') as
        | { title: string; content: string }
        | undefined;

      expect(row).toEqual({ title: 'DB Title', content: 'DB content' });
    } finally {
      db.close();
    }
  });

  it('returns null without creating side effects when neither file nor row exists', () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE wiki_entries (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT,
        provenance TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    try {
      expect(ensureFileBackedEntry('missing-page', db)).toBeNull();
      expect(fs.existsSync(path.join(stateDir, 'wiki', 'missing-page.md'))).toBe(false);
      const row = db.prepare('SELECT slug FROM wiki_entries WHERE slug = ?').get('missing-page');
      expect(row).toBeNull();
    } finally {
      db.close();
    }
  });

  it('keeps wiki_fts aligned with the authoritative record and remains idempotent', () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE wiki_entries (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT,
        provenance TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE wiki_fts USING fts5(
        title, content, tags,
        content=wiki_entries, content_rowid=rowid
      );
    `);
    db.run(
      `INSERT INTO wiki_entries (id, slug, title, content, tags, provenance, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['db-id', 'fts-page', 'Old Title', 'stale keyword only', 'stale', null, null, '2026-05-11T00:00:00.000Z', '2026-05-11T01:00:00.000Z'],
    );
    const existingRowId = (db.prepare('SELECT rowid FROM wiki_entries WHERE slug = ?').get('fts-page') as { rowid: number }).rowid;
    db.run('INSERT INTO wiki_fts(rowid, title, content, tags) VALUES (?, ?, ?, ?)', [existingRowId, 'Old Title', 'stale keyword only', 'stale']);
    writeWikiFile({
      id: 'file-id',
      slug: 'fts-page',
      title: 'New Title',
      content: 'fresh keyword only',
      tags: 'fresh',
      provenance: 'human',
      created_by: 'alice',
      created_at: '2026-05-11T02:00:00.000Z',
      updated_at: '2026-05-11T03:00:00.000Z',
    });

    try {
      ensureFileBackedEntry('fts-page', db);
      ensureFileBackedEntry('fts-page', db);

      const staleMatches = db.prepare(
        `SELECT w.slug
         FROM wiki_fts f
         JOIN wiki_entries w ON w.rowid = f.rowid
         WHERE wiki_fts MATCH ?`,
      ).all('stale') as Array<{ slug: string }>;
      const freshMatches = db.prepare(
        `SELECT w.slug
         FROM wiki_fts f
         JOIN wiki_entries w ON w.rowid = f.rowid
         WHERE wiki_fts MATCH ?`,
      ).all('fresh') as Array<{ slug: string }>;

      expect(staleMatches).toEqual([]);
      expect(freshMatches).toEqual([{ slug: 'fts-page' }]);
    } finally {
      db.close();
    }
  });

  it('lists file-backed entries that only exist on disk', () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE wiki_entries (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT,
        provenance TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE wiki_fts USING fts5(
        title, content, tags,
        content=wiki_entries, content_rowid=rowid
      );
    `);
    writeWikiFile({
      id: 'manual-only-id',
      slug: 'manual-only-page',
      title: 'Manual Only Page',
      content: 'This page exists only on disk.',
      tags: 'plain-file',
      provenance: 'human',
      created_by: 'bob',
      created_at: '2026-05-11T02:00:00.000Z',
      updated_at: '2026-05-11T02:30:00.000Z',
    });

    try {
      const entries = listWikiEntries(db);

      expect(entries.map((entry) => entry.slug)).toEqual(['manual-only-page']);
      const row = db.prepare(
        `SELECT id, slug, title, content, tags, provenance, created_by, created_at, updated_at
         FROM wiki_entries WHERE slug = ?`,
      ).get('manual-only-page') as WikiFileRow | null;

      expect(row).toEqual(entries[0]);
    } finally {
      db.close();
    }
  });

  it('lists indexed entries that only exist in sqlite', () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE wiki_entries (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT,
        provenance TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE wiki_fts USING fts5(
        title, content, tags,
        content=wiki_entries, content_rowid=rowid
      );
    `);
    db.run(
      `INSERT INTO wiki_entries (id, slug, title, content, tags, provenance, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'db-only-id',
        'db-only-page',
        'DB Only Page',
        'This page exists only in sqlite.',
        'sql,only',
        'human',
        'bob',
        '2026-05-11T00:00:00.000Z',
        '2026-05-11T01:00:00.000Z',
      ],
    );

    try {
      expect(listWikiEntries(db)).toEqual([
        {
          id: 'db-only-id',
          slug: 'db-only-page',
          title: 'DB Only Page',
          content: 'This page exists only in sqlite.',
          tags: 'sql,only',
          provenance: 'human',
          created_by: 'bob',
          created_at: '2026-05-11T00:00:00.000Z',
          updated_at: '2026-05-11T01:00:00.000Z',
        },
      ]);
    } finally {
      db.close();
    }
  });

  it('prefers file-backed entries for duplicate slugs and re-syncs sqlite', () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE wiki_entries (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT,
        provenance TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE wiki_fts USING fts5(
        title, content, tags,
        content=wiki_entries, content_rowid=rowid
      );
    `);
    db.run(
      `INSERT INTO wiki_entries (id, slug, title, content, tags, provenance, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'db-id',
        'shared-page',
        'DB Title',
        'Stale DB content',
        'stale',
        'human',
        'bob',
        '2026-05-11T00:00:00.000Z',
        '2026-05-11T01:00:00.000Z',
      ],
    );
    writeWikiFile({
      id: 'file-id',
      slug: 'shared-page',
      title: 'File Title',
      content: 'Fresh file content',
      tags: 'fresh,file',
      provenance: 'human',
      created_by: 'alice',
      created_at: '2026-05-11T02:00:00.000Z',
      updated_at: '2026-05-11T03:00:00.000Z',
    });

    try {
      const entries = listWikiEntries(db);
      const row = db.prepare(
        `SELECT id, slug, title, content, tags, provenance, created_by, created_at, updated_at
         FROM wiki_entries WHERE slug = ?`,
      ).get('shared-page') as WikiFileRow | null;

      expect(entries).toEqual([
        {
          id: 'file-id',
          slug: 'shared-page',
          title: 'File Title',
          content: 'Fresh file content',
          tags: 'fresh,file',
          provenance: 'human',
          created_by: 'alice',
          created_at: '2026-05-11T02:00:00.000Z',
          updated_at: '2026-05-11T03:00:00.000Z',
        },
      ]);
      expect(row).toEqual(entries[0]);
    } finally {
      db.close();
    }
  });

  it('sorts merged entries by created_at descending without duplicates', () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE wiki_entries (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT,
        provenance TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE wiki_fts USING fts5(
        title, content, tags,
        content=wiki_entries, content_rowid=rowid
      );
    `);
    db.run(
      `INSERT INTO wiki_entries (id, slug, title, content, tags, provenance, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'older-db-id',
        'older-db-page',
        'Older DB Page',
        'Older sqlite content',
        null,
        'human',
        'bob',
        '2026-05-11T00:00:00.000Z',
        '2026-05-11T00:30:00.000Z',
      ],
    );
    db.run(
      `INSERT INTO wiki_entries (id, slug, title, content, tags, provenance, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'duplicate-db-id',
        'newer-file-page',
        'Duplicate DB Title',
        'Duplicate sqlite content',
        null,
        'human',
        'bob',
        '2026-05-11T01:00:00.000Z',
        '2026-05-11T01:30:00.000Z',
      ],
    );
    writeWikiFile({
      id: 'newer-file-id',
      slug: 'newer-file-page',
      title: 'Newer File Page',
      content: 'Newest file content',
      created_at: '2026-05-11T03:00:00.000Z',
      updated_at: '2026-05-11T03:30:00.000Z',
    });
    writeWikiFile({
      id: 'middle-file-id',
      slug: 'middle-file-page',
      title: 'Middle File Page',
      content: 'Middle file content',
      created_at: '2026-05-11T02:00:00.000Z',
      updated_at: '2026-05-11T02:30:00.000Z',
    });

    try {
      const entries = listWikiEntries(db);

      expect(entries.map((entry) => entry.slug)).toEqual([
        'newer-file-page',
        'middle-file-page',
        'older-db-page',
      ]);
      expect(entries).toHaveLength(3);
    } finally {
      db.close();
    }
  });

  it('does not rewrite sqlite rows when file-backed entries are already synced', () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE wiki_entries (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT,
        provenance TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE wiki_fts USING fts5(
        title, content, tags,
        content=wiki_entries, content_rowid=rowid
      );
    `);
    writeWikiFile({
      id: 'manual-only-id',
      slug: 'manual-only-page',
      title: 'Manual Only Page',
      content: 'This page exists only on disk.',
      tags: 'plain-file',
      provenance: 'human',
      created_by: 'bob',
      created_at: '2026-05-11T02:00:00.000Z',
      updated_at: '2026-05-11T02:30:00.000Z',
    });

    try {
      listWikiEntries(db);

      let writeCount = 0;
      const originalRun = db.run.bind(db);
      db.run = ((sql: string, params?: unknown[]) => {
        writeCount += 1;

        if (params === undefined) {
          return originalRun(sql);
        }

        return originalRun(sql, params as never);
      }) as typeof db.run;

      expect(listWikiEntries(db)).toHaveLength(1);
      expect(writeCount).toBe(0);
    } finally {
      db.close();
    }
  });

  it('rebuilds wiki_fts only once when listing syncs multiple changed files', () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE wiki_entries (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT,
        provenance TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE wiki_fts USING fts5(
        title, content, tags,
        content=wiki_entries, content_rowid=rowid
      );
    `);
    writeWikiFile({
      id: 'first-id',
      slug: 'first-page',
      title: 'First Page',
      content: 'First file content',
      created_at: '2026-05-11T02:00:00.000Z',
      updated_at: '2026-05-11T02:30:00.000Z',
    });
    writeWikiFile({
      id: 'second-id',
      slug: 'second-page',
      title: 'Second Page',
      content: 'Second file content',
      created_at: '2026-05-11T03:00:00.000Z',
      updated_at: '2026-05-11T03:30:00.000Z',
    });

    try {
      let rebuildCount = 0;
      const originalRun = db.run.bind(db);
      db.run = ((sql: string, params?: unknown[]) => {
        if (sql === "INSERT INTO wiki_fts(wiki_fts) VALUES('rebuild')") {
          rebuildCount += 1;
        }

        if (params === undefined) {
          return originalRun(sql);
        }

        return originalRun(sql, params as never);
      }) as typeof db.run;

      expect(listWikiEntries(db).map((entry) => entry.slug)).toEqual(['second-page', 'first-page']);
      expect(rebuildCount).toBe(1);
    } finally {
      db.close();
    }
  });

  it('rolls back sqlite sync when listing hits a malformed file', () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE wiki_entries (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT,
        provenance TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE wiki_fts USING fts5(
        title, content, tags,
        content=wiki_entries, content_rowid=rowid
      );
    `);
    writeWikiFile({
      id: 'valid-id',
      slug: 'valid-page',
      title: 'Valid Page',
      content: 'Valid file content',
      created_at: '2026-05-11T02:00:00.000Z',
      updated_at: '2026-05-11T02:30:00.000Z',
    });
    fs.writeFileSync(path.join(stateDir, 'wiki', 'broken-page.md'), '# Missing frontmatter', 'utf8');

    try {
      expect(() => listWikiEntries(db)).toThrow();
      const validRow = db.prepare(
        `SELECT id, slug, title, content, tags, provenance, created_by, created_at, updated_at
         FROM wiki_entries WHERE slug = ?`,
      ).get('valid-page') as WikiFileRow | null;

      expect(validRow).toBeNull();
    } finally {
      db.close();
    }
  });

  it('creates a wiki entry, writes the file, and syncs the sqlite row', () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE wiki_entries (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT,
        provenance TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE wiki_fts USING fts5(
        title, content, tags,
        content=wiki_entries, content_rowid=rowid
      );
    `);

    try {
      const entry = createWikiEntry({
        slug: 'test-page',
        title: 'Test Page',
        content: 'This is test content',
        tags: ['test', 'example'],
        provenance: 'unit-test',
        created_by: 'tester',
        db,
      });

      const row = db.prepare(
        `SELECT id, slug, title, content, tags, provenance, created_by, created_at, updated_at
         FROM wiki_entries WHERE slug = ?`,
      ).get('test-page') as WikiFileRow | null;

      expect(entry.id).toEqual(expect.any(String));
      expect(entry.slug).toBe('test-page');
      expect(entry.title).toBe('Test Page');
      expect(entry.content).toBe('This is test content');
      expect(entry.tags).toBe('test,example');
      expect(entry.provenance).toBe('unit-test');
      expect(entry.created_by).toBe('tester');
      expect(entry.updated_at).toBe(entry.created_at);
      expect(readWikiFile('test-page')).toEqual(entry);
      expect(row).toEqual(entry);
    } finally {
      db.close();
    }
  });

  it('defaults provenance to human unless created_by is agent', () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE wiki_entries (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT,
        provenance TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    try {
      const humanEntry = createWikiEntry({
        slug: 'human-page',
        title: 'Human Page',
        content: 'Human content',
        db,
      });
      const agentEntry = createWikiEntry({
        slug: 'agent-page',
        title: 'Agent Page',
        content: 'Agent content',
        created_by: 'agent',
        db,
      });

      expect(humanEntry.provenance).toBe('human');
      expect(agentEntry.provenance).toBe('agent');
    } finally {
      db.close();
    }
  });

  it('rejects duplicate slugs when the existing record is file-backed', () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE wiki_entries (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT,
        provenance TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    try {
      writeWikiFile({
        id: 'existing-id',
        slug: 'duplicate-page',
        title: 'Existing Title',
        content: 'Existing content',
        created_at: '2026-05-11T00:00:00.000Z',
        updated_at: '2026-05-11T01:00:00.000Z',
      });

      expect(() => createWikiEntry({
        slug: 'duplicate-page',
        title: 'New Title',
        content: 'New content',
        db,
      })).toThrow();
      expect(readWikiFile('duplicate-page')).toEqual({
        id: 'existing-id',
        slug: 'duplicate-page',
        title: 'Existing Title',
        content: 'Existing content',
        created_at: '2026-05-11T00:00:00.000Z',
        updated_at: '2026-05-11T01:00:00.000Z',
      });
    } finally {
      db.close();
    }
  });

  it('rejects duplicate slugs when the existing record is row-backed', () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE wiki_entries (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT,
        provenance TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.run(
      `INSERT INTO wiki_entries (id, slug, title, content, tags, provenance, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['db-id', 'row-duplicate', 'DB Title', 'DB content', null, null, null, '2026-05-11T00:00:00.000Z', '2026-05-11T01:00:00.000Z'],
    );

    try {
      expect(() => createWikiEntry({
        slug: 'row-duplicate',
        title: 'New Title',
        content: 'New content',
        db,
      })).toThrow();
      expect(readWikiFile('row-duplicate')).toEqual({
        id: 'db-id',
        slug: 'row-duplicate',
        title: 'DB Title',
        content: 'DB content',
        created_at: '2026-05-11T00:00:00.000Z',
        updated_at: '2026-05-11T01:00:00.000Z',
      });
    } finally {
      db.close();
    }
  });

  it('rejects duplicate slugs when the input differs only by surrounding whitespace', () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE wiki_entries (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT,
        provenance TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.run(
      `INSERT INTO wiki_entries (id, slug, title, content, tags, provenance, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['db-id', 'trimmed-page', 'DB Title', 'DB content', null, null, null, '2026-05-11T00:00:00.000Z', '2026-05-11T01:00:00.000Z'],
    );

    try {
      expect(() => createWikiEntry({
        slug: '  trimmed-page  ',
        title: 'New Title',
        content: 'New content',
        db,
      })).toThrow();

      const row = db.prepare(
        `SELECT id, slug, title, content, created_at, updated_at
         FROM wiki_entries WHERE slug = ?`,
      ).get('trimmed-page') as { id: string; slug: string; title: string; content: string; created_at: string; updated_at: string } | null;

      expect(row).toEqual({
        id: 'db-id',
        slug: 'trimmed-page',
        title: 'DB Title',
        content: 'DB content',
        created_at: '2026-05-11T00:00:00.000Z',
        updated_at: '2026-05-11T01:00:00.000Z',
      });
    } finally {
      db.close();
    }
  });

  it('rejects duplicate slugs when a malformed file already exists', () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;
    fs.mkdirSync(path.join(stateDir, 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'wiki', 'broken-duplicate.md'), '# Missing frontmatter', 'utf8');

    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE wiki_entries (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT,
        provenance TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    try {
      expect(() => createWikiEntry({
        slug: 'broken-duplicate',
        title: 'New Title',
        content: 'New content',
        db,
      })).toThrow();
      expect(fs.readFileSync(path.join(stateDir, 'wiki', 'broken-duplicate.md'), 'utf8')).toBe('# Missing frontmatter');
    } finally {
      db.close();
    }
  });

  it('throws after file creation when sqlite sync fails and leaves the file behind for recovery', () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE wiki_entries (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT,
        provenance TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.run = (() => {
      let insertCount = 0;

      return ((sql: string, params?: unknown[]) => {
        if (sql.includes('INSERT INTO wiki_entries')) {
          insertCount += 1;
          if (insertCount === 1) {
            throw new Error('sqlite sync failed');
          }
        }

        return Database.prototype.run.call(db, sql, params as never);
      }) as typeof db.run;
    })();

    try {
      expect(() => createWikiEntry({
        slug: 'partial-page',
        title: 'Partial Page',
        content: 'Partial content',
        db,
      })).toThrow();
      expect(readWikiFile('partial-page')).toEqual(expect.objectContaining({
        slug: 'partial-page',
        title: 'Partial Page',
        content: 'Partial content',
      }));
    } finally {
      db.close();
    }
  });

  it('gets wiki entries through getWikiEntry and returns null for missing slugs', () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    const db = createWikiDb();

    try {
      const entry = createWikiEntry({
        slug: 'lookup-page',
        title: 'Lookup Page',
        content: 'Lookup content',
        tags: ['lookup'],
        provenance: 'human',
        created_by: 'alice',
        db,
      });

      expect(getWikiEntry('lookup-page', db)).toEqual(entry);
      expect(getWikiEntry('missing-page', db)).toBeNull();
    } finally {
      db.close();
    }
  });

  it('updates a wiki entry through updateWikiEntry and persists the changes', async () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    const db = createWikiDb();

    try {
      const entry = createWikiEntry({
        slug: 'update-page',
        title: 'Original Title',
        content: 'Original content',
        tags: ['original'],
        provenance: 'human',
        created_by: 'alice',
        db,
      });

      await new Promise((resolve) => setTimeout(resolve, 5));

      const updated = updateWikiEntry('update-page', {
        title: 'Updated Title',
        tags: ['updated', 'docs'],
        provenance: 'agent',
      }, db);

      expect(updated).toEqual({
        ...entry,
        title: 'Updated Title',
        content: 'Original content',
        tags: 'updated,docs',
        provenance: 'agent',
        updated_at: expect.any(String),
      });
      expect(updated?.created_at).toBe(entry.created_at);
      expect(updated?.created_by).toBe('alice');
      expect(updated?.updated_at).not.toBe(entry.updated_at);
      expect(readWikiFile('update-page')).toEqual(updated);
      expect(getWikiEntry('update-page', db)).toEqual(updated);
    } finally {
      db.close();
    }
  });

  it('deletes wiki entries through deleteWikiEntry and removes file-backed and indexed state', () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    const db = createWikiDb();

    try {
      createWikiEntry({
        slug: 'delete-page',
        title: 'Delete Page',
        content: 'Delete me',
        db,
      });

      expect(deleteWikiEntry('delete-page', db)).toBe(true);
      expect(readWikiFile('delete-page')).toBeNull();
      expect(getWikiEntry('delete-page', db)).toBeNull();

      const row = db.prepare('SELECT slug FROM wiki_entries WHERE slug = ?').get('delete-page');
      expect(row).toBeNull();
    } finally {
      db.close();
    }
  });

  it('returns false when deleteWikiEntry is called for a missing slug', () => {
    const stateDir = makeStateDir();
    process.env.COVE_STATE_DIR = stateDir;

    const db = createWikiDb();

    try {
      expect(deleteWikiEntry('missing-page', db)).toBe(false);
    } finally {
      db.close();
    }
  });

  describe('hybridSearchWikiEntries', () => {
    it('returns [] for empty and all-whitespace queries', async () => {
      const stateDir = makeStateDir();
      process.env.COVE_STATE_DIR = stateDir;

      const db = createWikiDb();

      try {
        createWikiEntry({
          slug: 'beach-page',
          title: 'Beach Page',
          content: 'Beach content',
          db,
        });

        expect(await runHybridSearchWikiEntries('', db)).toEqual([]);
        expect(await runHybridSearchWikiEntries('   \n\t  ', db)).toEqual([]);
      } finally {
        db.close();
      }
    });

    it('treats surrounding query whitespace the same as a trimmed query', async () => {
      const stateDir = makeStateDir();
      process.env.COVE_STATE_DIR = stateDir;

      const db = createWikiDb({ withFts: false });

      try {
        createWikiEntry({
          slug: 'trimmed-query-page',
          title: 'Beach Vacation Packing',
          content: 'Bring sunscreen and sandals.',
          db,
        });

        const trimmed = await runHybridSearchWikiEntries('beach vacation', db);
        const padded = await runHybridSearchWikiEntries('  beach vacation  ', db);

        expect(padded).toEqual(trimmed);
      } finally {
        db.close();
      }
    });

    it('escapes quoted tokens before issuing the FTS query', async () => {
      const stateDir = makeStateDir();
      process.env.COVE_STATE_DIR = stateDir;

      const db = createWikiDb();
      let recordedFtsQuery: unknown;
      const originalPrepare = db.prepare.bind(db);
      db.prepare = ((sql: string) => {
        const statement = originalPrepare(sql);

        if (sql.includes('WHERE wiki_fts MATCH ?')) {
          const originalAll = statement.all.bind(statement);
          statement.all = ((...args: unknown[]) => {
            recordedFtsQuery = args[0];
            return originalAll(...args as never);
          }) as typeof statement.all;
        }

        return statement;
      }) as typeof db.prepare;

      try {
        createWikiEntry({
          slug: 'quoted-query-page',
          title: 'Guide to quoted searches',
          content: 'A guide to beach searches with quotes.',
          db,
        });

        await runHybridSearchWikiEntries('  "beach" guide  ', db);

        expect(recordedFtsQuery).toEqual(expect.stringContaining('guide'));
        expect(recordedFtsQuery).toEqual(expect.stringContaining('""beach""'));
      } finally {
        db.close();
      }
    });

    it('includes file-backed entries that only exist on disk', async () => {
      const stateDir = makeStateDir();
      process.env.COVE_STATE_DIR = stateDir;

      const db = createWikiDb();

      try {
        writeWikiFile({
          id: 'file-only-id',
          slug: 'file-only-page',
          title: 'File Only Beach Notes',
          content: 'Collected beach notes from the shoreline.',
          created_at: '2026-05-11T00:00:00.000Z',
          updated_at: '2026-05-11T01:00:00.000Z',
        });

        const results = await runHybridSearchWikiEntries('shoreline', db);

        expect(results.map((entry) => entry.slug)).toEqual(['file-only-page']);
      } finally {
        db.close();
      }
    });

    it('returns vector-only matches alongside lexical matches', async () => {
      const stateDir = makeStateDir();
      process.env.COVE_STATE_DIR = stateDir;

      const db = createWikiDb({ withFts: false });

      try {
        createWikiEntry({
          slug: 'lexical-match',
          title: 'Beach packing checklist',
          content: 'Bring sunscreen and sandals.',
          db,
        });
        createWikiEntry({
          slug: 'vector-only-match',
          title: 'Seaside getaway planner',
          content: 'Plan a coastal weekend with ocean views.',
          db,
        });
        createWikiEntry({
          slug: 'unrelated-match',
          title: 'Database rollback guide',
          content: 'Restore the previous migration safely.',
          db,
        });

        const results = await runHybridSearchWikiEntries('beach vacation', db, 10, {
          embedTexts: makeEmbedder({
            'beach vacation': [1, 0],
            'Beach packing checklist\n\nBring sunscreen and sandals.': [0.2, 0.9797958971132712],
            'Seaside getaway planner\n\nPlan a coastal weekend with ocean views.': [1, 0],
            'Database rollback guide\n\nRestore the previous migration safely.': [0, 1],
          }),
        });

        expect(results.map((entry) => entry.slug)).toContain('lexical-match');
        expect(results.map((entry) => entry.slug)).toContain('vector-only-match');
        expect(results.map((entry) => entry.slug)).not.toContain('unrelated-match');
      } finally {
        db.close();
      }
    });

    it('defaults limit to 10 when omitted', async () => {
      const stateDir = makeStateDir();
      process.env.COVE_STATE_DIR = stateDir;

      const db = createWikiDb({ withFts: false });

      try {
        for (let index = 0; index < 12; index++) {
          createWikiEntry({
            slug: `default-limit-${index}`,
            title: `Beach result ${index}`,
            content: 'A beach related note.',
            db,
          });
        }

        const results = await runHybridSearchWikiEntries('beach', db);

        expect(results).toHaveLength(10);
      } finally {
        db.close();
      }
    });

    it('defaults minScore to 0 when omitted', async () => {
      const stateDir = makeStateDir();
      process.env.COVE_STATE_DIR = stateDir;

      const db = createWikiDb({ withFts: false });

      try {
        createWikiEntry({
          slug: 'full-match',
          title: 'Beach Vacation Guide',
          content: 'Plan your beach vacation.',
          db,
        });
        createWikiEntry({
          slug: 'partial-match',
          title: 'Beach Guide',
          content: 'General beach ideas.',
          db,
        });

        const results = await runHybridSearchWikiEntries('beach vacation', db);

        expect(results.map((entry) => entry.slug)).toContain('full-match');
        expect(results.map((entry) => entry.slug)).toContain('partial-match');
      } finally {
        db.close();
      }
    });

    it('defaults embeddingWeight to 0.7 when omitted', async () => {
      const stateDir = makeStateDir();
      process.env.COVE_STATE_DIR = stateDir;

      const db = createWikiDb({ withFts: false });

      try {
        createWikiEntry({
          slug: 'lexical-heavy',
          title: 'Beach Vacation Essentials',
          content: 'Packing list for the trip.',
          db,
        });
        createWikiEntry({
          slug: 'vector-heavy',
          title: 'Beach Retreat',
          content: 'Weekend planner for a seaside break.',
          db,
        });

        const results = await runHybridSearchWikiEntries('beach vacation', db, 10, {
          embedTexts: makeEmbedder({
            'beach vacation': [1, 0],
            'Beach Vacation Essentials\n\nPacking list for the trip.': [0.4, 0.916515138991168],
            'Beach Retreat\n\nWeekend planner for a seaside break.': [1, 0],
          }),
        });

        expect(results.map((entry) => entry.slug).slice(0, 2)).toEqual([
          'vector-heavy',
          'lexical-heavy',
        ]);
      } finally {
        db.close();
      }
    });

    it('sorts by descending final hybrid score', async () => {
      const stateDir = makeStateDir();
      process.env.COVE_STATE_DIR = stateDir;

      const db = createWikiDb({ withFts: false });

      try {
        createWikiEntry({
          slug: 'highest-score',
          title: 'Beach Escape',
          content: 'A vacation plan with ocean views.',
          db,
        });
        createWikiEntry({
          slug: 'middle-score',
          title: 'Beach Vacation Checklist',
          content: 'Essentials for your trip.',
          db,
        });
        createWikiEntry({
          slug: 'lowest-score',
          title: 'Vacation Notes',
          content: 'Beach ideas for later.',
          db,
        });

        const results = await runHybridSearchWikiEntries('beach vacation', db, 10, {
          embedTexts: makeEmbedder({
            'beach vacation': [1, 0],
            'Beach Escape\n\nA vacation plan with ocean views.': [1, 0],
            'Beach Vacation Checklist\n\nEssentials for your trip.': [0.4, 0.916515138991168],
            'Vacation Notes\n\nBeach ideas for later.': [0.2, 0.9797958971132712],
          }),
        });

        expect(results.map((entry) => entry.slug).slice(0, 3)).toEqual([
          'highest-score',
          'middle-score',
          'lowest-score',
        ]);
      } finally {
        db.close();
      }
    });

    it('falls back to lexical matching when wiki_fts is missing', async () => {
      const stateDir = makeStateDir();
      process.env.COVE_STATE_DIR = stateDir;

      const db = createWikiDb({ withFts: false });

      try {
        createWikiEntry({
          slug: 'missing-fts-page',
          title: 'Beach fallback page',
          content: 'Keyword fallback should still work.',
          db,
        });

        const results = await runHybridSearchWikiEntries('fallback', db);

        expect(results.map((entry) => entry.slug)).toEqual(['missing-fts-page']);
      } finally {
        db.close();
      }
    });

    it('does not fall back to substring lexical matching when wiki_fts returns zero hits', async () => {
      const stateDir = makeStateDir();
      process.env.COVE_STATE_DIR = stateDir;

      const db = createWikiDb();

      try {
        createWikiEntry({
          slug: 'substring-only-page',
          title: 'Catalog entry',
          content: 'A guide to beach planning.',
          db,
        });

        const results = await runHybridSearchWikiEntries('cat', db);

        expect(results).toEqual([]);
      } finally {
        db.close();
      }
    });

    it('falls back to lexical matching when FTS query execution fails', async () => {
      const stateDir = makeStateDir();
      process.env.COVE_STATE_DIR = stateDir;

      const db = createWikiDb();
      const originalPrepare = db.prepare.bind(db);
      db.prepare = ((sql: string) => {
        if (sql.includes('WHERE wiki_fts MATCH ?')) {
          throw new Error('wiki_fts query failed');
        }

        return originalPrepare(sql);
      }) as typeof db.prepare;

      try {
        createWikiEntry({
          slug: 'fts-failure-page',
          title: 'Beach fallback page',
          content: 'Fallback after FTS failure.',
          db,
        });

        const results = await runHybridSearchWikiEntries('fallback', db);

        expect(results.map((entry) => entry.slug)).toEqual(['fts-failure-page']);
      } finally {
        db.close();
      }
    });

    it('keeps lexical-only results when vector similarity is non-positive', async () => {
      const stateDir = makeStateDir();
      process.env.COVE_STATE_DIR = stateDir;

      const db = createWikiDb({ withFts: false });

      try {
        createWikiEntry({
          slug: 'lexical-only-page',
          title: 'Beach Vacation Checklist',
          content: 'Bring towels and water.',
          db,
        });

        const results = await runHybridSearchWikiEntries('beach vacation', db, 10, {
          embedTexts: makeEmbedder({
            'beach vacation': [1, 0],
            'Beach Vacation Checklist\n\nBring towels and water.': [-1, 0],
          }),
        });

        expect(results.map((entry) => entry.slug)).toEqual(['lexical-only-page']);
      } finally {
        db.close();
      }
    });

    it('degrades to lexical-only results when embedding generation fails', async () => {
      const stateDir = makeStateDir();
      process.env.COVE_STATE_DIR = stateDir;

      const db = createWikiDb({ withFts: false });

      try {
        createWikiEntry({
          slug: 'embedding-failure-page',
          title: 'Beach Vacation Checklist',
          content: 'Bring towels and water.',
          db,
        });

        const results = await runHybridSearchWikiEntries('beach vacation', db, 10, {
          embedTexts: async () => {
            throw new Error('embedding failed');
          },
        });

        expect(results.map((entry) => entry.slug)).toEqual(['embedding-failure-page']);
      } finally {
        db.close();
      }
    });

    it('applies an explicit minScore threshold', async () => {
      const stateDir = makeStateDir();
      process.env.COVE_STATE_DIR = stateDir;

      const db = createWikiDb({ withFts: false });

      try {
        createWikiEntry({
          slug: 'above-threshold',
          title: 'Beach Vacation Guide',
          content: 'Plan your beach vacation.',
          db,
        });
        createWikiEntry({
          slug: 'below-threshold',
          title: 'Beach Guide',
          content: 'General beach ideas.',
          db,
        });

        const results = await runHybridSearchWikiEntries('beach vacation', db, 10, {
          minScore: 0.75,
        });

        expect(results.map((entry) => entry.slug)).toEqual(['above-threshold']);
      } finally {
        db.close();
      }
    });

    it('applies an explicit result limit after ranking', async () => {
      const stateDir = makeStateDir();
      process.env.COVE_STATE_DIR = stateDir;

      const db = createWikiDb({ withFts: false });

      try {
        createWikiEntry({
          slug: 'limit-first',
          title: 'Beach Vacation Escape',
          content: 'Top score entry.',
          db,
        });
        createWikiEntry({
          slug: 'limit-second',
          title: 'Beach Vacation',
          content: 'Second score entry.',
          db,
        });
        createWikiEntry({
          slug: 'limit-third',
          title: 'Beach',
          content: 'Third score entry.',
          db,
        });

        const results = await runHybridSearchWikiEntries('beach vacation escape', db, 2);

        expect(results.map((entry) => entry.slug)).toEqual(['limit-first', 'limit-second']);
      } finally {
        db.close();
      }
    });

    it('treats negative limits as zero results', async () => {
      const stateDir = makeStateDir();
      process.env.COVE_STATE_DIR = stateDir;

      const db = createWikiDb({ withFts: false });

      try {
        createWikiEntry({
          slug: 'negative-limit-page',
          title: 'Beach Vacation Escape',
          content: 'Top score entry.',
          db,
        });

        const results = await runHybridSearchWikiEntries('beach vacation', db, -1);

        expect(results).toEqual([]);
      } finally {
        db.close();
      }
    });

    it('embeds each wiki entry as <title>\\n\\n<content>', async () => {
      const stateDir = makeStateDir();
      process.env.COVE_STATE_DIR = stateDir;

      const db = createWikiDb({ withFts: false });
      const calls: string[][] = [];

      try {
        createWikiEntry({
          slug: 'payload-page',
          title: 'Payload Title',
          content: 'Payload body',
          tags: ['payload-tag'],
          db,
        });

        await runHybridSearchWikiEntries('payload', db, 10, {
          embedTexts: makeEmbedder({
            payload: [1, 0],
            'Payload Title\n\nPayload body': [0, 1],
          }, calls),
        });

        const embeddedTexts = calls.flat();

        expect(embeddedTexts).toContain('Payload Title\n\nPayload body');
        expect(embeddedTexts).not.toContain('Payload Title\nPayload body');
        expect(embeddedTexts).not.toContain('Payload Title\n\nPayload body\n\npayload-tag');
      } finally {
        db.close();
      }
    });

    it('keeps tags lexical-only and excludes them from the embedding payload', async () => {
      const stateDir = makeStateDir();
      process.env.COVE_STATE_DIR = stateDir;

      const db = createWikiDb({ withFts: false });
      const calls: string[][] = [];

      try {
        createWikiEntry({
          slug: 'tagged-page',
          title: 'Plain Title',
          content: 'Plain body text.',
          tags: ['rare-tag'],
          db,
        });

        const results = await runHybridSearchWikiEntries('rare-tag', db, 10, {
          embedTexts: makeEmbedder({
            'rare-tag': [1, 0],
            'Plain Title\n\nPlain body text.': [0, 1],
          }, calls),
        });
        const embeddedTexts = calls.flat().filter((text) => text !== 'rare-tag');

        expect(results.map((entry) => entry.slug)).toEqual(['tagged-page']);
        expect(embeddedTexts).toContain('Plain Title\n\nPlain body text.');
        expect(embeddedTexts.some((text) => text.includes('rare-tag'))).toBe(false);
      } finally {
        db.close();
      }
    });
  });
});
