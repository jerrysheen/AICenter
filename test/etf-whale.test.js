import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseCffexPositionXml } from '../packages/connectors/src/cffex-position.js';
import { parseSseSharePayload, parseSzseShareJson, parseSzseShareSheet } from '../packages/connectors/src/etf-exchange-shares.js';
import { parseEastmoneyKlines, parseSinaKlinePayload } from '../packages/connectors/src/etf-sina-kline.js';
import { parseTencentDayRows } from '../packages/connectors/src/etf-tencent-kline.js';
import { columnWidth } from '../packages/connectors/src/xlsx-workbook.js';
import { citicNetShort } from '../packages/domain/src/etf-whale/futures.js';
import { indexSessionShape, indexShapeHit } from '../packages/domain/src/etf-whale/session-shape.js';
import { createStore } from '../packages/database/src/index.js';
import { isApiTokenAllowlisted } from '../apps/web/src/http/api-token-access.js';
import { createRouter } from '../apps/web/src/http/router.js';
import { createEtfWhaleRoutes } from '../apps/web/src/routes/etf-whale-routes.js';
import { etfWhaleSyncWindow, syncEtfWhale } from '../packages/runtime/src/etf-whale-sync.js';
import { ensureEtfWhaleSchedule } from '../packages/runtime/src/etf-whale-schedule.js';
import {
  YI,
  aggregatePool,
  buildCodeSeries,
  classifyShareJump,
  disclosureUsableOn,
  lotToShares,
  percentileInclusive,
  shareUnitFactor,
  typicalPrice,
  turnoverFromTypical,
  wanFenToShares,
  yuanToYi,
} from '../packages/domain/src/etf-whale/calculate.js';
import { compareEtfDay, compareFixedSample, referenceFlowYi } from '../packages/domain/src/etf-whale/parity.js';
import { assertUniquePool, referencePool } from '../packages/domain/src/etf-whale/universe.js';

test('ETF 单位换算把万份、手和元折成份与亿元', () => {
  assert.equal(wanFenToShares(2646678.77), 26466787700);
  assert.equal(lotToShares(43947412), 4394741200);
  assert.equal(yuanToYi(1e8), 1);
  assert.equal(wanFenToShares('2,655.93'), 26559300);
});

test('前复权典型价和估算成交额复现 159915 2026-07-31', () => {
  const typical = typicalPrice(3.437, 3.486, 3.367, 3.368);
  assert.equal(typical, 3.4145);
  const turnover = turnoverFromTypical(typical, 43947412);
  assert.equal(Math.round(turnover / YI * 10_000) / 10_000, 150.0584);
});

test('份额变化只用上一交易日，缺失日不拿更早一天顶上', () => {
  const shares = new Map([
    ['2026-07-29', 100e8],
    ['2026-07-31', 110e8],
  ]);
  const quotes = new Map([
    ['2026-07-29', bar(2)],
    ['2026-07-30', bar(2)],
    ['2026-07-31', bar(2)],
  ]);
  const rows = buildCodeSeries({
    code: '159915',
    tradingDates: ['2026-07-29', '2026-07-30', '2026-07-31'],
    sharesByDate: shares,
    quotesByDate: quotes,
  });
  const latest = rows.at(-1);
  assert.equal(latest.reason, 'missing_prior_shares');
  assert.equal(latest.deltaShares, null);
  assert.equal(latest.flowCny, null);
});

test('接近整数倍的份额跳变换算到当前份额单位，剩余差额仍是申赎', () => {
  assert.equal(shareUnitFactor(121864307400, 62347244000), 0.5);
  assert.equal(shareUnitFactor(2903940000, 5655870000), null);
  const rows = buildCodeSeries({
    code: '510310',
    tradingDates: ['2024-09-19', '2024-09-20'],
    sharesByDate: new Map([
      ['2024-09-19', 121864307400],
      ['2024-09-20', 62347244000],
    ]),
    quotesByDate: new Map([
      ['2024-09-19', bar(2.934)],
      ['2024-09-20', bar(2.938)],
    ]),
  });
  assert.equal(rows[0].sharesYi, 609.3215);
  assert.equal(rows[1].sharesYi, 623.4724);
  assert.equal(rows[1].deltaYi, 14.1509);
  assert.equal(rows[1].adjustment.kind, 'share_unit');
  assert.equal(rows[1].flowComparable, true);
  const jump = classifyShareJump({ previousShares: 100, shares: 200, previousClose: 4, close: 2 });
  assert.equal(jump.kind, 'split');
});

