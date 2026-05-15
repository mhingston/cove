import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { migrate } from '../../src/db/migrate.ts';
import { createCoveTools } from '../../src/container-agent/tools.ts';

let tmpDir = '';
let db: Database;
let originalStateDir: string | undefined;
let originalCentralDbPath: string | undefined;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cove-v2-container-tools-'));
  originalStateDir = process.env.COVE_STATE_DIR;
  originalCentralDbPath = process.env.COVE_CENTRAL_DB_PATH;
  process.env.COVE_STATE_DIR = tmpDir;
  db = new Database(path.join(tmpDir, 'cove.db'));
  migrate(db);
});

afterEach(() => {
  if (originalCentralDbPath === undefined) {
    delete process.env.COVE_CENTRAL_DB_PATH;
  } else {
    process.env.COVE_CENTRAL_DB_PATH = originalCentralDbPath;
  }
});

describe('createCoveTools shape', () => {
  it('returns workflow bridge, memory, and wiki tools in order', () => {
    const tools = createCoveTools(db);

    expect(tools.map((tool) => tool.name)).toEqual([
      'start-workflow',
      'get-workflow',
      'list-workflows',
      'signal-workflow',
      'wait-for-workflow',
      'memory_search',
      'memory_store',
      'wiki_get',
      'wiki_search',
      'wiki_save',
      'search_memories',
      'save_memory',
      'read_wiki',
      'search_wiki',
      'save_wiki',
    ]);
  });

  it('opens the central db from env when no db handle is provided', () => {
    process.env.COVE_CENTRAL_DB_PATH = path.join(tmpDir, 'cove.db');

    const tools = createCoveTools();

    expect(tools).toHaveLength(15);
  });
});
