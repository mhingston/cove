import type { ChatMessage } from '../shared/types.ts';

export type RunAgentPromptExecutionResult = {
  content: string;
  sessionId: string;
  lastRunAt: string;
};

export type RunAgentPromptExecuteInput = {
  agent_group_id: string;
  thread_id: string;
  messages: ChatMessage[];
};

export type RunAgentPromptExecute = (input: RunAgentPromptExecuteInput) => Promise<RunAgentPromptExecutionResult>;

export function createScheduleThreadId(scheduleId: string): string {
  return `schedule:${scheduleId}`;
}

export function createRunAgentPrompt(deps: {
  execute: RunAgentPromptExecute;
}) {
  return async function runAgentPrompt(options: {
    schedule: {
      id: string;
      agent_group_id: string;
      prompt: string;
    };
  }): Promise<RunAgentPromptExecutionResult & { threadId: string }> {
    const threadId = createScheduleThreadId(options.schedule.id);
    const response = await deps.execute({
      agent_group_id: options.schedule.agent_group_id,
      thread_id: threadId,
      messages: [{ role: 'user', content: options.schedule.prompt }],
    });

    return {
      content: response.content,
      sessionId: response.sessionId,
      threadId,
      lastRunAt: response.lastRunAt,
    };
  };
}
