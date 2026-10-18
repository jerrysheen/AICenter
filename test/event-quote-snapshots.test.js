import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createStore } from '../packages/database/src/index.js';
import { latestSchemaVersion } from '../packages/database/src/migrations.js';
import { PredictionMarketQuoteSchema, parseContract } from '../packages/contracts/src/index.js';
import { parsePolymarketMarkets } from '../packages/connectors/src/market-native.js';
import {
  EVENT_QUOTE_24H_WINDOW_MS,
  EVENT_QUOTE_DAY_MS,
  createEventQuoteSnapshotService,
  selectProbability24hAgo,
  snapshotRowsFromQuotes,
} from '../packages/domain/src/event-quote-snapshots.js';
import {
  captureEventQuoteSnapshots,
  createEventQuoteSnapshotJobHandlers,
  ensureEventQuoteSnapshotSchedule,
  EVENT_QUOTE_SNAPSHOT_JOB_TYPE,
} from '../packages/runtime/src/event-quote-snapshot-job.js';
import { createSourceRoutes } from '../apps/web/src/routes/source-routes.js';
import { createAiCenterWorker } from '../apps/worker/src/worker.js';

const now = Date.UTC(2026, 9, 10, 15, 30, 0);
const target = now - EVENT_QUOTE_DAY_MS;

function temporaryDatabase() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-event-quote-'));
  const store = createStore(path.join(directory, 'test.db'));
  return {
    directory,
    store,
    remove() {
      try { store.close(); } catch { /* worker tests close the store */ }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function predictionQuote(price = '0.61') {
  return parsePolymarketMarkets([{
    id: 'pm-1', conditionId: '0xabc', question: 'Will the Fed cut rates?', slug: 'fed-cut',
    outcomes: '["Yes","No"]', outcomePrices: `["${price}","0.39"]`, volume24hr: 10,
  }], [], now, { limit: 10 })[0];
}

function sourcePort(quotes, { status = 'ready' } = {}) {
  return {
    list: () => [{ id: 'market-native.prediction.polymarket', title: 'P', viewKind: 'prediction-market' }],
    read: async () => {
      if (status === 'throw') throw new Error('upstream down');
      return {
        status, observedAt: now, warnings: [],
        data: {
          available: status === 'ready', observedAt: now, sourceUrl: 'https://example.com/p',
          quotes, note: '',
        },
      };
    },
  };
}

function jsonResponse() {
  return {
    statusCode: 0,
    body: null,
    writeHead(status) { this.statusCode = status; },
    end(payload) { this.body = JSON.parse(String(payload)); },
  };
}

test('event quote snapshots store and replace the same hour without inventing a probability', () => {
  const temporary = temporaryDatabase();
  try {
    assert.equal(temporary.store.getRuntimeStatus().schemaVersion, latestSchemaVersion());
    assert.ok(latestSchemaVersion() >= 51);
    const quote = predictionQuote('0.61');
    const blank = { ...quote, quoteId: 'polymarket:blank:Yes', midPrice: null };
    const rows = snapshotRowsFromQuotes([quote, blank, quote], now);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].symbol, quote.quoteId);
    assert.equal(rows[0].probability, '0.61');
    assert.equal(rows[0].observedAt, Math.floor(now / 3_600_000) * 3_600_000);
    assert.equal(temporary.store.repositories.eventQuotes.saveEventQuoteSnapshots(rows), 1);
    temporary.store.repositories.eventQuotes.saveEventQuoteSnapshots([{ ...rows[0], probability: '0.64' }]);
    const saved = temporary.store.repositories.eventQuotes.listEventQuoteSnapshotsBetween(rows[0].observedAt, rows[0].observedAt);
    assert.deepEqual(saved, [{ symbol: quote.quoteId, probability: '0.64', observedAt: rows[0].observedAt }]);
    const events = temporary.store.listEvents().filter((event) => event.name === 'market.event-quote.snapshot.saved.v1');
    assert.equal(events.length, 2);
    assert.throws(() => temporary.store.repositories.eventQuotes.saveEventQuoteSnapshots([
      { symbol: quote.quoteId, probability: '1.4', observedAt: rows[0].observedAt },
    ]), /事件概率不正确/);
    assert.equal(temporary.store.repositories.eventQuotes.listEventQuoteSnapshotsBetween(0, now).length, 1);
  } finally {
    temporary.remove();
  }
});