test('展示口径净申赎等于四位亿份差额乘以四位典型价', () => {
  const rows = buildCodeSeries({
    code: '159915',
    tradingDates: ['2026-07-30', '2026-07-31'],
    sharesByDate: new Map([
      ['2026-07-30', 21996450000],
      ['2026-07-31', 20397454936],
    ]),
    quotesByDate: new Map([
      ['2026-07-30', { open: 3.35, high: 3.379, low: 3.182, close: 3.27, volumeLots: 1 }],
      ['2026-07-31', { open: 3.437, high: 3.486, low: 3.367, close: 3.368, volumeLots: 43947412 }],
    ]),
  });
  const row = rows[1];
  assert.equal(row.sharesYi, 203.9745);
  assert.equal(row.deltaYi, -15.99);
  assert.equal(Math.round(row.flowYi * 10) / 10, -54.6);
  assert.equal(row.flowComparable, true);
  assert.equal(row.rolling.d5.complete, false);
  const fixed = compareFixedSample(rows);
  const sample = fixed.etfs.find((item) => item.code === '159915');
  assert.equal(sample.deltaStatus, 'PASS');
  assert.equal(sample.flowStatus, 'PASS');
});

test('历史分位包含当日、使用绝对值，窗口从 2024-01-01 起', () => {
  assert.equal(percentileInclusive([1, 2, 3], 2), (2 / 3) * 100);
  const shares = new Map();
  const quotes = new Map();
  const dates = ['2024-01-02', '2024-01-03', '2024-01-04'];
  shares.set(dates[0], 100e8);
  quotes.set(dates[0], bar(1, 10));
  shares.set(dates[1], 101e8);
  quotes.set(dates[1], bar(1, 20));
  shares.set(dates[2], 90e8);
  quotes.set(dates[2], bar(1, 30));
  const rows = buildCodeSeries({ code: '510300', tradingDates: dates, sharesByDate: shares, quotesByDate: quotes });
  const latest = rows[2];
  assert.equal(latest.percentiles.since20240101.window, 'since_2024_01_01_inclusive');
  assert.equal(latest.percentiles.since20240101.sampleFlow, 2);
  assert.ok(latest.percentiles.since20240101.absFlow > 50);
  assert.equal(latest.percentiles.rolling252.comparableToReferenceSite, false);
});

test('观察池 20 只不重复，588000 不进入合计', () => {
  assertUniquePool();
  const pool = referencePool();
  assert.equal(pool.length, 20);
  assert.equal(pool.some((item) => item.code === '588000'), false);
  const rows = [
    daily('510300', '2026-07-31', 10e8, 1),
    daily('510300', '2026-07-31', 99e8, 1),
    daily('159915', '2026-07-31', -4e8, 1),
  ];
  const total = aggregatePool(rows, { codes: ['510300', '159915'], tradeDate: '2026-07-31' });
  assert.equal(total.flowCny, 6e8);
  assert.equal(total.inflowCount, 1);
  assert.equal(total.outflowCount, 1);
});

test('区间资金流是每日金额求和', () => {
  const rows = [
    daily('510300', '2026-07-30', 2e8, 1),
    daily('510300', '2026-07-31', 3e8, 1),
  ];
  const series = buildCodeSeries({
    code: '510300',
    tradingDates: ['2026-07-30', '2026-07-31'],
    sharesByDate: new Map([['2026-07-30', 10e8], ['2026-07-31', 12e8]]),
    quotesByDate: new Map([
      ['2026-07-30', bar(1, 1)],
      ['2026-07-31', bar(1, 1)],
    ]),
  });
  assert.equal(series[1].rolling.d5.count, 1);
  assert.equal(series[1].flowCny, rows[1].flowCny ? series[1].deltaYi * series[1].typicalPrice * YI : series[1].flowCny);
  assert.ok(Math.abs(series[1].flowCny - 2e8) / 1e8 < 0.01);
});

