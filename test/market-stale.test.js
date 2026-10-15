import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarketService, marketStaleMs } from '../packages/source/src/market/service.js';
import { usRegularSessionAt } from '../packages/source/src/market/boards.js';
import {
  captureMarketBoards,
  marketBoardSnapshotKey,
  marketUsFreshMs,
  usBoardFreshnessError,
} from '../packages/runtime/src/web-snapshot-jobs.js';
import { marketStaleLabel } from '../apps/web/public/home-timeline.js';
import { createMarketBoardReader } from '../packages/source/src/market/board-read.js';

const catalog = {
  us: {
    groups: ['全部', '指数'],
    indices: [{ symbol: '^GSPC', name: '标普 500', group: '指数', summary: '' }],
    watchlist: [
      { symbol: 'AAPL', name: 'Apple', group: '全部', summary: '' },
      { symbol: 'NVDA', name: 'NVIDIA', group: '全部', summary: '' },
      { symbol: 'MSFT', name: 'Microsoft', group: '全部', summary: '' },
      { symbol: 'AMD', name: 'AMD', group: '全部', summary: '' },
    ],
  },
  asia: { groups: ['全部'], indices: [], watchlist: [] },
  cn: { groups: ['全部'], indices: [], watchlist: [] },
};

function quote(symbol, price) {
  return {
    symbol,
    name: symbol,
    lastPrice: price,
    prevClose: price - 1,
    currency: 'USD',
    session: 'regular',
    provider: 'yahoo',
  };
}

function serviceWith(quotesFor, logs, clock) {
  return createMarketService({
    marketCatalog: catalog,
    ttlMs: 10_000,
    staleMs: 180_000,
    inflightTimeoutMs: 1_000,
    now: () => clock.value,
    log(_level, message) { logs.push(message); },
    tushare: null,
    sinaFutures: null,
    xueqiuQuotes: { fetchQuotes: async () => [] },
    cnQuotes: { fetchQuotes: async () => [] },
    yahoo: {
      fetchQuotes: async () => quotesFor(),
    },
  });
}

test('kept quotes stay on the board and become stale after the time limit', async () => {
  const logs = [];
  const clock = { value: 1_000_000 };
  let mode = 'live';
  let calls = 0;
  const service = serviceWith(() => {
    calls += 1;
    if (mode === 'empty') return { quotes: [], session: 'closed' };
    if (mode === 'thin') return { quotes: [quote('AAPL', 3)], session: 'regular' };
    if (mode === 'boom') throw new Error('Yahoo HTTP 401');
    return {
      quotes: [quote('^GSPC', 5000), quote('AAPL', 100), quote('NVDA', 200), quote('MSFT', 300), quote('AMD', 400)],
      session: 'regular',
    };
  }, logs, clock);

  const first = await service.getBoard({ board: 'us' });
  assert.equal(first.indices.find((item) => item.symbol === '^GSPC').lastPrice, 5000);
  assert.equal(first.indices.find((item) => item.symbol === '^GSPC').provider, 'yahoo');
  assert.equal(first.stale, undefined);
  const fetchedAt = first.fetchedAt;

  mode = 'empty';
  clock.value += 60_000;
  const kept = await service.getBoard({ board: 'us' });
  assert.equal(kept.indices.find((item) => item.symbol === '^GSPC').lastPrice, 5000);
  assert.equal(kept.stale, undefined);
  assert.equal(kept.fetchedAt, fetchedAt);
  assert.match(logs.join('\n'), /美股报价不足 got=0 expected=5/);

  clock.value += 5_000;
  const cached = await service.getBoard({ board: 'us' });
  assert.equal(calls, 2);
  assert.equal(cached.fetchedAt, fetchedAt);

  clock.value += 130_000;
  mode = 'boom';
  const stale = await service.getBoard({ board: 'us' });
  assert.equal(stale.stale, true);
  assert.equal(stale.fetchedAt, fetchedAt);
  assert.equal(stale.indices.find((item) => item.symbol === '^GSPC').lastPrice, 5000);
  assert.match(logs.join('\n'), /美股行情失败 Yahoo HTTP 401/);
  assert.equal(marketStaleLabel(stale), '已过期 · 1月1日 08:16');

  mode = 'thin';
  clock.value += 20_000;
  await service.getBoard({ board: 'us' });
  assert.match(logs.join('\n'), /美股报价不足 got=1 expected=5/);
});