test('24h lookup returns the nearest snapshot inside the window and omits anything else', () => {
  const rows = [
    { symbol: 'polymarket:pm-1:Yes', probability: '0.40', observedAt: target },
    { symbol: 'polymarket:pm-1:Yes', probability: '0.50', observedAt: target - 2 * 3_600_000 },
    { symbol: 'polymarket:pm-1:Yes', probability: '0.70', observedAt: now - 2 * 3_600_000 },
    { symbol: 'polymarket:other:Yes', probability: '0.20', observedAt: target - EVENT_QUOTE_24H_WINDOW_MS },
    { symbol: 'polymarket:edge:Yes', probability: '0.30', observedAt: target - EVENT_QUOTE_24H_WINDOW_MS - 1 },
    { symbol: 'polymarket:tie:Yes', probability: '0.11', observedAt: target - 3_600_000 },
    { symbol: 'polymarket:tie:Yes', probability: '0.99', observedAt: target + 3_600_000 },
  ];
  assert.equal(selectProbability24hAgo(rows.filter((row) => row.symbol === 'polymarket:pm-1:Yes'), now), '0.40');
  assert.equal(selectProbability24hAgo(rows.filter((row) => row.symbol === 'polymarket:other:Yes'), now), '0.20');
  assert.equal(selectProbability24hAgo(rows.filter((row) => row.symbol === 'polymarket:edge:Yes'), now), null);
  assert.equal(selectProbability24hAgo(rows.filter((row) => row.symbol === 'polymarket:tie:Yes'), now), '0.11');
  assert.equal(selectProbability24hAgo([], now), null);

  const temporary = temporaryDatabase();
  try {
    const service = createEventQuoteSnapshotService({ repository: temporary.store.repositories.eventQuotes, now: () => now });
    temporary.store.repositories.eventQuotes.saveEventQuoteSnapshots([
      { symbol: 'polymarket:pm-1:Yes', probability: '0.42', observedAt: target },
    ]);
    const quote = predictionQuote('0.61');
    const board = {
      generatedAt: now,
      predictionMarkets: [quote],
      cryptoDerivatives: [],
      stablecoinLiquidity: null,
      sourceHealth: [],
    };
    const withHistory = service.attachPriorPrices(board, now);
    assert.equal(withHistory.predictionMarkets[0].midPrice24hAgo, '0.42');
    assert.equal(withHistory.predictionMarkets[0].midPrice, quote.midPrice);
    temporary.store.repositories.eventQuotes.saveEventQuoteSnapshots([
      { symbol: 'polymarket:recent:Yes', probability: '0.10', observedAt: now - 3_600_000 },
    ]);
    const recentOnly = service.attachPriorPrices({
      ...board,
      predictionMarkets: [{ ...quote, quoteId: 'polymarket:recent:Yes' }],
    }, now);
    assert.equal('midPrice24hAgo' in recentOnly.predictionMarkets[0], false);
  } finally {
    temporary.remove();
  }
});

test('hourly job persists live event quotes and retries when every prediction source is down', async () => {
  const temporary = temporaryDatabase();
  try {
    const quote = predictionQuote('0.55');
    const service = createEventQuoteSnapshotService({ repository: temporary.store.repositories.eventQuotes, now: () => now });
    const saved = await captureEventQuoteSnapshots({
      sourcePort: sourcePort([quote, { ...quote, quoteId: 'polymarket:empty:Yes', midPrice: null }]),
      service,
      now: () => now,
    });
    assert.equal(saved.count, 1);
    assert.equal(saved.observedAt, Math.floor(now / 3_600_000) * 3_600_000);
    const stored = temporary.store.repositories.eventQuotes.listEventQuoteSnapshotsBetween(0, now);
    assert.deepEqual(stored.map((row) => row.symbol), [quote.quoteId]);
    await assert.rejects(
      () => captureEventQuoteSnapshots({ sourcePort: sourcePort([], { status: 'throw' }), service, now: () => now }),
      /事件报价来源暂不可用/,
    );
    const handlers = createEventQuoteSnapshotJobHandlers({
      repository: temporary.store.repositories.eventQuotes,
      sourcePort: sourcePort([quote]),
      now: () => now + 3_600_000,
    });
    const again = await handlers[EVENT_QUOTE_SNAPSHOT_JOB_TYPE]({ scheduleKey: 'market.event-quote.snapshot', scheduledFor: now });
    assert.equal(again.count, 1);
    const first = ensureEventQuoteSnapshotSchedule(temporary.store, now);
    const second = ensureEventQuoteSnapshotSchedule(temporary.store, now + 3_600_000);
    assert.equal(first.jobType, EVENT_QUOTE_SNAPSHOT_JOB_TYPE);
    assert.equal(first.schedule.kind, 'interval');
    assert.equal(first.schedule.intervalMinutes, 60);
    assert.equal(first.nextRunAt, now);
    assert.equal(second.nextRunAt, first.nextRunAt);
  } finally {
    temporary.remove();
  }
});

