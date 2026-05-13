import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendWorkingMessage,
  buildWorkingContext,
  compactSession,
  ensureWorkingSession,
} from '../../src/context/working.ts';

const tempDirs: string[] = [];

function makeSessionDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cove-v2-working-'));
  tempDirs.push(dir);
  return dir;
}

function readWorkingEntries(sessionDir: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(path.join(sessionDir, 'working.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('compactSession', () => {
  it('rewrites working.jsonl down to the session header and one system summary message', () => {
    const sessionDir = makeSessionDir();

    ensureWorkingSession(sessionDir, 'sess-compact-1');
    appendWorkingMessage(sessionDir, 'sess-compact-1', 'user', 'First question');
    appendWorkingMessage(sessionDir, 'sess-compact-1', 'assistant', 'Earlier answer');

    compactSession(sessionDir, 'sess-compact-1', 'Condensed summary');

    const entries = readWorkingEntries(sessionDir);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      type: 'session',
      id: 'sess-compact-1',
      version: 3,
    });
    expect(entries[1]).toEqual({
      type: 'message',
      id: expect.any(String),
      parentId: null,
      timestamp: expect.any(String),
      message: { role: 'system', content: 'Condensed summary' },
    });
    expect(JSON.stringify(entries)).not.toContain('First question');
    expect(JSON.stringify(entries)).not.toContain('Earlier answer');
  });

  it('returns only the compacted system summary from buildWorkingContext', () => {
    const sessionDir = makeSessionDir();

    appendWorkingMessage(sessionDir, 'sess-compact-2', 'user', 'Question to drop');
    appendWorkingMessage(sessionDir, 'sess-compact-2', 'assistant', 'Answer to drop');

    compactSession(sessionDir, 'sess-compact-2', 'Conversation summary');

    expect(buildWorkingContext(sessionDir)).toEqual([{ role: 'system', content: 'Conversation summary' }]);
  });
});
