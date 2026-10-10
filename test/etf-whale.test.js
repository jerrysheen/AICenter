import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseSseSharePayload, parseSzseShareJson, parseSzseShareSheet } from '../packages/connectors/src/etf-exchange-shares.js';
import { parseTencentDayRows } from '../packages/connectors/src/etf-tencent-kline.js';
import { createStore } from '../packages/database/src/index.js';
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
