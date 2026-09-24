import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../packages/database/src/index.js';
import { aggregateBasket } from '../packages/domain/src/trading-strategies/basket-aggregate.js';
import { classifyDividendRegime } from '../packages/domain/src/trading-strategies/dividend-value.js';
import { createDividendStrategyService } from '../packages/domain/src/trading-strategies/strategy-service.js';
import { createMarketStatisticsService } from '../packages/domain/src/market-statistics-service.js';
import { createReportService } from '../packages/domain/src/report-service.js';
import { resolveDailyWindow } from '../packages/domain/src/daily-window.js';
import { zonedLocalToUtc } from '../packages/domain/src/zoned-time.js';
import { ensureDividendStrategySchedule } from '../packages/runtime/src/strategy-module.js';
import { createStrategyJobHandlers } from '../packages/runtime/src/strategy-module.js';
import { createJobRunner } from '../packages/runtime/src/job-runner.js';
import { createRouter } from '../apps/web/src/http/router.js';
import { createStrategyRoutes } from '../apps/web/src/routes/strategy-routes.js';
import { createLocalToolRegistry } from '../packages/runtime/src/local-tools.js';
import {
  createTushareClient,
  seriesFromTushareIndexWeight,
} from '../packages/connectors/src/tushare.js';
import { createMarketService } from '../packages/source/src/market/service.js';

function temporaryDatabase() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-dividend-'));
  return {
    path: path.join(directory, 'test.db'),
    remove: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function closeTo(actual, expected) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-10, `${actual} !~ ${expected}`);
}

function responseRecorder() {
  return {
    status: 0,
    body: '',
    writeHead(status) { this.status = status; },
    end(body = '') { this.body = body; },
  };
}

const day1 = Date.parse('2026-09-21T00:00:00+08:00');
const day2 = Date.parse('2026-09-22T00:00:00+08:00');
const day3 = Date.parse('2026-09-23T00:00:00+08:00');

function members(pairs) {
  return pairs.map(([symbol, weight]) => ({ symbol, weight }));
}

function point(at, fields) {
  return { at, close: 10, peTtm: null, pb: null, dividendYieldTtm: null, ...fields };
}

test('index weights convert percent, symbols, and date order', async () => {
  const snapshots = seriesFromTushareIndexWeight({
    data: {
      fields: ['trade_date', 'con_code', 'weight'],
      items: [
        ['20260922', '600519.SH', '2.5'],
        ['20260921', '000001.SZ', '0'],
        ['20260921', '600000.SH', '4'],
        ['20260922', '000002.SZ', null],
      ],
    },
  });
  assert.deepEqual(snapshots.map((snapshot) => snapshot.tradeDate), ['2026-09-21', '2026-09-22']);
  assert.equal(snapshots[1].members[0].symbol, '600519.SS');
  assert.equal(snapshots[1].members[0].weight, 0.025);
  assert.equal(snapshots[0].members.some((member) => member.weight === 0), false);

  const silent = createTushareClient({ token: '', fetchImpl() { throw new Error('should not fetch'); } });
  assert.equal(await silent.fetchIndexWeights('000922', { range: '1y' }), null);
  const denied = createTushareClient({
    token: 'token',
    fetchImpl: async () => ({ ok: true, json: async () => ({ code: 402, msg: '没有权限' }) }),
  });
  await assert.rejects(() => denied.fetchIndexWeights('000922.SH', { range: '1y' }), /没有权限/);
  const calls = [];
  const csi = createTushareClient({
    token: 'token',
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ code: 0, data: { fields: ['trade_date', 'con_code', 'weight'], items: [] } }) };
    },
  });
  await csi.fetchIndexWeights('000922', { range: '1y' });
  assert.equal(calls[0].params.index_code, '000922.CSI');

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
  }).fetchIndexWeights('000922', { range: '5y' });
  assert.equal(unavailable.status, 'unavailable');
  assert.match(unavailable.warnings[0], /TUSHARE_TOKEN/);
});

