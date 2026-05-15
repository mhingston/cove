import { spawnSync } from 'node:child_process';

import { getContainerRuntimeBin } from '../container/detect.ts';
import { getImageName } from '../container/image.ts';
import type { ScheduleRunAgentPrompt } from '../shared/types.ts';
import type { ScheduleRecord } from './schedules.ts';

type AgentResult = {
  content: string;
  sessionId: string;
  threadId: string;
  lastRunAt: string;
};

type ScriptResult = {
  mode: 'script';
  stdout: string;
  stderr: string;
  exitCode: number;
};

type NotificationResult = {
  mode: 'notification';
  logged: true;
};

type HybridResult = {
  content: string;
  sessionId: string;
  threadId: string;
  lastRunAt: string;
  notified: true;
};

type WorkflowResult = {
  mode: 'workflow';
  config: Record<string, unknown> | null;
};

export type ScheduleExecutionResult = AgentResult | ScriptResult | NotificationResult | HybridResult | WorkflowResult;

function executeNotification(schedule: ScheduleRecord): NotificationResult {
  console.log(`[Schedule notification] ${schedule.id}: ${schedule.prompt}`);
  return { mode: 'notification', logged: true };
}

function executeScript(schedule: ScheduleRecord): ScriptResult {
  const result = spawnSync(
    getContainerRuntimeBin(),
    ['run', '--rm', getImageName(), 'sh', '-lc', schedule.prompt],
    { shell: false, timeout: 30_000 },
  );

  const stdout = result.stdout?.toString() ?? '';
  const stderr = result.stderr?.toString() ?? result.error?.message ?? '';
  const exitCode = result.status ?? -1;

  if (result.error != null || exitCode !== 0) {
    throw new Error(`Script schedule failed: ${stderr || `exit code ${exitCode}`}`);
  }

  return {
    mode: 'script',
    stdout,
    stderr,
    exitCode,
  };
}

function executeWorkflow(schedule: ScheduleRecord): WorkflowResult {
  return {
    mode: 'workflow',
    config: schedule.config,
  };
}

export async function executeSchedule(options: {
  schedule: ScheduleRecord;
  runAgentPrompt?: ScheduleRunAgentPrompt;
}): Promise<ScheduleExecutionResult> {
  const { schedule, runAgentPrompt } = options;

  switch (schedule.mode) {
    case 'agent':
      if (runAgentPrompt == null) {
        throw new Error('runAgentPrompt is required for agent schedules');
      }

      return await runAgentPrompt({ schedule });
    case 'notification':
      return executeNotification(schedule);
    case 'script':
      return executeScript(schedule);
    case 'hybrid': {
      if (runAgentPrompt == null) {
        throw new Error('runAgentPrompt is required for hybrid schedules');
      }

      const result = await runAgentPrompt({ schedule });
      return {
        ...result,
        notified: true,
      };
    }
    case 'workflow':
      return executeWorkflow(schedule);
  }
}
