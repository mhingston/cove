import { afterEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { assembleContext } from '../../src/context/assembly.ts';
import { storeMemory } from '../../src/context/external.ts';
import { appendWorkingMessage, ensureWorkingSession } from '../../src/context/working.ts';
import { migrate } from '../../src/db/migrate.ts';

const tempDirs: string[] = [];

function makeStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cove-v2-assembly-'));
  tempDirs.push(dir);
  return dir;
}

function writePersonaFile(stateDir: string, agentGroupId: string, fileName: 'SOUL.md' | 'AGENTS.md', content: string): void {
  const personaDir = path.join(stateDir, 'personas', agentGroupId);
  fs.mkdirSync(personaDir, { recursive: true });
  fs.writeFileSync(path.join(personaDir, fileName), content);
}

function createDb(stateDir: string): Database {
  const db = new Database(path.join(stateDir, 'cove.db'));
  migrate(db);
  return db;
}

afterEach(() => {
  delete process.env.COVE_STATE_DIR;

  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('assembleContext', () => {
  it('assembles persona, working messages, up to three memories, then request messages in order', async () => {
    const stateDir = makeStateDir();
    const db = createDb(stateDir);
    const sessionDir = path.join(stateDir, 'sessions', 'agent-1', 'sess-1');

    process.env.COVE_STATE_DIR = stateDir;
    writePersonaFile(stateDir, 'agent-1', 'SOUL.md', 'You are a test assistant.');
    ensureWorkingSession(sessionDir, 'sess-1');
    appendWorkingMessage(sessionDir, 'sess-1', 'user', 'First working message');
    appendWorkingMessage(sessionDir, 'sess-1', 'assistant', 'First response');

    storeMemory({ content: 'Memory one', agentGroupId: 'agent-1', db });
    storeMemory({ content: 'Memory two', agentGroupId: 'agent-1', db });
    storeMemory({ content: 'Memory three', agentGroupId: 'agent-1', db });
    storeMemory({ content: 'Memory four', agentGroupId: 'agent-1', db });

    const result = await assembleContext({
      agentGroupId: 'agent-1',
      sessionId: 'sess-1',
      sessionDir,
      db,
      messages: [
        { role: 'user', content: 'What about the rollout checklist?' },
        { role: 'assistant', content: 'Draft reply placeholder' },
      ],
      searchMemories: async () => [
        { id: 'm1', content: 'Memory one', agent_group_id: 'agent-1', importance: 0.9, created_at: '2026-01-01T00:00:00.000Z' },
        { id: 'm2', content: 'Memory two', agent_group_id: 'agent-1', importance: 0.8, created_at: '2026-01-01T00:00:00.000Z' },
        { id: 'm3', content: 'Memory three', agent_group_id: 'agent-1', importance: 0.7, created_at: '2026-01-01T00:00:00.000Z' },
        { id: 'm4', content: 'Memory four', agent_group_id: 'agent-1', importance: 0.6, created_at: '2026-01-01T00:00:00.000Z' },
      ],
    });

    expect(result).toEqual([
      { role: 'system', content: 'You are a test assistant.' },
      { role: 'user', content: 'First working message' },
      { role: 'assistant', content: 'First response' },
      { role: 'system', content: 'Memory one' },
      { role: 'system', content: 'Memory two' },
      { role: 'system', content: 'Memory three' },
      { role: 'user', content: 'What about the rollout checklist?' },
      { role: 'assistant', content: 'Draft reply placeholder' },
    ]);

    db.close();
  });

  it('uses explicit persona override ahead of filesystem or db persona', async () => {
    const stateDir = makeStateDir();
    const db = createDb(stateDir);

    process.env.COVE_STATE_DIR = stateDir;
    writePersonaFile(stateDir, 'agent-1', 'SOUL.md', 'Filesystem persona');

    const result = await assembleContext({
      agentGroupId: 'agent-1',
      sessionId: 'sess-1',
      db,
      persona: 'Explicit persona',
      messages: [{ role: 'user', content: 'Only request message' }],
      searchMemories: async () => [],
    });

    expect(result[0]).toEqual({ role: 'system', content: 'Explicit persona' });

    db.close();
  });

  it('skips working messages when sessionDir is absent', async () => {
    const stateDir = makeStateDir();
    const db = createDb(stateDir);

    process.env.COVE_STATE_DIR = stateDir;

    const result = await assembleContext({
      agentGroupId: 'agent-1',
      sessionId: 'sess-1',
      db,
      messages: [{ role: 'user', content: 'Only request message' }],
      searchMemories: async () => [],
    });

    expect(result).toEqual([{ role: 'user', content: 'Only request message' }]);

    db.close();
  });

  it('skips retrieval when there is no non-empty incoming user message', async () => {
    const stateDir = makeStateDir();
    const db = createDb(stateDir);
    const searchMemories = mock(async () => []);

    process.env.COVE_STATE_DIR = stateDir;

    const result = await assembleContext({
      agentGroupId: 'agent-1',
      sessionId: 'sess-1',
      db,
      messages: [
        { role: 'assistant', content: 'Trailing assistant' },
        { role: 'tool', content: 'Trailing tool output' },
      ],
      searchMemories,
    });

    expect(result).toEqual([
      { role: 'assistant', content: 'Trailing assistant' },
      { role: 'tool', content: 'Trailing tool output' },
    ]);
    expect(searchMemories).not.toHaveBeenCalled();

    db.close();
  });

  it('uses the latest non-empty user message even when trailing non-user messages exist', async () => {
    const stateDir = makeStateDir();
    const db = createDb(stateDir);
    const searchMemories = mock(async () => []);

    process.env.COVE_STATE_DIR = stateDir;

    await assembleContext({
      agentGroupId: 'agent-1',
      sessionId: 'sess-1',
      db,
      messages: [
        { role: 'user', content: '   ' },
        { role: 'user', content: 'Latest real user question' },
        { role: 'assistant', content: 'Draft reply' },
      ],
      searchMemories,
    });

    expect(searchMemories).toHaveBeenCalledWith({
      query: 'Latest real user question',
      agentGroupId: 'agent-1',
      maxResults: 3,
      db,
    });

    db.close();
  });

  it('opens and closes the central db locally when db is not provided', async () => {
    const stateDir = makeStateDir();
    const centralDbPath = path.join(stateDir, 'cove.db');

    process.env.COVE_STATE_DIR = stateDir;
    createDb(stateDir).close();

    const openedPaths: string[] = [];
    let closeCount = 0;

    const result = await assembleContext({
      agentGroupId: 'agent-1',
      sessionId: 'sess-1',
      messages: [{ role: 'user', content: 'Question needing memory search' }],
      createDb: (dbPath) => {
        openedPaths.push(dbPath);
        return {
          close() {
            closeCount += 1;
          },
        } as unknown as Database;
      },
      searchMemories: async () => [],
    });

    expect(result).toEqual([{ role: 'user', content: 'Question needing memory search' }]);
    expect(openedPaths).toEqual([centralDbPath]);
    expect(closeCount).toBe(1);
  });

  it('degrades to persona plus request messages when a locally opened db cannot serve memory search', async () => {
    const stateDir = makeStateDir();

    process.env.COVE_STATE_DIR = stateDir;
    writePersonaFile(stateDir, 'agent-1', 'SOUL.md', 'Recovered persona');

    const result = await assembleContext({
      agentGroupId: 'agent-1',
      sessionId: 'sess-1',
      messages: [{ role: 'user', content: 'Question needing memory search' }],
      createDb: () => ({
        close() {
          // no-op
        },
      } as unknown as Database),
      searchMemories: async () => {
        throw new Error('memory search unavailable');
      },
    });

    expect(result).toEqual([
      { role: 'system', content: 'Recovered persona' },
      { role: 'user', content: 'Question needing memory search' },
    ]);
  });
});
