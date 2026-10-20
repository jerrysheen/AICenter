import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadingHourService } from '../packages/domain/src/reading-hour-service.js';
import { composeHomeBootstrap, HOME_BOOTSTRAP_VISIBLE_HOURS } from '../apps/web/src/http/home-bootstrap.js';
import { createMarketBoardReader } from '../packages/source/src/market/board-read.js';
import {
  captureHomeBootstrap,
  captureMarketBoards,
  marketBoardSnapshotKey,
} from '../packages/runtime/src/web-snapshot-jobs.js';
import { createXueqiuQuoteClient } from '../packages/connectors/src/xueqiu-quotes.js';
import { marketStaleLabel, marketStatusLabel, quoteStaleLabel } from '../apps/web/public/home-timeline.js';
import { createMarketService } from '../packages/source/src/market/service.js';

const NOW = Date.parse('2026-10-10T02:00:00Z');

function hourSnapshot(items) {
  return {
    id: 'rh:batch',
    status: 'partial',
    scope: 'hour',
    routeVersion: 'reading-route-2026-10-10.4',
    window: { startAt: 1_000, endAt: 1_000 + 3_600_000 },
    timezone: 'Asia/Shanghai',
    generatedAt: 1_000,
    scored: items.length,
    candidates: items.length,
    selected: items.length,
    groups: [],
    sections: [],
    items,
  };
}

test('present loads every item with one node query and one source batch', () => {
  const items = Array.from({ length: 5 }, (_, index) => ({
    sourceId: `s${index}`,
    sourceVersion: '1',
    nodeId: `n${index}`,
    title: `标题${index}`,
    disposition: 'hit',
    hits: [],
    publisher: '',
    readingDirectionName: '金融',
    readingThemeName: '美国',
  }));
  const snapshot = hourSnapshot(items);
  let nodeCalls = 0;
  let contextCalls = 0;
  const repository = {
    getReadingHour: () => snapshot,
    getNodes(_workspace, ids) {
      nodeCalls += 1;
      assert.deepEqual(ids, ['n0', 'n1', 'n2', 'n3', 'n4']);
      return ids.map((id) => ({
        id,
        sourceRefs: [{ type: 'content-item', id: `c-${id}` }],
        eventAt: 20,
      }));
    },
    getNode() {
      throw new Error('present must not query one node at a time');
    },
  };
  const service = createReadingHourService({
    repository,
    enabled: true,
    sourceContextFor(_workspace, refs) {
      contextCalls += 1;
      assert.equal(refs.length, 5);
      return {
        factsFor(itemRefs) {
          return {
            titles: [],
            urls: [],
            publishedAt: itemRefs[0]?.id === 'c-n0' ? 50 : 80,
          };
        },
        publisherFor(itemRefs) {
          return itemRefs[0]?.id === 'c-n0' ? '批量来源' : '其他来源';
        },
      };
    },
    publisherFor() {
      throw new Error('present must not look up one publisher at a time');
    },
    publishedAtFor() {
      throw new Error('present must not look up one published time at a time');
    },
  });
  const shown = service.get('local', 'rh:batch');
  assert.equal(nodeCalls, 1);
  assert.equal(contextCalls, 1);
  assert.equal(shown.items.length, 5);
  assert.equal(shown.items[0].publisher, '批量来源');
  assert.equal(shown.items[0].publishedAt, 50);
  assert.equal(shown.items[1].publisher, '其他来源');
  let headCalls = 0;
  const ranged = createReadingHourService({
    repository: {
      readingHoursForWindows(_workspace, windows) {
        headCalls += 1;
        assert.equal(windows.length, 2);
        return [snapshot, { ...snapshot, id: 'rh:next', window: { startAt: 2_000, endAt: 3_000 } }];
      },
      getNodes: repository.getNodes,
    },
    enabled: true,
    sourceContextFor: () => ({
      factsFor: () => ({ titles: [], urls: [], publishedAt: null }),
      publisherFor: () => '',
    }),
  });
  const many = ranged.forWindows('local', [{ startAt: 1, endAt: 2 }, { startAt: 2, endAt: 3 }], 'hour');
  assert.equal(headCalls, 1);
  assert.equal(many.length, 2);
  assert.equal(nodeCalls, 2);
});

