import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../packages/database/src/index.js';
import { createTradingService } from '../packages/domain/src/trading-service.js';
import { createMemorySnapshotCache } from '../packages/runtime/src/snapshot-cache.js';
import {
  captureHoldingsMarket,
  captureStaticSignalBoard,
  ensureHoldingsMarketSchedule,
  ensureStaticSignalBoardSchedule,
  HOLDINGS_MARKET_JOB_TYPE,
  HOLDINGS_MARKET_SNAPSHOT_KEY,
  STATIC_SIGNAL_BOARD_JOB_TYPE,
} from '../packages/runtime/src/web-snapshot-jobs.js';
import { createStaticSignalBoardReader } from '../packages/source/src/static/board-read.js';
import { projectStaticSignalBoard } from '../packages/source/src/static/board.js';
import { readAccessSummary } from '../apps/web/src/http/access-log.js';
import { createAiCenterServer } from '../apps/web/src/server.js';

const NOW = Date.parse('2026-09-17T04:00:00Z');
const FROM = Date.parse('2026-09-17T00:00:00Z');
const TO = Date.parse('2026-09-24T23:59:59Z');

function event(overrides = {}) {
  return {
    eventId: 'event', country: 'US', authority: 'Authority', eventType: 'economic-release',
    title: 'Consumer Price Index', scheduledAt: Date.parse('2026-09-18T12:30:00Z'),
    scheduledEndAt: null, referencePeriod: null, status: 'scheduled',
    scheduleBasis: 'official-calendar', timePrecision: 'exact',
    sourceUrl: 'https://example.gov/calendar', observedAt: NOW, ...overrides,
  };
}

function boardPort() {
  let reads = 0;
  const manifests = [
    { id: 'calendar.us.fomc', title: 'FOMC', category: 'calendar', viewKind: 'calendar' },
    { id: 'calendar.us.bls', title: 'BLS', category: 'calendar', viewKind: 'calendar' },
    { id: 'calendar.cn.scio', title: 'SCIO', category: 'calendar', viewKind: 'calendar' },
  ];
  const data = {
    'calendar.us.fomc': [event({ eventId: 'fomc', title: 'FOMC Meeting', eventType: 'central-bank-meeting', scheduledAt: Date.parse('2026-09-17T12:30:00Z') })],
    'calendar.us.bls': [
      event({ eventId: 'cpi' }),
      event({ eventId: 'minor', title: 'Minor statistical table', scheduledAt: Date.parse('2026-09-19T12:30:00Z') }),
    ],
    'calendar.cn.scio': [event({
      eventId: 'scio', country: 'CN', authority: '国务院新闻办公室', eventType: 'government-meeting',
      title: 'Notice of SCIO press conference', scheduledAt: Date.parse('2026-09-18T02:00:00Z'),
      sourceUrl: 'https://english.scio.gov.cn/notice',
    })],
  };
  return {
    reads: () => reads,
    list() { return manifests; },
    async read(sourceId) {
      reads += 1;
      return {
        sourceId, providerId: 'provider', observedAt: NOW, status: 'ready', warnings: [],
        data: { available: true, observedAt: NOW, sourceUrl: 'https://example.gov', events: data[sourceId], note: '' },
      };
    },
  };
}

