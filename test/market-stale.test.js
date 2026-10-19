import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarketService, marketStaleMs } from '../packages/source/src/market/service.js';
import { usRegularSessionAt, usSessionAt } from '../packages/source/src/market/boards.js';
import {
  captureMarketBoards,
  marketBoardSnapshotKey,
  marketUsFreshMs,
  usBoardFreshnessError,
} from '../packages/runtime/src/web-snapshot-jobs.js';
import { homeDataDelayLabel, marketClosedLabel, marketFillDelayMs, marketPhaseLabel, marketStaleLabel, quoteClosedLabel, quoteStaleLabel } from '../apps/web/public/home-timeline.js';
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
  assert.equal(usSessionAt(Date.parse('2026-10-19T11:00:00Z')), 'pre');
  assert.equal(usSessionAt(Date.parse('2026-10-19T21:00:00Z')), 'post');
  assert.equal(usSessionAt(Date.parse('2026-10-20T01:00:00Z')), 'closed');
  assert.equal(usSessionAt(Date.parse('2026-10-17T15:00:00Z')), 'closed');
  assert.equal(usSessionAt(Date.parse('2026-11-26T16:00:00Z')), 'closed');
  assert.equal(usSessionAt(Date.parse('2026-11-27T17:00:00Z')), 'regular');
  assert.equal(usSessionAt(Date.parse('2026-11-27T18:00:00Z')), 'post');
  assert.equal(usRegularSessionAt(Date.parse('2026-10-19T11:00:00Z')), 'closed');
  assert.equal(usSessionAt(Date.parse('2027-01-01T15:00:00Z')), 'closed');
  assert.equal(usSessionAt(Date.parse('2027-06-18T14:00:00Z')), 'closed');
  assert.equal(usSessionAt(Date.parse('2027-07-05T14:00:00Z')), 'closed');
  assert.equal(usSessionAt(Date.parse('2027-11-25T16:00:00Z')), 'closed');
  assert.equal(usSessionAt(Date.parse('2027-12-24T15:00:00Z')), 'closed');
  assert.equal(usSessionAt(Date.parse('2027-12-24T17:00:00Z')), 'closed');
  assert.equal(usSessionAt(Date.parse('2027-11-26T17:00:00Z')), 'regular');
  assert.equal(usSessionAt(Date.parse('2027-11-26T18:00:00Z')), 'post');
  assert.equal(usSessionAt(Date.parse('2027-11-26T22:00:00Z')), 'closed');
  assert.equal(usSessionAt(Date.parse('2027-01-04T15:00:00Z')), 'regular');
  assert.equal(usBoardFreshnessError({ fetchedAt: open - 11 * 60_000 }, open, 10 * 60_000), '美股看板行情已 11 分钟未更新');
  assert.equal(usBoardFreshnessError({ fetchedAt: open - 11 * 60_000 }, closed, 10 * 60_000), '');
  const at = Date.parse('2026-10-15T13:40:00Z');
  assert.equal(marketStaleLabel({ stale: true, fetchedAt: at }, at), '');
  assert.equal(marketStaleLabel({ fetchedAt: at }, at + 120_000), '');
  assert.equal(marketStaleLabel({ fetchedAt: at }, at + 180_000), '已过期 · 10月15日 21:40');
  assert.equal(homeDataDelayLabel(at, at + 5 * 60_000 - 1), '');
  assert.equal(homeDataDelayLabel(at, at + 5 * 60_000), '数据更新延迟');
});

test('a year missing from the NYSE holiday table warns once', () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const monday = Date.parse('2028-01-03T15:00:00Z');
    assert.equal(usSessionAt(monday), 'regular');
    assert.equal(usSessionAt(monday + 60_000), 'regular');
    assert.equal(usSessionAt(Date.parse('2025-01-06T15:00:00Z')), 'regular');
    assert.equal(usSessionAt(Date.parse('2025-01-06T15:01:00Z')), 'regular');
    assert.equal(usSessionAt(Date.parse('2027-01-04T15:00:00Z')), 'regular');
  } finally {
    console.warn = original;
  }
  assert.deepEqual(warnings, [
    '[market] 2028 年纽交所休市日还没有写入假日表，这一年只按周末和美东时钟判断',
    '[market] 2025 年纽交所休市日还没有写入假日表，这一年只按周末和美东时钟判断',
  ]);
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

