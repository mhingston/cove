import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';

import type { ScheduleRollbackWorkflow, ScheduleStartWorkflow } from '../shared/types.ts';

export type WorkflowRuntime = {
  start(): Promise<void>;
  stop(): Promise<void>;
  startWorkflow: ScheduleStartWorkflow;
  rollbackWorkflow: ScheduleRollbackWorkflow;
};

function createDatabase(databasePath: string): Database {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

function ensureWorkflowTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_instances (
      id          TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL,
      input_json  TEXT,
      created_at  TEXT NOT NULL
    );
  `);
}

export function createWorkflowRuntime(databasePath: string): WorkflowRuntime {
  let db: Database | null = null;

  return {
    async start() {
      if (db != null) {
        return;
      }

      db = createDatabase(databasePath);
      ensureWorkflowTables(db);
    },
    async stop() {
      db?.close();
      db = null;
    },
    async startWorkflow({ schedule, input }) {
      if (db == null) {
        throw new Error('Workflow runtime is not started');
      }

      const instanceId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO workflow_instances (id, schedule_id, input_json, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(
        instanceId,
        schedule.id,
        input == null ? null : JSON.stringify(input),
        new Date().toISOString(),
      );

      return { instanceId };
    },
    async rollbackWorkflow({ instanceId }) {
      if (db == null) {
        throw new Error('Workflow runtime is not started');
      }

      db.prepare('DELETE FROM workflow_instances WHERE id = ?').run(instanceId);
    },
  };
}