test('home bootstrap starts market while readings are still running', async () => {
  let releaseMarket;
  const gate = new Promise((resolve) => { releaseMarket = resolve; });
  let marketEntered = false;
  let readingsFinished = false;
  const hourStart = NOW - 3_600_000;
  const bodyPromise = composeHomeBootstrap({
    informationTree: {
      list() {
        return { hours: [{ window: { startAt: hourStart, endAt: NOW } }] };
      },
    },
    readingHour: {
      forWindows() {
        readingsFinished = marketEntered;
        return [{
          id: 'hour-1',
          window: { startAt: hourStart, endAt: NOW },
          items: [{ title: '一条', disposition: 'hit', readingDirectionName: '金融', nodeId: 'n1', timely: true }],
        }];
      },
    },
    report: { getLatestDailyBrief: () => ({ sentence: '日报' }) },
    marketBoard: {
      async read() {
        marketEntered = true;
        await gate;
        return { market: { board: 'overview', indices: [{ symbol: 'X', lastPrice: 1 }] }, pending: false };
      },
    },
    staticSignalBoard: {
      async read() {
        return { board: { generatedAt: NOW, releases: [] }, pending: false };
      },
    },
  }, { workspace: 'phone', now: NOW });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(marketEntered, true);
  releaseMarket();
  const body = await bodyPromise;
  assert.equal(readingsFinished, true);
  assert.equal(body.readings[hourStart].items[0].title, '一条');
  assert.equal(typeof body.timings.tree, 'number');
  assert.equal(typeof body.timings.readings, 'number');
  assert.equal(typeof body.timings.market, 'number');
  assert.equal(typeof body.timings.board, 'number');
  assert.equal(typeof body.timings.brief, 'number');
  assert.ok(body.timings.total >= body.timings.market);
});

test('a missing extra quote returns pending without waiting for the upstream', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = Date.now();
  const reader = createMarketBoardReader({
    repository: {
      readSnapshot: () => ({
        payload: {
          board: 'us',
          mode: 'live',
          fetchedAt: started,
          session: 'regular',
          indices: [{ symbol: 'AAPL', name: 'Apple', lastPrice: 100, currency: 'USD', asOf: started }],
          watchlist: [],
          gainers: [],
          losers: [],
          breadth: { advancers: 0, decliners: 0, unchanged: 0 },
        },
      }),
    },
    now: () => started,
    ttlMs: 60_000,
    quotePort: {
      fetchQuotes() {
        return gate.then(() => [{ symbol: 'MSFT', name: 'Microsoft', lastPrice: 42, currency: 'USD' }]);
      },
    },
  });
  const pending = await reader.read({ board: 'us', extraUs: 'MSFT' });
  assert.ok(Date.now() - started < 200);
  assert.equal(pending.pending, true);
  assert.equal(pending.market.watchlist.some((item) => item.symbol === 'MSFT' && item.lastPrice == null), true);
  assert.equal(pending.market.indices[0].lastPrice, 100);
  release();
  let filled = pending;
  for (let attempt = 0; attempt < 10 && filled.pending; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    filled = await reader.read({ board: 'us', extraUs: 'MSFT' });
  }
  assert.equal(filled.pending, false);
  assert.equal(filled.market.watchlist.find((item) => item.symbol === 'MSFT').lastPrice, 42);
});

test('each market board is stored on its own timeout', async () => {
  const at = Date.parse('2026-10-15T14:00:00Z');
  let releaseUs;
  const gate = new Promise((resolve) => { releaseUs = resolve; });
  const saved = [];
  const sourcePort = {
    async read(sourceId) {
      const board = String(sourceId).replace(/^market\./, '');
      if (board === 'us') await gate;
      return {
        data: {
          board,
          mode: 'live',
          fetchedAt: at,
          session: 'regular',
          indices: [],
          watchlist: [{ symbol: board.toUpperCase(), name: board, lastPrice: 1, currency: 'USD', asOf: at }],
          gainers: [],
          losers: [],
          breadth: { advancers: 1, decliners: 0, unchanged: 0 },
        },
      };
    },
  };
  const settled = captureMarketBoards({
    sourcePort,
    repository: { saveSnapshot(_workspace, key) { saved.push(key); } },
    now: () => at,
    timeoutMs: 30,
    env: {},
    log() {},
  }).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(saved.includes(marketBoardSnapshotKey('asia')));
  assert.ok(saved.includes(marketBoardSnapshotKey('cn')));
  assert.ok(saved.includes(marketBoardSnapshotKey('global')));
  assert.equal(saved.includes(marketBoardSnapshotKey('us')), false);
  const result = await settled;
  assert.equal(result.ok, false);
  assert.match(result.error.message, /美股看板.*超时|行情看板 us 超时/);
  releaseUs();
});