test('basket valuation uses earnings yield and ignores future weights', () => {
  const series = {
    '600000.SS': { adjusted: false, points: [point(day1, { peTtm: 10, pb: 1, dividendYieldTtm: 0.06 }), point(day3, { peTtm: 1, pb: 1, dividendYieldTtm: 0.01 })] },
    '600519.SS': { adjusted: false, points: [point(day1, { peTtm: 20, pb: 2, dividendYieldTtm: 0.02 }), point(day2, { peTtm: -5, pb: 2, dividendYieldTtm: 0.02 })] },
  };
  const basket = aggregateBasket({
    index: '000922',
    name: '中证红利',
    range: '5y',
    asOf: day1,
    snapshots: [
      { tradeDate: '2026-09-21', at: day1, members: members([['600000.SS', 0.5], ['600519.SS', 0.5]]) },
      { tradeDate: '2026-09-22', at: day2, members: members([['600000.SS', 1]]) },
    ],
    series,
  });
  closeTo(basket.value.peTtm, 1 / (0.5 / 10 + 0.5 / 20));
  assert.notEqual(basket.value.peTtm, 15);
  closeTo(basket.value.pb, 1 / (0.5 / 1 + 0.5 / 2));
  closeTo(basket.value.dividendYield, 0.04);
  assert.equal(basket.value.peTtm, 1 / (0.5 / 10 + 0.5 / 20));

  const later = aggregateBasket({
    index: '000922',
    name: '中证红利',
    range: '5y',
    asOf: day2,
    snapshots: [
      { tradeDate: '2026-09-21', at: day1, members: members([['600000.SS', 0.5], ['600519.SS', 0.5]]) },
    ],
    series,
  });
  assert.equal(later.value.peTtm, 10);
  assert.equal(later.dataQuality.negativePeWeight, 0.5);
  assert.equal(later.dataQuality.earningsCoverage, 0.5);
});

test('dividend regime names the example state without a score', () => {
  const regime = classifyDividendRegime({
    value: { dividendYieldPercentile5y: 0.92, peTtm: 7.8, pePercentile5y: 0.18 },
    pain: { return20d: -0.074, drawdown252d: -0.145 },
  });
  assert.equal(regime, 'VALUE_HIGH_PAIN_HIGH');
  assert.equal(classifyDividendRegime({
    value: { dividendYieldPercentile5y: 0.5, peTtm: 12, pePercentile5y: 0.5 },
    pain: { return20d: 0.01, drawdown252d: -0.02 },
  }), 'NORMAL');
  assert.equal(classifyDividendRegime({
    value: { dividendYieldPercentile5y: null, peTtm: 7.8, pePercentile5y: 0.18 },
    pain: { return20d: -0.074, drawdown252d: -0.145 },
  }), 'UNKNOWN');
});

test('strategy snapshot is idempotent, scheduled at the close, and read by the next morning report', async () => {
  const temporary = temporaryDatabase();
  const store = createStore(temporary.path);
  const previousClose = Date.parse('2026-09-21T07:30:00.000Z');
  const sameDayClose = Date.parse('2026-09-22T07:30:00.000Z');
  const basketFor = (asOf) => ({
    asOf,
    status: 'partial',
    warnings: ['indexWeightHistoryShort'],
    value: {
      dividendYield: 0.054,
      dividendYieldPercentile5y: 0.92,
      peTtm: 7.8,
      pePercentile5y: 0.18,
      pb: 0.91,
      pbPercentile5y: 0.23,
    },
    pain: {
      return20d: -0.074,
      return60d: -0.112,
      return120d: null,
      return252d: null,
      drawdown252d: -0.145,
      distanceToMA20: null,
      distanceToMA60: null,
      distanceToMA120: null,
      distanceToMA250: null,
      breadthAboveMA20: null,
      breadthAboveMA60: null,
    },
    dataQuality: {
      constituentCount: 100,
      coverage: 0.94,
      earningsCoverage: 0.9,
      negativePeWeight: 0.02,
      missingWeight: 0.06,
      adjustedPrice: false,
    },
  });
  const strategy = createDividendStrategyService({
    strategyRepository: store.repositories.strategy,
    basketPort: {
      async getBasketStatistics({ asOf }) {
        return basketFor(asOf >= sameDayClose ? sameDayClose : previousClose);
      },
    },
  });
  try {
    const first = await strategy.captureDividendSnapshot({ scheduledFor: previousClose });
    const second = await strategy.captureDividendSnapshot({ scheduledFor: previousClose });
    assert.equal(second.id, first.id);
    assert.equal(first.factors.regime, 'VALUE_HIGH_PAIN_HIGH');
    assert.equal(JSON.stringify(first.factors).includes('BUY'), false);
    await strategy.captureDividendSnapshot({ scheduledFor: sameDayClose });
    assert.equal(store.repositories.strategy.getLatestStrategySnapshot('local', 'cn.dividend.value').asOf, sameDayClose);

    const morning = Date.parse('2026-09-22T00:00:00.000Z');
    const schedule = ensureDividendStrategySchedule(store, Date.parse('2026-09-22T02:00:00.000Z'));
    assert.equal(schedule.schedule.timezone, 'Asia/Shanghai');
    assert.equal(schedule.schedule.hour, 15);
    assert.equal(schedule.schedule.minute, 30);
    assert.equal(schedule.nextRunAt, zonedLocalToUtc(2026, 9, 22, 15, 30, 'Asia/Shanghai'));
    assert.notEqual(schedule.nextRunAt, morning);

    const window = resolveDailyWindow({
      reportDate: '2026-09-22',
      timezone: 'Asia/Shanghai',
      cutoffHour: 8,
      cutoffMinute: 0,
    });
    const reportService = createReportService({
      reportRepository: store.repositories.report,
      feedService: { listContentItemsInWindow: () => [] },
      tradingService: {
        async getBoard({ board }) {
          return { board, mode: 'live', fetchedAt: window.endAt, indices: [] };
        },
      },
      staticSignalPort: { async readBoard() { return { releases: [], upcoming: [], sourceHealth: [] }; } },
      strategyPort: strategy,
      defaultConfig: { timezone: 'Asia/Shanghai', cutoffHour: 8, cutoffMinute: 0, upcomingHours: 36 },
      now: () => window.endAt,
    });
    const report = await reportService.generateDailyReport({
      reportDate: '2026-09-22',
      timezone: 'Asia/Shanghai',
      cutoffHour: 8,
      cutoffMinute: 0,
    });
    assert.equal(report.content.strategy.asOf, previousClose);
    assert.equal(report.content.strategy.regime, 'VALUE_HIGH_PAIN_HIGH');
    assert.equal(report.sourceRefs.some((item) => item.type === 'strategy-snapshot' && item.id === first.id), true);

    const runner = createJobRunner({
      store,
      handlers: createStrategyJobHandlers({ strategyService: strategy }),
    });
    const job = store.createJob({
      type: 'strategy.cn-dividend.snapshot',
      input: { scheduledFor: previousClose },
      maxAttempts: 1,
    });
    const completed = await runner.runOnce();
    assert.equal(completed.id, job.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.output.regime, 'VALUE_HIGH_PAIN_HIGH');
  } finally {
    store.close();
    temporary.remove();
  }
});

