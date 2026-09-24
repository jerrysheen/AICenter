import { json, readJson } from '../http/response.js';

export function createStrategyRoutes() {
  return [
    {
      method: 'GET',
      path: '/api/v1/strategies/cn-dividend',
      handler({ response, services }) {
        json(response, 200, { ok: true, snapshot: services.strategy.getLatest('local') });
      },
    },
    {
      method: 'POST',
      path: '/api/v1/strategies/cn-dividend/snapshot',
      access: 'desktop',
      async handler({ request, response, services }) {
        await readJson(request);
        const job = services.runtime.requestDividendSnapshot();
        json(response, 202, { ok: true, job });
      },
    },
  ];
}
