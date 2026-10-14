import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { parseContract } from '../packages/contracts/src/index.js';
import {
  createTushareClient,
  isCnIndexYahooSymbol,
  seriesFromTushareDaily,
  tushareDailyApiName,
} from '../packages/connectors/src/tushare.js';
import { runMigrations } from '../packages/database/src/migrations.js';
import { createTradingRepository } from '../packages/database/src/repositories/trading-repository.js';
import { cnDailyHistoryHasGap } from '../packages/domain/src/market-history-bars.js';
import { createTradingService } from '../packages/domain/src/trading-service.js';
import { HistorySeriesSchema } from '../packages/source/src/schemas.js';

const FIELDS = ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'vol', 'amount'];

function at(iso) {
  return Date.parse(`${iso}T00:00:00+08:00`);
}

function bar(iso, close = 3, extra = {}) {
  return {
    at: at(iso),
    open: close,
    high: close + 0.05,
    low: close - 0.05,
    close,
    volume: 10,
    ...extra,
  };
}

function dates(bars) {
  return bars.map((item) => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(item.at)));
}

function payload(items) {
  return { code: 0, data: { fields: FIELDS, items } };
}

test('indexes use index_daily, ETFs use fund_daily, and amount is kept', async () => {
  assert.equal(isCnIndexYahooSymbol('399006.SZ'), true);
  assert.equal(isCnIndexYahooSymbol('000688.SS'), true);
  assert.equal(isCnIndexYahooSymbol('000001.SS'), true);
  assert.equal(isCnIndexYahooSymbol('000001.SZ'), false);
  assert.equal(isCnIndexYahooSymbol('159915.SZ'), false);
  assert.equal(tushareDailyApiName('399006.SZ'), 'index_daily');
  assert.equal(tushareDailyApiName('000688.SS'), 'index_daily');
  assert.equal(tushareDailyApiName('159915.SZ'), 'fund_daily');
  assert.equal(tushareDailyApiName('588000.SS'), 'fund_daily');
  assert.equal(tushareDailyApiName('510300.SS'), 'fund_daily');
  assert.equal(tushareDailyApiName('600519.SS'), 'daily');

  const calls = [];
  const client = createTushareClient({
    token: 'test-token',
    fetchImpl: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      const api = calls.at(-1).api_name;
      const code = api === 'index_daily' ? '399006.SZ' : '159915.SZ';
      const symbol = api === 'index_daily' ? '399006.SZ' : '159915.SZ';
      return {
        ok: true,
        json: async () => payload([
          [symbol, '20261013', 3.1, 3.2, 3.0, 3.05, 1000, 4567.8],
          [code, '20261014', 3.029, 2.981, 2.9, 3.01, 100, 10],
        ]),
      };
    },
  });
  const index = await client.fetchHistory(['399006.SZ'], { range: '1mo', interval: '1d' });
  const etf = await client.fetchHistory(['159915.SZ'], { range: '1mo', interval: '1d' });
  assert.deepEqual(calls.map((item) => item.api_name), ['index_daily', 'fund_daily']);
  assert.equal(calls[0].fields, 'ts_code,trade_date,open,high,low,close,vol,amount');
  assert.equal(index[0].bars.length, 1);
  assert.equal(index[0].bars[0].amount, 4567.8);
  assert.equal(dates(index[0].bars)[0], '2026-10-13');
  assert.equal(etf[0].bars.length, 1);
  assert.equal(etf[0].bars[0].amount, 4567.8);
  const parsed = parseContract(HistorySeriesSchema, index);
  assert.equal(parsed[0].bars[0].amount, 4567.8);
  assert.equal(parsed[0].points.length, 1);
});

test('invalid OHLC is skipped before a daily series is built', () => {
  const series = seriesFromTushareDaily(payload([
    ['159915.SZ', '20261013', 3.1, 3.2, 3.0, 3.05, 1000, 20],
    ['159915.SZ', '20261014', 3.029, 2.981, 2.9, 3.01, 100, 10],
  ]), '159915.SZ');
  assert.deepEqual(dates(series.bars), ['2026-10-13']);
  assert.equal(series.bars[0].amount, 20);
});

test('a missing A-share session is a gap and a holiday is not', () => {
  const beforeClose = Date.parse('2026-10-14T02:00:00Z');
  assert.equal(cnDailyHistoryHasGap([bar('2026-10-09'), bar('2026-10-12')], beforeClose), true);
  assert.equal(cnDailyHistoryHasGap([
    bar('2026-10-09'),
    bar('2026-10-12'),
    bar('2026-10-13'),
  ], beforeClose), false);
  const afterHoliday = Date.parse('2026-10-08T08:30:00Z');
  assert.equal(cnDailyHistoryHasGap([bar('2026-09-30'), bar('2026-10-08')], afterHoliday), false);
});

test('history cache refetches a missing session and does not store an unfinished or invalid bar', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-history-gap-'));
  const database = new Database(path.join(directory, 'test.db'));
  runMigrations(database);
  const repository = createTradingRepository(database, () => {});
  let now = Date.parse('2026-10-14T02:00:00Z');
  let upstream = [
    bar('2026-10-09'),
    bar('2026-10-12'),
    bar('2026-10-13'),
    bar('2026-10-14', 3.029, { high: 2.981, low: 2.9 }),
  ];
  let calls = 0;
  const service = createTradingService({
    tradingRepository: repository,
    now: () => now,
    sourcePort: {
      async read() {
        calls += 1;
        return { data: [{ symbol: '159915.SZ', bars: upstream }], observedAt: now };
      },
    },
  });
  try {
    repository.putMarketHistoryCache({
      symbol: '159915.SZ',
      range: '6mo',
      interval: '1d',
      bars: [bar('2026-10-09'), bar('2026-10-12')],
      updatedAt: now - 60_000,
    });
    const healed = await service.getQuoteHistory({ symbol: '159915.sz', range: '6mo', interval: '1d' });
    assert.equal(calls, 1);
    assert.deepEqual(dates(healed.bars), ['2026-10-09', '2026-10-12', '2026-10-13']);
    const stored = repository.getMarketHistoryCache('159915.SZ', '6mo', '1d');
    assert.deepEqual(dates(stored.bars), ['2026-10-09', '2026-10-12', '2026-10-13']);
    assert.equal(stored.bars.some((item) => item.high < item.open), false);

    calls = 0;
    const cached = await service.getQuoteHistory({ symbol: '159915.SZ', range: '6mo', interval: '1d' });
    assert.equal(calls, 0);
    assert.deepEqual(dates(cached.bars), ['2026-10-09', '2026-10-12', '2026-10-13']);

    now = Date.parse('2026-10-14T07:00:00Z');
    upstream = [
      bar('2026-10-09'),
      bar('2026-10-12'),
      bar('2026-10-13'),
      bar('2026-10-14', 3.02, { amount: 88 }),
    ];
    const closed = await service.getQuoteHistory({ symbol: '159915.SZ', range: '6mo', interval: '1d' });
    assert.equal(calls, 1);
    assert.deepEqual(dates(closed.bars), ['2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14']);
    assert.equal(closed.bars.at(-1).amount, 88);
    assert.equal(repository.getMarketHistoryCache('159915.SZ', '6mo', '1d').bars.at(-1).amount, 88);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
