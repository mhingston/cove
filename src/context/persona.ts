import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';

import { getStateDir } from '../db/index.ts';

type LoadPersonaOptions = {
  personaText?: string | null;
  stateDir?: string;
  db?: Database;
  dbPath?: string;
  allowFilesystemFallback?: boolean;
};

function readPersonaFile(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return content.trim() ? content : null;
  } catch {
    return null;
  }
}

function readSoulFromDb(db: Database, agentGroupId: string): string | null {
  try {
    const row = db.prepare('SELECT soul FROM agent_groups WHERE id = ?').get(agentGroupId) as
      | { soul: string | null }
      | undefined;

    return row?.soul?.trim() ? row.soul : null;
  } catch {
    return null;
  }
}

function readSoulFromDbPath(dbPath: string, agentGroupId: string): string | null {
  if (!fs.existsSync(dbPath)) {
    return null;
  }

  let db: Database | null = null;

  try {
    db = new Database(dbPath, { readonly: true });
    return readSoulFromDb(db, agentGroupId);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export function loadPersona(agentGroupId: string, options: LoadPersonaOptions = {}): string | null {
  if (options.personaText?.trim()) {
    return options.personaText;
  }

  const stateDir = options.stateDir ?? getStateDir();

  if (options.allowFilesystemFallback !== false) {
    const personaDir = path.join(stateDir, 'personas', agentGroupId);

    for (const fileName of ['SOUL.md', 'AGENTS.md'] as const) {
      const content = readPersonaFile(path.join(personaDir, fileName));
      if (content != null) {
        return content;
      }
    }
  }

  const dbCandidates = [
    options.db != null ? readSoulFromDb(options.db, agentGroupId) : null,
    options.dbPath != null ? readSoulFromDbPath(options.dbPath, agentGroupId) : null,
    readSoulFromDbPath(path.join(stateDir, 'cove.db'), agentGroupId),
  ];

  for (const candidate of dbCandidates) {
    if (candidate != null) {
      return candidate;
    }
  }

  return null;
}

export type { LoadPersonaOptions };
