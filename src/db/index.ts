import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function getStateDir(): string {
  return process.env.COVE_STATE_DIR ?? path.join(os.homedir(), '.cove');
}

export function getDb(): Database {
  const stateDir = getStateDir();
  fs.mkdirSync(stateDir, { recursive: true });
  const db = new Database(path.join(stateDir, 'cove.db'));
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}
