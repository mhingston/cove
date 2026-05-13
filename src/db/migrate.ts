import type { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const migrationsDir = path.join(import.meta.dir, 'migrations');

type Migration = {
  name: string;
  sql: string;
};

function loadMigrations(): Migration[] {
  return fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => ({
      name: file.replace(/\.sql$/, ''),
      sql: fs.readFileSync(path.join(migrationsDir, file), 'utf8'),
    }));
}

function ensureSchemaVersionTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      name    TEXT NOT NULL,
      applied TEXT NOT NULL
    );
  `);
}

function ensureSessionsThreadUniquenessIndex(db: Database): void {
  db.exec(`
    DROP INDEX IF EXISTS sessions_agent_group_thread_idx;

    CREATE UNIQUE INDEX IF NOT EXISTS sessions_agent_group_thread_idx
    ON sessions(agent_group_id, thread_id)
    WHERE thread_id IS NOT NULL;
  `);
}

export function migrate(db: Database): void {
  ensureSchemaVersionTable(db);

  const appliedNames = new Set(
    (db.prepare('SELECT name FROM schema_version ORDER BY version').all() as { name: string }[]).map(
      (row) => row.name,
    ),
  );

  const latestAppliedVersion = db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as {
    version: number | null;
  };
  let nextVersion = latestAppliedVersion.version ?? 0;

  for (const migration of loadMigrations()) {
    if (appliedNames.has(migration.name)) {
      continue;
    }

    db.transaction(() => {
      db.exec(migration.sql);
      nextVersion += 1;
      db.prepare('INSERT INTO schema_version (version, name, applied) VALUES (?, ?, ?)').run(
        nextVersion,
        migration.name,
        new Date().toISOString(),
      );
    })();
  }

  ensureSessionsThreadUniquenessIndex(db);
}
