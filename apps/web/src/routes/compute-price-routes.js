import { json } from '../http/response.js';

const workspace = (identity) => identity?.device?.workspaceId || 'local';

export function createComputePriceRoutes() {
  return [
    {
      method: 'GET',
      path: '/api/v1/compute-prices',
      handler({ response, services, identity }) {
        if (!services.computePrices) {
          json(response, 503, { ok: false, error: '算力价格尚未就绪' });
          return;
        }
        json(response, 200, { ok: true, ...services.computePrices.list(workspace(identity)) });
      },
    },
    {
      method: 'GET',
      path: '/api/v1/compute-prices/history',
      handler({ response, services, identity, url }) {
        if (!services.computePrices) {
          json(response, 503, { ok: false, error: '算力价格尚未就绪' });
          return;
        }
        json(response, 200, { ok: true, ...services.computePrices.history(workspace(identity), {
          start: url.searchParams.get('start') || '',
          end: url.searchParams.get('end') || '',
          models: url.searchParams.get('models') || undefined,
          tiers: url.searchParams.get('tiers') || undefined,
          sources: url.searchParams.get('sources') || undefined,
          grain: url.searchParams.get('grain') || undefined,
        }) });
      },
    },
  ];
}
