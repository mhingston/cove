import type { SubagentResult, SubagentSession, SubagentTask } from './types.ts';

function getLastAssistantText(session: SubagentSession): string {
  for (let index = session.state.messages.length - 1; index >= 0; index -= 1) {
    const message = session.state.messages[index];

    if (message?.role !== 'assistant') {
      continue;
    }

    if (typeof message.content === 'string') {
      return message.content;
    }

    if (Array.isArray(message.content)) {
      return message.content
        .filter((part): part is { type: string; text: string } => (
          part != null
          && typeof part === 'object'
          && 'type' in part
          && 'text' in part
          && (part as { type: unknown }).type === 'text'
          && typeof (part as { text: unknown }).text === 'string'
        ))
        .map((part) => part.text)
        .join('');
    }
  }

  return '';
}

export async function delegateSubagentTask(task: SubagentTask, session: SubagentSession): Promise<SubagentResult> {
  let text = '';
  const unsubscribe = session.subscribe((event) => {
    if (
      event != null
      && typeof event === 'object'
      && 'type' in event
      && (event as { type: unknown }).type === 'message_update'
      && 'assistantMessageEvent' in event
    ) {
      const assistantMessageEvent = (event as { assistantMessageEvent?: { type?: unknown; delta?: unknown } }).assistantMessageEvent;

      if (assistantMessageEvent?.type === 'text_delta' && typeof assistantMessageEvent.delta === 'string') {
        text += assistantMessageEvent.delta;
      }
    }
  });

  try {
    await session.prompt(task.prompt);

    if (text === '') {
      text = getLastAssistantText(session);
    }

    return { ok: true, text };
  } catch (error) {
    return { ok: false, error: String(error) };
  } finally {
    unsubscribe();
  }
}
