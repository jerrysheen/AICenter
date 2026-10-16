import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadingHourService } from '../packages/domain/src/reading-hour-service.js';
import { composeHomeBootstrap } from '../apps/web/src/http/home-bootstrap.js';
import { createMarketBoardReader } from '../packages/source/src/market/board-read.js';
import {
  captureMarketBoards,
  marketBoardSnapshotKey,
} from '../packages/runtime/src/web-snapshot-jobs.js';
import { marketStaleLabel, quoteStaleLabel } from '../apps/web/public/home-timeline.js';
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

test('a fresh quote asOf is not expired when the board fetchedAt is old', () => {
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
  assert.match(quoteStaleLabel(payload.watchlist[0], asOf + 60_000), /^已过期/);
  assert.equal(quoteStaleLabel(payload.indices[0], asOf + 60_000), '');
  assert.match(marketStaleLabel(payload, asOf + 180_000), /^已过期/);
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
        return symbols.map((symbol) => ({ symbol, sparkline: [8, 9, 10] }));
      },
    },
  });
  const board = await service.getBoard({ board: 'cn' });
  assert.deepEqual(sparked.sort(), ['000001.SS', '600519.SS']);
  assert.deepEqual(board.indices.find((item) => item.symbol === '000001.SS').sparkline, [8, 9, 10]);
  assert.deepEqual(board.watchlist.find((item) => item.symbol === '600519.SS').sparkline, [8, 9, 10]);
});
