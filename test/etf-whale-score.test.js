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
  assert.equal(confirmed.maxScore, 100);
  assert.equal(confirmed.score, confirmed.sTurnover + confirmed.sBreadth + confirmed.sIndex);
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
    assert.equal(scored.maxScore, 75);
    const inputs = JSON.parse(scored.inputsJson);
    assert.equal(inputs.futuresScored, false);
    assert.equal(inputs.breadth.count, 1);
    assert.equal(inputs.breadth.hasRed, true);
    repository.saveSignal(scored);
    repository.saveSignal({ ...scored, score: scored.score + 1 });
    const saved = repository.listSignals(tradeDate, tradeDate, 'gjd-score-v1');
    assert.equal(saved.length, 1);
    assert.equal(saved[0].s_breadth, 20);

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
  } finally {
    store.close();
  }
});
