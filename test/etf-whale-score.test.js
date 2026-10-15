import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isApiTokenAllowlisted } from '../apps/web/src/http/api-token-access.js';
import { createRouter } from '../apps/web/src/http/router.js';
import { createEtfWhaleRoutes } from '../apps/web/src/routes/etf-whale-routes.js';
import { ValidationError } from '../packages/contracts/src/errors.js';
import { createStore } from '../packages/database/src/index.js';
import { addDays } from '../packages/domain/src/etf-whale/calculate.js';
import { createEtfWhaleReadService } from '../packages/domain/src/etf-whale-service.js';
import {
  breadthComponent,
  flowComponent,
  indexComponent,
  scoreGjdV1,
  scoreLevel,
  turnoverComponent,
} from '../packages/domain/src/etf-whale/score.js';
import { dailyIndexApprox, metricOrNull } from '../packages/domain/src/etf-whale/session-shape.js';
import { referencePool } from '../packages/domain/src/etf-whale/universe.js';
import { refreshEtfWhaleSignals, scoreTradeDate } from '../packages/runtime/src/etf-whale-score.js';

const HIT = { lowDropPct: -0.02, reboundPct: 0.02, tailPct: 0 };

function responseRecorder() {
  return {
    status: 0,
    body: '',
    writeHead(status) { this.status = status; },
    end(body = '') { this.body = body; },
  };
}

function quietNames(multiple = 1) {
  return referencePool().map((item) => ({ code: item.code, multiple: item.code === '510310' ? multiple : 1 }));
}

test('gjd-score-v1 gives a lone 8x name 20 and does not give partial index credit', () => {
  const lone = breadthComponent(quietNames(25));
  assert.equal(lone.count, 1);
  assert.equal(lone.hasRed, true);
  assert.equal(lone.score, 20);

  assert.equal(breadthComponent(quietNames(8)).score, 20);
  assert.equal(breadthComponent(quietNames(7.9)).score, 0);
  assert.equal(breadthComponent([
    { code: 'a', multiple: 4 },
    { code: 'b', multiple: 4 },
  ]).score, 0);
  assert.equal(breadthComponent([
    { code: 'a', multiple: 3 },
    { code: 'b', multiple: 3 },
    { code: 'c', multiple: 3 },
  ]).score, 15);
  assert.equal(breadthComponent([
    { code: 'a', multiple: 3 },
    { code: 'b', multiple: 3 },
    { code: 'c', multiple: 3 },
    { code: 'd', multiple: 3 },
  ]).score, 17.5);
  assert.equal(breadthComponent([
    { code: 'a', multiple: 8 },
    { code: 'b', multiple: 3 },
    { code: 'c', multiple: 3 },
  ]).score, 20);
  assert.equal(breadthComponent([
    { code: 'a', multiple: 8 },
    { code: 'b', multiple: 3 },
    { code: 'c', multiple: 3 },
    { code: 'd', multiple: 3 },
    { code: 'e', multiple: 3 },
    { code: 'f', multiple: 3 },
    { code: 'g', multiple: 3 },
  ]).score, 25);
  assert.equal(breadthComponent([
    { code: 'a', multiple: 1, sharePercentile: 95 },
    { code: 'b', multiple: 1, sharePercentile: 96 },
    { code: 'c', multiple: 1, sharePercentile: 99 },
  ], { confirmed: true }).score, 15);
  assert.equal(breadthComponent([
    { code: 'a', multiple: 1, sharePercentile: 99 },
    { code: 'b', multiple: 1, sharePercentile: 99 },
    { code: 'c', multiple: 1, sharePercentile: 99 },
  ]).score, 0);

  assert.equal(indexComponent([{ symbol: '000016', ...HIT }]).score, 15);
  assert.equal(indexComponent([{ symbol: '000300', ...HIT }]).score, 25);
  assert.equal(indexComponent([
    { symbol: '000016', ...HIT },
    { symbol: '000905', ...HIT },
  ]).score, 25);
  assert.equal(indexComponent([{ symbol: '000300', lowDropPct: -0.009, reboundPct: 0.02, tailPct: 0 }]).score, 0);
  assert.equal(indexComponent([{ symbol: '000300', lowDropPct: -0.02, reboundPct: 0.009, tailPct: 0.009 }]).score, 0);
  assert.equal(indexComponent([{ symbol: '000016', lowDropPct: 0, reboundPct: 0, tailPct: 0.01 }]).score, 15);

  assert.equal(flowComponent(0, [1, 2, 3]).score, 0);
  assert.equal(flowComponent(-5, [1, 2, 3]).score, 0);
  assert.equal(flowComponent(99, Array.from({ length: 100 }, (_, index) => index)).score, 25);
  assert.equal(turnoverComponent(3, Array(20).fill(1)).score, 25);

  const initial = scoreGjdV1({
    stage: 'initial',
    names: quietNames(25),
    flowToday: 1e9,
    flowHistory: Array.from({ length: 100 }, () => 1),
  });
  assert.equal(initial.sBreadth, 20);
  assert.equal(initial.sFlow, null);
  assert.equal(initial.maxScore, 75);
  assert.equal(initial.level, scoreLevel(initial.scaled));
  assert.ok(Math.abs(initial.scaled - (initial.score / 75) * 100) < 1e-9);

  const confirmed = scoreGjdV1({ stage: 'confirmed', flowToday: -1, names: [] });
  assert.equal(confirmed.sFlow, 0);
  assert.equal(confirmed.sTurnover, null);
  assert.equal(confirmed.sIndex, null);
  assert.deepEqual(confirmed.insufficient, ['turnover', 'index']);
  assert.equal(confirmed.maxScore, 100);
  assert.equal(confirmed.score, confirmed.sBreadth + confirmed.sFlow);
  assert.equal(turnoverComponent(null, []).insufficient, true);
  assert.equal(turnoverComponent(null, []).score, null);
  assert.equal(indexComponent([]).insufficient, true);
  assert.equal(indexComponent([{ symbol: '000300', lowDropPct: null, reboundPct: null, tailPct: null }]).score, null);
  const scored = scoreGjdV1({
    stage: 'initial',
    poolSumToday: 3,
    poolHistory: Array(20).fill(1),
    names: quietNames(1),
    indices: [{ symbol: '000300', ...HIT }],
  });
  assert.equal(scored.sTurnover, 25);
  assert.equal(scored.sIndex, 25);
  assert.deepEqual(scored.insufficient, []);
  assert.equal(scored.score, 50);
  assert.equal(scoreLevel(70), 'strong');
  assert.equal(scoreLevel(69.9), 'suspected');
  assert.equal(scoreLevel(50), 'suspected');
  assert.equal(scoreLevel(30), 'watch');
  assert.equal(scoreLevel(29.9), 'none');
});