test('market stale window and US snapshot freshness read the environment', () => {
  assert.equal(marketStaleMs({}), 180_000);
  assert.equal(marketStaleMs({ AI_CENTER_MARKET_STALE_MS: '120000' }), 120_000);
  assert.throws(() => marketStaleMs({ AI_CENTER_MARKET_STALE_MS: '10' }), /AI_CENTER_MARKET_STALE_MS/);
  assert.equal(marketUsFreshMs({}), 600_000);
  assert.equal(marketUsFreshMs({ AI_CENTER_MARKET_US_FRESH_MS: '600000' }), 600_000);
  const open = Date.parse('2026-10-15T14:00:00Z');
  const closed = Date.parse('2026-10-15T21:30:00Z');
  assert.equal(usRegularSessionAt(open), 'regular');
  assert.equal(usRegularSessionAt(closed), 'closed');
  assert.equal(usBoardFreshnessError({ fetchedAt: open - 11 * 60_000 }, open, 10 * 60_000), '美股看板行情已 11 分钟未更新');
  assert.equal(usBoardFreshnessError({ fetchedAt: open - 11 * 60_000 }, closed, 10 * 60_000), '');
  const at = Date.parse('2026-10-15T13:40:00Z');
  assert.equal(marketStaleLabel({ stale: true, fetchedAt: at }, at), '已过期 · 10月15日 21:40');
  assert.equal(marketStaleLabel({ fetchedAt: at }, at + 120_000), '');
  assert.equal(marketStaleLabel({ fetchedAt: at }, at + 180_000), '已过期 · 10月15日 21:40');
});

test('US trading hours fail the snapshot after the freshness window and still keep the board', async () => {
  const at = Date.parse('2026-10-15T14:00:00Z');
  const old = at - 11 * 60_000;
  const saved = [];
  const sourcePort = {
    async read(sourceId) {
      const board = String(sourceId).replace(/^market\./, '');
      return {
        data: {
          board,
          mode: 'live',
          fetchedAt: board === 'us' ? old : at,
          stale: board === 'us',
          session: 'regular',
          note: 'snapshot',
          groups: [],
          indices: [],
          watchlist: [{ symbol: 'AAPL', name: 'Apple', lastPrice: 345, changePct: 0.8, currency: 'USD', session: 'regular' }],
          gainers: [],
          losers: [],
          breadth: { advancers: 1, decliners: 0, unchanged: 0 },
        },
      };
    },
  };
  const warnings = [];
  await assert.rejects(() => captureMarketBoards({
    sourcePort,
    repository: {
      saveSnapshot(_workspace, key, payload) { saved.push({ key, payload }); },
    },
    now: () => at,
    env: {},
    log(_level, message) { warnings.push(message); },
  }), /美股看板行情已 11 分钟未更新/);
  const us = saved.find((item) => item.key === marketBoardSnapshotKey('us'));
  assert.equal(us.payload.fetchedAt, old);
  assert.equal(us.payload.watchlist[0].lastPrice, 345);
  assert.match(warnings.join('\n'), /11 分钟未更新/);

  saved.length = 0;
  const closed = Date.parse('2026-10-15T21:30:00Z');
  const done = await captureMarketBoards({
    sourcePort,
    repository: {
      saveSnapshot(_workspace, key, payload) { saved.push({ key, payload }); },
    },
    now: () => closed,
    env: {},
    log() {},
  });
  assert.equal(done.boards, 5);
});

