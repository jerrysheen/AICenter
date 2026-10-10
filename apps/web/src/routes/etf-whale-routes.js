import { json } from '../http/response.js';

export function createEtfWhaleRoutes() {
  return [
    {
      method: 'GET',
      path: '/api/v1/etf-whale/overview',
      access: 'desktop',
      handler({ response, services }) {
        json(response, 200, { ok: true, overview: services.etfWhale.overview() });
      },
    },
    {
      method: 'GET',
      path: /^\/api\/v1\/etf-whale\/etfs\/(\d{6})$/,
      access: 'desktop',
      handler({ response, services, params }) {
        json(response, 200, { ok: true, series: services.etfWhale.series(params[0]) });
      },
    },
  ];
}