test('参考站同日对账区分通过、方向和近零相对误差', () => {
  const reference = {
    qfq_total_units_yi: 203.9745,
    qfq_delta_units_yi: -15.99,
    etf_qfq_close: 3.368,
    etf_qfq_avg_price_est: 3.4145,
    etf_qfq_turnover_est_yi: 150.0584,
  };
  assert.equal(Math.round(referenceFlowYi(reference) * 10) / 10, -54.6);
  const ours = {
    code: '159915',
    tradeDate: '2026-07-31',
    sharesYi: 203.9745,
    deltaYi: -15.99,
    closePrice: 3.368,
    typicalPrice: 3.4145,
    turnoverCny: 150.0584 * YI,
    flowYi: referenceFlowYi(reference),
    flowComparable: true,
    shareComparable: true,
    reason: 'ok',
  };
  const matched = compareEtfDay(ours, reference);
  assert.equal(matched.shareStatus, 'PASS');
  assert.equal(matched.flowStatus, 'PASS');
  const flipped = compareEtfDay({ ...ours, flowYi: 54.6 }, reference);
  assert.equal(flipped.directionMatch, false);
  assert.equal(flipped.flowStatus, 'FAIL');
});

test('未公告的持仓披露不能提前用于历史时点', () => {
  assert.equal(disclosureUsableOn({ reportEnd: '2025-12-31', announcedOn: null }, '2026-03-31'), false);
  assert.equal(disclosureUsableOn({ reportEnd: '2025-12-31', announcedOn: '2026-04-20' }, '2026-03-31'), false);
  assert.equal(disclosureUsableOn({ reportEnd: '2025-12-31', announcedOn: '2026-01-21' }, '2026-03-31'), true);
});

test('交易所解析保留单位，重复入库不增加份额行', () => {
  const sse = parseSseSharePayload({
    result: [{ SEC_CODE: '510300', SEC_NAME: '300ETF', STAT_DATE: '2026-07-31', TOT_VOL: '10.5' }],
    pageHelp: { pageCount: 1, total: 1 },
  }, '2026-07-31');
  assert.equal(sse.rows[0].rawUnit, '万份');
  assert.equal(sse.rows[0].shares, 105000);
  const szse = parseSzseShareSheet([['日期', '基金代码', '基金简称', '基金规模(份)'], ['2026-07-31', 159915, '创业板', '20397454936']]);
  assert.equal(szse[0].rawUnit, '份');
  assert.equal(szse[0].shares, 20397454936);
  const json = parseSzseShareJson([{ data: [{ size_date: '2026-07-31', fund_code: '159915', security_short_name: '创业板', current_size: '2,039,745.49' }], metadata: { pagecount: 1 } }]);
  assert.equal(json.rows[0].rawUnit, '万份');
  assert.equal(json.rows[0].shares, 20397454900);
  const bars = parseTencentDayRows([['2026-07-31', '3.437', '3.368', '3.486', '3.367', '43947412']]);
  assert.equal(bars[0].close, 3.368);
  assert.equal(bars[0].volumeLots, 43947412);

  const store = createStore(path.join(mkdtempSync(path.join(tmpdir(), 'etf-whale-')), 'ai-center.db'));
  const repo = store.repositories.etfWhale;
  const row = sse.rows[0];
  const meta = { source: 'sse', dateStart: '2026-07-31', dateEnd: '2026-07-31', status: 'ok', blobPath: 'blobs/etf-whale/sse/2026-07-31.json', contentHash: 'abc', capturedAt: 1, error: '' };
  repo.saveShares([row], meta);
  repo.saveShares([{ ...row, shares: 105000 }], meta);
  assert.equal(repo.listShares(['510300'], 'sse').length, 1);
  repo.saveShares([{ ...row, shares: 106000 }], { ...meta, contentHash: 'def', capturedAt: 2 });
  assert.equal(repo.listShares(['510300'], 'sse')[0].shares, 106000);
  assert.equal(repo.listShares(['510300'], 'sse').length, 1);
});

