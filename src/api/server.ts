import type { Database } from 'bun:sqlite';

import { handleHealth } from './handlers/health.ts';
import { handleModels } from './handlers/models.ts';
import type { ApiServer } from '../shared/types.ts';
import type { AppContext } from '../shared/types.ts';

type ApiRoute = {
  method: string;
  pathname: RegExp;
  handle(request: Request, context: AppContext): Response | Promise<Response>;
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
  const route = apiRoutes.find(
    ({ method, pathname }) => request.method === method && pathname.test(url.pathname),
  );

  if (route) {
    return route.handle(request, context);
  }

  return Response.json({ error: 'Not Found' }, { status: 404 });
}

export function startApiServer(options: { db: Database; port?: number }): ApiServer {
  const requestedPort = options.port ?? resolvePort();
  const hostname = '127.0.0.1';
  const context = { db: options.db };

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