test('an open US board does not say expired when one print is older', () => {
  const fetchedAt = Date.parse('2026-10-15T13:40:00Z');
  const asOf = fetchedAt + 10 * 60_000;
  const payload = {
    board: 'us',
    fetchedAt,
    stale: true,
    indices: [{ symbol: 'AAPL', name: 'Apple', lastPrice: 100, asOf }],
    watchlist: [{ symbol: 'MSFT', name: 'Microsoft', lastPrice: 90, asOf: fetchedAt }],
  };
  assert.equal(marketStaleLabel(payload, asOf + 60_000), '');
  assert.equal(quoteStaleLabel(payload.watchlist[0], asOf + 60_000), '');
  assert.equal(quoteStaleLabel(payload.indices[0], asOf + 60_000), '');
  assert.equal(marketStaleLabel(payload, asOf + 180_000), '');
  assert.equal(marketStatusLabel(payload, asOf + 180_000), '盘中');
});

test('the A-share board snapshot fills sparklines from xueqiu klines', async () => {
  const catalog = {
    us: { groups: ['全部'], indices: [], watchlist: [] },
    asia: { groups: ['全部'], indices: [], watchlist: [] },
    cn: {
      groups: ['全部'],
      indices: [{ symbol: '000001.SS', name: '上证指数', group: '指数' }],
      watchlist: [{ symbol: '600519.SS', name: '贵州茅台', group: '全部' }],
    },
  };
  const sparked = [];
  const service = createMarketService({
    marketCatalog: catalog,
    ttlMs: 1_000,
    now: () => Date.parse('2026-10-16T02:00:00Z'),
    log() {},
    tushare: null,
    sinaFutures: null,
    cnQuotes: { fetchQuotes: async () => [] },
    yahoo: { fetchQuotes: async () => ({ quotes: [], session: 'closed' }) },
    xueqiuQuotes: {
      async fetchQuotes(symbols) {
        return symbols.map((symbol) => ({
          symbol,
          name: symbol,
          lastPrice: 10,
          prevClose: 9,
          currency: 'CNY',
          session: 'regular',
          sparkline: [],
          asOf: Date.parse('2026-10-16T02:00:00Z'),
        }));
      },
      async fetchSparklines(symbols) {
        sparked.push(...symbols);
        const today = Date.parse('2026-10-16T02:00:00Z');
        return symbols.map((symbol) => ({
          symbol,
          sparkline: [8, 9, 10],
          lastAt: symbol === '600519.SS' ? today - 86_400_000 : today,
        }));
      },
    },
  });
  const board = await service.getBoard({ board: 'cn' });
  assert.deepEqual(sparked.sort(), ['000001.SS', '600519.SS']);
  assert.deepEqual(board.indices.find((item) => item.symbol === '000001.SS').sparkline, [8, 9, 10]);
  assert.deepEqual(board.watchlist.find((item) => item.symbol === '600519.SS').sparkline, [8, 9, 10, 10]);
});

test('home bootstrap enriches only the first filled hours', async () => {
  const presented = [];
  const windows = Array.from({ length: 8 }, (_, index) => {
    const startAt = NOW - (8 - index) * 3_600_000;
    return { startAt, endAt: startAt + 3_600_000 };
  });
  const emptyFrom = windows[6].startAt;
  await composeHomeBootstrap({
    informationTree: {
      list() {
        return { hours: windows.map((window) => ({ window })) };
      },
    },
    readingHour: {
      listWindowSnapshots(_workspace, requested) {
        return requested.map((window) => ({
          id: `h-${window.startAt}`,
          window,
          items: window.startAt >= emptyFrom
            ? []
            : [{ title: '条目', disposition: 'hit', readingDirectionName: '金融', nodeId: 'n', timely: true }],
        }));
      },
      presentSnapshots(_workspace, snapshots) {
        presented.push(...snapshots.map((item) => item.id));
        return snapshots;
      },
    },
    report: { getLatestDailyBrief: () => null },
    marketBoard: { async read() { return { market: { board: 'overview', indices: [] }, pending: false }; } },
    staticSignalBoard: { async read() { return { board: { generatedAt: NOW, releases: [] }, pending: false }; } },
  }, { now: NOW });
  assert.equal(presented.length, HOME_BOOTSTRAP_VISIBLE_HOURS);
  assert.deepEqual(presented, [5, 4, 3, 2].map((index) => `h-${windows[index].startAt}`));
});