test('a stored snapshot is marked stale when it is read, using the current time', async () => {
  const fetchedAt = Date.parse('2026-10-15T13:40:00Z');
  const clock = { value: fetchedAt + 60_000 };
  const payload = {
    board: 'us',
    mode: 'live',
    fetchedAt,
    session: 'regular',
    note: 'snapshot',
    groups: [],
    indices: [{ symbol: 'AAPL', name: 'Apple', lastPrice: 100, currency: 'USD', session: 'regular' }],
    watchlist: [],
    gainers: [],
    losers: [],
    breadth: { advancers: 0, decliners: 0, unchanged: 0 },
  };
  const reader = createMarketBoardReader({
    repository: { readSnapshot: () => ({ payload }) },
    now: () => clock.value,
    staleMs: 180_000,
    ttlMs: 60_000,
  });
  const fresh = await reader.read({ board: 'us' });
  assert.equal(fresh.market.stale, undefined);
  assert.equal(fresh.market.indices[0].lastPrice, 100);
  clock.value = fetchedAt + 180_000;
  const stale = await reader.read({ board: 'us' });
  assert.equal(stale.market.stale, true);
  assert.equal(stale.market.fetchedAt, fetchedAt);
  assert.equal(payload.stale, undefined);
  assert.equal(marketStaleLabel(stale.market, clock.value), '已过期 · 10月15日 21:40');
});

test('US snapshot is stored before a slow A-share read finishes', async () => {
  let releaseCn;
  const gate = new Promise((resolve) => { releaseCn = resolve; });
  const saved = [];
  const at = Date.parse('2026-10-15T14:00:00Z');
  const sourcePort = {
    async read(sourceId) {
      const board = String(sourceId).replace(/^market\./, '');
      if (board === 'cn') await gate;
      return {
        data: {
          board,
          mode: 'live',
          fetchedAt: at,
          session: 'regular',
          note: 'snapshot',
          groups: [],
          indices: [],
          watchlist: [],
          gainers: [],
          losers: [],
          breadth: { advancers: 0, decliners: 0, unchanged: 0 },
        },
      };
    },
  };
  const running = captureMarketBoards({
    sourcePort,
    repository: { saveSnapshot(_workspace, key) { saved.push(key); } },
    now: () => at,
    env: {},
    log() {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(saved.includes(marketBoardSnapshotKey('us')));
  assert.ok(saved.includes(marketBoardSnapshotKey('overview')));
  assert.equal(saved.includes(marketBoardSnapshotKey('cn')), false);
  releaseCn();
  const done = await running;
  assert.equal(done.boards, 5);
  assert.ok(saved.includes(marketBoardSnapshotKey('cn')));
});

test('quotes that arrive after the board timeout stay available for the next read', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const service = createMarketService({
    marketCatalog: catalog,
    ttlMs: 60_000,
    inflightTimeoutMs: 20,
    now: () => 5_000_000,
    log() {},
    tushare: null,
    sinaFutures: null,
    xueqiuQuotes: { fetchQuotes: async () => [] },
    cnQuotes: { fetchQuotes: async () => [] },
    yahoo: {
      fetchQuotes: () => {
        calls += 1;
        if (calls === 1) {
          return gate.then(() => ({
            quotes: [quote('^GSPC', 5), quote('AAPL', 9), quote('NVDA', 8), quote('MSFT', 7), quote('AMD', 6)],
            session: 'regular',
          }));
        }
        return Promise.resolve({ quotes: [], session: 'closed' });
      },
    },
  });
  await assert.rejects(service.getBoard({ board: 'us' }), /行情请求超时/);
  release();
  await gate;
  await new Promise((resolve) => setImmediate(resolve));
  const board = await service.getBoard({ board: 'us' });
  assert.equal(calls, 1);
  assert.equal(board.indices.find((item) => item.symbol === '^GSPC').lastPrice, 5);
  assert.equal(board.stale, undefined);
});
