import type { ScheduleRecord } from '../jobs/schedules.ts';

export type WorkflowStatus = 'Pending' | 'Running' | 'Completed' | 'Failed' | 'Terminated';

export type WorkflowDefinition = {
  name: string;
  description: string | null;
};

export type WorkflowInstanceError = {
  message: string;
  [key: string]: unknown;
} | null;

export type WorkflowInstance = {
  instanceId: string;
  name: string;
  status: WorkflowStatus;
  output: unknown;
  customStatus: string | null;
  createdAt: string;
  updatedAt: string;
  input: Record<string, unknown> | null;
  error: WorkflowInstanceError;
};

export type WorkflowExecutionContext = {
  trigger: 'api' | 'schedule' | 'tool';
  schedule_id?: string;
  agent_group_id?: string;
  session_id?: string;
  thread_id?: string;
  [key: string]: unknown;
};

export type WorkflowListInstancesOptions = {
  name?: string;
  status?: WorkflowStatus;
};

export type WorkflowStartInput = {
  id?: string;
  name: string;
  input?: Record<string, unknown> | null;
  context?: WorkflowExecutionContext;
};

export type WorkflowSignalInput = {
  instanceId: string;
  eventName: string;
  data?: Record<string, unknown> | null;
};

export type WorkflowTerminateInput = {
  instanceId: string;
};

export type WorkflowWaitInput = {
  instanceId: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
};

export type WorkflowStartResult = {
  instanceId: string;
};

type WorkflowRuntimeEnvelope = {
  __cove: {
    context: WorkflowExecutionContext;
  };
  input: Record<string, unknown> | null;
};

type WorkflowStartEnvelope = WorkflowStartInput & {
  input?: WorkflowRuntimeEnvelope;
};

export type WorkflowService = {
  listDefinitions(options?: { name?: string }): Promise<WorkflowDefinition[]>;
  listInstances(options?: WorkflowListInstancesOptions): Promise<WorkflowInstance[]>;
  startWorkflow(input: WorkflowStartInput): Promise<WorkflowStartResult>;
  getWorkflow(input: { instanceId: string }): Promise<WorkflowInstance | null>;
  signalWorkflow(input: WorkflowSignalInput): Promise<void>;
  terminateWorkflow(input: WorkflowTerminateInput): Promise<void>;
  waitForWorkflow(input: WorkflowWaitInput): Promise<WorkflowInstance>;
  startScheduledWorkflow(input: {
    schedule: ScheduleRecord;
    input: Record<string, unknown> | null;
  }): Promise<WorkflowStartResult>;
  rollbackWorkflow(input: { instanceId: string }): Promise<void>;
};

type RawWorkflowDefinition = {
  name: string;
  description?: string | null;
};

type RawWorkflowInstance = {
  id?: string;
  instanceId?: string;
  name: string;
  status: WorkflowStatus;
  createdAt?: string;
  updatedAt?: string;
  customStatus?: string | null;
  input?: Record<string, unknown> | null;
  output?: unknown;
  error?: unknown;
  raw?: unknown;
};

type WorkflowServiceBackend = {
  listDefinitions(options?: { name?: string }): Promise<RawWorkflowDefinition[]>;
  listInstances(options?: WorkflowListInstancesOptions): Promise<RawWorkflowInstance[]>;
  startWorkflow(input: WorkflowStartEnvelope): Promise<WorkflowStartResult>;
  getWorkflow(input: { instanceId: string }): Promise<RawWorkflowInstance | null>;
  signalWorkflow(input: WorkflowSignalInput): Promise<void>;
  terminateWorkflow(input: WorkflowTerminateInput): Promise<void>;
  waitForWorkflow(input: WorkflowWaitInput): Promise<RawWorkflowInstance>;
  rollbackWorkflow(input: { instanceId: string }): Promise<void>;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function cloneRecord(value: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!isPlainObject(value)) {
    return value == null ? null : null;
  }

  return { ...value };
}