test('a second market capture does not request xueqiu klines again', async () => {
  const at = Date.parse('2026-10-16T02:00:00Z');
  let kline = 0;
  const client = createXueqiuQuoteClient({
    cookie: 'xq_a_token=user-token',
    now: () => at,
    fetchImpl: async (url) => {
      const href = String(url);
      if (href.includes('/v5/stock/chart/kline.json')) {
        kline += 1;
        return {
          ok: true,
          status: 200,
          headers: { getSetCookie: () => [], get: () => null },
          async arrayBuffer() {
            return Buffer.from(JSON.stringify({
              data: {
                column: ['timestamp', 'close'],
                item: [[1, 8], [2, 9]],
              },
            }));
          },
        };
      }
      const symbol = new URL(href).searchParams.get('symbol') || '';
      const items = symbol.split(',').filter(Boolean).map((code) => ({
        market: { status: '交易中', status_id: 5 },
        quote: { symbol: code, current: 10.5, last_close: 10, currency: 'CNY' },
      }));
      return {
        ok: true,
        status: 200,
        headers: { getSetCookie: () => [], get: () => null },
        async arrayBuffer() {
          return Buffer.from(JSON.stringify({ data: { items } }));
        },
      };
    },
  });
  const catalog = {
    us: { groups: ['全部'], indices: [], watchlist: [] },
    asia: { groups: ['全部'], indices: [], watchlist: [] },
    cn: {
      groups: ['全部'],
      indices: [{ symbol: '000001.SS', name: '上证指数', group: '指数' }],
      watchlist: [{ symbol: '600519.SS', name: '贵州茅台', group: '全部' }],
    },
  };
  const service = createMarketService({
    marketCatalog: catalog,
    ttlMs: 0,
    now: () => at,
    log() {},
    tushare: null,
    sinaFutures: null,
    cnQuotes: { fetchQuotes: async () => [] },
    yahoo: { fetchQuotes: async () => ({ quotes: [], session: 'closed' }) },
    xueqiuQuotes: client,
  });
  const saved = [];
  const sourcePort = {
    async read(sourceId) {
      const board = String(sourceId).replace(/^market\./, '');
      if (board === 'cn') return { data: await service.getBoard({ board: 'cn' }) };
      return {
        data: {
          board,
          mode: 'live',
          fetchedAt: at,
          session: 'closed',
          indices: [],
          watchlist: [],
          gainers: [],
          losers: [],
          breadth: { advancers: 0, decliners: 0, unchanged: 0 },
        },
      };
    },
  };
  const repository = { saveSnapshot(_workspace, key, payload) { saved.push({ key, payload }); } };
  await captureMarketBoards({ sourcePort, repository, now: () => at, env: {}, log() {} });
  const first = kline;
  assert.ok(first > 0);
  const cn = saved.find((item) => item.key === marketBoardSnapshotKey('cn'));
  assert.deepEqual(cn.payload.indices.find((item) => item.symbol === '000001.SS').sparkline, [8, 9, 10.5]);
  await captureMarketBoards({ sourcePort, repository, now: () => at, env: {}, log() {} });
  assert.equal(kline - first, 0);
});

test('extra quotes abort when the fill exceeds ten seconds', async () => {
  let signal;
  const started = Date.now();
  const reader = createMarketBoardReader({
    repository: {
      readSnapshot: () => ({
        payload: {
          board: 'us',
          mode: 'live',
          fetchedAt: started,
          session: 'regular',
          indices: [{ symbol: 'AAPL', name: 'Apple', lastPrice: 100, currency: 'USD', asOf: started }],
          watchlist: [],
          gainers: [],
          losers: [],
          breadth: { advancers: 0, decliners: 0, unchanged: 0 },
        },
      }),
    },
    now: () => started,
    ttlMs: 60_000,
    extraTimeoutMs: 30,
    quotePort: {
      fetchQuotes(_symbols, options) {
        signal = options.signal;
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      },
    },
  });
  const pending = await reader.read({ board: 'us', extraUs: 'MSFT' });
  assert.equal(pending.pending, true);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(signal.aborted, true);
});

test('the stored home snapshot leaves timings off the client payload', async () => {
  const saved = [];
  const result = await captureHomeBootstrap({
    compose: async () => ({ ok: true, generatedAt: 5, timings: { tree: 1, total: 4 }, tree: { hours: [] } }),
    repository: { saveSnapshot(_workspace, _key, body) { saved.push(body); } },
    now: () => 5,
  });
  assert.equal(saved[0].timings, undefined);
  assert.equal(saved[0].tree.hours.length, 0);
  assert.equal(result.timings.total, 4);
});
