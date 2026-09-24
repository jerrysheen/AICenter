import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTushareClient,
  seriesFromTushareAdjFactors,
  seriesFromTushareDailyBasic,
} from '../packages/connectors/src/tushare.js';
import { createMarketService } from '../packages/source/src/market/service.js';
import { MarketMetricSeriesSchema } from '../packages/source/src/schemas.js';
import { parseContract } from '../packages/contracts/src/index.js';
import { createMarketStatisticsService } from '../packages/domain/src/market-statistics-service.js';
import { createLocalToolRegistry } from '../packages/runtime/src/local-tools.js';

const fields = [
  'ts_code', 'trade_date', 'close', 'turnover_rate', 'turnover_rate_f', 'volume_ratio',
  'pe', 'pe_ttm', 'pb', 'ps', 'ps_ttm', 'dv_ratio', 'dv_ttm',
  'total_share', 'float_share', 'free_share', 'total_mv', 'circ_mv',
];

function payload(items) {
  return { code: 0, data: { fields, items } };
}

test('daily_basic and adj_factor map dates, nulls, and negative PE', () => {
  const points = seriesFromTushareDailyBasic(payload([
    ['600519.SH', '20260918', 1400, '-', null, '1.2', '20', '-3.5', null, '8', 'None', 0, '', 12, 8, 7, 100, 80],
    ['600519.SH', '20260917', 1390, '0.4', '0.5', '0.9', '21', '22', '6', '7', '7.1', '1.1', '1.2', 12, 8, 7, 99, 79],
  ]), '600519.SS');
  assert.deepEqual(points.map((point) => point.tradeDate), ['2026-09-17', '2026-09-18']);
  assert.equal(points[1].peTtm, -3.5);
  assert.equal(points[1].pb, null);
  assert.equal(points[1].turnoverRate, null);
  assert.equal(points[1].psTtm, null);
  assert.equal(points[1].dividendYieldTtm, null);
  assert.equal(points[1].dividendYield, 0);
  assert.equal(Number(points[0].dividendYield.toFixed(4)), 0.011);
  assert.equal(Number(points[0].dividendYieldTtm.toFixed(4)), 0.012);
  assert.equal(points[0].turnoverRate, 0.4);
  assert.equal(points.some((point) => Object.values(point).includes(NaN)), false);

  const factors = seriesFromTushareAdjFactors({
    data: {
      fields: ['trade_date', 'adj_factor'],
      items: [['20260918', '3.2'], ['20260917', '3.1'], ['20260916', null]],
    },
  });
  assert.deepEqual(factors.map((point) => point.tradeDate), ['2026-09-17', '2026-09-18']);
  assert.equal(factors[1].adjFactor, 3.2);
});

test('tushare metric client reports token, api, and timeout failures without fabricating zeros', async () => {
  const silent = createTushareClient({
    token: '',
    fetchImpl() { throw new Error('should not fetch'); },
  });
  assert.equal(await silent.fetchDailyBasic('600519.SS', { range: '5y' }), null);
  assert.equal(await silent.fetchAdjFactors('600519.SS', { range: '5y' }), null);

  const denied = createTushareClient({
    token: 'test-token',
    fetchImpl: async () => ({ ok: true, json: async () => ({ code: 402, msg: '没有权限' }) }),
  });
  await assert.rejects(() => denied.fetchDailyBasic('600519.SS', { range: '5y' }), /没有权限/);

  const timedOut = createTushareClient({
    token: 'test-token',
    timeoutMs: 20,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
  });
  await assert.rejects(() => timedOut.fetchAdjFactors('600519.SS', { range: '1y' }), /超时/);

  const idle = {
    async fetchQuotes() { return []; },
    async fetchHistory() { return []; },
    async searchSymbols() { return []; },
  };
  const unavailable = await createMarketService({
    tushare: silent,
    yahoo: idle,
    cnQuotes: idle,
    xueqiuQuotes: idle,
    sinaFutures: idle,
  }).fetchMetricHistory('600519.SS', { range: '5y' });
  assert.equal(unavailable.status, 'unavailable');
  assert.deepEqual(unavailable.points, []);
  assert.match(unavailable.warnings[0], /TUSHARE_TOKEN/);
  parseContract(MarketMetricSeriesSchema, unavailable);

  const partial = await createMarketService({
    tushare: {
      enabled: true,
      async fetchDailyBasic() { throw new Error('daily_basic 失败'); },
      async fetchAdjFactors() {
        return [{ tradeDate: '2026-09-18', at: Date.parse('2026-09-18T00:00:00+08:00'), adjFactor: 2 }];
      },
    },
    yahoo: idle,
    cnQuotes: idle,
    xueqiuQuotes: idle,
    sinaFutures: idle,
  }).fetchMetricHistory('600519.SS', { range: '5y' });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.points.length, 0);
  assert.equal(partial.factors.length, 1);
  assert.equal(JSON.stringify(partial).includes('"peTtm":0'), false);
});

test('stock statistics and the agent tool return facts from source snapshots', async () => {
  const bars = Array.from({ length: 6 }, (_, index) => ({ at: index + 1, open: 10, high: 10, low: 10, close: 10, volume: 100 }));
  const service = createMarketStatisticsService({
    sourcePort: {
      async read(sourceId) {
        if (sourceId === 'market.quotes') {
          return { data: [{ symbol: '600519.SS', name: '贵州茅台', lastPrice: 1400, changePct: 0.01, asOf: 6 }] };
        }
        if (sourceId === 'market.history') return { data: [{ symbol: '600519.SS', points: [], bars }] };
        if (sourceId === 'market.metrics.history') {
          return {
            data: {
              symbol: '600519.SS',
              range: '5y',
              status: 'partial',
              points: [{ at: 6, peTtm: 20, pb: 5, dividendYieldTtm: 2, turnoverRate: 0.4, volumeRatio: 1 }],
              factors: [],
              warnings: ['复权因子不可用'],
            },
          };
        }
        throw new Error(sourceId);
      },
    },
  });
  const statistics = await service.getStockStatistics({ symbol: '600519.ss', range: '5y' });
  assert.equal(statistics.instrument.name, '贵州茅台');
  assert.equal(statistics.quote.lastPrice, 1400);
  assert.equal(statistics.valuation.peTtm.value, 20);
  assert.equal(statistics.coverage.adjustedPrice, false);
  assert.ok(statistics.warnings.includes('priceSeriesAdjusted=false'));
  assert.equal(JSON.stringify(statistics).includes('强烈推荐'), false);

  const registry = createLocalToolRegistry({
    contextService: {},
    feedService: {},
    knowledgeService: {},
    tradingService: {},
    marketStatisticsService: service,
  });
  const tool = await registry.execute('market.stock.stats', { symbol: '600519.SS', range: '5y' }, { workspaceId: 'local' });
  assert.equal(tool.data.instrument.symbol, '600519.SS');
  assert.match(registry.list().find((item) => item.id === 'market.stock.stats').description, /只返回事实/);
});
