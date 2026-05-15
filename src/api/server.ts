import type { Database } from 'bun:sqlite';

import { handleHealth } from './handlers/health.ts';
import {
  handleApproveApproval,
  handleCreateApproval,
  handleDeclineApproval,
  handleGetApproval,
  handleListApprovals,
} from './handlers/approvals.ts';
import { handleChatCompletion } from './handlers/chat.ts';
import { handleModels } from './handlers/models.ts';
import {
  handleCreateSchedule,
  handleDeleteSchedule,
  handleGetSchedule,
  handleListSchedules,
  handleRunSchedule,
  handleUpdateSchedule,
} from './handlers/schedules.ts';
import {
  handleCreateWorkflow,
  handleGetWorkflow,
  handleListWorkflows,
  handleSignalWorkflow,
  handleTerminateWorkflow,
} from './handlers/workflows.ts';
import {
  handleCreateWiki,
  handleDeleteWiki,
  handleGetWiki,
  handleListOrSearchWiki,
  handleUpdateWiki,
} from './handlers/wiki.ts';
import { completeStreamRelay, failStreamRelay, pushStreamRelayChunk } from '../stream-relay.ts';
import type { ApiServer } from '../shared/types.ts';
import type { AppContext } from '../shared/types.ts';
import type { ChatHandlerContext } from '../shared/types.ts';
import type { ScheduleRollbackWorkflow } from '../shared/types.ts';
import type { ScheduleStartWorkflow } from '../shared/types.ts';

type ApiRoute = {
  method: string;
  pathname: RegExp;
  handle(request: Request, context: AppContext, match: RegExpMatchArray): Response | Promise<Response>;
};

const apiRoutes: ApiRoute[] = [
  {
    method: 'GET',
    pathname: /^\/healthz$/,
    handle() {
      return handleHealth();
    },
  },
  {
    method: 'GET',
    pathname: /^\/v1\/models$/,
    handle(_request, context) {
      return handleModels(context);
    },
  },
  {
    method: 'POST',
    pathname: /^\/v1\/chat\/completions$/,
    handle(request, context) {
      return handleChatCompletion(request, context);
    },
  },
  {
    method: 'POST',
    pathname: /^\/v1\/approvals$/,
    handle(request, context) {
      return handleCreateApproval(request, context.db);
    },
  },
  {
    method: 'GET',
    pathname: /^\/v1\/approvals$/,
    handle(request, context) {
      return handleListApprovals(request, context.db);
    },
  },
  {
    method: 'POST',
    pathname: /^\/v1\/schedules$/,
    handle(request, context) {
      return handleCreateSchedule(request, context.db);
    },
  },
  {
    method: 'GET',
    pathname: /^\/v1\/schedules$/,
    handle(request, context) {
      return handleListSchedules(request, context.db);
    },
  },
  {
    method: 'GET',
    pathname: /^\/v1\/schedules\/([^/]+)$/,
    handle(request, context, match) {
      return handleGetSchedule(request, context.db, { id: match[1] });
    },
  },
  {
    method: 'PUT',
    pathname: /^\/v1\/schedules\/([^/]+)$/,
    handle(request, context, match) {
      return handleUpdateSchedule(request, context.db, { id: match[1] });
    },
  },
  {
    method: 'DELETE',
    pathname: /^\/v1\/schedules\/([^/]+)$/,
    handle(request, context, match) {
      return handleDeleteSchedule(request, context.db, { id: match[1] });
    },
  },
  {
    method: 'POST',
    pathname: /^\/v1\/schedules\/([^/]+)\/run$/,
    handle(request, context, match) {
      return handleRunSchedule(request, context, { id: match[1] });
    },
  },
  {
    method: 'GET',
    pathname: /^\/v1\/workflows$/,
    handle(request, context) {
      return handleListWorkflows(request, context);
    },
  },
  {
    method: 'POST',
    pathname: /^\/v1\/workflows$/,
    handle(request, context) {
      return handleCreateWorkflow(request, context);
    },
  },
  {
    method: 'GET',
    pathname: /^\/v1\/workflows\/([^/]+)$/,
    handle(request, context, match) {
      return handleGetWorkflow(request, context, { instanceId: match[1] });
    },
  },
  {
    method: 'POST',
    pathname: /^\/v1\/workflows\/([^/]+)\/signal$/,
    handle(request, context, match) {
      return handleSignalWorkflow(request, context, { instanceId: match[1] });
    },
  },
  {
    method: 'POST',
    pathname: /^\/v1\/workflows\/([^/]+)\/terminate$/,
    handle(request, context, match) {
      return handleTerminateWorkflow(request, context, { instanceId: match[1] });
    },
  },
  {
    method: 'POST',
    pathname: /^\/v1\/wiki$/,
    handle(request, context) {
      return handleCreateWiki(request, context.db);
    },
  },
  {
    method: 'GET',
    pathname: /^\/v1\/wiki$/,
    handle(request, context) {
      return handleListOrSearchWiki(request, context.db);
    },
  },
  {
    method: 'GET',
    pathname: /^\/v1\/wiki\/search$/,
    handle(request, context) {
      return handleListOrSearchWiki(request, context.db);
    },
  },
  {
    method: 'GET',
    pathname: /^\/v1\/wiki\/([^/]+)$/,
    handle(request, context, match) {
      return handleGetWiki(request, context.db, { slug: match[1] });
    },
  },
  {
    method: 'PUT',
    pathname: /^\/v1\/wiki\/([^/]+)$/,
    handle(request, context, match) {
      return handleUpdateWiki(request, context.db, { slug: match[1] });
    },
  },
  {
    method: 'DELETE',
    pathname: /^\/v1\/wiki\/([^/]+)$/,
    handle(request, context, match) {
      return handleDeleteWiki(request, context.db, { slug: match[1] });
    },
  },
  {
    method: 'GET',
    pathname: /^\/v1\/approvals\/([^/]+)$/,
    handle(request, context, match) {
      return handleGetApproval(request, context.db, { id: match[1] });
    },
  },
  {
    method: 'POST',
    pathname: /^\/v1\/approvals\/([^/]+)\/approve$/,
    handle(request, context, match) {
      return handleApproveApproval(request, context.db, { id: match[1] });
    },
  },
  {
    method: 'POST',
    pathname: /^\/v1\/approvals\/([^/]+)\/decline$/,
    handle(request, context, match) {
      return handleDeclineApproval(request, context.db, { id: match[1] });
    },
  },
  {
    method: 'POST',
    pathname: /^\/internal\/streams\/([^/]+)\/chunk$/,
    async handle(request, _context, match) {
      const relayId = match[1];
      const body = await request.json() as { token?: string };

      if (typeof relayId !== 'string' || typeof body.token !== 'string') {
        return Response.json({ error: 'Invalid relay chunk payload' }, { status: 400 });
      }

      return new Response(null, { status: pushStreamRelayChunk(relayId, body.token) ? 204 : 404 });
    },
  },
  {
    method: 'POST',
    pathname: /^\/internal\/streams\/([^/]+)\/complete$/,
    handle(_request, _context, match) {
      const relayId = match[1];
      return new Response(null, { status: completeStreamRelay(relayId) ? 204 : 404 });
    },
  },
  {
    method: 'POST',
    pathname: /^\/internal\/streams\/([^/]+)\/error$/,
    async handle(request, _context, match) {
      const relayId = match[1];
      const body = await request.json() as { error?: string };
      return new Response(null, {
        status: failStreamRelay(relayId, new Error(body.error ?? 'Stream relay failed')) ? 204 : 404,
      });
    },
  },
];

