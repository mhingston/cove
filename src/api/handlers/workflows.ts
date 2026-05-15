import type { AppContext } from '../../shared/types.ts';
import type { WorkflowService, WorkflowStartInput, WorkflowStatus } from '../../workflows/bridge.ts';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} is required and must be a string`);
  }

  return value.trim();
}

function parseOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requireString(value, fieldName);
}

function parseRequiredInput(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('input is required and must be an object');
  }

  return value;
}

function isWorkflowStatus(value: string): value is WorkflowStatus {
  return value === 'Pending'
    || value === 'Running'
    || value === 'Completed'
    || value === 'Failed'
    || value === 'Terminated';
}

async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new Error('Invalid JSON body');
  }
}

function getWorkflowService(context: AppContext): WorkflowService {
  if (context.workflowService == null) {
    throw new Error('Workflow runtime is not started');
  }

  return context.workflowService;
}

function mapWorkflowError(error: unknown): Response {
  const message = error instanceof Error ? error.message : 'Workflow request failed';

  if (
    message === 'Invalid JSON body'
    || message === 'name is required and must be a string'
    || message === 'input is required and must be an object'
    || message === 'id is required and must be a string'
    || message === 'agent_group_id is required and must be a string'
    || message === 'thread_id is required and must be a string'
    || message === 'session_id is required and must be a string'
    || message === 'eventName is required and must be a string'
    || message === 'data is required and must be an object'
    || message === 'status must be one of Pending, Running, Completed, Failed, Terminated'
    || message === 'Workflow payload must be a JSON object'
    || message === 'Workflow signal payload must be a JSON object'
  ) {
    return jsonResponse({ error: message }, 400);
  }

  if (
    /^Workflow definition not found: /.test(message)
    || /^Workflow instance not found: /.test(message)
  ) {
    return jsonResponse({ error: 'Not Found' }, 404);
  }

  if (
    /^Workflow instance already exists: /.test(message)
    || /not in a .* state/i.test(message)
    || /invalid lifecycle state/i.test(message)
  ) {
    return jsonResponse({ error: message }, 409);
  }

  if (
    message === 'Workflow runtime is not started'
    || /workflow runtime unavailable/i.test(message)
  ) {
    return jsonResponse({ error: message }, 503);
  }

  return jsonResponse({ error: 'Failed to handle workflow request' }, 500);
}

function parseListFilters(request: Request): { name?: string; status?: WorkflowStatus } {
  const url = new URL(request.url);
  const name = url.searchParams.get('name')?.trim();
  const status = url.searchParams.get('status')?.trim();

  if (status != null && status !== '' && !isWorkflowStatus(status)) {
    throw new Error('status must be one of Pending, Running, Completed, Failed, Terminated');
  }

  return {
    ...(name != null && name !== '' ? { name } : {}),
    ...(status != null && status !== '' ? { status } : {}),
  };
}

function parseCreateBody(body: unknown): WorkflowStartInput {
  if (!isRecord(body)) {
    throw new Error('Workflow payload must be a JSON object');
  }

  return {
    id: parseOptionalString(body.id, 'id'),
    name: requireString(body.name, 'name'),
    input: parseRequiredInput(body.input),
    context: {
      trigger: 'api',
      ...(body.agent_group_id === undefined ? {} : { agent_group_id: requireString(body.agent_group_id, 'agent_group_id') }),
      ...(body.thread_id === undefined ? {} : { thread_id: requireString(body.thread_id, 'thread_id') }),
      ...(body.session_id === undefined ? {} : { session_id: requireString(body.session_id, 'session_id') }),
    },
  };
}

function normalizeCreateInput(input: WorkflowStartInput): WorkflowStartInput {
  const instanceId = input.id ?? crypto.randomUUID();
  const agentGroupId = input.context?.agent_group_id ?? 'default';
  const sessionId = input.context?.session_id;
  const threadId = sessionId == null
    ? (input.context?.thread_id ?? `workflow:${instanceId}`)
    : undefined;

  return {
    id: instanceId,
    name: input.name,
    input: input.input,
    context: {
      trigger: 'api',
      agent_group_id: agentGroupId,
      ...(sessionId == null ? { ...(threadId == null ? {} : { thread_id: threadId }) } : { session_id: sessionId }),
    },
  };
}

function parseSignalBody(body: unknown): { eventName: string; data: Record<string, unknown> } {
  if (!isRecord(body)) {
    throw new Error('Workflow signal payload must be a JSON object');
  }

  if (!isRecord(body.data)) {
    throw new Error('data is required and must be an object');
  }

  return {
    eventName: requireString(body.eventName, 'eventName'),
    data: body.data,
  };
}

export async function handleListWorkflows(request: Request, context: AppContext): Promise<Response> {
  try {
    const workflowService = getWorkflowService(context);
    const filters = parseListFilters(request);
    const nameFilter = filters.name == null ? {} : { name: filters.name };

    return jsonResponse({
      definitions: await workflowService.listDefinitions(nameFilter),
      instances: await workflowService.listInstances(filters),
    }, 200);
  } catch (error) {
    return mapWorkflowError(error);
  }
}

export async function handleCreateWorkflow(request: Request, context: AppContext): Promise<Response> {
  try {
    const workflowService = getWorkflowService(context);
    const input = normalizeCreateInput(parseCreateBody(await parseJsonBody(request)));
    const started = await workflowService.startWorkflow(input);
    return jsonResponse(started, 201);
  } catch (error) {
    return mapWorkflowError(error);
  }
}

export async function handleGetWorkflow(_request: Request, context: AppContext, params: { instanceId: string }): Promise<Response> {
  try {
    const workflowService = getWorkflowService(context);
    const workflow = await workflowService.getWorkflow({ instanceId: params.instanceId });

    if (workflow == null) {
      return jsonResponse({ error: 'Not Found' }, 404);
    }

    return jsonResponse({
      instanceId: workflow.instanceId,
      name: workflow.name,
      status: workflow.status,
      output: workflow.output,
      customStatus: workflow.customStatus,
      createdAt: workflow.createdAt,
      updatedAt: workflow.updatedAt,
    }, 200);
  } catch (error) {
    return mapWorkflowError(error);
  }
}

export async function handleSignalWorkflow(request: Request, context: AppContext, params: { instanceId: string }): Promise<Response> {
  try {
    const workflowService = getWorkflowService(context);
    const signal = parseSignalBody(await parseJsonBody(request));
    await workflowService.signalWorkflow({
      instanceId: params.instanceId,
      eventName: signal.eventName,
      data: signal.data,
    });
    return jsonResponse({ signalled: true }, 200);
  } catch (error) {
    return mapWorkflowError(error);
  }
}

export async function handleTerminateWorkflow(_request: Request, context: AppContext, params: { instanceId: string }): Promise<Response> {
  try {
    const workflowService = getWorkflowService(context);
    await workflowService.terminateWorkflow({ instanceId: params.instanceId });
    return jsonResponse({ terminated: true }, 200);
  } catch (error) {
    return mapWorkflowError(error);
  }
}
