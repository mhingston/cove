import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';

import { migrate } from '../../src/db/migrate.ts';
import type { ScheduleRecord } from '../../src/jobs/schedules.ts';
import { createWorkflowSessionBindings } from '../../src/workflows/session-bindings.ts';
import type { ContainerSessionDeps } from '../../src/container-agent/runner.ts';
import { createSessionForThread } from '../../src/session/manager.ts';
import { openInboundDb } from '../../src/session/inbound.ts';
import {
  getNextOutboundSeq,
  openOutboundDb,
  readProcessingAck,
  writeOutboundMessage,
  writeProcessingAck,
} from '../../src/session/outbound.ts';
import { createWorkflowRuntime, type WorkflowRuntime } from '../../src/workflows/runtime.ts';

const createdPaths: string[] = [];
const createdDbs: Database[] = [];

type FakeRunnerSessionOptions = {
  responseText?: string;
  toolCall?: { toolName: string; input: Record<string, unknown> };
  capture?: {
    promptedMessages: string[];
    resourceLoaders?: Array<unknown>;
    customToolsHistory?: Array<unknown>;
    configs?: Array<unknown>;
  };
};

type FakeToolCallHandler = (
  event: { toolName: string; input: Record<string, unknown> },
) => Promise<{ block?: boolean; reason?: string } | undefined> | { block?: boolean; reason?: string } | undefined;

type FakeCreateSessionOptions = Parameters<NonNullable<ContainerSessionDeps['createSession']>>[0];
type FakeCreateSessionResult = Awaited<ReturnType<NonNullable<ContainerSessionDeps['createSession']>>>;

type FakeMessageUpdate = {
  type: 'message_update';
  assistantMessageEvent?: { type: 'text_delta'; delta: string };
};

afterEach(() => {
  for (const db of createdDbs.splice(0)) {
    db.close();
  }

  for (const createdPath of createdPaths.splice(0)) {
    fs.rmSync(createdPath, { recursive: true, force: true });
  }
});

function buildSchedule(config: Record<string, unknown> | null): ScheduleRecord {
  return {
    id: 'schedule-1',
    agent_group_id: 'support',
    cron_expr: '0 9 * * *',
    prompt: 'Workflow run',
    mode: 'workflow',
    config,
    enabled: true,
    last_run_at: null,
    next_run_at: '2026-01-15T09:00:00.000Z',
    created_at: '2026-01-15T08:00:00.000Z',
  };
}

function registerDailySummaryWorkflow(runtime: WorkflowRuntime): void {
  runtime.registerDefinition({
    name: 'daily-summary',
    description: 'Collects the daily summary',
    async execute({ input, context }) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return {
        topic: input?.topic ?? null,
        trigger: context.trigger,
      };
    },
  });
}

function createCentralDb(): Database {
  const db = new Database(':memory:');
  migrate(db);
  db.prepare(
    `INSERT INTO agent_groups (
       id,
       name,
       workspace,
       provider,
       model,
       thinking,
       permissions,
       soul,
       config,
       created_at,
       updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'support',
    'Support',
    '/workspace/support',
    'anthropic',
    'support-model',
    'medium',
    '{"default":"ask"}',
    null,
    null,
    '2026-01-15T08:00:00.000Z',
    '2026-01-15T08:00:00.000Z',
  );
  createdDbs.push(db);
  return db;
}

async function waitForInboundWorkflowActionRequest(sessionDir: string, timeoutMs = 1_000): Promise<{
  request_id: string;
  action: 'prompt' | 'tool' | 'llm' | 'skill';
}> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const inboundDb = openInboundDb(sessionDir);

    try {
      const latestInbound = inboundDb.prepare(
        'SELECT metadata FROM messages_in ORDER BY seq DESC LIMIT 1',
      ).get() as { metadata: string | null } | null;
      const metadata = latestInbound?.metadata == null
        ? null
        : JSON.parse(latestInbound.metadata) as { type?: string; request_id?: string; action?: unknown };

      if (
        metadata?.type === 'workflow_action'
        && typeof metadata.request_id === 'string'
        && (metadata.action === 'prompt' || metadata.action === 'tool' || metadata.action === 'llm' || metadata.action === 'skill')
      ) {
        return {
          request_id: metadata.request_id,
          action: metadata.action,
        };
      }
    } finally {
      inboundDb.close();
    }

    await Bun.sleep(10);
  }

  throw new Error('Timed out waiting for workflow action request metadata');
}

function updateAgentGroup(options: {
  db: Database;
  id?: string;
  provider?: string;
  model?: string | null;
  config?: string | null;
}): void {
  options.db.prepare(
    `UPDATE agent_groups
     SET provider = ?, model = ?, config = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    options.provider ?? 'anthropic',
    options.model ?? null,
    options.config ?? null,
    '2026-01-15T08:30:00.000Z',
    options.id ?? 'support',
  );
}

function createFakeRunnerDeps(options: FakeRunnerSessionOptions = {}): ContainerSessionDeps {
  return {
    async createSession(sessionOptions: FakeCreateSessionOptions) {
      options.capture?.resourceLoaders?.push(sessionOptions.resourceLoader);
      options.capture?.customToolsHistory?.push(sessionOptions.customTools);
      options.capture?.configs?.push(sessionOptions.config);
      const listeners = new Set<(event: FakeMessageUpdate) => void>();
      const toolHandlers: FakeToolCallHandler[] = [];

      async function runToolHandlers(toolName: string, input: Record<string, unknown>) {
        for (const handler of toolHandlers) {
          const result = await handler({ toolName, input });

          if (result?.block) {
            return result;
          }
        }

        return undefined;
      }

      function createAssistantMessage(responseText: string) {
        return {
          role: 'assistant',
          content: [{ type: 'text', text: responseText }],
          api: 'anthropic-messages',
          provider: 'anthropic',
          model: sessionOptions.config.model,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: 'stop',
          timestamp: Date.now(),
        };
      }

      function pushAssistantMessage(responseText: string) {
        const assistantMessage = createAssistantMessage(responseText);
        agentState.messages.push(assistantMessage);
      }

      function emitAssistantText(responseText: string) {
        for (const listener of listeners) {
          listener({
            type: 'message_update',
            assistantMessageEvent: { type: 'text_delta', delta: responseText },
          });
        }
      }

      for (const factory of sessionOptions.resourceLoader?.extensionFactories ?? []) {
        factory({
          on(event: 'tool_call' | 'before_agent_start' | 'context', handler: unknown) {
            if (event === 'tool_call') {
              toolHandlers.push(handler as FakeToolCallHandler);
            }
          },
        } as unknown as Parameters<typeof factory>[0]);
      }

      const agentState = {
        systemPrompt: 'base system prompt',
        messages: [] as Array<unknown>,
        tools: (sessionOptions.customTools ?? []).map((tool) => ({
          ...tool,
          label: tool.name,
        })),
      };

      const session = {
        agent: {
          state: agentState,
          async beforeToolCall(event: {
            toolCall: { name: string };
            args: Record<string, unknown>;
          }) {
            return await runToolHandlers(event.toolCall.name, event.args);
          },
          async waitForIdle() {},
          async prompt(message: unknown) {
            const promptedMessage = Array.isArray(message) ? message[0] : message;
            if (promptedMessage == null || typeof promptedMessage !== 'object' || !('content' in promptedMessage)) {
              throw new Error('Unsupported fake agent prompt payload');
            }

            agentState.messages.push(...(Array.isArray(message) ? message : [message]));

            const firstMessage = Array.isArray(message) ? message[0] : message;
            const firstContent = firstMessage != null && typeof firstMessage === 'object' && 'content' in firstMessage
              ? (firstMessage as { content: unknown }).content
              : undefined;
            const promptedText = Array.isArray(firstContent)
              ? firstContent
                .map((part) => part != null && typeof part === 'object' && 'text' in part && typeof (part as { text: unknown }).text === 'string'
                  ? (part as { text: string }).text
                  : '')
                .join('')
              : typeof firstContent === 'string'
                ? firstContent
                : '';

            options.capture?.promptedMessages.push(promptedText);

            if (options.toolCall != null) {
              const result = await runToolHandlers(options.toolCall.toolName, options.toolCall.input);

              if (result?.block) {
                throw new Error(result.reason ?? 'Tool execution was blocked');
              }
            }

            const responseText = options.responseText ?? `Processed: ${promptedText}`;
            pushAssistantMessage(responseText);
          },
        },
        messages: agentState.messages,
        getToolDefinition(name: string) {
          return sessionOptions.customTools?.find((tool) => tool.name === name);
        },
        getLastAssistantText() {
          const assistant = [...agentState.messages].reverse().find((message) => (
            message != null && typeof message === 'object' && 'role' in message && (message as { role: unknown }).role === 'assistant'
          )) as { content?: Array<{ type: string; text?: string }> } | undefined;

          return assistant?.content?.map((part) => part.type === 'text' ? part.text ?? '' : '').join('');
        },
        async waitForIdle() {},
        subscribe(handler: (event: FakeMessageUpdate) => void) {
          listeners.add(handler);
          return () => {
            listeners.delete(handler);
          };
        },
        async prompt(message: string) {
          options.capture?.promptedMessages.push(message);

          if (options.toolCall != null) {
            const result = await runToolHandlers(options.toolCall.toolName, options.toolCall.input);

            if (result?.block) {
              const blockedText = result.reason ?? '';
              pushAssistantMessage(blockedText);
              emitAssistantText(blockedText);
              return;
            }
          }

          const responseText = options.responseText ?? `Processed: ${message}`;
          pushAssistantMessage(responseText);
          emitAssistantText(responseText);
        },
      };

      return {
        session,
      } as FakeCreateSessionResult;
    },
  };
}