test('an older quote time does not replace a newer price already on the board', async () => {
  const clock = { value: 5_000_000 };
  let round = 0;
  const service = createMarketService({
    marketCatalog: catalog,
    ttlMs: 1_000,
    now: () => clock.value,
    log() {},
    tushare: null,
    sinaFutures: null,
    xueqiuQuotes: { fetchQuotes: async () => [] },
    cnQuotes: { fetchQuotes: async () => [] },
    yahoo: {
      fetchQuotes: async () => {
        round += 1;
        const asOf = round === 1 ? 8_000_000 : 7_000_000;
        const price = round === 1 ? 100 : 1;
        return {
          quotes: [quote('^GSPC', price), quote('AAPL', price), quote('NVDA', price), quote('MSFT', price), quote('AMD', price)]
            .map((item) => ({ ...item, asOf })),
          session: 'regular',
        };
      },
    },
  });
  const first = await service.getBoard({ board: 'us' });
  assert.equal(first.watchlist.find((item) => item.symbol === 'AAPL').lastPrice, 100);
  clock.value += 2_000;
  const second = await service.getBoard({ board: 'us' });
  assert.equal(second.fetchedAt, clock.value);
  assert.equal(second.watchlist.find((item) => item.symbol === 'AAPL').lastPrice, 100);
  assert.equal(second.watchlist.find((item) => item.symbol === 'AAPL').asOf, 8_000_000);
  assert.equal(round, 2);
});

test('a closed market is not expired, and five quiet minutes during the session are', async () => {
  const evening = Date.parse('2026-10-15T14:00:00Z');
  const cnPayload = {
    board: 'cn',
    fetchedAt: evening - 60 * 60_000,
    stale: true,
    indices: [{ symbol: '000001.SS', name: '上证指数', lastPrice: 3000, asOf: Date.parse('2026-10-15T07:00:00Z') }],
    watchlist: [],
    gainers: [],
    losers: [],
    breadth: { advancers: 0, decliners: 0, unchanged: 0 },
  };
  const cn = await createMarketBoardReader({
    repository: { readSnapshot: () => ({ payload: cnPayload }) },
    now: () => evening,
    staleMs: 180_000,
  }).read({ board: 'cn' });
  assert.equal(cn.market.stale, false);
  assert.equal(marketStaleLabel(cn.market, evening), '');
  assert.match(marketClosedLabel(cn.market, evening), /^收盘 · /);
  assert.equal(quoteStaleLabel(cn.market.indices[0], evening), '');
  assert.match(quoteClosedLabel(cn.market.indices[0], evening), /^收盘 · /);

  const saturday = Date.parse('2026-10-17T15:00:00Z');
  const usPayload = {
    board: 'us',
    fetchedAt: Date.parse('2026-10-16T20:00:00Z'),
    stale: true,
    indices: [{ symbol: 'AAPL', name: 'Apple', lastPrice: 100, asOf: Date.parse('2026-10-16T20:00:00Z') }],
    watchlist: [],
    gainers: [],
    losers: [],
    breadth: { advancers: 0, decliners: 0, unchanged: 0 },
  };
  const closedUs = await createMarketBoardReader({
    repository: { readSnapshot: () => ({ payload: usPayload }) },
    now: () => saturday,
    staleMs: 180_000,
  }).read({ board: 'us' });
  assert.equal(closedUs.market.stale, false);
  assert.equal(marketStaleLabel(closedUs.market, saturday), '');
  assert.equal(quoteStaleLabel(closedUs.market.indices[0], saturday), '');
  assert.match(quoteClosedLabel(closedUs.market.indices[0], saturday), /^收盘 · /);

  const asOf = evening - 5 * 60_000;
  const livePayload = {
    board: 'us',
    fetchedAt: asOf,
    indices: [{ symbol: 'AAPL', name: 'Apple', lastPrice: 100, asOf }],
    watchlist: [],
    gainers: [],
    losers: [],
    breadth: { advancers: 0, decliners: 0, unchanged: 0 },
  };
  const live = await createMarketBoardReader({
    repository: { readSnapshot: () => ({ payload: livePayload }) },
    now: () => evening,
    staleMs: 180_000,
  }).read({ board: 'us' });
  assert.equal(live.market.stale, true);
  assert.match(marketStaleLabel(live.market, evening), /^已过期/);
  assert.match(quoteStaleLabel(live.market.indices[0], evening), /^已过期/);
  assert.equal(live.market.marketOpen, true);
  assert.equal(live.market.indices[0].session, 'regular');
  assert.equal(cn.market.marketOpen, false);
  assert.equal(cn.market.indices[0].marketOpen, false);
  assert.equal(cnPayload.marketOpen, undefined);
  assert.equal(closedUs.market.marketOpen, false);
});