export function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  for (const candidate of [env.PORT, env.COVE_PORT, '4111']) {
    if (candidate == null) {
      continue;
    }

    const value = candidate.trim();

    if (!/^\d+$/.test(value)) {
      continue;
    }

    const parsed = Number(value);

    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
      return parsed;
    }
  }

  return 4111;
}

export function routeApiRequest(
  request: Request,
  context: AppContext,
): Response | Promise<Response> {
  const url = new URL(request.url);
  const route = apiRoutes.find(({ method, pathname }) => request.method === method && pathname.test(url.pathname));

  if (route) {
    const match = url.pathname.match(route.pathname);

    if (match) {
      return route.handle(request, context, match);
    }
  }

  return Response.json({ error: 'Not Found' }, { status: 404 });
}

export function startApiServer(options: {
  db: Database;
  port?: number;
  chat?: ChatHandlerContext;
  startWorkflow?: ScheduleStartWorkflow;
  rollbackWorkflow?: ScheduleRollbackWorkflow;
  workflowService?: AppContext['workflowService'];
}): ApiServer {
  const requestedPort = options.port ?? resolvePort();
  const hostname = '127.0.0.1';
  const context: AppContext = {
    db: options.db,
    chat: options.chat,
    startWorkflow: options.startWorkflow,
    rollbackWorkflow: options.rollbackWorkflow,
    workflowService: options.workflowService,
  };

  const server = Bun.serve({
    hostname,
    port: requestedPort,
    fetch(request) {
      return routeApiRequest(request, context);
    },
  });

  return {
    hostname,
    port: server.port ?? requestedPort,
    async stop() {
      await server.stop(true);
    },
  };
}