test('510310 at about 25x is stored as breadth 20 and futures stay out of the score', () => {
  const codes = referencePool().map((item) => item.code);
  const dates = [];
  let cursor = '2026-09-01';
  while (dates.length < 21) {
    const weekday = new Date(`${cursor}T12:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) dates.push(cursor);
    cursor = addDays(cursor, 1);
  }
  const tradeDate = dates.at(-1);
  const rows = [];
  for (const date of dates) {
    for (const code of codes) {
      rows.push({
        source: 'sina-amount',
        code,
        tradeDate: date,
        amountCny: code === '510310' && date === tradeDate ? 25e9 : 1e9,
        volumeShares: 1,
        close: 4,
      });
    }
  }
  const store = createStore(path.join(mkdtempSync(path.join(tmpdir(), 'etf-whale-score-')), 'ai-center.db'));
  try {
    const repository = store.repositories.etfWhale;
    repository.saveTurnover(rows);
    repository.saveFuturesRanks([{
      tradeDate, product: 'IF', contract: 'IF2510', dataType: 2, rank: 1, partyId: '0018',
      member: '乱码', volume: 9000, varVolume: 100, sourceUrl: 'http://www.cffex.com.cn/sj/ccpm/fixture/IF.xml',
    }]);
    const scored = scoreTradeDate(repository, tradeDate, 'initial');
    assert.equal(scored.sBreadth, 20);
    assert.equal(scored.sFlow, null);
    assert.equal(scored.sIndex, null);
    assert.equal(scored.maxScore, 75);
    const inputs = JSON.parse(scored.inputsJson);
    assert.deepEqual(inputs.insufficient, ['index']);
    assert.equal(inputs.futuresScored, false);
    assert.equal(inputs.breadth.count, 1);
    assert.equal(inputs.breadth.hasRed, true);
    repository.saveSignal(scored);
    repository.saveSignal({ ...scored, score: scored.score + 1 });
    const saved = repository.listSignals(tradeDate, tradeDate, 'gjd-score-v1');
    assert.equal(saved.length, 1);
    assert.equal(saved[0].s_breadth, 20);
    assert.equal(saved[0].s_index, null);
    assert.equal(JSON.parse(saved[0].inputs_json).index.score, null);

    const counted = refreshEtfWhaleSignals(repository, { startDate: '2026-10-01', endDate: '2026-10-02', stage: 'initial' });
    assert.equal(counted, 0);
    assert.equal(repository.listSignals('2026-10-01', '2026-10-01', 'gjd-score-v1').length, 0);
    const friday = refreshEtfWhaleSignals(repository, { startDate: '2026-10-09', endDate: '2026-10-09', stage: 'initial' });
    assert.equal(friday, 1);
  } finally {
    store.close();
  }
});

test('unknown ETF codes are 404, bad codes and signal ranges are 400, and series is an alias', async () => {
  assert.equal(isApiTokenAllowlisted('GET', '/api/v1/etf-whale/daily'), true);
  assert.equal(isApiTokenAllowlisted('GET', '/api/v1/etf-whale/signals'), true);
  assert.equal(isApiTokenAllowlisted('GET', '/api/v1/etf-whale/series'), true);
  assert.equal(isApiTokenAllowlisted('GET', '/api/v1/etf-whale/etfs/abc'), true);
  assert.equal(isApiTokenAllowlisted('GET', '/api/v1/holdings'), false);
  assert.equal(isApiTokenAllowlisted('GET', '/api/v1/assets/personal'), false);
  assert.equal(isApiTokenAllowlisted('GET', '/api/v1/etf-whale/etfs/159915/shares'), false);

  const store = createStore(path.join(mkdtempSync(path.join(tmpdir(), 'etf-whale-read-')), 'ai-center.db'));
  try {
    const repository = store.repositories.etfWhale;
    repository.saveFetch({
      source: 'sse', dateStart: '2026-10-14', dateEnd: '2026-10-14', status: 'pending',
      rowCount: 0, error: '', blobPath: '', contentHash: '', capturedAt: 1,
    });
    repository.saveShares([{
      source: 'sse', tradeDate: '2026-10-13', code: '510300', name: '沪深300ETF', shares: 1, rawValue: '1', rawUnit: '份',
    }], {
      source: 'sse', dateStart: '2026-10-13', dateEnd: '2026-10-13', status: 'ok',
      blobPath: 'blobs/etf-whale/sse/2026-10-13.json', contentHash: 'abc', capturedAt: 1, error: '',
    });
    repository.saveQuotes([{
      source: 'tencent', code: '510300', tradeDate: '2026-10-15', open: 1, high: 1, low: 1, close: 1,
      volumeLots: 1, volumeShares: 100, typicalPrice: 1, turnoverCny: 1, adjust: 'qfq',
    }], { capturedAt: 1 });
    const service = createEtfWhaleReadService({ repository });
    const overview = service.overview();
    assert.equal(overview.disclaimer, '不构成投资建议');
    assert.equal(overview.sharesLatest, '2026-10-13');
    assert.equal(overview.quotesLatest, '2026-10-15');
    assert.deepEqual(overview.pendingDates, ['2026-10-14']);
    assert.equal(service.series('588000').inPool, false);
    assert.equal(service.series('159915').inPool, true);
    assert.equal(service.series('000001'), null);
    assert.throws(() => service.series('12'), ValidationError);
    assert.throws(() => service.series(''), ValidationError);
    assert.throws(() => service.daily('20261015'), ValidationError);
    assert.throws(() => service.signals({ start: '2026-10-15' }), ValidationError);
    assert.throws(() => service.signals({ start: '2026-10-15', end: '2026-10-01' }), ValidationError);
    assert.throws(() => service.signals({ start: '2024-01-01', end: '2025-01-01' }), ValidationError);
    const open = service.signals({ start: '2024-01-01', end: '2024-01-10' });
    assert.equal(open.start, '2024-01-01');
    assert.equal(open.disclaimer, '不构成投资建议');

    const router = createRouter(createEtfWhaleRoutes());
    const context = (url) => ({
      request: { method: 'GET' },
      response: responseRecorder(),
      url,
      identity: { kind: 'desktop' },
      services: { etfWhale: service },
    });
    const known = context({ pathname: '/api/v1/etf-whale/etfs/159915', searchParams: new URLSearchParams() });
    await router.dispatch(known);
    const alias = context({ pathname: '/api/v1/etf-whale/series', searchParams: new URLSearchParams('code=159915') });
    await router.dispatch(alias);
    assert.equal(known.response.status, 200);
    assert.deepEqual(JSON.parse(known.response.body), JSON.parse(alias.response.body));
    assert.equal(JSON.parse(alias.response.body).disclaimer, '不构成投资建议');
    assert.equal(JSON.parse(alias.response.body).series.inPool, true);

    const missing = context({ pathname: '/api/v1/etf-whale/etfs/000001' });
    await router.dispatch(missing);
    assert.equal(missing.response.status, 404);
    assert.equal(JSON.parse(missing.response.body).error, 'not_in_universe');

    await assert.rejects(() => router.dispatch(context({ pathname: '/api/v1/etf-whale/etfs/abc' })), ValidationError);
    await assert.rejects(() => router.dispatch(context({
      pathname: '/api/v1/etf-whale/series',
      searchParams: new URLSearchParams(),
    })), ValidationError);
    await assert.rejects(() => router.dispatch(context({
      pathname: '/api/v1/etf-whale/signals',
      searchParams: new URLSearchParams('start=2026-10-02&end=2026-10-01'),
    })), ValidationError);

    const daily = context({ pathname: '/api/v1/etf-whale/daily', searchParams: new URLSearchParams('date=2026-10-15') });
    await router.dispatch(daily);
    const dailyBody = JSON.parse(daily.response.body);
    assert.equal(daily.response.status, 200);
    assert.equal(dailyBody.daily.tradeDate, '2026-10-15');
    assert.equal(dailyBody.daily.sharesStatus, 'pending');
    assert.equal(dailyBody.disclaimer, '不构成投资建议');
    assert.equal(dailyBody.daily.futures.displayOnly, true);
    assert.equal(dailyBody.daily.indices.every((item) => item.method == null), true);
  } finally {
    store.close();
  }
});

const WASHED_DAILY = {
  open: 99,
  high: 101,
  low: 98.5,
  close: 100.8,
  prevClose: 100,
};

test('missing 5-minute bars use daily OHLC approximation and a real zero is not stored as insufficient', () => {
  assert.equal(metricOrNull(null), null);
  assert.equal(dailyIndexApprox(WASHED_DAILY).hit, true);
  assert.equal(dailyIndexApprox({
    open: 100, high: 101, low: 99.2, close: 100.5, prevClose: 100,
  }).hit, true);
  const surge = dailyIndexApprox({
    open: 99.5, high: 101, low: 99.4, close: 100.6, prevClose: 100,
    amountCny: 160, priorAmounts: Array(10).fill(100),
  });
  assert.equal(surge.hit, true);
  assert.equal(dailyIndexApprox({
    open: 99.5, high: 101, low: 99.4, close: 100.6, prevClose: 100,
    amountCny: 160, priorAmounts: Array(9).fill(100),
  }).hit, false);
  assert.equal(dailyIndexApprox({
    open: 100, high: 101, low: 99.8, close: 100.1, prevClose: 100,
  }).hit, false);

  const washed = indexComponent([{ symbol: '000300', ...WASHED_DAILY }]);
  assert.equal(washed.insufficient, false);
  assert.equal(washed.method, 'daily-approx');
  assert.equal(washed.score, 25);
  assert.equal(indexComponent([{ symbol: '000016', ...WASHED_DAILY }]).score, 15);
  const coerced = indexComponent([{
    symbol: '000300',
    lowDropPct: 0,
    reboundPct: 0,
    tailPct: 0,
    ...WASHED_DAILY,
  }]);
  assert.equal(coerced.method, 'daily-approx');
  assert.equal(coerced.score, 25);

  const preferred = indexComponent([{
    symbol: '000300',
    barsPresent: true,
    lowDropPct: 0,
    reboundPct: 0,
    tailPct: 0.002,
    lowTime: '2024-01-02 10:00',
    ...WASHED_DAILY,
  }]);
  assert.equal(preferred.method, 'intraday');
  assert.equal(preferred.score, 0);
  assert.equal(preferred.insufficient, false);
  const mixed = indexComponent([
    { symbol: '000300', barsPresent: true, lowDropPct: -0.02, reboundPct: 0.02, tailPct: 0, lowTime: '2024-01-02 10:00' },
    { symbol: '000016', ...WASHED_DAILY },
  ]);
  assert.equal(mixed.method, 'mixed');
  assert.equal(mixed.score, 25);
  assert.equal(mixed.hits.find((item) => item.symbol === '000016').method, 'daily-approx');

  const quiet = scoreGjdV1({
    stage: 'initial',
    poolSumToday: 3,
    poolHistory: Array(20).fill(1),
    names: quietNames(1),
    indices: [{ symbol: '000300', ...WASHED_DAILY }],
  });
  assert.equal(quiet.sTurnover, 25);
  assert.equal(quiet.sBreadth, 0);
  assert.equal(quiet.sIndex, 25);
  assert.equal(quiet.score, 50);
  assert.equal(quiet.index.method, 'daily-approx');
  assert.deepEqual(quiet.insufficient, []);

  const store = createStore(path.join(mkdtempSync(path.join(tmpdir(), 'etf-whale-approx-')), 'ai-center.db'));
  try {
    const repository = store.repositories.etfWhale;
    repository.saveIndexDaily([{
      symbol: '000300',
      tradeDate: '2024-01-02',
      prevClose: 100,
      open: 99,
      high: 101,
      low: 98.5,
      close: 100.8,
      amountCny: 1e11,
      lowTime: null,
      lowDropPct: null,
      reboundPct: null,
      tailPct: null,
      source: 'tencent',
    }]);
    const scored = scoreTradeDate(repository, '2024-01-02', 'initial');
    assert.equal(scored.sIndex, 25);
    assert.equal(JSON.parse(scored.inputsJson).index.method, 'daily-approx');
    assert.deepEqual(JSON.parse(scored.inputsJson).insufficient, ['turnover']);
    repository.saveSignal(scored);
    const row = repository.listSignals('2024-01-02', '2024-01-02', 'gjd-score-v1')[0];
    assert.equal(row.s_index, 25);
    const daily = createEtfWhaleReadService({ repository }).daily('2024-01-02');
    const hs300 = daily.indices.find((item) => item.symbol === '000300');
    const other = daily.indices.find((item) => item.symbol === '000016');
    assert.equal(hs300.method, 'daily-approx');
    assert.equal(hs300.hit, true);
    assert.equal(hs300.tailPct, null);
    assert.equal(other.method, null);
    repository.saveIntradayBars([{
      source: 'sina', symbol: '000300', kind: 'index', intervalKey: '5m',
      barTime: '2024-01-02 10:00', tradeDate: '2024-01-02',
      open: 100, high: 100.1, low: 99.9, close: 100, volume: 1, amountCny: 1,
    }]);
    const preferredScore = scoreTradeDate(repository, '2024-01-02', 'initial');
    assert.equal(preferredScore.sIndex, 0);
    assert.equal(JSON.parse(preferredScore.inputsJson).index.method, 'intraday');
    repository.saveSignal({
      ...scored,
      sIndex: 0,
      inputsJson: JSON.stringify({ insufficient: ['index'], index: { score: null, method: null } }),
    });
    assert.equal(repository.listSignals('2024-01-02', '2024-01-02', 'gjd-score-v1')[0].s_index, null);
    const signals = createEtfWhaleReadService({ repository }).signals({ start: '2024-01-02', end: '2024-01-02' });
    assert.equal(signals.days[0].initial.sIndex, null);
    assert.equal(signals.days[0].initial.indexMethod, null);
    assert.ok(signals.days[0].initial.insufficient.includes('index'));
  } finally {
    store.close();
  }
});
