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
  ];
}
