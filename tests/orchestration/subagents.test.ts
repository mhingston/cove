import { describe, expect, it } from 'bun:test';

import { delegateSubagentTask } from '../../src/orchestration/subagents.ts';
import type { SubagentSession, SubagentTask } from '../../src/orchestration/types.ts';

describe('delegateSubagentTask', () => {
  it('returns streamed assistant text when the session emits text_delta events', async () => {
    const listeners: Array<(event: unknown) => void> = [];
    const session: SubagentSession = {
      subscribe(handler) {
        listeners.push(handler);
        return () => {
          const index = listeners.indexOf(handler);
          if (index >= 0) {
            listeners.splice(index, 1);
          }
        };
      },
      async prompt() {
        for (const listener of listeners) {
          listener({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello' } });
          listener({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ' world' } });
        }
      },
      state: {
        messages: [{ role: 'assistant', content: 'Hello world' }],
      },
    };
    const task: SubagentTask = { id: 'task-1', prompt: 'Greet' };

    await expect(delegateSubagentTask(task, session)).resolves.toEqual({ ok: true, text: 'Hello world' });
  });

  it('falls back to the last assistant message when no text_delta events fire', async () => {
    const session: SubagentSession = {
      subscribe() {
        return () => {};
      },
      async prompt() {},
      state: {
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Fallback' }, { type: 'text', text: ' text' }] }],
      },
    };

    await expect(delegateSubagentTask({ id: 'task-2', prompt: 'Fallback' }, session)).resolves.toEqual({
      ok: true,
      text: 'Fallback text',
    });
  });

  it('returns an error result when session.prompt throws', async () => {
    const session: SubagentSession = {
      subscribe() {
        return () => {};
      },
      async prompt() {
        throw new Error('subagent failed');
      },
      state: { messages: [] },
    };

    await expect(delegateSubagentTask({ id: 'task-3', prompt: 'Fail' }, session)).resolves.toEqual({
      ok: false,
      error: 'Error: subagent failed',
    });
  });
});
