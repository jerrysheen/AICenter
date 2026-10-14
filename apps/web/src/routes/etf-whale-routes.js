import { json } from '../http/response.js';

export function createEtfWhaleRoutes() {
  return [
    {
      method: 'GET',
      path: '/api/v1/etf-whale/overview',
      handler({ response, services }) {
        json(response, 200, { ok: true, overview: services.etfWhale.overview() });
      },
    },
    {
      method: 'GET',
      path: /^\/api\/v1\/etf-whale\/etfs\/(\d{6})$/,
      handler({ response, services, params }) {
        json(response, 200, { ok: true, series: services.etfWhale.series(params.values[0]) });
      },
    },
  ];
}
