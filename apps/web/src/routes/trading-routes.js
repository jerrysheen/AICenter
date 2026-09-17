import { parseHoldingsQuery, parseMarketQuery, parseMarketSearchQuery } from '../../../../packages/contracts/src/index.js';
import { json, readJson } from '../http/response.js';

export function createTradingRoutes() {
  return [
    {
      method: 'GET', path: '/api/v1/markets',
      async handler({ response, services, url }) {
        const query = parseMarketQuery(Object.fromEntries(url.searchParams.entries()));
        try {
          json(response, 200, { ok: true, market: await services.trading.getBoard(query) });
        } catch (error) {
          json(response, 502, { ok: false, error: error instanceof Error ? error.message : '行情加载失败' });
        }
      },
    },
    {
      method: 'GET', path: '/api/v1/markets/search',
      async handler({ response, services, url }) {
        const query = parseMarketSearchQuery(url.searchParams.get('q') || '');
        try {
          json(response, 200, { ok: true, items: await services.trading.search(query) });
        } catch (error) {
          json(response, 502, { ok: false, error: error instanceof Error ? error.message : '标的搜索失败' });
        }
      },
    },
    {
      method: 'GET', path: '/api/v1/assets/personal',
      async handler({ response, services }) {
        try {
          json(response, 200, { ok: true, dashboard: await services.trading.getPersonalAssetDashboard() });
        } catch (error) {
          json(response, 502, { ok: false, error: error instanceof Error ? error.message : '个人资产加载失败' });
        }
      },
    },
    {
      method: 'GET', path: '/api/v1/holdings',
      async handler({ response, services, url }) {
        try {
          const query = parseHoldingsQuery(Object.fromEntries(url.searchParams.entries()));
          json(response, 200, { ok: true, holdings: await services.trading.getHoldingsBoard(query) });
        } catch (error) {
          json(response, 502, { ok: false, error: error instanceof Error ? error.message : '持仓加载失败' });
        }
      },
    },
    {
      method: 'POST', path: '/api/v1/holdings/lots',
      async handler({ request, response, services }) {
        try {
          const body = await readJson(request);
          json(response, 201, { ok: true, lot: services.trading.addHoldingLot(body) });
        } catch (error) {
          json(response, error.statusCode || 400, { ok: false, error: error instanceof Error ? error.message : '添加持仓失败' });
        }
      },
    },
    {
      method: 'DELETE', path: /^\/api\/v1\/holdings\/lots\/([^/]+)$/,
      async handler({ response, services, params }) {
        try {
          const lot = services.trading.archiveHoldingLot(decodeURIComponent(params.values[0]));
          json(response, 200, { ok: true, lot });
        } catch (error) {
          json(response, error.statusCode || 400, { ok: false, error: error instanceof Error ? error.message : '删除持仓失败' });
        }
      },
    },
    {
      method: 'PUT', path: '/api/v1/holdings/cash',
      async handler({ request, response, services }) {
        try {
          const body = await readJson(request);
          json(response, 200, { ok: true, cash: services.trading.upsertPortfolioCash(body) });
        } catch (error) {
          json(response, error.statusCode || 400, { ok: false, error: error instanceof Error ? error.message : '保存现金失败' });
        }
      },
    },
  ];
}