function responseRecorder() {
  return {
    status: 0,
    body: '',
    writeHead(status) { this.status = status; },
    end(body = '') { this.body = body; },
  };
}

test('series route reads params.values and read-only tokens can GET both ETF routes', async () => {
  assert.equal(isApiTokenAllowlisted('GET', '/api/v1/etf-whale/overview'), true);
  assert.equal(isApiTokenAllowlisted('GET', '/api/v1/etf-whale/etfs/159915'), true);
  assert.equal(isApiTokenAllowlisted('POST', '/api/v1/etf-whale/overview'), false);
  assert.equal(isApiTokenAllowlisted('GET', '/api/v1/etf-whale/etfs/159915/shares'), false);
  assert.equal(isApiTokenAllowlisted('GET', '/api/v1/etf-whale/sync'), false);

  const seen = [];
  const router = createRouter(createEtfWhaleRoutes());
  const response = responseRecorder();
  const handled = await router.dispatch({
    request: { method: 'GET' },
    response,
    url: { pathname: '/api/v1/etf-whale/etfs/159915' },
    identity: { kind: 'api-token', token: { id: 'token-1' } },
    services: {
      etfWhale: {
        series(code) {
          seen.push(code);
          return {
            code,
            inPool: code === '159915',
            points: code === '159915' ? [{ tradeDate: '2026-10-08' }] : [],
          };
        },
      },
    },
  });
  assert.equal(handled, true);
  assert.deepEqual(seen, ['159915']);
  const body = JSON.parse(response.body);
  assert.equal(response.status, 200);
  assert.equal(body.series.inPool, true);
  assert.equal(body.series.points[0].tradeDate, '2026-10-08');

  const denied = responseRecorder();
  await router.dispatch({
    request: { method: 'GET' },
    response: denied,
    url: { pathname: '/api/v1/etf-whale/overview' },
    identity: null,
    services: { etfWhale: { overview() { throw new Error('must not run'); } } },
  });
  assert.equal(denied.status, 401);
});

test('an empty SSE day stays inside the lookback and is fetched again', async () => {
  const tomorrow = etfWhaleSyncWindow({}, { AI_CENTER_ETF_WHALE_LOOKBACK_DAYS: '12' }, new Date('2026-10-15T18:30:00+08:00'));
  assert.equal(tomorrow.endDate, '2026-10-15');
  assert.equal(tomorrow.startDate, '2026-10-04');
  const root = mkdtempSync(path.join(tmpdir(), 'etf-whale-empty-'));
  const store = createStore(path.join(root, 'ai-center.db'));
  try {
    const seen = [];
    const fetchImpl = async (url) => {
      const text = String(url);
      if (text.includes('szse.cn')) {
        return { ok: false, status: 500, headers: { get: () => '' }, arrayBuffer: async () => new ArrayBuffer(0) };
      }
      const date = new URL(text).searchParams.get('STAT_DATE');
      seen.push(date);
      const result = date === '2026-10-06'
        ? [{ SEC_CODE: '510300', SEC_NAME: '沪深300ETF', STAT_DATE: date, TOT_VOL: '100' }]
        : [];
      const body = Buffer.from(JSON.stringify({ result, pageHelp: { pageCount: 1, total: result.length } }));
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        arrayBuffer: async () => Uint8Array.from(body).buffer,
      };
    };
    const options = {
      repository: store.repositories.etfWhale,
      dataDirectory: root,
      startDate: '2026-10-06',
      endDate: '2026-10-14',
      quotes: false,
      pauseMs: 0,
      today: '2026-10-15',
      fetchImpl,
      instruments: [{
        code: '510300', exchange: 'SH', name: '沪深300ETF', groupKey: '宽基',
        referencePool: true, source: 'test', verifiedOn: '2026-10-09',
      }],
    };
    await syncEtfWhale(options);
    assert.equal(store.repositories.etfWhale.getFetch('sse', '2026-10-14', '2026-10-14').status, 'pending');
    assert.equal(store.repositories.etfWhale.getFetch('sse', '2026-10-08', '2026-10-08').status, 'pending');
    assert.equal(store.repositories.etfWhale.getFetch('sse', '2026-10-07', '2026-10-07').status, 'holiday');
    assert.equal(store.repositories.etfWhale.getFetch('sse', '2026-10-06', '2026-10-06').status, 'ok');
    seen.length = 0;
    await syncEtfWhale(options);
    assert.equal(seen.includes('2026-10-14'), true);
    assert.equal(seen.includes('2026-10-08'), true);
    assert.equal(seen.includes('2026-10-07'), false);
    assert.equal(seen.includes('2026-10-06'), false);
  } finally {
    store.close();
  }
});

