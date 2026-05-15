import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_POLL_INTERVAL_MS = 250;

type WorkflowBridgeRuntimeOptions = {
  workflowApiBaseUrl?: string;
  agentGroupId?: string;
  sessionId?: string;
};

type WorkflowBridgeRequestOptions = {
  runtime?: WorkflowBridgeRuntimeOptions;
  fetchImpl?: typeof fetch;
};

type WorkflowInstance = {
  instanceId: string;
  name: string;
  status: 'Pending' | 'Running' | 'Completed' | 'Failed' | 'Terminated';
  output: unknown;
  customStatus: string | null;
  createdAt: string;
  updatedAt: string;
};

type WorkflowListResponse = {
  definitions: Array<{ name: string; description: string | null }>;
  instances: WorkflowInstance[];
};

type WorkflowWaitResult = WorkflowInstance & {
  timed_out?: true;
};

function resolveWorkflowApiBaseUrl(runtime?: WorkflowBridgeRuntimeOptions): string {
  const candidate = runtime?.workflowApiBaseUrl ?? process.env.COVE_WORKFLOW_API_BASE_URL;
  const trimmed = candidate?.trim();

  if (!trimmed) {
    throw new Error('COVE_WORKFLOW_API_BASE_URL is required for workflow bridge tools');
  }

  return trimmed.replace(/\/$/u, '');
}

function isTerminalStatus(status: WorkflowInstance['status']): boolean {
  return status === 'Completed' || status === 'Failed' || status === 'Terminated';
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function requestJson<T>(
  pathname: string,
  init: RequestInit | undefined,
  options: WorkflowBridgeRequestOptions,
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${resolveWorkflowApiBaseUrl(options.runtime)}${pathname}`;
  const response = await fetchImpl(url, init);
  const body = await parseJson(response);

  if (!response.ok) {
    const error = body != null && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? body.error
      : `Workflow bridge request failed: ${response.status}`;
    throw new Error(error);
  }

  return body as T;
}

export function createWorkflowBridge(options: WorkflowBridgeRequestOptions = {}) {
  return {
    async startWorkflow(input: {
      name: string;
      input: Record<string, unknown>;
      id?: string;
    }): Promise<{ instanceId: string }> {
      return await requestJson<{ instanceId: string }>(
        '/v1/workflows',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...('id' in input && input.id != null ? { id: input.id } : {}),
            name: input.name,
            input: input.input,
            ...(options.runtime?.agentGroupId == null ? {} : { agent_group_id: options.runtime.agentGroupId }),
            ...(options.runtime?.sessionId == null ? {} : { session_id: options.runtime.sessionId }),
          }),
        },
        options,
      );
    },
    async getWorkflow(instanceId: string): Promise<WorkflowInstance> {
      return await requestJson<WorkflowInstance>(`/v1/workflows/${encodeURIComponent(instanceId)}`, undefined, options);
    },
    async listWorkflows(filters: {
      name?: string;
      status?: WorkflowInstance['status'];
    } = {}): Promise<WorkflowListResponse> {
      const query = new URLSearchParams();

      if (filters.name != null) {
        query.set('name', filters.name);
      }

      if (filters.status != null) {
        query.set('status', filters.status);
      }

      const suffix = query.size === 0 ? '' : `?${query.toString()}`;
      return await requestJson<WorkflowListResponse>(`/v1/workflows${suffix}`, undefined, options);
    },
    async signalWorkflow(input: {
      instanceId: string;
      eventName: string;
      data: Record<string, unknown>;
    }): Promise<{ signalled: true }> {
      return await requestJson<{ signalled: true }>(
        `/v1/workflows/${encodeURIComponent(input.instanceId)}/signal`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ eventName: input.eventName, data: input.data }),
        },
        options,
      );
    },
    async waitForWorkflow(input: {
      instanceId: string;
      timeoutMs?: number;
      pollIntervalMs?: number;
    }): Promise<WorkflowWaitResult> {
      const timeoutMs = input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
      const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_WAIT_POLL_INTERVAL_MS;
      const deadline = Date.now() + timeoutMs;
      let latest: WorkflowInstance | null = null;

      while (true) {
        latest = await requestJson<WorkflowInstance>(
          `/v1/workflows/${encodeURIComponent(input.instanceId)}`,
          undefined,
          options,
        );

        if (isTerminalStatus(latest.status)) {
          return latest;
        }

        if (Date.now() >= deadline) {
          return {
            ...latest,
            timed_out: true,
          };
        }

        await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
      }
    },
  };
}

export type WorkflowBridge = ReturnType<typeof createWorkflowBridge>;