test('market-native board adds midPrice24hAgo only when a snapshot exists', async () => {
  const temporary = temporaryDatabase();
  try {
    const quote = predictionQuote('0.61');
    const route = createSourceRoutes().find((item) => item.path === '/api/v1/market-native/board');
    const services = {
      sources: sourcePort([quote]),
      eventQuotes: createEventQuoteSnapshotService({ repository: temporary.store.repositories.eventQuotes, now: () => now }),
      feed: null,
    };
    const url = new URL('http://127.0.0.1/api/v1/market-native/board?predictionLimit=10');
    const missing = jsonResponse();
    await route.handler({ response: missing, services, identity: null, url });
    assert.equal(missing.statusCode, 200);
    assert.equal(missing.body.ok, true);
    assert.equal(missing.body.board.predictionMarkets[0].quoteId, quote.quoteId);
    assert.equal('midPrice24hAgo' in missing.body.board.predictionMarkets[0], false);
    temporary.store.repositories.eventQuotes.saveEventQuoteSnapshots([
      { symbol: quote.quoteId, probability: '0.58', observedAt: target },
    ]);
    const found = jsonResponse();
    await route.handler({ response: found, services, identity: null, url });
    assert.equal(found.body.board.predictionMarkets[0].midPrice, quote.midPrice);
    assert.equal(found.body.board.predictionMarkets[0].midPrice24hAgo, '0.58');
    assert.equal('bullish' in found.body.board.predictionMarkets[0], false);
  } finally {
    temporary.remove();
  }
});

test('prediction quote contract keeps the 24h field optional', () => {
  const quote = predictionQuote('0.5');
  const parsed = parseContract(PredictionMarketQuoteSchema, quote);
  assert.equal('midPrice24hAgo' in parsed, false);
  assert.equal(parseContract(PredictionMarketQuoteSchema, { ...quote, midPrice24hAgo: '0.25' }).midPrice24hAgo, '0.25');
  assert.throws(() => parseContract(PredictionMarketQuoteSchema, { ...quote, midPrice24hAgo: '1.2' }));
  assert.throws(() => parseContract(PredictionMarketQuoteSchema, { ...quote, bullish: true }));
});

test('worker installs the hourly event quote snapshot beside existing schedules', async () => {
  const temporary = temporaryDatabase();
  let worker;
  try {
    worker = createAiCenterWorker({
      store: temporary.store,
      browserRuntime: { providerId: 'test', health: async () => null },
    });
    const schedule = temporary.store.getJobSchedule('local', 'market.event-quote.snapshot');
    assert.equal(schedule.enabled, true);
    assert.equal(schedule.jobType, EVENT_QUOTE_SNAPSHOT_JOB_TYPE);
    assert.equal(schedule.schedule.intervalMinutes, 60);
    assert.equal(temporary.store.getJobSchedule('local', 'report.hourly.default').jobType, 'report.hourly.extract');
  } finally {
    await worker?.close();
    temporary.remove();
  }
});

function element(tag) {
  return {
    tag,
    className: '',
    textContent: '',
    style: {},
    children: [],
    append(...nodes) { this.children.push(...nodes); },
    addEventListener() {},
  };
}