test('ETF whale sync is scheduled after the Shanghai close and backfills a short window', () => {
  const window = etfWhaleSyncWindow({}, { AI_CENTER_ETF_WHALE_LOOKBACK_DAYS: '12' }, new Date('2026-10-14T10:30:00+08:00'));
  assert.equal(window.endDate, '2026-10-14');
  assert.equal(window.startDate, '2026-10-03');
  assert.deepEqual(etfWhaleSyncWindow({ startDate: '2026-10-08', endDate: '2026-10-09' }, {}, new Date('2026-10-14T10:30:00+08:00')), {
    startDate: '2026-10-08',
    endDate: '2026-10-09',
  });

  const store = createStore(path.join(mkdtempSync(path.join(tmpdir(), 'etf-whale-schedule-')), 'ai-center.db'));
  try {
    const now = Date.parse('2026-10-14T02:00:00Z');
    const saved = ensureEtfWhaleSchedule(store, {}, now);
    const shares = saved.filter((item) => item.key.startsWith('etf.whale.shares.') && item.enabled);
    assert.deepEqual(shares.map((item) => [item.schedule.hour, item.schedule.minute]), [
      [9, 0], [12, 0], [16, 30], [18, 30], [20, 30],
    ]);
    assert.equal(shares[3].maxAttempts, 3);
    assert.equal(shares[3].nextRunAt, Date.parse('2026-10-14T10:30:00Z'));
    assert.equal(shares[3].input.task, 'shares');
    const market = saved.find((item) => item.key === 'etf.whale.market');
    assert.equal(market.schedule.hour, 15);
    assert.equal(market.schedule.minute, 30);
    assert.equal(market.jobType, 'etf.whale.market');
    const futures = saved.find((item) => item.key === 'etf.whale.futures');
    assert.equal(futures.schedule.hour, 17);
    assert.equal(futures.schedule.minute, 0);
    assert.equal(saved.find((item) => item.key === 'etf.whale.sync').enabled, false);
    const moved = ensureEtfWhaleSchedule(store, { AI_CENTER_ETF_WHALE_SYNC: '0' }, now);
    assert.equal(moved.every((item) => item.enabled === false), true);
  } finally {
    store.close();
  }
});

