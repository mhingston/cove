import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';

import { createWorkflowRuntime } from '../../src/workflows/runtime.ts';

const createdPaths: string[] = [];

afterEach(() => {
  for (const createdPath of createdPaths.splice(0)) {
    fs.rmSync(createdPath, { recursive: true, force: true });
  }
});

describe('workflow runtime', () => {
  it('owns the configured workflows.db path and records started workflow instances', async () => {
    const stateDir = `/tmp/cove-v2-workflows-${crypto.randomUUID()}`;
    const databasePath = `${stateDir}/workflows.db`;
    createdPaths.push(stateDir);

    const runtime = createWorkflowRuntime(databasePath);
    await runtime.start();

    try {
      const started = await runtime.startWorkflow({
        schedule: {
          id: 'schedule-1',
          agent_group_id: 'support',
          cron_expr: '0 9 * * *',
          prompt: 'Workflow run',
          mode: 'workflow',
          config: { workflow: 'daily-summary' },
          enabled: true,
          last_run_at: null,
          next_run_at: '2026-01-15T09:00:00.000Z',
          created_at: '2026-01-15T08:00:00.000Z',
        },
        input: { workflow: 'daily-summary' },
      });

      expect(started).toEqual({
        instanceId: expect.any(String),
      });
      expect(fs.existsSync(databasePath)).toBe(true);
    } finally {
      await runtime.stop();
    }
  });

  it('removes a started workflow instance when rollback is requested', async () => {
    const stateDir = `/tmp/cove-v2-workflows-${crypto.randomUUID()}`;
    const databasePath = `${stateDir}/workflows.db`;
    createdPaths.push(stateDir);

    const runtime = createWorkflowRuntime(databasePath);
    await runtime.start();

    try {
      const started = await runtime.startWorkflow({
        schedule: {
          id: 'schedule-1',
          agent_group_id: 'support',
          cron_expr: '0 9 * * *',
          prompt: 'Workflow run',
          mode: 'workflow',
          config: { workflow: 'daily-summary' },
          enabled: true,
          last_run_at: null,
          next_run_at: '2026-01-15T09:00:00.000Z',
          created_at: '2026-01-15T08:00:00.000Z',
        },
        input: { workflow: 'daily-summary' },
      });

      await runtime.rollbackWorkflow({ instanceId: started.instanceId });

      const db = new Database(databasePath, { readonly: true });

      try {
        const row = db.prepare('SELECT id FROM workflow_instances WHERE id = ?').get(started.instanceId);
        expect(row).toBeNull();
      } finally {
        db.close();
      }
    } finally {
      await runtime.stop();
    }
  });
});