test('basket statistics and routes stay on the statistics service', async () => {
  const service = createMarketStatisticsService({
    sourcePort: {
      async read(sourceId, input) {
        if (sourceId === 'market.index.weights') {
          return {
            data: {
              index: '000922',
              range: '5y',
              status: 'ready',
              snapshots: [{
                tradeDate: '2026-09-21',
                at: day1,
                members: members([['600000.SS', 0.5], ['600519.SS', 0.5]]),
              }],
              warnings: [],
            },
          };
        }
        const pe = input.symbol === '600000.SS' ? 10 : 20;
        return {
          data: {
            symbol: input.symbol,
            range: '5y',
            status: 'ready',
            points: [point(day1, { peTtm: pe, pb: 1, dividendYieldTtm: 0.03, close: 10 })],
            factors: [],
            warnings: [],
          },
        };
      },
    },
    now: () => day1,
  });
  const basket = await service.getBasketStatistics({ index: '000922', range: '5y', asOf: day1 });
  closeTo(basket.value.peTtm, 1 / (0.5 / 10 + 0.5 / 20));
  assert.equal(basket.name, '中证红利');

  const calls = [];
  const router = createRouter([
    ...createStrategyRoutes(),
    {
      method: 'GET',
      path: '/api/v1/markets/baskets',
      async handler({ response, url, services }) {
        calls.push(url.searchParams.get('index'));
        response.writeHead(200);
        response.end(JSON.stringify({ ok: true, index: url.searchParams.get('index') }));
        await services.marketStatistics.getBasketStatistics({ index: url.searchParams.get('index'), range: '5y' });
      },
    },
  ]);
  const jobs = [];
  const denied = responseRecorder();
  await router.dispatch({
    request: { method: 'POST', async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ jobType: 'system.healthcheck' })); } },
    response: denied,
    url: new URL('http://127.0.0.1/api/v1/strategies/cn-dividend/snapshot'),
    identity: { kind: 'device' },
    services: { runtime: { requestDividendSnapshot() { jobs.push('no'); } }, strategy: { getLatest() { return null; } }, marketStatistics: service },
  });
  assert.equal(denied.status, 403);
  assert.equal(jobs.length, 0);
  const accepted = responseRecorder();
  await router.dispatch({
    request: { method: 'POST', async *[Symbol.asyncIterator]() { yield Buffer.from('{}'); } },
    response: accepted,
    url: new URL('http://127.0.0.1/api/v1/strategies/cn-dividend/snapshot'),
    identity: { kind: 'desktop' },
    services: {
      runtime: { requestDividendSnapshot() { const job = { type: 'strategy.cn-dividend.snapshot' }; jobs.push(job); return job; } },
      strategy: { getLatest() { return null; } },
      marketStatistics: service,
    },
  });
  assert.equal(accepted.status, 202);
  assert.equal(jobs[0].type, 'strategy.cn-dividend.snapshot');

  const registry = createLocalToolRegistry({
    contextService: {},
    feedService: {},
    knowledgeService: {},
    tradingService: {},
    marketStatisticsService: service,
  });
  const tool = await registry.execute('market.basket.stats', { index: '000922', range: '5y', asOf: day1 }, { workspaceId: 'local' });
  assert.equal(tool.data.index, '000922');
  assert.match(registry.list().find((item) => item.id === 'market.basket.stats').description, /不给出买卖建议/);
});