test('a holiday board follows the server marketOpen, and pending retries grow', async () => {
  const holiday = Date.parse('2026-10-01T02:00:00Z');
  const payload = {
    board: 'cn',
    fetchedAt: holiday - 60_000,
    session: 'regular',
    indices: [{
      symbol: '000001.SS',
      name: '上证指数',
      lastPrice: 3000,
      asOf: holiday - 30 * 60_000,
      session: 'regular',
    }],
    watchlist: [],
    gainers: [],
    losers: [],
    breadth: { advancers: 0, decliners: 0, unchanged: 0 },
  };
  const read = await createMarketBoardReader({
    repository: { readSnapshot: () => ({ payload }) },
    now: () => holiday,
    staleMs: 180_000,
  }).read({ board: 'cn' });
  assert.equal(read.market.marketOpen, false);
  assert.equal(read.market.session, 'closed');
  assert.equal(read.market.indices[0].marketOpen, false);
  assert.equal(payload.session, 'regular');
  assert.equal(payload.indices[0].session, 'regular');
  assert.equal(quoteStaleLabel(read.market.indices[0], holiday), '');
  assert.match(quoteClosedLabel(read.market.indices[0], holiday), /^收盘/);
  assert.equal(marketStaleLabel(read.market, holiday), '');
  const stored = { symbol: '000001.SS', lastPrice: 3000, asOf: holiday - 10 * 60_000, session: 'regular', marketOpen: false };
  assert.equal(quoteStaleLabel(stored, holiday), '');
  assert.deepEqual([0, 1, 2, 3, 4].map((attempt) => marketFillDelayMs(attempt)), [800, 1600, 3200, 6400, 10_000]);
  assert.equal(marketFillDelayMs(8), 10_000);
});

test('US pre and post stay on the board and do not count as expired', async () => {
  async function readAt(at, session) {
    const payload = {
      board: 'us',
      mode: 'live',
      fetchedAt: at - 30 * 60_000,
      stale: true,
      session: 'closed',
      groups: [],
      indices: [{
        symbol: 'NVDA',
        name: 'NVIDIA',
        lastPrice: 218.2,
        prevClose: 214.13,
        change: 4.07,
        changePct: 1.9,
        currency: 'USD',
        session,
        asOf: at,
      }],
      watchlist: [],
      gainers: [],
      losers: [],
      breadth: { advancers: 1, decliners: 0, unchanged: 0 },
      sections: [{
        id: 'us',
        title: '美股观察',
        session: 'closed',
        indices: [{
          symbol: 'NVDA',
          name: 'NVIDIA',
          lastPrice: 218.2,
          prevClose: 214.13,
          change: 4.07,
          changePct: 1.9,
          session,
          asOf: at,
        }],
        gainers: [],
        losers: [],
      }],
    };
    return createMarketBoardReader({
      repository: { readSnapshot: () => ({ payload }) },
      now: () => at,
      staleMs: 180_000,
    }).read({ board: 'us' });
  }

  const pre = await readAt(Date.parse('2026-10-19T11:00:00Z'), 'pre');
  assert.equal(pre.market.session, 'pre');
  assert.equal(pre.market.marketOpen, false);
  assert.equal(pre.market.stale, false);
  assert.equal(pre.market.indices[0].session, 'pre');
  assert.equal(pre.market.indices[0].marketOpen, false);
  assert.equal(pre.market.sections[0].session, 'pre');
  assert.equal(pre.market.sections[0].marketOpen, false);
  assert.equal(marketStaleLabel(pre.market, Date.parse('2026-10-19T11:00:00Z')), '');
  assert.equal(marketPhaseLabel(pre.market), '盘前');
  assert.equal(quoteStaleLabel(pre.market.indices[0], Date.parse('2026-10-19T11:00:00Z')), '');
  assert.equal(quoteClosedLabel(pre.market.indices[0], Date.parse('2026-10-19T11:00:00Z')), '盘前 · 10月19日 19:00');

  const post = await readAt(Date.parse('2026-10-19T21:00:00Z'), 'post');
  assert.equal(post.market.session, 'post');
  assert.equal(post.market.marketOpen, false);
  assert.equal(post.market.indices[0].session, 'post');
  assert.equal(post.market.stale, false);
  assert.equal(quoteClosedLabel(post.market.indices[0], Date.parse('2026-10-19T21:00:00Z')), '盘后 · 10月20日 05:00');

  const night = await readAt(Date.parse('2026-10-20T01:00:00Z'), 'post');
  assert.equal(night.market.session, 'closed');
  assert.equal(night.market.indices[0].session, 'closed');
  assert.equal(night.market.marketOpen, false);

  const weekend = await readAt(Date.parse('2026-10-17T15:00:00Z'), 'pre');
  assert.equal(weekend.market.session, 'closed');
  assert.equal(weekend.market.indices[0].session, 'closed');
  assert.equal(weekend.market.marketOpen, false);
});