describe('workflow runtime', () => {
  it('owns the configured workflows.db path and exposes the stable workflow service contract', async () => {
    const stateDir = `/tmp/cove-v2-workflows-${crypto.randomUUID()}`;
    const databasePath = `${stateDir}/workflows.db`;
    createdPaths.push(stateDir);

    const runtime = createWorkflowRuntime(databasePath);
    await runtime.start();

    try {
      expect(typeof runtime.workflowService.listDefinitions).toBe('function');
      expect(typeof runtime.workflowService.listInstances).toBe('function');
      expect(typeof runtime.workflowService.startWorkflow).toBe('function');
      expect(typeof runtime.workflowService.getWorkflow).toBe('function');
      expect(typeof runtime.workflowService.signalWorkflow).toBe('function');
      expect(typeof runtime.workflowService.terminateWorkflow).toBe('function');
      expect(typeof runtime.workflowService.waitForWorkflow).toBe('function');
      expect(typeof runtime.workflowService.startScheduledWorkflow).toBe('function');
      expect(typeof runtime.workflowService.rollbackWorkflow).toBe('function');

      expect(await runtime.workflowService.listDefinitions()).toEqual([]);

      registerDailySummaryWorkflow(runtime);

      const started = await runtime.startWorkflow({
        schedule: buildSchedule({ workflow: 'daily-summary' }),
        input: { workflow: 'daily-summary' },
      });

      expect(started).toEqual({ instanceId: expect.any(String) });
      expect(fs.existsSync(`${stateDir}/workflows.metadata.db`)).toBe(true);
      expect(await runtime.workflowService.getWorkflow({ instanceId: started.instanceId })).toEqual({
        instanceId: started.instanceId,
        name: 'daily-summary',
        status: 'Running',
        customStatus: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        input: {
          workflow: 'daily-summary',
        },
        output: null,
        error: null,
      });
      expect(fs.existsSync(databasePath)).toBe(true);
    } finally {
      await runtime.stop();
    }
  });

  it('allows tests to register definitions through the runtime-owned public seam', async () => {
    const stateDir = `/tmp/cove-v2-workflows-${crypto.randomUUID()}`;
    const databasePath = `${stateDir}/workflows.db`;
    createdPaths.push(stateDir);

    const runtime = createWorkflowRuntime(databasePath);

    runtime.registerDefinition({
      name: 'daily-summary',
      description: 'Collects the daily summary',
      async execute() {
        return { ok: true };
      },
    });

    await runtime.start();

    try {
      expect(await runtime.workflowService.listDefinitions()).toEqual([
        {
          name: 'daily-summary',
          description: 'Collects the daily summary',
        },
      ]);
    } finally {
      await runtime.stop();
    }
  });

  it('rejects duplicate workflow definition names in the host-owned registry', () => {
    const stateDir = `/tmp/cove-v2-workflows-${crypto.randomUUID()}`;
    const databasePath = `${stateDir}/workflows.db`;
    createdPaths.push(stateDir);

    const runtime = createWorkflowRuntime(databasePath);

    runtime.registerDefinition({
      name: 'daily-summary',
      description: 'Collects the daily summary',
      async execute() {
        return { ok: true };
      },
    });

    expect(() => runtime.registerDefinition({
      name: 'daily-summary',
      description: 'Duplicate definition',
      async execute() {
        return { ok: false };
      },
    })).toThrow('Workflow definition already registered: daily-summary');
  });

  it('rejects workflow starts for unknown definitions once the runtime is started', async () => {
    const stateDir = `/tmp/cove-v2-workflows-${crypto.randomUUID()}`;
    const databasePath = `${stateDir}/workflows.db`;
    createdPaths.push(stateDir);

    const runtime = createWorkflowRuntime(databasePath);
    await runtime.start();

    try {
      await expect(runtime.workflowService.startWorkflow({
        name: 'missing-workflow',
        input: { topic: 'sales' },
        context: { trigger: 'api' },
      })).rejects.toThrow('Workflow definition not found: missing-workflow');
      expect(await runtime.workflowService.listInstances()).toEqual([]);
    } finally {
      await runtime.stop();
    }
  });

  it('surfaces durable completed and failed status transitions through the workflow service', async () => {
    const stateDir = `/tmp/cove-v2-workflows-${crypto.randomUUID()}`;
    const databasePath = `${stateDir}/workflows.db`;
    createdPaths.push(stateDir);

    const runtime = createWorkflowRuntime(databasePath);

    runtime.registerDefinition({
      name: 'complete-workflow',
      description: 'Completes immediately',
      async execute({ input, context }) {
        return {
          ok: true,
          topic: input?.topic ?? null,
          trigger: context.trigger,
        };
      },
    });

    runtime.registerDefinition({
      name: 'fail-workflow',
      description: 'Fails immediately',
      async execute() {
        throw new Error('workflow exploded');
      },
    });

    await runtime.start();

    try {
      const completed = await runtime.workflowService.startWorkflow({
        id: 'instance-completed',
        name: 'complete-workflow',
        input: { topic: 'sales' },
        context: {
          trigger: 'api',
          thread_id: 'workflow:instance-completed',
        },
      });

      await expect(
        runtime.workflowService.waitForWorkflow({
          instanceId: completed.instanceId,
          timeoutMs: 2_000,
          pollIntervalMs: 10,
        }),
      ).resolves.toEqual({
        instanceId: 'instance-completed',
        name: 'complete-workflow',
        status: 'Completed',
        customStatus: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        input: {
          topic: 'sales',
        },
        output: {
          ok: true,
          topic: 'sales',
          trigger: 'api',
        },
        error: null,
      });

      const failed = await runtime.workflowService.startWorkflow({
        id: 'instance-failed',
        name: 'fail-workflow',
        input: { topic: 'support' },
        context: {
          trigger: 'tool',
          session_id: 'session-1',
        },
      });

      await expect(
        runtime.workflowService.waitForWorkflow({
          instanceId: failed.instanceId,
          timeoutMs: 2_000,
          pollIntervalMs: 10,
        }),
      ).resolves.toEqual({
        instanceId: 'instance-failed',
        name: 'fail-workflow',
        status: 'Failed',
        customStatus: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        input: {
          topic: 'support',
        },
        output: null,
        error: {
          message: 'workflow exploded',
        },
      });
    } finally {
      await runtime.stop();
    }
  });

  it('wraps direct workflow starts with the stable cove execution context envelope', async () => {
    const stateDir = `/tmp/cove-v2-workflows-${crypto.randomUUID()}`;
    const databasePath = `${stateDir}/workflows.db`;
    createdPaths.push(stateDir);

    const runtime = createWorkflowRuntime(databasePath);
    registerDailySummaryWorkflow(runtime);
    await runtime.start();

    try {
      const started = await runtime.workflowService.startWorkflow({
        id: 'instance-api',
        name: 'daily-summary',
        input: { topic: 'sales' },
        context: {
          trigger: 'api',
          agent_group_id: 'default',
          thread_id: 'workflow:instance-api',
        },
      });

      expect(started).toEqual({ instanceId: 'instance-api' });
      expect(await runtime.workflowService.getWorkflow({ instanceId: started.instanceId })).toEqual({
        instanceId: 'instance-api',
        name: 'daily-summary',
        status: 'Running',
        customStatus: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        input: {
          topic: 'sales',
        },
        output: null,
        error: null,
      });
    } finally {
      await runtime.stop();
    }
  });

  it('stores schedule starts through the same envelope logic and returns plain stable input data', async () => {
    const stateDir = `/tmp/cove-v2-workflows-${crypto.randomUUID()}`;
    const databasePath = `${stateDir}/workflows.db`;
    createdPaths.push(stateDir);

    const runtime = createWorkflowRuntime(databasePath);
    registerDailySummaryWorkflow(runtime);
    await runtime.start();

    try {
      const started = await runtime.workflowService.startScheduledWorkflow({
        schedule: buildSchedule({ name: 'daily-summary', workflow: 'fallback-name' }),
        input: { topic: 'sales' },
      });

      expect(await runtime.workflowService.getWorkflow({ instanceId: started.instanceId })).toEqual({
        instanceId: started.instanceId,
        name: 'daily-summary',
        status: 'Running',
        customStatus: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        input: {
          topic: 'sales',
        },
        output: null,
        error: null,
      });
    } finally {
      await runtime.stop();
    }
  });

  it('rejects stable workflow service calls when the runtime is not started', async () => {
    const stateDir = `/tmp/cove-v2-workflows-${crypto.randomUUID()}`;
    const databasePath = `${stateDir}/workflows.db`;
    createdPaths.push(stateDir);

    const runtime = createWorkflowRuntime(databasePath);

    await expect(runtime.workflowService.listInstances()).rejects.toThrow('Workflow runtime is not started');
    await expect(runtime.workflowService.startWorkflow({
      name: 'daily-summary',
      input: { topic: 'sales' },
      context: { trigger: 'api' },
    })).rejects.toThrow('Workflow runtime is not started');
    await expect(runtime.workflowService.getWorkflow({ instanceId: 'missing' })).rejects.toThrow('Workflow runtime is not started');
    await expect(runtime.workflowService.signalWorkflow({
      instanceId: 'missing',
      eventName: 'refresh',
      data: null,
    })).rejects.toThrow('Workflow runtime is not started');
    await expect(runtime.workflowService.terminateWorkflow({ instanceId: 'missing' })).rejects.toThrow('Workflow runtime is not started');
    await expect(runtime.workflowService.waitForWorkflow({ instanceId: 'missing' })).rejects.toThrow('Workflow runtime is not started');
    await expect(runtime.workflowService.rollbackWorkflow({ instanceId: 'missing' })).rejects.toThrow('Workflow runtime is not started');
  });

  it('lists, signals, terminates, waits for, and rolls back workflow instances through the stable service contract', async () => {
    const stateDir = `/tmp/cove-v2-workflows-${crypto.randomUUID()}`;
    const databasePath = `${stateDir}/workflows.db`;
    createdPaths.push(stateDir);

    const runtime = createWorkflowRuntime(databasePath);
    registerDailySummaryWorkflow(runtime);
    await runtime.start();

    try {
      const started = await runtime.workflowService.startWorkflow({
        id: 'instance-tool',
        name: 'daily-summary',
        input: { topic: 'sales' },
        context: {
          trigger: 'tool',
          agent_group_id: 'support',
          session_id: 'session-1',
        },
      });

      expect(await runtime.workflowService.listInstances({ name: 'daily-summary', status: 'Running' })).toEqual([
        {
          instanceId: started.instanceId,
          name: 'daily-summary',
          status: 'Running',
          customStatus: null,
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
          input: {
            topic: 'sales',
          },
          output: null,
          error: null,
        },
      ]);

      await runtime.workflowService.signalWorkflow({
        instanceId: started.instanceId,
        eventName: 'refresh',
        data: { urgent: true },
      });

      await runtime.workflowService.terminateWorkflow({
        instanceId: started.instanceId,
      });

      expect(await runtime.workflowService.waitForWorkflow({ instanceId: started.instanceId })).toEqual({
        instanceId: started.instanceId,
        name: 'daily-summary',
        status: 'Terminated',
        customStatus: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        input: {
          topic: 'sales',
        },
        output: null,
        error: {
          message: 'Workflow terminated',
        },
      });

      await runtime.workflowService.rollbackWorkflow({ instanceId: started.instanceId });

      expect(await runtime.workflowService.getWorkflow({ instanceId: started.instanceId })).toBeNull();
    } finally {
      await runtime.stop();
    }
  });

  it('waits until a running workflow reaches a terminal state', async () => {
    const stateDir = `/tmp/cove-v2-workflows-${crypto.randomUUID()}`;
    const databasePath = `${stateDir}/workflows.db`;
    createdPaths.push(stateDir);

    const runtime = createWorkflowRuntime(databasePath);
    registerDailySummaryWorkflow(runtime);
    await runtime.start();

    try {
      const started = await runtime.workflowService.startWorkflow({
        id: 'instance-wait',
        name: 'daily-summary',
        input: { topic: 'sales' },
        context: { trigger: 'api' },
      });

      setTimeout(() => {
        void runtime.workflowService.terminateWorkflow({ instanceId: started.instanceId });
      }, 20);

      await expect(
        runtime.workflowService.waitForWorkflow({
          instanceId: started.instanceId,
          timeoutMs: 500,
          pollIntervalMs: 10,
        }),
      ).resolves.toEqual({
        instanceId: started.instanceId,
        name: 'daily-summary',
        status: 'Terminated',
        customStatus: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        input: {
          topic: 'sales',
        },
        output: null,
        error: {
          message: 'Workflow terminated',
        },
      });
    } finally {
      await runtime.stop();
    }
  });

  it('times out when a workflow never reaches a terminal state', async () => {
    const stateDir = `/tmp/cove-v2-workflows-${crypto.randomUUID()}`;
    const databasePath = `${stateDir}/workflows.db`;
    createdPaths.push(stateDir);

    const runtime = createWorkflowRuntime(databasePath);
    registerDailySummaryWorkflow(runtime);
    await runtime.start();

    try {
      const started = await runtime.workflowService.startWorkflow({
        id: 'instance-timeout',
        name: 'daily-summary',
        input: { topic: 'sales' },
        context: { trigger: 'api' },
      });

      await expect(
        runtime.workflowService.waitForWorkflow({
          instanceId: started.instanceId,
          timeoutMs: 30,
          pollIntervalMs: 10,
        }),
      ).rejects.toThrow(`Workflow wait timed out: ${started.instanceId}`);
    } finally {
      await runtime.stop();
    }
  });

  it('waits with a sane default timeout when timeoutMs is omitted', async () => {
    const stateDir = `/tmp/cove-v2-workflows-${crypto.randomUUID()}`;
    const databasePath = `${stateDir}/workflows.db`;
    createdPaths.push(stateDir);

    const runtime = createWorkflowRuntime(databasePath);
    registerDailySummaryWorkflow(runtime);
    await runtime.start();

    try {
      const started = await runtime.workflowService.startWorkflow({
        id: 'instance-default-timeout',
        name: 'daily-summary',
        input: { topic: 'sales' },
        context: { trigger: 'api' },
      });

      setTimeout(() => {
        void runtime.workflowService.terminateWorkflow({ instanceId: started.instanceId });
      }, 20);

      await expect(
        runtime.workflowService.waitForWorkflow({
          instanceId: started.instanceId,
          pollIntervalMs: 10,
        }),
      ).resolves.toEqual({
        instanceId: started.instanceId,
        name: 'daily-summary',
        status: 'Terminated',
        customStatus: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        input: {
          topic: 'sales',
        },
        output: null,
        error: {
          message: 'Workflow terminated',
        },
      });
    } finally {
      await runtime.stop();
    }
  });

  it('routes __pi_prompt through workflow action metadata using workflow execution context', async () => {
    const stateDir = `/tmp/cove-v2-workflows-${crypto.randomUUID()}`;
    const databasePath = `${stateDir}/workflows.db`;
    createdPaths.push(stateDir);

    const centralDb = createCentralDb();
    const ensureSessionRuntimeCalls: Array<{ sessionId: string; threadId: string; model: string | null }> = [];
    const pollCalls: Array<{ sessionId: string; requestId: string; action: string }> = [];
    const runtime = createWorkflowRuntime(databasePath);
    runtime.bindPi(createWorkflowSessionBindings({
      db: centralDb,
      stateDir,
      ensureSessionRuntime: async ({ routed, config }) => {
        ensureSessionRuntimeCalls.push({
          sessionId: routed.session.id,
          threadId: routed.threadId,
          model: config.model,
        });
        return true;
      },
      pollForWorkflowActionResult: async ({ sessionId, requestId }) => {
        pollCalls.push({ sessionId, requestId, action: 'prompt' });
        return {
          type: 'workflow_action_result',
          request_id: requestId,
          action: 'prompt',
          status: 'completed',
          result: 'Summarised sales',
        };
      },
    }));

    runtime.registerDefinition({
      name: 'prompt-workflow',
      description: 'Calls ctx.pi.prompt',
      *generator(ctx, input) {
        const response = yield ctx.pi.prompt(`Summarise ${String(input?.topic ?? '')}`, { model: 'prompt-model' });
        return {
          response,
        };
      },
    });

    await runtime.start();

    try {
      const started = await runtime.workflowService.startWorkflow({
        id: 'instance-prompt',
        name: 'prompt-workflow',
        input: { topic: 'sales' },
        context: {
          trigger: 'api',
          agent_group_id: 'support',
          thread_id: 'workflow:instance-prompt',
        },
      });

      await expect(runtime.workflowService.waitForWorkflow({
        instanceId: started.instanceId,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
      })).resolves.toEqual({
        instanceId: 'instance-prompt',
        name: 'prompt-workflow',
        status: 'Completed',
        customStatus: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        input: {
          topic: 'sales',
        },
        output: {
          response: 'Summarised sales',
        },
        error: null,
      });

      const session = centralDb.prepare(
        'SELECT id, thread_id, session_file FROM sessions WHERE agent_group_id = ? AND thread_id = ?',
      ).get('support', 'workflow:instance-prompt') as {
        id: string;
        thread_id: string;
        session_file: string;
      } | null;
      expect(session).not.toBeNull();
      expect(ensureSessionRuntimeCalls).toEqual([
        {
          sessionId: session!.id,
          threadId: 'workflow:instance-prompt',
          model: 'prompt-model',
        },
      ]);
      expect(pollCalls).toEqual([{ sessionId: session!.id, requestId: expect.any(String), action: 'prompt' }]);

      const inboundDb = openInboundDb(session!.session_file);
      try {
        const configRow = inboundDb.prepare('SELECT model FROM session_config').get() as { model: string } | null;
        expect(configRow?.model).toBe('prompt-model');
        expect(inboundDb.prepare('SELECT role, content, metadata FROM messages_in ORDER BY seq ASC').all()).toEqual([
          {
            role: 'user',
            content: 'Summarise sales',
            metadata: JSON.stringify({
              type: 'workflow_action',
              request_id: pollCalls[0]!.requestId,
              action: 'prompt',
              prompt: 'Summarise sales',
            }),
          },
        ]);
      } finally {
        inboundDb.close();
      }
    } finally {
      await runtime.stop();
    }
  });

  it('preserves a null stored model for __pi_prompt when the agent group has no default model', async () => {
    const stateDir = `/tmp/cove-v2-workflows-${crypto.randomUUID()}`;
    const databasePath = `${stateDir}/workflows.db`;
    createdPaths.push(stateDir);

    const centralDb = createCentralDb();
    updateAgentGroup({
      db: centralDb,
      model: null,
    });
    const ensureSessionRuntimeCalls: Array<{ sessionId: string; threadId: string; model: string | null }> = [];
    const pollCalls: Array<{ sessionId: string; requestId: string; action: string }> = [];
    const runtime = createWorkflowRuntime(databasePath);
    runtime.bindPi(createWorkflowSessionBindings({
      db: centralDb,
      stateDir,
      ensureSessionRuntime: async ({ routed, config }) => {
        ensureSessionRuntimeCalls.push({
          sessionId: routed.session.id,
          threadId: routed.threadId,
          model: config.model,
        });
        return true;
      },
      pollForWorkflowActionResult: async ({ sessionId, requestId }) => {
        pollCalls.push({ sessionId, requestId, action: 'prompt' });
        return {
          type: 'workflow_action_result',
          request_id: requestId,
          action: 'prompt',
          status: 'completed',
          result: 'Summarised sales',
        };
      },
    }));

    runtime.registerDefinition({
      name: 'prompt-workflow-null-model',
      description: 'Calls ctx.pi.prompt without a default model',
      *generator(ctx, input) {
        const response = yield ctx.pi.prompt(`Summarise ${String(input?.topic ?? '')}`);
        return {
          response,
        };
      },
    });

    await runtime.start();

    try {
      const started = await runtime.workflowService.startWorkflow({
        id: 'instance-prompt-null-model',
        name: 'prompt-workflow-null-model',
        input: { topic: 'sales' },
        context: {
          trigger: 'api',
          agent_group_id: 'support',
          thread_id: 'workflow:instance-prompt-null-model',
        },
      });

      await expect(runtime.workflowService.waitForWorkflow({
        instanceId: started.instanceId,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
      })).resolves.toEqual({
        instanceId: 'instance-prompt-null-model',
        name: 'prompt-workflow-null-model',
        status: 'Completed',
        customStatus: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        input: {
          topic: 'sales',
        },
        output: {
          response: 'Summarised sales',
        },
        error: null,
      });

      const session = centralDb.prepare(
        'SELECT id, thread_id, session_file FROM sessions WHERE agent_group_id = ? AND thread_id = ?',
      ).get('support', 'workflow:instance-prompt-null-model') as {
        id: string;
        thread_id: string;
        session_file: string;
      } | null;
      expect(session).not.toBeNull();
      expect(ensureSessionRuntimeCalls).toEqual([
        {
          sessionId: session!.id,
          threadId: 'workflow:instance-prompt-null-model',
          model: null,
        },
      ]);
      expect(pollCalls).toEqual([{ sessionId: session!.id, requestId: expect.any(String), action: 'prompt' }]);

      const inboundDb = openInboundDb(session!.session_file);
      try {
        const configRow = inboundDb.prepare('SELECT model FROM session_config').get() as { model: string | null } | null;
        expect(configRow?.model).toBeNull();
        expect(inboundDb.prepare('SELECT role, content, metadata FROM messages_in ORDER BY seq ASC').all()).toEqual([
          {
            role: 'user',
            content: 'Summarise sales',
            metadata: JSON.stringify({
              type: 'workflow_action',
              request_id: pollCalls[0]!.requestId,
              action: 'prompt',
              prompt: 'Summarise sales',
            }),
          },
        ]);
      } finally {
        inboundDb.close();
      }
    } finally {
      await runtime.stop();
    }
  });

  it('fails __pi_prompt when the agent group runtime-prep config is invalid', async () => {
    const stateDir = `/tmp/cove-v2-workflows-${crypto.randomUUID()}`;
    const databasePath = `${stateDir}/workflows.db`;
    createdPaths.push(stateDir);

    const centralDb = createCentralDb();
    updateAgentGroup({
      db: centralDb,
      config: '{"provider_env_passthrough":[{"name":""}]}',
    });
    const ensureSessionRuntimeCalls: Array<{ sessionId: string; threadId: string; model: string | null }> = [];
    const pollCalls: Array<{ sessionId: string; baselineOutSeq: number }> = [];
    const runtime = createWorkflowRuntime(databasePath);
    runtime.bindPi(createWorkflowSessionBindings({
      db: centralDb,
      stateDir,
      ensureSessionRuntime: async ({ routed, config }) => {
        ensureSessionRuntimeCalls.push({
          sessionId: routed.session.id,
          threadId: routed.threadId,
          model: config.model,
        });
        return true;
      },
      pollForResponse: async ({ sessionId, baselineOutSeq }) => {
        pollCalls.push({ sessionId, baselineOutSeq });
        return [
          {
            id: 'out-1',
            seq: 1,
            role: 'assistant',
            content: 'Summarised sales',
            finish_reason: 'stop',
            tool_calls: null,
            metadata: null,
            created_at: '2026-01-15T09:00:00.000Z',
          },
        ];
      },
    }));

    runtime.registerDefinition({
      name: 'prompt-workflow-invalid-config',
      description: 'Calls ctx.pi.prompt with invalid runtime-prep config',
      *generator(ctx) {
        const response = yield ctx.pi.prompt('Summarise sales');
        return {
          response,
        };
      },
    });

    await runtime.start();

    try {
      const started = await runtime.workflowService.startWorkflow({
        id: 'instance-prompt-invalid-config',
        name: 'prompt-workflow-invalid-config',
        input: null,
        context: {
          trigger: 'api',
          agent_group_id: 'support',
          thread_id: 'workflow:instance-prompt-invalid-config',
        },
      });

      await expect(runtime.workflowService.waitForWorkflow({
        instanceId: started.instanceId,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
      })).resolves.toMatchObject({
        instanceId: 'instance-prompt-invalid-config',
        name: 'prompt-workflow-invalid-config',
        status: 'Failed',
        output: null,
        error: {
          message: expect.stringContaining('Invalid agent group config: provider_env_passthrough[0].name must be a non-empty string'),
        },
      });
      expect(ensureSessionRuntimeCalls).toHaveLength(0);
      expect(pollCalls).toHaveLength(0);
    } finally {
      await runtime.stop();
    }
  });

  it('routes __pi_sendMessage to the targeted session when workflow execution context provides session_id', async () => {
    const stateDir = `/tmp/cove-v2-workflows-${crypto.randomUUID()}`;
    const databasePath = `${stateDir}/workflows.db`;
    createdPaths.push(stateDir);

    const centralDb = createCentralDb();
    const existingSession = createSessionForThread({
      db: centralDb,
      stateDir,
      agentGroupId: 'support',
      threadId: 'existing-thread',
    });
    const runtime = createWorkflowRuntime(databasePath);
    runtime.bindPi(createWorkflowSessionBindings({
      db: centralDb,
      stateDir,
    }));

    runtime.registerDefinition({
      name: 'message-workflow',
      description: 'Calls ctx.pi.sendMessage',
      *generator(ctx) {
        yield ctx.pi.sendMessage('Deploy completed successfully');
        return {
          status: 'done',
        };
      },
    });

    await runtime.start();

    try {
      const started = await runtime.workflowService.startWorkflow({
        id: 'instance-message',
        name: 'message-workflow',
        input: null,
        context: {
          trigger: 'tool',
          agent_group_id: 'support',
          session_id: existingSession.id,
          thread_id: 'ignored-thread',
        },
      });

      await expect(runtime.workflowService.waitForWorkflow({
        instanceId: started.instanceId,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
      })).resolves.toEqual({
        instanceId: 'instance-message',
        name: 'message-workflow',
        status: 'Completed',
        customStatus: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        input: null,
        output: {
          status: 'done',
        },
        error: null,
      });

      const sessionCount = centralDb.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number };
      expect(sessionCount.count).toBe(1);
      expect(centralDb.prepare('SELECT id FROM sessions WHERE thread_id = ?').get('ignored-thread')).toBeNull();

      const outboundDb = openOutboundDb(existingSession.session_file!);
      try {
        const messages = outboundDb.prepare(
          'SELECT seq, role, content FROM messages_out ORDER BY seq ASC',
        ).all() as Array<{ seq: number; role: string; content: string }>;
        expect(messages).toEqual([
          {
            seq: 3,
            role: 'assistant',
            content: 'Deploy completed successfully',
          },
        ]);
        expect(readProcessingAck(outboundDb, existingSession.id)).toMatchObject({
          session_id: existingSession.id,
          last_out_seq: 3,
        });
      } finally {
        outboundDb.close();
      }
    } finally {
      await runtime.stop();
    }
  });

  it('routes __pi_prompt to the targeted session through workflow action metadata when workflow execution context provides session_id', async () => {
    const stateDir = `/tmp/cove-v2-workflows-${crypto.randomUUID()}`;
    const databasePath = `${stateDir}/workflows.db`;
    createdPaths.push(stateDir);

    const centralDb = createCentralDb();
    const existingSession = createSessionForThread({
      db: centralDb,
      stateDir,
      agentGroupId: 'support',
      threadId: 'existing-thread',
    });
    const ensureSessionRuntimeCalls: Array<{ sessionId: string; threadId: string; model: string | null }> = [];
    const pollCalls: Array<{ sessionId: string; requestId: string; action: string }> = [];
    const runtime = createWorkflowRuntime(databasePath);
    runtime.bindPi(createWorkflowSessionBindings({
      db: centralDb,
      stateDir,
      ensureSessionRuntime: async ({ routed, config }) => {
        ensureSessionRuntimeCalls.push({
          sessionId: routed.session.id,
          threadId: routed.threadId,
          model: config.model,
        });
        return true;
      },
      pollForWorkflowActionResult: async ({ sessionId, requestId }) => {
        pollCalls.push({ sessionId, requestId, action: 'prompt' });
        return {
          type: 'workflow_action_result',
          request_id: requestId,
          action: 'prompt',
          status: 'completed',
          result: 'Existing session summary',
        };
      },
    }));

    runtime.registerDefinition({
      name: 'prompt-existing-session-workflow',
      description: 'Calls ctx.pi.prompt with an existing session',
      *generator(ctx) {
        const response = yield ctx.pi.prompt('Summarise the existing session', { model: 'prompt-model' });
        return { response };
      },
    });

    await runtime.start();

    try {
      const started = await runtime.workflowService.startWorkflow({
        id: 'instance-prompt-session',
        name: 'prompt-existing-session-workflow',
        input: null,
        context: {
          trigger: 'tool',
          agent_group_id: 'support',
          session_id: existingSession.id,
          thread_id: 'ignored-thread',
        },
      });

      await expect(runtime.workflowService.waitForWorkflow({
        instanceId: started.instanceId,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
      })).resolves.toEqual({
        instanceId: 'instance-prompt-session',
        name: 'prompt-existing-session-workflow',
        status: 'Completed',
        customStatus: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        input: null,
        output: {
          response: 'Existing session summary',
        },
        error: null,
      });

      const sessionCount = centralDb.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number };
      expect(sessionCount.count).toBe(1);
      expect(centralDb.prepare('SELECT id FROM sessions WHERE thread_id = ?').get('ignored-thread')).toBeNull();
      expect(ensureSessionRuntimeCalls).toEqual([
        {
          sessionId: existingSession.id,
          threadId: 'existing-thread',
          model: 'prompt-model',
        },
      ]);
      expect(pollCalls).toEqual([{ sessionId: existingSession.id, requestId: expect.any(String), action: 'prompt' }]);

      const inboundDb = openInboundDb(existingSession.session_file!);
      try {
        const configRow = inboundDb.prepare('SELECT model FROM session_config').get() as { model: string } | null;
        expect(configRow?.model).toBe('prompt-model');
        expect(inboundDb.prepare('SELECT role, content, metadata FROM messages_in ORDER BY seq ASC').all()).toEqual([
          {
            role: 'user',
            content: 'Summarise the existing session',
            metadata: JSON.stringify({
              type: 'workflow_action',
              request_id: pollCalls[0]!.requestId,
              action: 'prompt',
              prompt: 'Summarise the existing session',
            }),
          },
        ]);
      } finally {
        inboundDb.close();
      }
    } finally {
      await runtime.stop();
    }
  });

  it('uses the production workflow action poller by default and ignores stale matching rows written before the baseline', async () => {
    const stateDir = `/tmp/cove-v2-workflows-${crypto.randomUUID()}`;
    const databasePath = `${stateDir}/workflows.db`;
    createdPaths.push(stateDir);

    const centralDb = createCentralDb();
    const existingSession = createSessionForThread({
      db: centralDb,
      stateDir,
      agentGroupId: 'support',
      threadId: 'existing-thread',
    });
    const ensureSessionRuntimeCalls: Array<{ sessionId: string; threadId: string; model: string | null }> = [];
    const runtime = createWorkflowRuntime(databasePath);
    runtime.bindPi(createWorkflowSessionBindings({
      db: centralDb,
      stateDir,
      ensureSessionRuntime: async ({ routed, config }) => {
        ensureSessionRuntimeCalls.push({
          sessionId: routed.session.id,
          threadId: routed.threadId,
          model: config.model,
        });
        return true;
      },
    }));

    runtime.registerDefinition({
      name: 'prompt-existing-session-default-poller-workflow',
      description: 'Calls ctx.pi.prompt with the production workflow action poller',
      *generator(ctx) {
        const response = yield ctx.pi.prompt('Summarise the existing session', { model: 'prompt-model' });
        return { response };
      },
    });

    await runtime.start();

    try {
      const staleOutboundDb = openOutboundDb(existingSession.session_file!);
      try {
        writeOutboundMessage(staleOutboundDb, {
          id: 'out-stale',
          seq: 3,
          role: 'assistant',
          content: 'Stale matching result',
          metadata: {
            type: 'workflow_action_result',
            request_id: 'req-placeholder',
            action: 'prompt',
            status: 'completed',
            result: 'Stale matching result',
          },
        });
        writeProcessingAck(staleOutboundDb, {
          session_id: existingSession.id,
          last_in_seq: 2,
          last_out_seq: 3,
          heartbeat_at: '2026-01-15T08:59:00.000Z',
        });
      } finally {
        staleOutboundDb.close();
      }

      const started = await runtime.workflowService.startWorkflow({
        id: 'instance-prompt-session-default-poller',
        name: 'prompt-existing-session-default-poller-workflow',
        input: null,
        context: {
          trigger: 'tool',
          agent_group_id: 'support',
          session_id: existingSession.id,
          thread_id: 'ignored-thread',
        },
      });

      const workflowActionRequest = await waitForInboundWorkflowActionRequest(existingSession.session_file!);
      expect(workflowActionRequest.action).toBe('prompt');

      const outboundDb = openOutboundDb(existingSession.session_file!);
      try {
        outboundDb.prepare('UPDATE messages_out SET metadata = ? WHERE id = ?').run(
          JSON.stringify({
            type: 'workflow_action_result',
            request_id: workflowActionRequest.request_id,
            action: 'prompt',
            status: 'completed',
            result: 'Stale matching result',
          }),
          'out-stale',
        );

        const ack = readProcessingAck(outboundDb, existingSession.id);
        const seq = getNextOutboundSeq(ack?.last_out_seq ?? null, ack?.last_in_seq ?? 0);

        writeOutboundMessage(outboundDb, {
          id: 'out-fresh',
          seq,
          role: 'assistant',
          content: 'Existing session summary',
          metadata: {
            type: 'workflow_action_result',
            request_id: workflowActionRequest.request_id,
            action: 'prompt',
            status: 'completed',
            result: 'Existing session summary',
          },
        });
        writeProcessingAck(outboundDb, {
          session_id: existingSession.id,
          last_in_seq: ack?.last_in_seq ?? null,
          last_out_seq: seq,
          heartbeat_at: '2026-01-15T09:00:00.000Z',
        });
      } finally {
        outboundDb.close();
      }

      await expect(runtime.workflowService.waitForWorkflow({
        instanceId: started.instanceId,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
      })).resolves.toEqual({
        instanceId: 'instance-prompt-session-default-poller',
        name: 'prompt-existing-session-default-poller-workflow',
        status: 'Completed',
        customStatus: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        input: null,
        output: {
          response: 'Existing session summary',
        },
        error: null,
      });

      const sessionCount = centralDb.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number };
      expect(sessionCount.count).toBe(1);
      expect(centralDb.prepare('SELECT id FROM sessions WHERE thread_id = ?').get('ignored-thread')).toBeNull();
      expect(ensureSessionRuntimeCalls).toEqual([
        {
          sessionId: existingSession.id,
          threadId: 'existing-thread',
          model: 'prompt-model',
        },
      ]);

      const inboundDb = openInboundDb(existingSession.session_file!);
      try {
        const configRow = inboundDb.prepare('SELECT model FROM session_config').get() as { model: string } | null;
        const inboundMessages = inboundDb.prepare('SELECT role, content, metadata FROM messages_in ORDER BY seq ASC').all() as Array<{
          role: string;
          content: string;
          metadata: string | null;
        }>;
        const requestId = JSON.parse(inboundMessages[0]!.metadata ?? '{}') as { request_id?: string };

        expect(configRow?.model).toBe('prompt-model');
        expect(inboundMessages).toEqual([
          {
            role: 'user',
            content: 'Summarise the existing session',
            metadata: JSON.stringify({
              type: 'workflow_action',
              request_id: requestId.request_id,
              action: 'prompt',
              prompt: 'Summarise the existing session',
            }),
          },
        ]);
      } finally {
        inboundDb.close();
      }
    } finally {
      await runtime.stop();
    }
  });

  it('routes __pi_sendMessage through a new thread when workflow execution context does not provide session_id', async () => {
    const stateDir = `/tmp/cove-v2-workflows-${crypto.randomUUID()}`;
    const databasePath = `${stateDir}/workflows.db`;
    createdPaths.push(stateDir);

    const centralDb = createCentralDb();
    const runtime = createWorkflowRuntime(databasePath);
    runtime.bindPi(createWorkflowSessionBindings({
      db: centralDb,
      stateDir,
    }));

    runtime.registerDefinition({
      name: 'message-new-thread-workflow',
      description: 'Calls ctx.pi.sendMessage on a new workflow thread',
      *generator(ctx) {
        yield ctx.pi.sendMessage('Created on a workflow-owned thread');
        return {
          status: 'done',
        };
      },
    });

    await runtime.start();

    try {
      const started = await runtime.workflowService.startWorkflow({
        id: 'instance-message-new-thread',
        name: 'message-new-thread-workflow',
        input: null,
        context: {
          trigger: 'api',
          agent_group_id: 'support',
          thread_id: 'workflow:new-thread',
        },
      });

      await expect(runtime.workflowService.waitForWorkflow({
        instanceId: started.instanceId,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
      })).resolves.toEqual({
        instanceId: 'instance-message-new-thread',
        name: 'message-new-thread-workflow',
        status: 'Completed',
        customStatus: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        input: null,
        output: {
          status: 'done',
        },
        error: null,
      });

      const session = centralDb.prepare(
        'SELECT id, thread_id, session_file FROM sessions WHERE agent_group_id = ? AND thread_id = ?',
      ).get('support', 'workflow:new-thread') as {
        id: string;
        thread_id: string;
        session_file: string;
      } | null;
      expect(session).not.toBeNull();

      const sessionCount = centralDb.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number };
      expect(sessionCount.count).toBe(1);

      const outboundDb = openOutboundDb(session!.session_file);
      try {
        const messages = outboundDb.prepare(
          'SELECT seq, role, content FROM messages_out ORDER BY seq ASC',
        ).all() as Array<{ seq: number; role: string; content: string }>;
        expect(messages).toEqual([
          {
            seq: 3,
            role: 'assistant',
            content: 'Created on a workflow-owned thread',
          },
        ]);
        expect(readProcessingAck(outboundDb, session!.id)).toMatchObject({
          session_id: session!.id,
          last_out_seq: 3,
        });
      } finally {
        outboundDb.close();
      }
    } finally {
      await runtime.stop();
    }
  });

  it('routes __pi_tool through workflow action metadata using workflow execution context', async () => {
    const stateDir = `/tmp/cove-v2-workflows-${crypto.randomUUID()}`;
    const databasePath = `${stateDir}/workflows.db`;
    createdPaths.push(stateDir);

    const centralDb = createCentralDb();
    centralDb.prepare('UPDATE agent_groups SET permissions = ? WHERE id = ?').run(
      JSON.stringify({ default: 'ask', wiki_search: 'auto' }),
      'support',
    );
    const pollCalls: Array<{ sessionId: string; requestId: string; action: string }> = [];
    const runtime = createWorkflowRuntime(databasePath);
    runtime.bindPi(createWorkflowSessionBindings({
      db: centralDb,
      stateDir,
      runnerDeps: {
        async createSession() {
          throw new Error('sendMessage remains the only host-owned binding');
        },
      },
      pollForWorkflowActionResult: async ({ sessionId, requestId }) => {
        pollCalls.push({ sessionId, requestId, action: 'tool' });
        return {
          type: 'workflow_action_result',
          request_id: requestId,
          action: 'tool',
          status: 'completed',
          result: {
            runtimeScope: {
              agentGroupId: 'support',
              sessionId,
            },
            params: {
              query: 'policies',
            },
          },
        };
      },
    }));

    runtime.registerDefinition({
      name: 'tool-workflow',
      description: 'Calls ctx.pi.tool',
      *generator(ctx) {
        const result = yield ctx.pi.tool('wiki_search', { query: 'policies' });
        return { result };
      },
    });

    await runtime.start();

    try {
      const started = await runtime.workflowService.startWorkflow({
        id: 'instance-tool-binding',
        name: 'tool-workflow',
        input: null,
        context: {
          trigger: 'tool',
          agent_group_id: 'support',
          thread_id: 'workflow:tool-binding',
        },
      });

      await expect(runtime.workflowService.waitForWorkflow({
        instanceId: started.instanceId,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
      })).resolves.toEqual({
        instanceId: 'instance-tool-binding',
        name: 'tool-workflow',
        status: 'Completed',
        customStatus: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        input: null,
        output: {
          result: {
            runtimeScope: {
              agentGroupId: 'support',
              sessionId: expect.any(String),
            },
            params: {
              query: 'policies',
            },
          },
        },
        error: null,
      });

      const session = centralDb.prepare(
        'SELECT id, session_file FROM sessions WHERE agent_group_id = ? AND thread_id = ?',
      ).get('support', 'workflow:tool-binding') as {
        id: string;
        session_file: string;
      } | null;
      expect(session).not.toBeNull();
      expect(pollCalls).toEqual([{ sessionId: session!.id, requestId: expect.any(String), action: 'tool' }]);

      const inboundDb = openInboundDb(session!.session_file);
      try {
        expect(inboundDb.prepare('SELECT role, content, metadata FROM messages_in ORDER BY seq ASC').all()).toEqual([
          {
            role: 'user',
            content: '',
            metadata: JSON.stringify({
              type: 'workflow_action',
              request_id: pollCalls[0]!.requestId,
              action: 'tool',
              name: 'wiki_search',
              args: { query: 'policies' },
            }),
          },
        ]);
      } finally {
        inboundDb.close();
      }
    } finally {
      await runtime.stop();
    }
  });

  it('routes __pi_tool blocked results through the workflow action contract and surfaces blocked runtime output cleanly', async () => {
    const stateDir = `/tmp/cove-v2-workflows-${crypto.randomUUID()}`;
    const databasePath = `${stateDir}/workflows.db`;
    createdPaths.push(stateDir);

    const centralDb = createCentralDb();
    const pollCalls: Array<{ sessionId: string; requestId: string; action: string }> = [];
    const runtime = createWorkflowRuntime(databasePath);
    runtime.bindPi(createWorkflowSessionBindings({
      db: centralDb,
      stateDir,
      runnerDeps: {
        async createSession() {
          throw new Error('sendMessage remains the only host-owned binding');
        },
      },
      pollForWorkflowActionResult: async ({ sessionId, requestId }) => {
        pollCalls.push({ sessionId, requestId, action: 'tool' });
        return {
          type: 'workflow_action_result',
          request_id: requestId,
          action: 'tool',
          status: 'blocked',
          result: "Tool 'wiki_search' requires confirmation from the user before it can run.",
        };
      },
    }));

    runtime.registerDefinition({
      name: 'tool-approval-workflow',
      description: 'Calls ctx.pi.tool under prompt-tier permissions',
      *generator(ctx) {
        const result = yield ctx.pi.tool('wiki_search', { query: 'policies' });
        return { result };
      },
    });

    await runtime.start();

    try {
      const started = await runtime.workflowService.startWorkflow({
        id: 'instance-tool-approval',
        name: 'tool-approval-workflow',
        input: null,
        context: {
          trigger: 'tool',
          agent_group_id: 'support',
          thread_id: 'workflow:tool-approval',
        },
      });

      await expect(runtime.workflowService.waitForWorkflow({
        instanceId: started.instanceId,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
      })).resolves.toEqual({
        instanceId: 'instance-tool-approval',
        name: 'tool-approval-workflow',
        status: 'Completed',
        customStatus: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        input: null,
        output: {
          result: "Tool 'wiki_search' requires confirmation from the user before it can run.",
        },
        error: null,
      });

      const session = centralDb.prepare(
        'SELECT id, session_file FROM sessions WHERE agent_group_id = ? AND thread_id = ?',
      ).get('support', 'workflow:tool-approval') as {
        id: string;
        session_file: string;
      } | null;
      expect(session).not.toBeNull();
      expect(pollCalls).toEqual([{ sessionId: session!.id, requestId: expect.any(String), action: 'tool' }]);

      const inboundDb = openInboundDb(session!.session_file);
      try {
        expect(inboundDb.prepare('SELECT role, content, metadata FROM messages_in ORDER BY seq ASC').all()).toEqual([
          {
            role: 'user',
            content: '',
            metadata: JSON.stringify({
              type: 'workflow_action',
              request_id: pollCalls[0]!.requestId,
              action: 'tool',
              name: 'wiki_search',
              args: { query: 'policies' },
            }),
          },
        ]);
      } finally {
        inboundDb.close();
      }
    } finally {
      await runtime.stop();
    }
  });

  it('routes __pi_llm through workflow action metadata with workflow model overrides', async () => {
    const stateDir = `/tmp/cove-v2-workflows-${crypto.randomUUID()}`;
    const databasePath = `${stateDir}/workflows.db`;
    createdPaths.push(stateDir);

    const centralDb = createCentralDb();
    const pollCalls: Array<{ sessionId: string; requestId: string; action: string }> = [];
    const runtime = createWorkflowRuntime(databasePath);
    runtime.bindPi(createWorkflowSessionBindings({
      db: centralDb,
      stateDir,
      runnerDeps: {
        async createSession() {
          throw new Error('sendMessage remains the only host-owned binding');
        },
      },
      pollForWorkflowActionResult: async ({ sessionId, requestId }) => {
        pollCalls.push({ sessionId, requestId, action: 'llm' });
        return {
          type: 'workflow_action_result',
          request_id: requestId,
          action: 'llm',
          status: 'completed',
          result: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Host LLM response' }],
            api: 'anthropic-messages',
            provider: 'anthropic',
            model: 'workflow-llm-model',
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: 'stop',
          },
        };
      },
    }));

    runtime.registerDefinition({
      name: 'llm-workflow',
      description: 'Calls ctx.pi.llm',
      *generator(ctx) {
        const response = yield ctx.pi.llm([
          { role: 'user', content: 'Summarise the escalations' },
        ], {
          model: 'workflow-llm-model',
          tools: [{ name: 'per-call-tool', description: 'should stay inert' }],
        });
        return { response };
      },
    });

    await runtime.start();

    try {
      const started = await runtime.workflowService.startWorkflow({
        id: 'instance-llm-binding',
        name: 'llm-workflow',
        input: null,
        context: {
          trigger: 'api',
          agent_group_id: 'support',
          thread_id: 'workflow:llm-binding',
        },
      });

      await expect(runtime.workflowService.waitForWorkflow({
        instanceId: started.instanceId,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
      })).resolves.toEqual({
        instanceId: 'instance-llm-binding',
        name: 'llm-workflow',
        status: 'Completed',
        customStatus: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        input: null,
        output: {
          response: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Host LLM response' }],
            api: 'anthropic-messages',
            provider: 'anthropic',
            model: 'workflow-llm-model',
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: 'stop',
          },
        },
        error: null,
      });

      const session = centralDb.prepare(
        'SELECT id, session_file FROM sessions WHERE agent_group_id = ? AND thread_id = ?',
      ).get('support', 'workflow:llm-binding') as {
        id: string;
        session_file: string;
      } | null;
      expect(session).not.toBeNull();
      expect(pollCalls).toEqual([{ sessionId: session!.id, requestId: expect.any(String), action: 'llm' }]);

      const inboundDb = openInboundDb(session!.session_file);
      try {
        const configRow = inboundDb.prepare('SELECT model FROM session_config').get() as { model: string } | null;
        expect(configRow?.model).toBe('workflow-llm-model');
        expect(inboundDb.prepare('SELECT role, content, metadata FROM messages_in ORDER BY seq ASC').all()).toEqual([
          {
            role: 'user',
            content: '',
            metadata: JSON.stringify({
              type: 'workflow_action',
              request_id: pollCalls[0]!.requestId,
              action: 'llm',
              messages: [{ role: 'user', content: 'Summarise the escalations' }],
            }),
          },
        ]);
      } finally {
        inboundDb.close();
      }
    } finally {
      await runtime.stop();
    }
  });

  it('keeps llm per-call tools inert and out of workflow action metadata', async () => {
    const stateDir = `/tmp/cove-v2-workflows-${crypto.randomUUID()}`;
    const databasePath = `${stateDir}/workflows.db`;
    createdPaths.push(stateDir);

    const centralDb = createCentralDb();
    const runtime = createWorkflowRuntime(databasePath);
    runtime.bindPi(createWorkflowSessionBindings({
      db: centralDb,
      stateDir,
      pollForWorkflowActionResult: async ({ requestId }) => ({
        type: 'workflow_action_result',
        request_id: requestId,
        action: 'llm',
        status: 'completed',
        result: {
          role: 'assistant',
          content: [{ type: 'text', text: 'No tools wired' }],
          api: 'anthropic-messages',
          provider: 'anthropic',
          model: 'workflow-llm-model',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: 'stop',
        },
      }),
    }));

    runtime.registerDefinition({
      name: 'llm-tools-inert-workflow',
      description: 'Calls ctx.pi.llm with per-call tools that must stay inert',
      *generator(ctx) {
        const response = yield ctx.pi.llm([
          { role: 'user', content: 'Summarise the escalations' },
        ], {
          model: 'workflow-llm-model',
          tools: [
            { name: 'per-call-tool', description: 'should stay inert' },
            { name: 'another-tool', description: 'still inert' },
          ],
        });
        return { response };
      },
    });

    await runtime.start();

    try {
      const started = await runtime.workflowService.startWorkflow({
        id: 'instance-llm-tools-inert',
        name: 'llm-tools-inert-workflow',
        input: null,
        context: {
          trigger: 'api',
          agent_group_id: 'support',
          thread_id: 'workflow:llm-tools-inert',
        },
      });

      await expect(runtime.workflowService.waitForWorkflow({
        instanceId: started.instanceId,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
      })).resolves.toMatchObject({
        instanceId: 'instance-llm-tools-inert',
        name: 'llm-tools-inert-workflow',
        status: 'Completed',
        output: {
          response: {
            model: 'workflow-llm-model',
          },
        },
        error: null,
      });

      const session = centralDb.prepare(
        'SELECT session_file FROM sessions WHERE agent_group_id = ? AND thread_id = ?',
      ).get('support', 'workflow:llm-tools-inert') as {
        session_file: string;
      } | null;
      expect(session).not.toBeNull();

      const inboundDb = openInboundDb(session!.session_file);
      try {
        const row = inboundDb.prepare('SELECT metadata FROM messages_in ORDER BY seq ASC').get() as { metadata: string } | null;
        expect(row).not.toBeNull();
        expect(row!.metadata).not.toContain('per-call-tool');
        expect(row!.metadata).not.toContain('another-tool');
        expect(JSON.parse(row!.metadata)).toEqual({
          type: 'workflow_action',
          request_id: expect.any(String),
          action: 'llm',
          messages: [{ role: 'user', content: 'Summarise the escalations' }],
        });
      } finally {
        inboundDb.close();
      }
    } finally {
      await runtime.stop();
    }
  });

  it('fails __pi_llm when the workflow action poller reports blocked', async () => {
    const stateDir = `/tmp/cove-v2-workflows-${crypto.randomUUID()}`;
    const databasePath = `${stateDir}/workflows.db`;
    createdPaths.push(stateDir);

    const centralDb = createCentralDb();
    const runtime = createWorkflowRuntime(databasePath);
    runtime.bindPi(createWorkflowSessionBindings({
      db: centralDb,
      stateDir,
      pollForWorkflowActionResult: async ({ requestId }) => ({
        type: 'workflow_action_result',
        request_id: requestId,
        action: 'llm',
        status: 'blocked',
        result: 'workflow blocked llm',
      }),
    }));

    runtime.registerDefinition({
      name: 'llm-blocked-workflow',
      description: 'Calls ctx.pi.llm when blocked should fail',
      *generator(ctx) {
        const response = yield ctx.pi.llm([{ role: 'user', content: 'Summarise the escalations' }]);
        return { response };
      },
    });

    await runtime.start();

    try {
      const started = await runtime.workflowService.startWorkflow({
        id: 'instance-llm-blocked',
        name: 'llm-blocked-workflow',
        input: null,
        context: {
          trigger: 'api',
          agent_group_id: 'support',
          thread_id: 'workflow:llm-blocked',
        },
      });

      await expect(runtime.workflowService.waitForWorkflow({
        instanceId: started.instanceId,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
      })).resolves.toMatchObject({
        instanceId: 'instance-llm-blocked',
        name: 'llm-blocked-workflow',
        status: 'Failed',
        output: null,
        error: {
          message: 'Workflow LLM action was blocked',
        },
      });
    } finally {
      await runtime.stop();
    }
  });

  it('routes __pi_skill through workflow action metadata with workflow model and skill context', async () => {
    const stateDir = `/tmp/cove-v2-workflows-${crypto.randomUUID()}`;
    const databasePath = `${stateDir}/workflows.db`;
    createdPaths.push(stateDir);

    const centralDb = createCentralDb();
    const pollCalls: Array<{ sessionId: string; requestId: string; action: string }> = [];
    const runtime = createWorkflowRuntime(databasePath);
    runtime.bindPi(createWorkflowSessionBindings({
      db: centralDb,
      stateDir,
      runnerDeps: {
        async createSession() {
          throw new Error('sendMessage remains the only host-owned binding');
        },
      },
      pollForWorkflowActionResult: async ({ sessionId, requestId }) => {
        pollCalls.push({ sessionId, requestId, action: 'skill' });
        return {
          type: 'workflow_action_result',
          request_id: requestId,
          action: 'skill',
          status: 'completed',
          result: 'Skill result text',
        };
      },
    }));

    runtime.registerDefinition({
      name: 'skill-workflow',
      description: 'Calls ctx.pi.skill',
      *generator(ctx) {
        const response = yield ctx.pi.skill('documentation-writer', 'Draft a changelog entry');
        return { response };
      },
    });

    await runtime.start();

    try {
      const started = await runtime.workflowService.startWorkflow({
        id: 'instance-skill-binding',
        name: 'skill-workflow',
        input: null,
        context: {
          trigger: 'api',
          agent_group_id: 'support',
          thread_id: 'workflow:skill-binding',
        },
      });

      await expect(runtime.workflowService.waitForWorkflow({
        instanceId: started.instanceId,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
      })).resolves.toEqual({
        instanceId: 'instance-skill-binding',
        name: 'skill-workflow',
        status: 'Completed',
        customStatus: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        input: null,
        output: {
          response: 'Skill result text',
        },
        error: null,
      });

      const session = centralDb.prepare(
        'SELECT id, session_file FROM sessions WHERE agent_group_id = ? AND thread_id = ?',
      ).get('support', 'workflow:skill-binding') as {
        id: string;
        session_file: string;
      } | null;
      expect(session).not.toBeNull();
      expect(pollCalls).toEqual([{ sessionId: session!.id, requestId: expect.any(String), action: 'skill' }]);

      const inboundDb = openInboundDb(session!.session_file);
      try {
        const configRow = inboundDb.prepare('SELECT model FROM session_config').get() as { model: string } | null;
        expect(configRow?.model).toBe('support-model');
        expect(inboundDb.prepare('SELECT role, content, metadata FROM messages_in ORDER BY seq ASC').all()).toEqual([
          {
            role: 'user',
            content: '',
            metadata: JSON.stringify({
              type: 'workflow_action',
              request_id: pollCalls[0]!.requestId,
              action: 'skill',
              name: 'documentation-writer',
              input: 'Draft a changelog entry',
            }),
          },
        ]);
      } finally {
        inboundDb.close();
      }
    } finally {
      await runtime.stop();
    }
  });

  it('fails __pi_prompt when the workflow action poller reports blocked', async () => {
    const stateDir = `/tmp/cove-v2-workflows-${crypto.randomUUID()}`;
    const databasePath = `${stateDir}/workflows.db`;
    createdPaths.push(stateDir);

    const centralDb = createCentralDb();
    const runtime = createWorkflowRuntime(databasePath);
    runtime.bindPi(createWorkflowSessionBindings({
      db: centralDb,
      stateDir,
      pollForWorkflowActionResult: async ({ requestId }) => ({
        type: 'workflow_action_result',
        request_id: requestId,
        action: 'prompt',
        status: 'blocked',
        result: 'workflow blocked prompt',
      }),
    }));

    runtime.registerDefinition({
      name: 'prompt-blocked-workflow',
      description: 'Calls ctx.pi.prompt when blocked should fail',
      *generator(ctx) {
        const response = yield ctx.pi.prompt('Summarise sales');
        return { response };
      },
    });

    await runtime.start();

    try {
      const started = await runtime.workflowService.startWorkflow({
        id: 'instance-prompt-blocked',
        name: 'prompt-blocked-workflow',
        input: null,
        context: {
          trigger: 'api',
          agent_group_id: 'support',
          thread_id: 'workflow:prompt-blocked',
        },
      });

      await expect(runtime.workflowService.waitForWorkflow({
        instanceId: started.instanceId,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
      })).resolves.toMatchObject({
        instanceId: 'instance-prompt-blocked',
        name: 'prompt-blocked-workflow',
        status: 'Failed',
        output: null,
        error: {
          message: 'Workflow prompt action was blocked',
        },
      });
    } finally {
      await runtime.stop();
    }
  });

  it('fails __pi_skill when the workflow action poller reports blocked', async () => {
    const stateDir = `/tmp/cove-v2-workflows-${crypto.randomUUID()}`;
    const databasePath = `${stateDir}/workflows.db`;
    createdPaths.push(stateDir);

    const centralDb = createCentralDb();
    const runtime = createWorkflowRuntime(databasePath);
    runtime.bindPi(createWorkflowSessionBindings({
      db: centralDb,
      stateDir,
      pollForWorkflowActionResult: async ({ requestId }) => ({
        type: 'workflow_action_result',
        request_id: requestId,
        action: 'skill',
        status: 'blocked',
        result: 'workflow blocked skill',
      }),
    }));

    runtime.registerDefinition({
      name: 'skill-blocked-workflow',
      description: 'Calls ctx.pi.skill when blocked should fail',
      *generator(ctx) {
        const response = yield ctx.pi.skill('documentation-writer', 'Draft a changelog entry');
        return { response };
      },
    });

    await runtime.start();

    try {
      const started = await runtime.workflowService.startWorkflow({
        id: 'instance-skill-blocked',
        name: 'skill-blocked-workflow',
        input: null,
        context: {
          trigger: 'api',
          agent_group_id: 'support',
          thread_id: 'workflow:skill-blocked',
        },
      });

      await expect(runtime.workflowService.waitForWorkflow({
        instanceId: started.instanceId,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
      })).resolves.toMatchObject({
        instanceId: 'instance-skill-blocked',
        name: 'skill-blocked-workflow',
        status: 'Failed',
        output: null,
        error: {
          message: 'Workflow skill action was blocked: documentation-writer',
        },
      });
    } finally {
      await runtime.stop();
    }
  });

  it('surfaces runtime unavailable errors through __pi_llm when workflow runtime preparation cannot start', async () => {
    const stateDir = `/tmp/cove-v2-workflows-${crypto.randomUUID()}`;
    const databasePath = `${stateDir}/workflows.db`;
    createdPaths.push(stateDir);

    const centralDb = createCentralDb();
    const runtime = createWorkflowRuntime(databasePath);
    runtime.bindPi(createWorkflowSessionBindings({
      db: centralDb,
      stateDir,
      ensureSessionRuntime: async () => {
        throw new Error('Container runtime unavailable');
      },
    }));

    runtime.registerDefinition({
      name: 'llm-runtime-unavailable-workflow',
      description: 'Calls ctx.pi.llm when the host runtime is unavailable',
      *generator(ctx) {
        const response = yield ctx.pi.llm([
          { role: 'user', content: 'Summarise the escalations' },
        ]);
        return { response };
      },
    });

    await runtime.start();

    try {
      const started = await runtime.workflowService.startWorkflow({
        id: 'instance-llm-runtime-unavailable',
        name: 'llm-runtime-unavailable-workflow',
        input: null,
        context: {
          trigger: 'api',
          agent_group_id: 'support',
        },
      });

      await expect(runtime.workflowService.waitForWorkflow({
        instanceId: started.instanceId,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
      })).resolves.toEqual({
        instanceId: 'instance-llm-runtime-unavailable',
        name: 'llm-runtime-unavailable-workflow',
        status: 'Failed',
        customStatus: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        input: null,
        output: null,
        error: {
          message: 'Container runtime unavailable',
        },
      });
    } finally {
      await runtime.stop();
    }
  });
});
