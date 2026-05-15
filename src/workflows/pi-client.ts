import type { OrchestrationContext, Runtime } from 'duroxide';

import type { WorkflowExecutionContext } from './bridge.ts';

export type WorkflowPiBindings = {
  llm: ((context: WorkflowExecutionContext, messages: unknown[], options?: { model?: string; tools?: unknown[] }) => Promise<unknown>) | null;
  tool: ((context: WorkflowExecutionContext, name: string, args: unknown) => Promise<unknown>) | null;
  skill: ((context: WorkflowExecutionContext, name: string, input: string) => Promise<string>) | null;
  sendMessage: ((context: WorkflowExecutionContext, content: string) => Promise<void>) | null;
  prompt: ((context: WorkflowExecutionContext, prompt: string, options?: { model?: string }) => Promise<string>) | null;
};

type WorkflowPiActivityEnvelope<TInput> = {
  context: WorkflowExecutionContext;
  input: TInput;
};

export type WorkflowPiClient = {
  llm(messages: unknown[], options?: { model?: string; tools?: unknown[] }): unknown;
  tool(name: string, args: unknown): unknown;
  skill(name: string, input: string): unknown;
  sendMessage(content: string): unknown;
  prompt(prompt: string, options?: { model?: string }): unknown;
};

export type WorkflowGeneratorContext = OrchestrationContext & {
  pi: WorkflowPiClient;
};

export function createDefaultWorkflowPiBindings(): WorkflowPiBindings {
  return {
    llm: null,
    tool: null,
    skill: null,
    sendMessage: null,
    prompt: null,
  };
}

export function createWorkflowPiClient(scheduleActivity: (name: string, input: unknown) => unknown): WorkflowPiClient {
  return {
    llm(messages, options) {
      return scheduleActivity('__pi_llm', { messages, options });
    },
    tool(name, args) {
      return scheduleActivity('__pi_tool', { name, args });
    },
    skill(name, input) {
      return scheduleActivity('__pi_skill', { name, input });
    },
    sendMessage(content) {
      return scheduleActivity('__pi_sendMessage', { content });
    },
    prompt(prompt, options) {
      return scheduleActivity('__pi_prompt', { prompt, options });
    },
  };
}

function getRequiredBinding<TKey extends keyof WorkflowPiBindings>(
  bindings: WorkflowPiBindings,
  key: TKey,
  activityName: string,
): NonNullable<WorkflowPiBindings[TKey]> {
  const binding = bindings[key];

  if (binding == null) {
    throw new Error(`PiClient not bound: ${activityName} not available until session starts`);
  }

  return binding as NonNullable<WorkflowPiBindings[TKey]>;
}

export function registerWorkflowPiActivities(runtime: Runtime, bindings: WorkflowPiBindings): void {
  runtime.registerActivity(
    '__pi_llm',
    async (_ctx, envelope: WorkflowPiActivityEnvelope<{ messages: unknown[]; options?: { model?: string; tools?: unknown[] } }>) => {
      return await getRequiredBinding(bindings, 'llm', '__pi_llm')(
        envelope.context,
        envelope.input.messages,
        envelope.input.options,
      );
    },
  );

  runtime.registerActivity(
    '__pi_tool',
    async (_ctx, envelope: WorkflowPiActivityEnvelope<{ name: string; args: unknown }>) => {
      return await getRequiredBinding(bindings, 'tool', '__pi_tool')(
        envelope.context,
        envelope.input.name,
        envelope.input.args,
      );
    },
  );

  runtime.registerActivity(
    '__pi_skill',
    async (_ctx, envelope: WorkflowPiActivityEnvelope<{ name: string; input: string }>) => {
      return await getRequiredBinding(bindings, 'skill', '__pi_skill')(
        envelope.context,
        envelope.input.name,
        envelope.input.input,
      );
    },
  );

  runtime.registerActivity(
    '__pi_sendMessage',
    async (_ctx, envelope: WorkflowPiActivityEnvelope<{ content: string }>) => {
      return await getRequiredBinding(bindings, 'sendMessage', '__pi_sendMessage')(
        envelope.context,
        envelope.input.content,
      );
    },
  );

  runtime.registerActivity(
    '__pi_prompt',
    async (_ctx, envelope: WorkflowPiActivityEnvelope<{ prompt: string; options?: { model?: string } }>) => {
      return await getRequiredBinding(bindings, 'prompt', '__pi_prompt')(
        envelope.context,
        envelope.input.prompt,
        envelope.input.options,
      );
    },
  );
}