test('the US open keeps premarket prices for five minutes instead of marking them expired', async () => {
  const friday = Date.parse('2026-10-16T20:00:00Z');
  const preAt = Date.parse('2026-10-19T13:12:00Z');
  const payload = {
    board: 'us',
    mode: 'live',
    fetchedAt: preAt,
    stale: false,
    session: 'pre',
    groups: [],
    indices: [{
      symbol: '^GSPC', name: '标普 500', lastPrice: 5200.41, prevClose: 5200.41, change: 0, changePct: 0,
      currency: 'USD', session: 'pre', asOf: friday,
    }],
    watchlist: [{
      symbol: 'NVDA', name: 'NVIDIA', lastPrice: 218.55, prevClose: 214.13, change: 4.42, changePct: 2.06,
      currency: 'USD', session: 'pre', asOf: preAt,
    }],
    gainers: [],
    losers: [],
    breadth: { advancers: 1, decliners: 0, unchanged: 1 },
    sections: [{
      id: 'us',
      title: '美股观察',
      session: 'pre',
      indices: [{
        symbol: '^GSPC', name: '标普 500', lastPrice: 5200.41, prevClose: 5200.41, change: 0, changePct: 0,
        session: 'pre', asOf: friday,
      }],
      gainers: [],
      losers: [],
    }],
  };
  const readAt = (at) => createMarketBoardReader({
    repository: { readSnapshot: () => ({ payload }) },
    now: () => at,
    staleMs: 180_000,
  }).read({ board: 'us' });

  const justOpen = Date.parse('2026-10-19T13:32:00Z');
  const opening = await readAt(justOpen);
  assert.equal(opening.market.session, 'regular');
  assert.equal(opening.market.awaitingQuote, true);
  assert.equal(opening.market.marketOpen, false);
  assert.equal(opening.market.stale, false);
  assert.equal(opening.market.sections[0].session, 'regular');
  assert.equal(opening.market.sections[0].awaitingQuote, true);
  assert.equal(marketStaleLabel(opening.market, justOpen), '');
  assert.equal(marketPhaseLabel(opening.market), '盘中 · 等待报价');
  assert.equal(marketPhaseLabel(opening.market.sections[0]), '盘中 · 等待报价');
  assert.equal(marketClosedLabel(opening.market, justOpen), '');
  const nvda = opening.market.watchlist[0];
  assert.equal(nvda.session, 'pre');
  assert.equal(nvda.lastPrice, 218.55);
  assert.equal(quoteStaleLabel(nvda, justOpen), '');
  assert.equal(quoteClosedLabel(nvda, justOpen), '盘前 · 10月19日 21:12');
  const index = opening.market.indices[0];
  assert.equal(quoteStaleLabel(index, justOpen), '');
  assert.equal(quoteClosedLabel(index, justOpen), '盘中 · 等待报价');
  assert.equal(quoteClosedLabel(opening.market.sections[0].indices[0], justOpen), '盘中 · 等待报价');

  const printedAt = Date.parse('2026-10-19T13:31:00Z');
  const settled = await createMarketBoardReader({
    repository: { readSnapshot: () => ({ payload: { ...payload, watchlist: [{ ...payload.watchlist[0], asOf: printedAt, session: 'regular' }] } }) },
    now: () => printedAt,
    staleMs: 180_000,
  }).read({ board: 'us' });
  assert.equal(settled.market.awaitingQuote, undefined);
  assert.equal(settled.market.session, 'regular');
  assert.equal(settled.market.marketOpen, true);
  assert.equal(settled.market.stale, false);
  assert.equal(marketStaleLabel(settled.market, printedAt), '');
  assert.equal(marketPhaseLabel(settled.market), '');
  assert.equal(settled.market.sections[0].session, 'regular');
  assert.equal(settled.market.sections[0].awaitingQuote, undefined);

  const late = Date.parse('2026-10-19T13:36:00Z');
  const expired = await readAt(late);
  assert.equal(expired.market.awaitingQuote, undefined);
  assert.equal(expired.market.marketOpen, true);
  assert.equal(expired.market.session, 'regular');
  assert.match(marketStaleLabel(expired.market, late), /^已过期 · 10月19日 21:12$/);
  assert.match(quoteStaleLabel(expired.market.watchlist[0], late), /^已过期 · 10月19日 21:12$/);
});
