import { ETF_WHALE_DISCLAIMER } from '../../../../packages/domain/src/etf-whale/score.js';
import { json } from '../http/response.js';

function writeSeries(response, series) {
  if (!series) {
    json(response, 404, { ok: false, error: 'not_in_universe', disclaimer: ETF_WHALE_DISCLAIMER });
    return;
  }
  json(response, 200, { ok: true, disclaimer: ETF_WHALE_DISCLAIMER, series });
}

export function createEtfWhaleRoutes() {
  return [
    {
      method: 'GET',
      path: '/api/v1/etf-whale/overview',
      handler({ response, services }) {
        const overview = services.etfWhale.overview();
        json(response, 200, { ok: true, disclaimer: overview.disclaimer || ETF_WHALE_DISCLAIMER, overview });
      },
    },
    {
      method: 'GET',
      path: /^\/api\/v1\/etf-whale\/etfs\/([^/]+)$/,
      handler({ response, services, params }) {
        writeSeries(response, services.etfWhale.series(params.values[0]));
      },
    },
    {
      method: 'GET',
      path: '/api/v1/etf-whale/series',
      handler({ response, services, url }) {
        writeSeries(response, services.etfWhale.series(url.searchParams?.get('code') ?? ''));
      },
    },
    {
      method: 'GET',
      path: '/api/v1/etf-whale/daily',
      handler({ response, services, url }) {
        const date = url.searchParams?.get('date') || '';
        json(response, 200, {
          ok: true,
          disclaimer: ETF_WHALE_DISCLAIMER,
          daily: services.etfWhale.daily(date || undefined),
        });
      },
    },
    {
      method: 'GET',
      path: '/api/v1/etf-whale/signals',
      handler({ response, services, url }) {
        const params = url.searchParams;
        json(response, 200, {
          ok: true,
          disclaimer: ETF_WHALE_DISCLAIMER,
          signals: services.etfWhale.signals({
            start: params?.get('start') || '',
            end: params?.get('end') || '',
          }),
        });
      },
    },
  ];
}
