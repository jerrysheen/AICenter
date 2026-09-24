import { parseHoldingsQuery, parseMarketHistoryQuery, parseMarketQuery, parseMarketSearchQuery, BasketStatsToolInputSchema, StockStatsToolInputSchema, parseContract } from '../../../../packages/contracts/src/index.js';
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
      method: 'GET', path: '/api/v1/markets/history',
      async handler({ response, services, url }) {
        const query = parseMarketHistoryQuery(Object.fromEntries(url.searchParams.entries()));
        try {
          json(response, 200, { ok: true, history: await services.trading.getQuoteHistory(query) });
        } catch (error) {
          json(response, error.statusCode || 502, { ok: false, error: error instanceof Error ? error.message : 'K线加载失败' });
        }
      },
    },
    {
      method: 'GET', path: '/api/v1/markets/analysis',
      async handler({ response, services, url }) {
        const query = parseContract(StockStatsToolInputSchema, {
          symbol: url.searchParams.get('symbol') || '',
          range: url.searchParams.get('range') || '5y',
        });
        try {
          json(response, 200, { ok: true, statistics: await services.marketStatistics.getStockStatistics(query) });
        } catch (error) {
          json(response, error.statusCode || 502, { ok: false, error: error instanceof Error ? error.message : '个股统计加载失败' });
        }
      },
    },
    {
      method: 'GET', path: '/api/v1/markets/baskets',
      async handler({ response, services, url }) {
        const query = parseContract(BasketStatsToolInputSchema, {
          index: url.searchParams.get('index') || '',
          range: url.searchParams.get('range') || '5y',
          ...(url.searchParams.get('asOf') ? { asOf: Number(url.searchParams.get('asOf')) } : {}),
        });
        try {
          json(response, 200, { ok: true, basket: await services.marketStatistics.getBasketStatistics(query) });
        } catch (error) {
          json(response, error.statusCode || 502, { ok: false, error: error instanceof Error ? error.message : '篮子统计加载失败' });
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
      method: 'POST', path: '/api/v1/assets/personal/import',
      async handler({ response, services }) {
        try {
          const payload = await services.trading.importPersonalAssets();
          json(response, 200, { ok: true, ...payload });
        } catch (error) {
          json(response, error.statusCode || 400, { ok: false, error: error instanceof Error ? error.message : '导入个人资产失败' });
        }
      },
    },
    {
      method: 'POST', path: '/api/v1/assets/personal/accounts',
      async handler({ request, response, services }) {
        try {
          const body = await readJson(request);
          const payload = await services.trading.createPersonalAssetAccount(body);
          json(response, 201, { ok: true, ...payload });
        } catch (error) {
          json(response, error.statusCode || 400, { ok: false, error: error instanceof Error ? error.message : '添加资产账户失败' });
        }
      },
    },
    {
      method: 'PATCH', path: /^\/api\/v1\/assets\/personal\/accounts\/([^/]+)$/,
      async handler({ request, response, services, params }) {
        try {
          const body = await readJson(request);
          const payload = await services.trading.updatePersonalAssetAccount(decodeURIComponent(params.values[0]), body);
          json(response, 200, { ok: true, ...payload });
        } catch (error) {
          json(response, error.statusCode || 400, { ok: false, error: error instanceof Error ? error.message : '更新资产账户失败' });
        }
      },
    },
    {
      method: 'POST', path: '/api/v1/assets/personal/snapshots',
      async handler({ request, response, services }) {
        try {
          const body = await readJson(request).catch(() => ({}));
          const payload = await services.trading.recordPersonalAssetSnapshot(body);
          json(response, 201, { ok: true, ...payload });
        } catch (error) {
          json(response, error.statusCode || 400, { ok: false, error: error instanceof Error ? error.message : '记录本期资产失败' });
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
