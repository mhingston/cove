import { routeApiRequest } from './server.ts';
import type { AppContext } from '../shared/types.ts';

export function createApp(context: AppContext): {
  fetch(request: Request): Response | Promise<Response>;
} {
  return {
    fetch(request: Request): Response | Promise<Response> {
      return routeApiRequest(request, context);
    },
  };
}