test('pending share dates are fetched outside the lookback, then go stale after five trading days', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'etf-whale-pending-'));
  const store = createStore(path.join(root, 'ai-center.db'));
  try {
    const repo = store.repositories.etfWhale;
    repo.saveFetch({
      source: 'sse', dateStart: '2026-10-08', dateEnd: '2026-10-08', status: 'pending',
      rowCount: 0, error: '', blobPath: '', contentHash: '', capturedAt: 1,
    });
    const seen = [];
    const fetchImpl = async (url) => {
      const text = String(url);
      if (text.includes('szse.cn')) {
        return { ok: false, status: 500, headers: { get: () => '' }, arrayBuffer: async () => new ArrayBuffer(0) };
      }
      seen.push(new URL(text).searchParams.get('STAT_DATE'));
      const body = Buffer.from(JSON.stringify({ result: [], pageHelp: { pageCount: 1, total: 0 } }));
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, arrayBuffer: async () => Uint8Array.from(body).buffer };
    };
    const base = {
      repository: repo,
      dataDirectory: root,
      quotes: false,
      pauseMs: 0,
      fetchImpl,
      instruments: [{
        code: '510300', exchange: 'SH', name: '沪深300ETF', groupKey: '宽基',
        referencePool: true, source: 'test', verifiedOn: '2026-10-09',
      }],
    };
    await syncEtfWhale({ ...base, startDate: '2026-10-15', endDate: '2026-10-15', today: '2026-10-15' });
    assert.equal(seen.includes('2026-10-08'), true);
    assert.equal(repo.getFetch('sse', '2026-10-08', '2026-10-08').status, 'pending');
    const stale = [];
    seen.length = 0;
    await syncEtfWhale({
      ...base,
      startDate: '2026-10-16',
      endDate: '2026-10-16',
      today: '2026-10-16',
      onStale: (date) => stale.push(date),
    });
    assert.equal(seen.includes('2026-10-08'), false);
    assert.equal(repo.getFetch('sse', '2026-10-08', '2026-10-08').status, 'stale');
    assert.deepEqual(stale, ['2026-10-08']);
  } finally {
    store.close();
  }
});

test('a completed Shenzhen segment is skipped, an incomplete one in the same window is fetched again', async () => {
  const calls = await szseCalls('2026-10-15');
  assert.equal(calls.covered, 0);
  assert.equal(calls.behind, 1);
});

test('xlsx width does not spread every cell into Math.max', () => {
  const rows = new Map([[1, { 0: 'a', 3: 'd' }]]);
  assert.equal(columnWidth(rows), 4);
  const wide = { };
  for (let index = 0; index < 20000; index += 1) wide[index] = 1;
  assert.equal(columnWidth(new Map([[1, wide]])), 20000);
});

test('sina 5-minute bars and eastmoney amount parse the fields scoring needs', () => {
  const bars = parseSinaKlinePayload(JSON.stringify([
    { day: '2026-10-15 14:30:00', open: '1', high: '2', low: '0.5', close: '1.2', volume: '100' },
    { day: '2026-10-15 14:35:00', open: '1', high: '1', low: '2', close: '1', volume: '1' },
  ]));
  assert.equal(bars.length, 1);
  assert.equal(bars[0].barTime, '2026-10-15 14:30');
  const daily = parseEastmoneyKlines({
    data: { klines: ['2026-10-15,4.10,4.20,4.30,4.00,1000,19413000000,1,1,0.1,1'] },
  });
  assert.equal(daily[0].amountCny, 19_413_000_000);
  assert.equal(daily[0].open, 4.1);
  assert.equal(daily[0].close, 4.2);
  const shape = indexSessionShape({
    prevClose: 100,
    close: 100,
    bars: [
      { barTime: '2026-10-15 10:00', low: 98, close: 99 },
      { barTime: '2026-10-15 14:30', low: 99, close: 99 },
    ],
  });
  assert.ok(Math.abs(shape.lowDropPct + 0.02) < 1e-12);
  assert.ok(shape.reboundPct >= 0.01);
  assert.equal(indexShapeHit(shape), true);
  assert.equal(indexShapeHit({ lowDropPct: -0.009, reboundPct: 0.02, tailPct: 0.009 }), false);
});

