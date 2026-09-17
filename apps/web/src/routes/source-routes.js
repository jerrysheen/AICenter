import { json } from '../http/response.js';

export function createSourceRoutes() {
  return [
    {
      method: 'GET', path: '/api/v1/sources',
      handler({ response, services }) {
        json(response, 200, { ok: true, sources: services.sources.list() });
      },
    },
    {
      method: 'GET', path: /^\/api\/v1\/sources\/([a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+)$/,
      async handler({ response, services, params, url }) {
        const sourceId = params.values[0];
        const input = Object.fromEntries(url.searchParams.entries());
        const refresh = input.refresh === '1' || input.refresh === 'true';
        delete input.refresh;
        const snapshot = await services.sources.read(sourceId, input, { refresh });
        json(response, 200, { ok: true, source: services.sources.describe(sourceId), snapshot });
      },
    },
  ];
}