function walk(node, visit) {
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}

function dayChangeNodes(root) {
  const found = [];
  walk(root, (node) => {
    if (String(node.textContent || '').includes('较昨日')) found.push(node);
  });
  return found;
}

const appSource = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');

function functionSource(name) {
  const match = appSource.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, name);
  return match[0];
}

test('prediction quote shows 较昨日 with existing up and down colors, and hides it without history', () => {
  const css = readFileSync(new URL('../apps/web/public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.prediction-side \.prediction-day-change\.up \{ color: var\(--data-up\); \}/);
  assert.match(css, /\.prediction-side \.prediction-day-change\.down \{ color: var\(--data-down\); \}/);
  const context = vm.createContext({
    document: { createElement: (tag) => element(tag) },
    localizedCopy: (_id, text) => text,
    formatTime: () => '',
    marketNativeAmount: () => '',
    attachGuardedOpen: () => {},
    openExternalHttpUrl: () => {},
  });
  vm.runInContext([
    'predictionShare', 'formatPredictionShare', 'predictionDayChange', 'predictionChangeNode', 'appendPredictionQuote',
  ].map(functionSource).join('\n'), context);
  assert.equal(JSON.stringify(context.predictionDayChange('0.61', '0.58')), JSON.stringify({ text: '较昨日 +3.0 个百分点', direction: 'up' }));
  assert.equal(JSON.stringify(context.predictionDayChange('0.40', '0.55')), JSON.stringify({ text: '较昨日 -15.0 个百分点', direction: 'down' }));
  assert.equal(JSON.stringify(context.predictionDayChange('0.50', '0.50')), JSON.stringify({ text: '较昨日 0.0 个百分点', direction: '' }));
  assert.equal(context.predictionDayChange('0.62', '0.50', 4).text, '较 4h 前 +12.0 个百分点');
  assert.equal(context.predictionDayChange('0.62', '0.50', 3).text, '较 3h 前 +12.0 个百分点');
  assert.equal(context.predictionDayChange('0.50', undefined), null);
  assert.equal(context.predictionDayChange(null, '0.50'), null);
  assert.equal(context.predictionShare(null), null);
  assert.equal(context.formatPredictionShare(null), '—');

  const upRoot = element('div');
  context.appendPredictionQuote(upRoot, { ...predictionQuote('0.61'), midPrice24hAgo: '0.58' });
  const upChange = dayChangeNodes(upRoot);
  assert.equal(upChange.length, 1);
  assert.equal(upChange[0].textContent, '较昨日 +3.0 个百分点');
  assert.equal(upChange[0].className, 'prediction-day-change up');
  assert.equal(textOf(upRoot).includes('正在读取'), false);
  assert.equal(textOf(upRoot).includes('上次'), false);

  const recentRoot = element('div');
  context.appendPredictionQuote(recentRoot, { ...predictionQuote('0.62'), midPrice24hAgo: '0.50', changeBasis: 4, lastPrice: '0.42' });
  assert.match(textOf(recentRoot), /较 4h 前 \+12\.0/);
  assert.match(textOf(recentRoot), /上次 42\.0%/);
  assert.equal(textOf(recentRoot).includes('较昨日'), false);

  const downRoot = element('div');
  context.appendPredictionQuote(downRoot, { ...predictionQuote('0.40'), midPrice24hAgo: '0.55' });
  const downChange = dayChangeNodes(downRoot);
  assert.equal(downChange[0].textContent, '较昨日 -15.0 个百分点');
  assert.equal(downChange[0].className, 'prediction-day-change down');

  const emptyRoot = element('div');
  context.appendPredictionQuote(emptyRoot, predictionQuote('0.61'));
  assert.equal(dayChangeNodes(emptyRoot).length, 0);
  assert.equal(textOf(emptyRoot).includes('正在读取'), false);
  const missingPrice = element('div');
  context.appendPredictionQuote(missingPrice, { ...predictionQuote('0.61'), midPrice: null, midPrice24hAgo: '0.40' });
  assert.equal(dayChangeNodes(missingPrice).length, 0);
});

function textOf(node) {
  return [node.textContent || '', ...(node.children || []).map(textOf)].join('');
}