function isWorkflowRuntimeEnvelope(value: unknown): value is WorkflowRuntimeEnvelope {
  return isPlainObject(value)
    && isPlainObject(value.__cove)
    && isPlainObject(value.__cove.context)
    && typeof value.__cove.context.trigger === 'string'
    && 'input' in value;
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Workflow instance is missing required field: ${fieldName}`);
  }

  return value;
}

export function stripWorkflowInternalEnvelope(value: unknown): unknown {
  if (isWorkflowRuntimeEnvelope(value)) {
    return value.input ?? null;
  }

  return value;
}

function mapWorkflowError(error: unknown): WorkflowInstanceError {
  if (error == null) {
    return null;
  }

  if (error instanceof Error) {
    return { message: error.message };
  }

  if (isPlainObject(error)) {
    const message = typeof error.message === 'string' ? error.message : 'Workflow failed';
    return {
      ...error,
      message,
    };
  }

  return { message: String(error) };
}

export function mapWorkflowDefinitionDto(definition: RawWorkflowDefinition): WorkflowDefinition {
  return {
    name: definition.name,
    description: definition.description ?? null,
  };
}

export function mapWorkflowInstanceDto(instance: RawWorkflowInstance): WorkflowInstance {
  return {
    instanceId: requireString(instance.instanceId ?? instance.id, 'instanceId'),
    name: instance.name,
    status: instance.status,
    output: stripWorkflowInternalEnvelope(instance.output),
    customStatus: instance.customStatus ?? null,
    createdAt: requireString(instance.createdAt, 'createdAt'),
    updatedAt: requireString(instance.updatedAt ?? instance.createdAt, 'updatedAt'),
    input: cloneRecord(stripWorkflowInternalEnvelope(instance.input) as Record<string, unknown> | null),
    error: mapWorkflowError(instance.error),
  };
}

export function resolveScheduledWorkflowName(schedule: ScheduleRecord): string {
  const config = schedule.config;
  const name = isPlainObject(config) && typeof config.name === 'string' && config.name.trim() !== ''
    ? config.name.trim()
    : isPlainObject(config) && typeof config.workflow === 'string' && config.workflow.trim() !== ''
      ? config.workflow.trim()
      : null;

  if (name == null) {
    throw new Error('Workflow schedule config.name or config.workflow is required');
  }

  return name;
}

export function withWorkflowExecutionContextEnvelope(options: {
  input: Record<string, unknown> | null | undefined;
  context: WorkflowExecutionContext;
}): WorkflowRuntimeEnvelope {
  return {
    __cove: {
      context: {
        ...options.context,
      },
    },
    input: cloneRecord(options.input) ?? null,
  };
}

export function createWorkflowService(backend: WorkflowServiceBackend): WorkflowService {
  return {
    async listDefinitions(options) {
      return (await backend.listDefinitions(options)).map(mapWorkflowDefinitionDto);
    },
    async listInstances(options) {
      return (await backend.listInstances(options)).map(mapWorkflowInstanceDto);
    },
    async startWorkflow(input) {
      const { context, ...rest } = input;

      return await backend.startWorkflow({
        ...rest,
        input: withWorkflowExecutionContextEnvelope({
          input: input.input,
          context: input.context ?? { trigger: 'api' },
        }),
      });
    },
    async getWorkflow(input) {
      const workflow = await backend.getWorkflow(input);
      return workflow == null ? null : mapWorkflowInstanceDto(workflow);
    },
    async signalWorkflow(input) {
      await backend.signalWorkflow(input);
    },
    async terminateWorkflow(input) {
      await backend.terminateWorkflow(input);
    },
    async waitForWorkflow(input) {
      return mapWorkflowInstanceDto(await backend.waitForWorkflow(input));
    },
    async startScheduledWorkflow(input) {
      return await backend.startWorkflow({
        name: resolveScheduledWorkflowName(input.schedule),
        input: withWorkflowExecutionContextEnvelope({
          input: input.input,
          context: {
            trigger: 'schedule',
            schedule_id: input.schedule.id,
            agent_group_id: input.schedule.agent_group_id,
            thread_id: `schedule:${input.schedule.id}`,
          },
        }),
      });
    },
    async rollbackWorkflow(input) {
      await backend.rollbackWorkflow(input);
    },
  };
}