test('cffex ranks identify 中信期货 by party id even when the short name is garbled', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <positionRank>
      <data><instrumentId>IF2510</instrumentId><tradingDay>20261015</tradingDay><dataTypeId>2</dataTypeId><rank>1</rank><shortname>????</shortname><volume>8000</volume><varVolume>-120</varVolume><partyid>0018</partyid></data>
      <data><instrumentId>IF2510</instrumentId><tradingDay>20261015</tradingDay><dataTypeId>1</dataTypeId><rank>3</rank><shortname>乱码</shortname><volume>3000</volume><varVolume>10</varVolume><partyid>0018</partyid></data>
      <data><instrumentId>IF2510</instrumentId><tradingDay>20261015</tradingDay><dataTypeId>2</dataTypeId><rank>2</rank><shortname>其他</shortname><volume>9000</volume><varVolume>1</varVolume><partyid>0001</partyid></data>
    </positionRank>`;
  const rows = parseCffexPositionXml(xml, { product: 'IF', tradeDate: '2026-10-15', sourceUrl: 'http://www.cffex.com.cn/sj/ccpm/202610/15/IF.xml' });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].partyId, '0018');
  assert.equal(citicNetShort(rows, '0018').IF.netShort, 5000);
  assert.equal(citicNetShort(rows, '0001').IF.netShort, 9000);
});

test('old Shenzhen stack-overflow fetches are marked superseded and kept', () => {
  const store = createStore(path.join(mkdtempSync(path.join(tmpdir(), 'etf-whale-stack-')), 'ai-center.db'));
  try {
    const repo = store.repositories.etfWhale;
    repo.saveFetch({
      source: 'szse-xlsx', dateStart: '2026-09-01', dateEnd: '2026-09-30', status: 'error', rowCount: 0,
      error: 'Maximum call stack size exceeded', blobPath: 'blobs/etf-whale/szse/old.xlsx', contentHash: 'abc', capturedAt: 1,
    });
    repo.saveFetch({
      source: 'szse-xlsx', dateStart: '2026-10-01', dateEnd: '2026-10-08', status: 'error', rowCount: 0,
      error: 'HTTP 500', blobPath: '', contentHash: '', capturedAt: 1,
    });
    assert.equal(repo.supersedeStackOverflowFetches(), 1);
    assert.equal(repo.getFetch('szse-xlsx', '2026-09-01', '2026-09-30').status, 'superseded');
    assert.equal(repo.getFetch('szse-xlsx', '2026-09-01', '2026-09-30').blob_path, 'blobs/etf-whale/szse/old.xlsx');
    assert.equal(repo.getFetch('szse-xlsx', '2026-10-01', '2026-10-08').status, 'error');
    assert.equal(repo.supersedeStackOverflowFetches(), 0);
  } finally {
    store.close();
  }
});

async function szseCalls(shareDate) {
  async function run(tradeDate) {
    const root = mkdtempSync(path.join(tmpdir(), 'etf-whale-szse-'));
    const store = createStore(path.join(root, 'ai-center.db'));
    try {
      const repo = store.repositories.etfWhale;
      repo.saveShares([{
        source: 'szse-xlsx', code: '159915', name: '创业板', tradeDate, rawValue: 1, rawUnit: '份', shares: 100,
      }], {
        source: 'szse-xlsx', dateStart: '2026-10-13', dateEnd: '2026-10-15', status: 'ok',
        blobPath: '', contentHash: 'abc', capturedAt: 1, error: '',
      });
      let calls = 0;
      const fetchImpl = async (url) => {
        if (String(url).includes('szse.cn')) {
          calls += 1;
          return { ok: false, status: 500, headers: { get: () => '' }, arrayBuffer: async () => new ArrayBuffer(0) };
        }
        const body = Buffer.from(JSON.stringify({ result: [], pageHelp: { pageCount: 1, total: 0 } }));
        return { ok: true, status: 200, headers: { get: () => 'application/json' }, arrayBuffer: async () => Uint8Array.from(body).buffer };
      };
      await syncEtfWhale({
        repository: repo,
        dataDirectory: root,
        startDate: '2026-10-13',
        endDate: '2026-10-15',
        quotes: false,
        pauseMs: 0,
        today: '2026-10-15',
        fetchImpl,
        instruments: [{
          code: '159915', exchange: 'SZ', name: '创业板ETF', groupKey: '宽基',
          referencePool: true, source: 'test', verifiedOn: '2026-10-09',
        }],
      });
      return calls;
    } finally {
      store.close();
    }
  }
  return { covered: await run(shareDate), behind: await run('2026-10-13') };
}

function bar(close, volumeLots = 100) {
  return { open: close, high: close, low: close, close, volumeLots };
}

function daily(code, tradeDate, flowCny, typicalPriceValue) {
  return {
    code,
    tradeDate,
    flowCny,
    deltaShares: flowCny,
    flowComparable: true,
    rawShares: 1,
    typicalPrice: typicalPriceValue,
  };
}
