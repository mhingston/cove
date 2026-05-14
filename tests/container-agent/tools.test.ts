import { afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { migrate } from '../../src/db/migrate.ts';
import { createCoveTools } from '../../src/container-agent/tools.ts';

function makeEmbedder(vectors: Record<string, number[]>): (texts: string[]) => Promise<number[][]> {
  return async (texts: string[]) => texts.map((text) => vectors[text] ?? [0, 0, 0]);
}

let tmpDir = '';
let db: Database;
let originalStateDir: string | undefined;
let originalCentralDbPath: string | undefined;
let originalAgentGroupId: string | undefined;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cove-v2-tools-real-'));
  originalStateDir = process.env.COVE_STATE_DIR;
  originalCentralDbPath = process.env.COVE_CENTRAL_DB_PATH;
  originalAgentGroupId = process.env.COVE_AGENT_GROUP_ID;
  process.env.COVE_STATE_DIR = tmpDir;
  db = new Database(path.join(tmpDir, 'cove.db'));
  migrate(db);
});

afterEach(() => {
  mock.restore();

  if (originalCentralDbPath === undefined) {
    delete process.env.COVE_CENTRAL_DB_PATH;
  } else {
    process.env.COVE_CENTRAL_DB_PATH = originalCentralDbPath;
  }

  if (originalAgentGroupId === undefined) {
    delete process.env.COVE_AGENT_GROUP_ID;
  } else {
    process.env.COVE_AGENT_GROUP_ID = originalAgentGroupId;
  }
});

describe('createCoveTools execution', () => {
  it('fails closed when memory search has no agent group scope', async () => {
    delete process.env.COVE_AGENT_GROUP_ID;
    const tool = createCoveTools(db).find((entry) => entry.name === 'search_memories');

    const result = await tool?.execute('call-1', { query: 'beach vacation plans', limit: 5 }, undefined, undefined, {});
    const text = result?.content.map((part) => part.type === 'text' ? part.text : '').join('') ?? '';
    const parsed = JSON.parse(text);

    expect(parsed.results).toEqual([]);
    expect(parsed.error).toBe('agentGroupId is required');
  });

  it('uses runtime centralDbPath as the embedder cache key when env is unset', async () => {
    delete process.env.COVE_CENTRAL_DB_PATH;
    process.env.COVE_AGENT_GROUP_ID = 'group-runtime-embedder';

    db.run(
      `INSERT INTO memories (id, content, agent_group_id, session_id, importance, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['m-runtime-tool-1', 'Seaside getaway planner', 'group-runtime-embedder', null, 0.8, new Date().toISOString()],
    );
    const rowId = (db.prepare('SELECT rowid FROM memories WHERE id = ?').get('m-runtime-tool-1') as { rowid: number }).rowid;
    db.run('INSERT INTO memories_fts(rowid, content) VALUES (?, ?)', [rowId, 'Seaside getaway planner']);

    mock.module('@xenova/transformers', () => ({
      pipeline: async () => async (texts: string[]) => ({
        tolist: () => texts.map((text) => {
          if (text === 'beach vacation plans' || text === 'Seaside getaway planner') {
            return [1, 0, 0];
          }

          return [0, 1, 0];
        }),
      }),
    }));

    const tool = createCoveTools(db, undefined, {
      agentGroupId: 'group-runtime-embedder',
      centralDbPath: '/runtime/only/cove.db',
    }).find((entry) => entry.name === 'search_memories');

    const result = await tool?.execute('call-2', { query: 'beach vacation plans', limit: 5 }, undefined, undefined, {});
    const text = result?.content.map((part) => part.type === 'text' ? part.text : '').join('') ?? '';
    const parsed = JSON.parse(text);

    expect(parsed.results.map((memory: { id: string }) => memory.id)).toContain('m-runtime-tool-1');
  });

  it('saves a wiki entry that can be read back immediately', async () => {
    const tools = createCoveTools(db, makeEmbedder({ 'Stored memory': [1, 0, 0] }));
    const saveTool = tools.find((entry) => entry.name === 'save_wiki');
    const readTool = tools.find((entry) => entry.name === 'read_wiki');

    const saveResult = await saveTool?.execute(
      'call-3',
      { slug: 'agent-notes', title: 'Agent Notes', content: 'Saved from tool', tags: ['agent'] },
      undefined,
      undefined,
      {},
    );
    const saveText = saveResult?.content.map((part) => part.type === 'text' ? part.text : '').join('') ?? '';
    const saved = JSON.parse(saveText);

    expect(saved.saved).toBe(true);
    expect(saved.entry.slug).toBe('agent-notes');

    const readResult = await readTool?.execute('call-4', { slug: 'agent-notes' }, undefined, undefined, {});
    const readText = readResult?.content.map((part) => part.type === 'text' ? part.text : '').join('') ?? '';
    const readBack = JSON.parse(readText);

    expect(readBack.found).toBe(true);
    expect(readBack.entry.content).toBe('Saved from tool');
  });
});