function temporaryStore(prefix) {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  const store = createStore(path.join(directory, 'test.db'));
  return {
    directory,
    store,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('static signal snapshot is projected without reading sources again', async () => {
  const temporary = temporaryStore('ai-center-board-snapshot-');
  const port = boardPort();
  try {
    const saved = await captureStaticSignalBoard({
      sourcePort: port,
      repository: temporary.store.repositories.runtimeSnapshots,
      now: () => NOW,
    });
    assert.equal(saved.upcoming, 4);
    assert.equal(port.reads(), 3);
    const stored = temporary.store.repositories.runtimeSnapshots.readSnapshot('local', 'static-signal-board');
    const focused = projectStaticSignalBoard(stored.payload, {
      from: FROM, to: TO, focus: true, includeUndated: false, limit: 100, releaseLimit: 50,
    });
    assert.deepEqual(focused.upcoming.map((item) => item.eventId), ['fomc', 'scio', 'cpi']);
    const narrow = projectStaticSignalBoard(stored.payload, {
      from: FROM, to: Date.parse('2026-09-17T23:59:59Z'), focus: false, includeUndated: false, limit: 100, releaseLimit: 50,
    });
    assert.deepEqual(narrow.upcoming.map((item) => item.eventId), ['fomc']);
    let clock = NOW;
    const reader = createStaticSignalBoardReader({
      repository: temporary.store.repositories.runtimeSnapshots,
      now: () => clock,
    });
    const first = await reader.read({
      from: FROM, to: TO, focus: '1', includeUndated: '0', limit: '40', releaseLimit: '60',
    });
    assert.equal(first.pending, false);
    assert.equal(first.board.upcoming.length, 3);
    assert.equal(first.board.upcoming.some((item) => item.eventId === 'minor'), false);
    temporary.store.repositories.runtimeSnapshots.saveSnapshot('local', 'static-signal-board', {
      ...stored.payload,
      upcoming: [],
      generatedAt: NOW + 1,
    }, NOW + 1);
    const cached = await reader.read({
      from: FROM, to: TO, focus: true, includeUndated: false, limit: 40, releaseLimit: 60,
    });
    assert.equal(cached.board.upcoming.length, 3);
    const refreshed = await reader.read({
      from: FROM, to: TO, focus: true, includeUndated: false, limit: 40, releaseLimit: 60,
    }, { refresh: true });
    assert.deepEqual(refreshed.board.upcoming, []);
    assert.equal(port.reads(), 3);
  } finally {
    temporary.close();
  }
});

test('static signal endpoint serves the stored snapshot and an empty pending board', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-board-http-'));
  const app = createAiCenterServer({ host: '127.0.0.1', port: 0, dataDirectory: directory });
  const address = await app.listen();
  try {
    const pending = await fetch(`${address.localUrl}/api/v1/static-signals/board?from=0&to=10000&focus=1&includeUndated=0`).then((response) => response.json());
    assert.equal(pending.ok, true);
    assert.equal(pending.pending, true);
    assert.deepEqual(pending.board.upcoming, []);
    const sample = boardPort();
    await captureStaticSignalBoard({
      sourcePort: sample,
      repository: app.store.repositories.runtimeSnapshots,
      now: () => NOW,
    });
    const live = await fetch(`${address.localUrl}/api/v1/static-signals/board?from=${FROM}&to=${TO}&focus=1&includeUndated=0&limit=40&releaseLimit=60&refresh=1`).then((response) => response.json());
    assert.equal(live.ok, true);
    assert.equal(live.pending, undefined);
    assert.deepEqual(live.board.upcoming.map((item) => item.eventId), ['fomc', 'scio', 'cpi']);
    assert.equal(Object.hasOwn(live.board, 'eventSourceIds'), false);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('holdings quotes come from the worker snapshot and keep the last precise price', async () => {
  const temporary = temporaryStore('ai-center-holdings-snapshot-');
  let quoteCalls = 0;
  let historyCalls = 0;
  let dropUsd = false;
  const sourcePort = {
    async read(sourceId, input) {
      if (sourceId === 'market.history') {
        historyCalls += 1;
        return { data: input.symbols.map((symbol) => ({ symbol, points: [{ at: NOW - 86_400_000, close: 10 }] })) };
      }
      quoteCalls += 1;
      const quotes = input.symbols.flatMap((symbol) => {
        if (dropUsd && symbol === 'USDCNY=X') return [];
        return [{ symbol, lastPrice: symbol.includes('=X') ? 7 : 12, prevClose: 11 }];
      });
      return { data: quotes };
    },
  };
  try {
    const first = await captureHoldingsMarket({
      sourcePort,
      repository: temporary.store.repositories.runtimeSnapshots,
      tradingRepository: temporary.store.repositories.trading,
      now: () => NOW,
    });
    assert.equal(first.historyRefreshed, true);
    assert.equal(quoteCalls, 1);
    assert.equal(historyCalls, 1);
    dropUsd = true;
    const second = await captureHoldingsMarket({
      sourcePort,
      repository: temporary.store.repositories.runtimeSnapshots,
      tradingRepository: temporary.store.repositories.trading,
      now: () => NOW + 60_000,
    });
    assert.equal(second.historyRefreshed, false);
    assert.equal(historyCalls, 1);
    assert.equal(quoteCalls, 2);
    const saved = temporary.store.repositories.runtimeSnapshots.readSnapshot('local', HOLDINGS_MARKET_SNAPSHOT_KEY);
    assert.equal(saved.payload.quotes.find((item) => item.symbol === 'USDCNY=X').lastPrice, 7);
    let webReads = 0;
    const trading = createTradingService({
      tradingRepository: temporary.store.repositories.trading,
      sourcePort: { async read() { webReads += 1; return { data: [] }; } },
      holdingsQuotePort: { async read() { return saved; } },
    });
    const board = await trading.getHoldingsBoard({ refresh: true });
    assert.equal(webReads, 0);
    assert.equal(board.fx.usdCny, '7');
    assert.equal(board.fx.hkdCny, '7');
    assert.equal(board.note.includes('行情快照尚未就绪'), false);
    const empty = createTradingService({
      tradingRepository: temporary.store.repositories.trading,
      sourcePort: { async read() { webReads += 1; return { data: [] }; } },
      holdingsQuotePort: { async read() { return null; } },
    });
    const pending = await empty.getHoldingsBoard();
    assert.equal(webReads, 0);
    assert.equal(pending.note.includes('行情快照尚未就绪'), true);
  } finally {
    temporary.close();
  }
});

test('snapshot schedules are one minute interval jobs', () => {
  const temporary = temporaryStore('ai-center-snapshot-schedule-');
  try {
    const board = ensureStaticSignalBoardSchedule(temporary.store, NOW);
    const holdings = ensureHoldingsMarketSchedule(temporary.store, NOW);
    assert.equal(board.jobType, STATIC_SIGNAL_BOARD_JOB_TYPE);
    assert.equal(holdings.jobType, HOLDINGS_MARKET_JOB_TYPE);
    assert.equal(board.schedule.intervalMinutes, 1);
    assert.equal(holdings.schedule.intervalMinutes, 1);
    assert.equal(board.enabled, true);
  } finally {
    temporary.close();
  }
});

test('snapshot cache returns stale data and refreshes behind the request', async () => {
  let clock = 0;
  let reads = 0;
  const cache = createMemorySnapshotCache({
    ttlMs: 45_000,
    now: () => clock,
    read: async () => {
      reads += 1;
      return { n: reads };
    },
  });
  assert.equal((await cache.get()).n, 1);
  clock = 10_000;
  assert.equal((await cache.get()).n, 1);
  assert.equal(reads, 1);
  clock = 50_000;
  assert.equal((await cache.get()).n, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 2);
  assert.equal((await cache.get()).n, 2);
});

test('access summary reports event loop samples apart from requests', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-loop-summary-'));
  writeFileSync(path.join(directory, 'access.2026-10-13.log'), [
    JSON.stringify({
      receivedAt: '2026-10-13T10:00:00.000+08:00',
      path: '/api/v1/ui/revision',
      bytesSent: 10,
      serverMs: 6,
      transferMs: 1,
      totalMs: 7,
    }),
    JSON.stringify({
      kind: 'event-loop',
      receivedAt: '2026-10-13T10:01:00.000+08:00',
      loopP50Ms: 1,
      loopP99Ms: 4,
      loopMaxMs: 9,
    }),
    JSON.stringify({
      kind: 'event-loop',
      receivedAt: '2026-10-13T10:02:00.000+08:00',
      loopP50Ms: 2,
      loopP99Ms: 20,
      loopMaxMs: 40,
    }),
  ].join('\n'));
  try {
    const summary = await readAccessSummary(directory, { date: '2026-10-13', now: () => Date.parse('2026-10-13T12:00:00.000+08:00') });
    assert.equal(summary.count, 1);
    assert.equal(summary.paths[0].path, '/api/v1/ui/revision');
    assert.equal(summary.eventLoop.count, 2);
    assert.equal(summary.eventLoop.max, 40);
    assert.equal(summary.eventLoop.p99.p50, 4);
    assert.equal(summary.eventLoop.p99.max, 20);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
