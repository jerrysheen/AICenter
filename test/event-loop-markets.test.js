import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../packages/database/src/index.js';
import { createTradingService } from '../packages/domain/src/trading-service.js';
import {
  captureMarketBoards,
  captureMarketNativeBoard,
  ensureMarketBoardsSchedule,
  ensureMarketNativeBoardSchedule,
  MARKET_BOARDS_JOB_TYPE,
  MARKET_NATIVE_BOARD_JOB_TYPE,
} from '../packages/runtime/src/web-snapshot-jobs.js';
import { preferredOverviewFocus } from '../packages/source/src/market/boards.js';
import {
  createMarketBoardReader,
  marketBoardSnapshotKey,
} from '../packages/source/src/market/board-read.js';
import {
  createMarketNativeBoardReader,
  MARKET_NATIVE_BOARD_SNAPSHOT_KEY,
  projectMarketNativeBoard,
} from '../packages/source/src/static/market-native-read.js';
import { createAccessLog, readAccessSummary, requestLoopDelayMs } from '../apps/web/src/http/access-log.js';
import { createAiCenterServer } from '../apps/web/src/server.js';

const AT = Date.parse('2026-09-18T02:00:00Z');

function temporaryStore(prefix) {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  const store = createStore(path.join(directory, 'test.db'));
  return {
    store,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function marketBoard(board) {
  return {
    board,
    mode: 'live',
    fetchedAt: AT,
    session: 'closed',
    note: 'snapshot',
    groups: [],
    indices: [],
    watchlist: [{ symbol: board.toUpperCase(), name: board, lastPrice: 1, changePct: 0.02, currency: 'USD', session: 'closed' }],
    gainers: [],
    losers: [],
    breadth: { advancers: 1, decliners: 0, unchanged: 0 },
  };
}

function prediction(id, volume) {
  return {
    quoteId: `polymarket:${id}:yes`,
    venue: 'polymarket',
    marketId: id,
    marketQuestion: `Question ${id}?`,
    outcome: 'Yes',
    midPrice: '0.6',
    bestBid: '0.59',
    bestAsk: '0.61',
    spread: '0.02',
    lastPrice: '0.6',
    volume24h: volume,
    totalVolume: '100',
    liquidity: '20',
    openInterest: '30',
    endAt: AT + 86_400_000,
    sourceUrl: `https://example.com/polymarket/${id}`,
    observedAt: AT,
  };
}

test('request loop delay records the stall that happened during that request', () => {
  assert.equal(requestLoopDelayMs({ max: 1_000_000 }, 1_000_000), 0);
  assert.equal(requestLoopDelayMs({ max: 250_000_000 }, 1_000_000), 249);
  assert.equal(requestLoopDelayMs({ max: 20_000_000 }, 500_000_000), 20);
  assert.equal(requestLoopDelayMs(null, 1), null);
});

test('access log attributes event-loop delay to the in-flight path', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-loop-attr-'));
  const histogram = { max: 1_000_000 };
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  const accessLog = createAccessLog({ directory, salt: 'salt', env: {} });
  accessLog.bindLoopDelay(histogram);
  const server = createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    accessLog.observe(request, response, url);
    if (url.pathname.endsWith('/markets')) histogram.max = 260_000_000;
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('ok');
  });
  const address = await listen(server);
  try {
    await fetch(`http://127.0.0.1:${address.port}/api/v1/ui/revision`);
    await fetch(`http://127.0.0.1:${address.port}/api/v1/markets`);
    await accessLog.flush();
    const name = readdirSync(directory).find((item) => item.startsWith('access.') && item.endsWith('.log'));
    const lines = readFileSync(path.join(directory, name), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const revision = lines.find((line) => line.path === '/api/v1/ui/revision');
    const markets = lines.find((line) => line.path === '/api/v1/markets');
    assert.equal(revision.loopMs, 0);
    assert.equal(markets.loopMs, 259);
    assert.equal(warnings.some((line) => line.includes('/api/v1/markets') && line.includes('loopMs=259')), true);
    const date = name.slice('access.'.length, -'.log'.length);
    const summary = await readAccessSummary(directory, {
      date,
      now: () => Date.parse(`${date}T18:00:00.000+08:00`),
    });
    const row = summary.paths.find((item) => item.path === '/api/v1/markets');
    assert.equal(row.loopMs.max, 259);
  } finally {
    console.warn = original;
    await accessLog.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('market and market-native boards are served from worker snapshots', async () => {
  const temporary = temporaryStore('ai-center-market-snapshot-');
  const calls = [];
  let quoteCalls = 0;
  const sourcePort = {
    list: () => [
      { id: 'market-native.prediction.polymarket', title: 'P', viewKind: 'prediction-market' },
    ],
    async read(sourceId, input) {
      calls.push(sourceId);
      if (sourceId === 'market.quotes') {
        quoteCalls += 1;
        return { data: (input.symbols || []).map((symbol) => ({ symbol, name: 'Extra', lastPrice: 4, changePct: 0.2, currency: 'USD', session: 'closed' })) };
      }
      if (String(sourceId).startsWith('market-native.')) {
        return {
          status: 'ready',
          observedAt: AT,
          warnings: [],
          data: { available: true, observedAt: AT, sourceUrl: 'https://example.com/p', quotes: [prediction('a', '3'), prediction('b', '9'), prediction('c', '1')], note: '' },
        };
      }
      return { data: marketBoard(String(sourceId).replace(/^market\./, '')) };
    },
  };
  try {
    const saved = await captureMarketBoards({
      sourcePort,
      repository: temporary.store.repositories.runtimeSnapshots,
      now: () => AT,
    });
    assert.equal(saved.boards, 5);
    assert.equal(saved.focus, preferredOverviewFocus(AT));
    assert.deepEqual(calls.filter((id) => id.startsWith('market.') && id !== 'market.quotes').sort(), [
      'market.asia', 'market.cn', 'market.global', 'market.us',
    ]);
    const overview = temporary.store.repositories.runtimeSnapshots.readSnapshot('local', marketBoardSnapshotKey('overview'));
    assert.equal(overview.payload.board, 'overview');
    assert.equal(overview.payload.focus, saved.focus);
    const reader = createMarketBoardReader({
      repository: temporary.store.repositories.runtimeSnapshots,
      now: () => AT,
      quotePort: {
        fetchQuotes: (symbols) => sourcePort.read('market.quotes', { symbols }).then((snapshot) => snapshot.data),
      },
    });
    const plain = await reader.read({ board: 'us' });
    assert.equal(plain.pending, false);
    assert.equal(plain.market.watchlist[0].symbol, 'US');
    assert.equal(quoteCalls, 0);
    const withExtra = await reader.read({ board: 'us', extraUs: 'MYEXTRA' });
    assert.equal(withExtra.market.watchlist.some((item) => item.symbol === 'MYEXTRA' && item.lastPrice === 4), true);
    assert.equal(quoteCalls, 1);
    const again = await reader.read({ board: 'us', extraUs: 'MYEXTRA', refresh: false }, { refresh: true });
    assert.equal(again.market.watchlist.some((item) => item.symbol === 'MYEXTRA'), true);
    assert.equal(quoteCalls, 1);
    const trading = createTradingService({
      tradingRepository: temporary.store.repositories.trading,
      sourcePort: { async read() { throw new Error('web live read'); } },
      marketBoardPort: reader,
    });
    assert.equal((await trading.getBoard({ board: 'cn' })).watchlist[0].symbol, 'CN');

    const native = await captureMarketNativeBoard({
      sourcePort,
      repository: temporary.store.repositories.runtimeSnapshots,
      now: () => AT,
    });
    assert.equal(native.predictions, 3);
    const nativeReader = createMarketNativeBoardReader({
      repository: temporary.store.repositories.runtimeSnapshots,
      now: () => AT,
    });
    const limited = await nativeReader.read({ predictionLimit: 1 });
    assert.equal(limited.pending, false);
    assert.equal(limited.board.predictionMarkets.length, 2);
    assert.equal(limited.board.predictionMarkets[0].volume24h, '9');
    assert.deepEqual(
      projectMarketNativeBoard(temporary.store.repositories.runtimeSnapshots.readSnapshot('local', MARKET_NATIVE_BOARD_SNAPSHOT_KEY).payload, 1).predictionMarkets.map((item) => item.marketId),
      limited.board.predictionMarkets.map((item) => item.marketId),
    );

    const empty = temporaryStore('ai-center-market-snapshot-empty-');
    try {
      const pendingBoard = await createMarketBoardReader({
        repository: empty.store.repositories.runtimeSnapshots,
        now: () => AT,
      }).read({ board: 'global' });
      assert.equal(pendingBoard.pending, true);
      assert.equal(pendingBoard.market.board, 'global');
      assert.match(pendingBoard.market.note, /行情快照尚未就绪/);
      const pendingNative = await createMarketNativeBoardReader({
        repository: empty.store.repositories.runtimeSnapshots,
        now: () => AT,
      }).read({ predictionLimit: 12 });
      assert.equal(pendingNative.pending, true);
      assert.deepEqual(pendingNative.board.predictionMarkets, []);
    } finally {
      empty.close();
    }

    const boards = ensureMarketBoardsSchedule(temporary.store, AT);
    const nativeSchedule = ensureMarketNativeBoardSchedule(temporary.store, AT);
    assert.equal(boards.jobType, MARKET_BOARDS_JOB_TYPE);
    assert.equal(nativeSchedule.jobType, MARKET_NATIVE_BOARD_JOB_TYPE);
    assert.equal(boards.schedule.intervalMinutes, 1);
    assert.equal(nativeSchedule.schedule.intervalMinutes, 1);
  } finally {
    temporary.close();
  }
});

test('GET markets and market-native do not call live sources before a snapshot exists', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-market-http-'));
  let boardCalls = 0;
  const app = createAiCenterServer({
    host: '127.0.0.1',
    port: 0,
    dataDirectory: directory,
    marketService: {
      async getBoard() {
        boardCalls += 1;
        throw new Error('live board');
      },
      async search() { return []; },
      async fetchQuotes() { return []; },
      async fetchHistory() { return []; },
    },
    marketNativeSources: {
      async polymarket() { throw new Error('live polymarket'); },
      async kalshi() { throw new Error('live kalshi'); },
      async hyperliquid() { throw new Error('live hyperliquid'); },
      async stablecoins() { throw new Error('live stablecoins'); },
    },
  });
  const address = await app.listen();
  try {
    const pending = await fetch(`${address.localUrl}/api/v1/markets?board=overview`).then((response) => response.json());
    assert.equal(pending.ok, true);
    assert.equal(pending.pending, true);
    assert.equal(pending.market.board, 'overview');
    assert.equal(boardCalls, 0);
    app.store.repositories.runtimeSnapshots.saveSnapshot('local', marketBoardSnapshotKey('overview'), {
      ...marketBoard('overview'),
      focus: 'us',
      sections: [{ id: 'us', title: '美股观察', indices: [], gainers: [], losers: [] }],
      breadth: {
        us: { advancers: 0, decliners: 0, unchanged: 0 },
        asia: { advancers: 0, decliners: 0, unchanged: 0 },
        cn: { advancers: 0, decliners: 0, unchanged: 0 },
      },
      watchlist: [],
    }, AT);
    const cached = await fetch(`${address.localUrl}/api/v1/markets?board=overview`).then((response) => response.json());
    assert.equal(cached.pending, true);
    const refreshed = await fetch(`${address.localUrl}/api/v1/markets?board=overview&refresh=1`).then((response) => response.json());
    assert.equal(refreshed.pending, undefined);
    assert.equal(refreshed.market.note, 'snapshot');
    assert.equal(boardCalls, 0);
    const native = await fetch(`${address.localUrl}/api/v1/market-native/board?predictionLimit=4`).then((response) => response.json());
    assert.equal(native.ok, true);
    assert.equal(native.pending, true);
    assert.deepEqual(native.board.predictionMarkets, []);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
