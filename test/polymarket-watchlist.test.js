import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createStore } from '../packages/database/src/index.js';
import { PredictionMarketSourceViewSchema, parseContract } from '../packages/contracts/src/index.js';
import { createMarketNativeClient, parsePolymarketMarkets } from '../packages/connectors/src/market-native.js';
import {
  createPolymarketGammaClient,
  createPolymarketGate,
  parsePolymarketEvent,
} from '../packages/connectors/src/polymarket-gamma.js';
import { loadPolymarketWatchlist, polymarketLegacyEnabled } from '../packages/connectors/src/polymarket-watchlist.js';
import {
  bucketObservedAt,
  pointsKeptAfterDownsample,
  POLYMARKET_DAY_MS,
  projectWatchlistQuotes,
  readStoredPolymarketView,
} from '../packages/domain/src/polymarket-series.js';
import { readMarketNativeBoard } from '../packages/source/src/static/market-native-board.js';
import { createMarketNativeBoardReader, MARKET_NATIVE_BOARD_SNAPSHOT_KEY } from '../packages/source/src/static/market-native-read.js';
import {
  capturePolymarketWatchlist,
  watchlistRowsFromEvents,
} from '../packages/runtime/src/polymarket-watchlist-job.js';

const APPROVED_SLUGS = [
  'fed-decision-in-october-20260617190323537',
  'fed-decision-in-december-20260729232808632',
  'what-will-the-fed-rate-be-at-the-end-of-2026',
  'another-fed-rate-hike-in-2026',
  'us-gdp-growth-in-q3-2026-20260730144539767',
  'core-pce-yoy-september-2026',
  'october-inflation-us-annual',
  'core-cpi-yoy-october-2026',
  'october-unemployment-rate-2026',
  'how-many-jobs-added-in-october-2026',
  'ism-manufacturing-pmi-october-2026',
  'us-recession-by-end-of-2026',
  'china-gdp-growth-yy-in-q3-2026-20260716161116873',
  'october-inflation-china-annual',
  'ecb-interest-rates-december-2026',
  'bank-of-japan-decision-in-december-20260918',
  'how-low-will-10-year-treasury-yield-get-in-october',
  'how-high-will-10-year-treasury-yield-go-before-2027',
  'what-price-will-dxy-hit-in-october-2026',
  'what-price-will-spy-hit-in-october-2026',
  'spx-hit-dec-2026',
  'what-price-will-wti-hit-in-october-2026',
  'crude-oil-all-time-high-by',
  'what-price-will-xauusd-hit-in-october-2026',
  'what-will-gold-gc-hit-by-end-of-december',
  'us-iran-ceasefire-continues-throughptptpt',
  'strait-of-hormuz-traffic-returns-to-normal-by-october-31-20260810151043583',
  'us-iran-hormuz-agreement-byptptpt-20260803235957575',
  'bab-el-mandeb-strait-effectively-closed-by',
  'will-china-invade-taiwan-before-2027',
  'russia-x-ukraine-ceasefire-agreement-by',
  'gpu-rental-prices-h200-end-of-october',
  'gpu-rental-prices-h100-end-of-october',
  'what-price-will-bitcoin-hit-in-october-2026',
  'what-price-will-bitcoin-hit-in-november-2026',
];

function temporaryDatabase() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-polymarket-'));
  const store = createStore(path.join(directory, 'test.db'));
  return {
    store,
    remove() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function eventFixture(overrides = {}) {
  return {
    id: '606422',
    slug: 'fed-decision-in-october-20260617190323537',
    title: 'Fed Decision in October?',
    closed: false,
    endDate: '2026-10-29T03:59:00Z',
    volume24hr: 1200,
    volume: 9000,
    tags: [{ slug: 'fed' }, { slug: 'fomc' }],
    markets: [
      {
        id: '2589810',
        slug: 'will-the-fed-decrease-interest-rates-by-50-bps-after-the-october-2026-meeting-20260617190324029',
        question: 'Will the Fed decrease interest rates by 50+ bps after the October 2026 meeting?',
        groupItemTitle: '50+ bps decrease',
        outcomes: '["Yes","No"]',
        outcomePrices: '["0.01","0.99"]',
        bestBid: 0.009,
        bestAsk: 0.011,
        volume24hr: 10,
        volume: 20,
        liquidity: 5000,
        closed: false,
      },
      {
        id: '2589811',
        slug: 'no-change-20260617190324029',
        groupItemTitle: 'No change',
        outcomes: '["Yes","No"]',
        outcomePrices: '["0.62","0.38"]',
        bestBid: 0.6,
        bestAsk: 0.64,
        liquidity: 8000,
        closed: false,
      },
    ],
    ...overrides,
  };
}

test('watchlist config keeps the approved slugs and both bitcoin months', () => {
  const config = loadPolymarketWatchlist(path.resolve('config/polymarket-watchlist.json'));
  const slugs = config.fixed.map((entry) => entry.slug);
  for (const slug of APPROVED_SLUGS) assert.equal(slugs.includes(slug), true, slug);
  assert.equal(slugs.includes('what-price-will-bitcoin-hit-before-2027'), false);
  assert.equal(config.rollingSeries.find((series) => series.id === 'btc-monthly').hold, 2);
  assert.equal(polymarketLegacyEnabled({}), false);
  assert.equal(polymarketLegacyEnabled({ AI_CENTER_POLYMARKET_LEGACY: '1' }), true);
});

test('event id is the identity and substring keywords do not select markets', () => {
  const parsed = parsePolymarketEvent(eventFixture(), 10);
  assert.equal(parsed[0].eventId, '606422');
  assert.notEqual(parsed[0].eventId, parsed[0].eventSlug);
  assert.match(parsed[0].marketSlug, /20260617190324029$/);
  const config = loadPolymarketWatchlist(path.resolve('config/polymarket-watchlist.json'));
  const noise = eventFixture({
    id: '9',
    slug: 'bitcoin-up-or-down-on-october-16-2026',
    title: 'Whether the method gathers oil and eth exposure',
  });
  const selected = watchlistRowsFromEvents([noise, eventFixture()], config, 10);
  assert.deepEqual(selected.outcomes.map((row) => row.eventId), ['606422', '606422']);
  assert.equal(selected.outcomes.some((row) => row.title.includes('Whether')), false);
  const legacy = parsePolymarketMarkets([{
    id: 'noise', question: 'Whether the method gathers oil', outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]',
  }], [], 10, { limit: 10 });
  assert.equal(legacy.length, 1);
});

test('gamma fetches /events in batches, coalesces the same request, and backs off on 429', async () => {
  let clock = 0;
  const sleeps = [];
  const urls = [];
  let attempts = 0;
  const gate = createPolymarketGate({
    minIntervalMs: 800,
    timeoutMs: 0,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  const fetch = async (url) => {
    urls.push(String(url));
    attempts += 1;
    if (attempts === 1) {
      return { ok: false, status: 429, headers: { get: () => '2' }, json: async () => ({}) };
    }
    const slug = new URL(String(url)).searchParams.getAll('slug');
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => slug.map((value, index) => ({ id: String(index + 1), slug: value, title: value, markets: [] })),
    };
  };
  const client = createPolymarketGammaClient({ fetch, gate, batchSize: 2, timeoutMs: 0 });
  const [first, second] = await Promise.all([
    client.fetchEventsBySlugs(['alpha', 'beta']),
    client.fetchEventsBySlugs(['alpha', 'beta']),
  ]);
  assert.equal(first.length, 2);
  assert.equal(second.length, 2);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /\/events\?/);
  assert.match(urls[0], /slug=alpha/);
  assert.match(urls[0], /slug=beta/);
  assert.ok(sleeps.some((ms) => ms >= 800));
  await client.fetchEventsBySlugs(['gamma']);
  assert.equal(urls.length, 3);
});

test('a timed out polymarket request releases the queue for the next one', async () => {
  const gate = createPolymarketGate({ minIntervalMs: 0, timeoutMs: 20, sleep: async () => {} });
  const controller = new AbortController();
  const task = new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('late')), 500);
    controller.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('stopped'));
    }, { once: true });
  });
  try {
    await assert.rejects(gate.request('hung', () => task), /请求超时/);
  } finally {
    controller.abort();
  }
  assert.equal(gate.inflightCount(), 0);
  assert.equal(await gate.request('next', async () => 'ok'), 'ok');

  let aborted = false;
  let calls = 0;
  const client = createPolymarketGammaClient({
    timeoutMs: 30,
    gate: createPolymarketGate({ minIntervalMs: 0, timeoutMs: 0, sleep: async () => {} }),
    fetch: (_url, init) => {
      calls += 1;
      if (calls > 1) return Promise.resolve({ ok: true, status: 200, json: async () => [] });
      return new Promise((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('late')), 500);
        init.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          aborted = true;
          reject(init.signal.reason || new Error('aborted'));
        }, { once: true });
      });
    },
  });
  await assert.rejects(client.fetchEventsBySlugs(['slow']), /超时|aborted|abort/i);
  assert.equal(aborted, true);
  assert.deepEqual(await client.fetchEventsBySlugs(['later']), []);
  await new Promise((resolve) => setTimeout(resolve, 40));
});

test('wide bid ask spreads use the outcome price instead of the midpoint', () => {
  const wide = parsePolymarketEvent({
    id: '1', slug: 'wide', title: 'Wide',
    markets: [{
      id: 'm', groupItemTitle: 'Yes', outcomes: '["Yes","No"]', outcomePrices: '["0.42","0.58"]',
      bestBid: 0.01, bestAsk: 0.99, lastTradePrice: 0.4,
    }],
  });
  assert.equal(wide[0].probability, '0.42');
  const lastOnly = parsePolymarketEvent({
    id: '2', slug: 'last', title: 'Last',
    markets: [{
      id: 'm2', groupItemTitle: 'Yes', outcomes: '["Yes","No"]', outcomePrices: '[]',
      bestBid: 0.01, bestAsk: 0.9, lastTradePrice: 0.37,
    }],
  });
  assert.equal(lastOnly[0].probability, '0.37');
  const tight = parsePolymarketEvent({
    id: '3', slug: 'tight', title: 'Tight',
    markets: [{
      id: 'm3', groupItemTitle: 'Yes', outcomes: '["Yes","No"]', outcomePrices: '["0.10","0.90"]',
      bestBid: 0.4, bestAsk: 0.44,
    }],
  });
  assert.equal(tight[0].probability, '0.42');
});

test('downsample only collapses the two hours before the cutoff', () => {
  const temporary = temporaryDatabase();
  const cutoff = Date.UTC(2026, 9, 16, 12, 0, 0);
  const inside = cutoff - 90 * 60 * 1000;
  const outside = cutoff - 48 * 60 * 60 * 1000;
  const points = [];
  for (let step = 0; step < 6; step += 1) {
    points.push({
      eventId: '1', marketId: 'm', outcomeKey: 'yes', observedAt: inside + step * 5 * 60 * 1000,
      probability: '0.20', granularity: '5m',
    });
    points.push({
      eventId: '1', marketId: 'm', outcomeKey: 'yes', observedAt: outside + step * 5 * 60 * 1000,
      probability: '0.10', granularity: '5m',
    });
  }
  try {
    const repository = temporary.store.repositories.polymarket;
    repository.saveWatchlist({
      outcomes: [{
        eventId: '1', marketId: 'm', outcomeKey: 'yes', seriesId: '', watched: true, sortOrder: 0,
        groupKey: 'us-data', alertProfile: 'binary', eventSlug: 'recession', marketSlug: '',
        title: 'US recession by end of 2026?', outcomeLabel: 'Yes', lifecycle: 'open', endAt: null,
        liquidity: '9000', volume24h: '10', totalVolume: '20', probability: '0.55',
        sourceUrl: 'https://polymarket.com/event/recession', updatedAt: cutoff,
      }],
      points,
      at: cutoff,
    });
    const removed = repository.downsampleBefore(cutoff);
    assert.equal(removed > 0, true);
    const kept = repository.listPointsBetween(0, cutoff);
    const oldPoints = kept.filter((point) => point.observedAt < cutoff - 2 * 60 * 60 * 1000);
    const recent = kept.filter((point) => point.observedAt >= cutoff - 2 * 60 * 60 * 1000);
    assert.equal(oldPoints.length, 6);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].granularity, '1h');
    const anchors = repository.listDashboardPoints(cutoff);
    assert.equal(anchors.length <= 2, true);
    const view = readStoredPolymarketView(repository, cutoff);
    assert.equal(view.quotes[0].midPrice, '0.55');
  } finally {
    temporary.remove();
  }
});

test('five minute points downsample to one hourly point after 30 days and day change uses the series', () => {
  const now = Date.UTC(2026, 9, 16, 12, 0, 0);
  assert.equal(bucketObservedAt(now + 60_000), now);
  const oldHour = now - 31 * POLYMARKET_DAY_MS;
  const points = [];
  for (let step = 0; step < 12; step += 1) {
    points.push({
      eventId: '1', marketId: 'm', outcomeKey: 'yes',
      observedAt: oldHour + step * 5 * 60_000, probability: '0.10', granularity: '5m',
    });
  }
  points.push({
    eventId: '1', marketId: 'm', outcomeKey: 'yes',
    observedAt: now - POLYMARKET_DAY_MS, probability: '0.40', granularity: '5m',
  });
  points.push({
    eventId: '1', marketId: 'm', outcomeKey: 'yes',
    observedAt: now, probability: '0.55', granularity: '5m',
  });
  const kept = pointsKeptAfterDownsample(points, now - 30 * POLYMARKET_DAY_MS);
  assert.equal(kept.filter((point) => point.observedAt < now - 30 * POLYMARKET_DAY_MS).length, 1);
  assert.equal(kept.find((point) => point.observedAt < now - 30 * POLYMARKET_DAY_MS).granularity, '1h');
  assert.equal(kept.filter((point) => point.observedAt >= now - 30 * POLYMARKET_DAY_MS).length, 2);

  const outcomes = [{
    eventId: '1', marketId: 'm', outcomeKey: 'yes', watched: true, sortOrder: 0,
    title: 'US recession by end of 2026?', outcomeLabel: 'Yes', lifecycle: 'open',
    probability: '0.55', volume24h: '10', totalVolume: '20', liquidity: '4000',
    endAt: now + 86_400_000, sourceUrl: 'https://polymarket.com/event/recession', updatedAt: now,
  }];
  const [quote] = projectWatchlistQuotes(outcomes, points, now);
  assert.equal(quote.midPrice24hAgo, '0.40');
  assert.equal(quote.midPrice, '0.55');
  assert.equal('seriesId' in quote, false);
  assert.equal('alertProfile' in quote, false);
  assert.equal('eventSlug' in quote, false);
  assert.equal(parseContract(PredictionMarketSourceViewSchema, {
    available: true, observedAt: now, sourceUrl: 'https://polymarket.com', quotes: [quote], note: '',
  }).quotes[0].quoteId, 'polymarket:event:1');
});

test('stored watchlist keeps a low-volume market and does not wipe it when another slug is missing', async () => {
  const temporary = temporaryDatabase();
  const now = Date.UTC(2026, 9, 16, 12, 0, 0);
  const config = {
    fixed: [
      { slug: 'recession', group: 'us-data', alertProfile: 'binary', seriesId: '' },
      { slug: 'what-price-will-bitcoin-hit-in-november-2026', group: 'crypto', alertProfile: 'multi', seriesId: 'btc-monthly' },
    ],
    fetch: { pointIntervalMinutes: 5, downsampleAfterDays: 30 },
  };
  const events = [{
    id: '48802',
    slug: 'recession',
    title: 'US recession by end of 2026?',
    volume24hr: 12,
    volume: 40,
    markets: [{
      id: 'm-1', groupItemTitle: 'Yes', outcomes: '["Yes","No"]', outcomePrices: '["0.22","0.78"]',
      liquidity: 9000, closed: false,
    }],
  }];
  try {
    const saved = await capturePolymarketWatchlist({
      client: { fetchEventsBySlugs: async () => events },
      repository: temporary.store.repositories.polymarket,
      config,
      now: () => now,
    });
    assert.deepEqual(saved.missing, ['what-price-will-bitcoin-hit-in-november-2026']);
    await assert.rejects(() => capturePolymarketWatchlist({
      client: { fetchEventsBySlugs: async () => [] },
      repository: temporary.store.repositories.polymarket,
      config: { ...config, fixed: config.fixed.slice(0, 1) },
      now: () => now + 5 * 60_000,
    }), /没有返回任何事件/);
    const still = temporary.store.repositories.polymarket.listWatchedOutcomes();
    assert.equal(still.length, 1);
    assert.equal(still[0].eventId, '48802');
    assert.equal(still[0].probability, '0.22');
    const view = readStoredPolymarketView(temporary.store.repositories.polymarket, now + 5 * 60_000);
    assert.equal(view.quotes.length, 1);
    assert.equal(view.quotes[0].marketQuestion, 'US recession by end of 2026?');
    const board = await readMarketNativeBoard({
      list: () => [
        { id: 'market-native.prediction.polymarket', title: 'P', viewKind: 'prediction-market' },
        { id: 'market-native.prediction.kalshi', title: 'K', viewKind: 'prediction-market' },
      ],
      read: async (id) => ({
        status: 'ready', observedAt: now, warnings: [],
        data: {
          available: true, observedAt: now, sourceUrl: 'https://polymarket.com', note: '',
          quotes: id.endsWith('kalshi')
            ? [{ ...view.quotes[0], quoteId: 'kalshi:big', venue: 'kalshi', marketId: 'big', volume24h: '999999', marketQuestion: 'Big' }]
            : [{ ...view.quotes[0], volume24h: '1' }],
        },
      }),
    }, { predictionLimit: 1 }, { keepPredictionOrder: true, now: () => now });
    assert.equal(board.predictionMarkets[0].marketQuestion, 'US recession by end of 2026?');
  } finally {
    temporary.remove();
  }
});

test('the board reads the watchlist instead of the first 24 snapshot rows', async () => {
  const temporary = temporaryDatabase();
  const now = Date.UTC(2026, 9, 16, 12, 0, 0);
  const legacy = Array.from({ length: 24 }, (_, index) => ({
    quoteId: `polymarket:legacy:${index}`,
    venue: 'polymarket',
    marketId: `legacy-${index}`,
    marketQuestion: `Legacy market ${index}`,
    outcome: 'Yes',
    midPrice: '0.50',
    bestBid: null,
    bestAsk: null,
    spread: null,
    lastPrice: null,
    volume24h: '900000',
    totalVolume: '900000',
    liquidity: '900000',
    openInterest: null,
    endAt: null,
    sourceUrl: 'https://polymarket.com/event/legacy',
    observedAt: now,
  }));
  const kalshi = {
    ...legacy[0],
    quoteId: 'kalshi:fed',
    venue: 'kalshi',
    marketId: 'KXFED',
    marketQuestion: 'Fed decision',
  };
  const kalshiOther = {
    ...kalshi,
    quoteId: 'kalshi:other',
    marketId: 'KXOTHER',
    marketQuestion: 'Other venue',
  };
  function outcome(eventId, title, sortOrder, extra = {}) {
    return {
      eventId,
      marketId: 'm',
      outcomeKey: 'yes',
      seriesId: extra.seriesId || '',
      watched: true,
      sortOrder,
      groupKey: extra.groupKey || 'macro',
      alertProfile: 'binary',
      eventSlug: eventId,
      marketSlug: '',
      title,
      outcomeLabel: 'Yes',
      lifecycle: 'open',
      endAt: null,
      liquidity: '9000',
      volume24h: '10',
      totalVolume: '20',
      probability: '0.40',
      sourceUrl: `https://polymarket.com/event/${eventId}`,
      updatedAt: now,
      ...extra,
    };
  }
  try {
    const repository = temporary.store.repositories.polymarket;
    const outcomes = Array.from({ length: 24 }, (_, index) => outcome(`early-${index}`, `Early market ${index}`, index));
    outcomes.push(
      outcome('gold', 'What will gold (GC) hit by end of December?', 24, { groupKey: 'commodities' }),
      outcome('iran', 'US x Iran ceasefire continues?', 25, { groupKey: 'geopolitics', alertProfile: 'geopolitics' }),
      outcome('hormuz', 'Strait of Hormuz traffic returns to normal by October 31?', 26, { groupKey: 'geopolitics', alertProfile: 'geopolitics' }),
      outcome('ukraine', 'Russia x Ukraine ceasefire agreement by...?', 27, { groupKey: 'geopolitics', alertProfile: 'geopolitics' }),
      outcome('taiwan', 'Will China invade Taiwan before 2027?', 28, { groupKey: 'geopolitics', alertProfile: 'geopolitics' }),
      outcome('bab', 'Bab el-Mandeb strait effectively closed by...?', 29, { groupKey: 'geopolitics', alertProfile: 'geopolitics' }),
      outcome('h200', 'GPU rental prices (H200) end of October?', 30, { seriesId: 'gpu-h200', groupKey: 'compute' }),
      outcome('h100', 'GPU rental prices (H100) end of October?', 31, { seriesId: 'gpu-h100', groupKey: 'compute' }),
      outcome('1112205', 'What price will Bitcoin hit in October?', 32, { seriesId: 'btc-monthly', groupKey: 'crypto', alertProfile: 'multi', outcomeLabel: '100k' }),
      outcome('pending:btc-monthly:November', 'What price will Bitcoin hit in November?', 33, {
        seriesId: 'btc-monthly',
        groupKey: 'crypto',
        alertProfile: 'multi',
        marketId: 'pending',
        outcomeKey: 'pending',
        outcomeLabel: '待定',
        lifecycle: 'pending_rollover',
        probability: null,
        liquidity: null,
        volume24h: null,
        totalVolume: null,
        eventSlug: '',
        sourceUrl: 'https://polymarket.com',
      }),
    );
    repository.saveWatchlist({ outcomes, at: now });
    temporary.store.repositories.runtimeSnapshots.saveSnapshot('local', MARKET_NATIVE_BOARD_SNAPSHOT_KEY, {
      generatedAt: now,
      predictionMarkets: [...legacy, kalshi, kalshiOther],
      cryptoDerivatives: [],
      stablecoinLiquidity: null,
      sourceHealth: [],
    }, now);
    let reads = 0;
    const reader = createMarketNativeBoardReader({
      repository: temporary.store.repositories.runtimeSnapshots,
      polymarketQuotes: () => {
        reads += 1;
        return readStoredPolymarketView(repository, now);
      },
      now: () => now,
    });
    const loaded = await reader.read({ predictionLimit: 1 });
    assert.equal(loaded.pending, false);
    const questions = loaded.board.predictionMarkets.map((quote) => quote.marketQuestion);
    assert.equal(questions.some((title) => title.startsWith('Legacy market')), false);
    assert.equal(questions.includes('What price will Bitcoin hit in October?'), true);
    const november = loaded.board.predictionMarkets.find((quote) => quote.marketQuestion === 'What price will Bitcoin hit in November?');
    assert.equal(november.statusLabel, '下一期尚未出现');
    for (const title of [
      'What will gold (GC) hit by end of December?',
      'US x Iran ceasefire continues?',
      'Strait of Hormuz traffic returns to normal by October 31?',
      'Russia x Ukraine ceasefire agreement by...?',
      'Will China invade Taiwan before 2027?',
      'Bab el-Mandeb strait effectively closed by...?',
      'GPU rental prices (H200) end of October?',
      'GPU rental prices (H100) end of October?',
    ]) {
      assert.equal(questions.includes(title), true, title);
    }
    assert.equal(loaded.board.predictionMarkets.length > 24, true);
    assert.equal(loaded.board.predictionMarkets.filter((quote) => quote.venue === 'polymarket').length, 34);
    assert.deepEqual(
      loaded.board.predictionMarkets.filter((quote) => quote.venue !== 'polymarket').map((quote) => quote.marketQuestion),
      ['Fed decision'],
    );
    const again = await reader.read({ predictionLimit: 1 });
    assert.equal(reads, 1);
    assert.equal(again.board.predictionMarkets.length, loaded.board.predictionMarkets.length);
    const refreshed = await reader.read({ predictionLimit: 50 }, { refresh: true });
    assert.equal(reads, 2);
    assert.deepEqual(
      refreshed.board.predictionMarkets.filter((quote) => quote.venue !== 'polymarket').map((quote) => quote.marketQuestion),
      ['Fed decision', 'Other venue'],
    );
  } finally {
    temporary.remove();
  }
});

test('legacy mode still ranks by 24h volume and watchlist mode does not call that endpoint', async () => {
  const urls = [];
  const legacy = createMarketNativeClient({
    env: { AI_CENTER_POLYMARKET_LEGACY: '1' },
    fetch: async (url) => {
      urls.push(String(url));
      return { ok: true, json: async () => [] };
    },
  });
  await legacy.polymarket({ limit: 12 });
  assert.match(urls[0], /\/markets\?/);
  assert.match(urls[0], /order=volume24hr/);
  let called = 0;
  const watchlist = createMarketNativeClient({
    env: {},
    polymarketQuotes: () => ({
      available: true, observedAt: 5, sourceUrl: 'https://polymarket.com', quotes: [], note: '',
    }),
    fetch: async () => {
      called += 1;
      throw new Error('live');
    },
  });
  const view = await watchlist.polymarket();
  assert.equal(called, 0);
  assert.equal(view.available, true);
});

test('a series younger than 24h falls back to the earliest point at least 1h old', () => {
  const temporary = temporaryDatabase();
  const now = Date.UTC(2026, 9, 16, 12, 0, 0);
  const hour = 60 * 60 * 1000;
  try {
    const repository = temporary.store.repositories.polymarket;
    repository.saveWatchlist({
      outcomes: [{
        eventId: '1', marketId: 'm', outcomeKey: 'yes', seriesId: '', watched: true, sortOrder: 0,
        groupKey: 'crypto', alertProfile: 'binary', eventSlug: 'btc-oct', marketSlug: '',
        title: 'What price will Bitcoin hit in October?', outcomeLabel: 'Yes', lifecycle: 'open', endAt: null,
        liquidity: '9000', volume24h: '10', totalVolume: '20', probability: '0.62',
        sourceUrl: 'https://polymarket.com/event/btc-oct', updatedAt: now,
      }],
      points: [
        { eventId: '1', marketId: 'm', outcomeKey: 'yes', observedAt: now - 10 * hour, probability: '0.50', granularity: '5m' },
        { eventId: '1', marketId: 'm', outcomeKey: 'yes', observedAt: now - 6 * hour, probability: '0.40', granularity: '5m' },
        { eventId: '1', marketId: 'm', outcomeKey: 'yes', observedAt: now - 20 * 60 * 1000, probability: '0.70', granularity: '5m' },
      ],
      at: now,
    });
    const view = readStoredPolymarketView(repository, now);
    assert.equal(view.quotes[0].midPrice, '0.62');
    assert.equal(view.quotes[0].midPrice24hAgo, '0.50');
    assert.equal(view.quotes[0].changeBasis, 10);
    const parsed = parseContract(PredictionMarketSourceViewSchema, {
      available: true, observedAt: now, sourceUrl: 'https://polymarket.com', quotes: view.quotes, note: '',
    });
    assert.equal(parsed.quotes[0].changeBasis, 10);

    repository.saveWatchlist({
      outcomes: [],
      points: [{
        eventId: '1', marketId: 'm', outcomeKey: 'yes', observedAt: now - POLYMARKET_DAY_MS, probability: '0.33', granularity: '5m',
      }],
      at: now,
    });
    const day = readStoredPolymarketView(repository, now);
    assert.equal(day.quotes[0].midPrice24hAgo, '0.33');
    assert.equal('changeBasis' in day.quotes[0], false);
  } finally {
    temporary.remove();
  }
});

test('a series older than 27h without a 24h window does not compare against the first point', () => {
  const temporary = temporaryDatabase();
  const now = Date.UTC(2026, 9, 16, 12, 0, 0);
  const hour = 60 * 60 * 1000;
  const outcome = {
    eventId: '1', marketId: 'm', outcomeKey: 'yes', seriesId: '', watched: true, sortOrder: 0,
    groupKey: 'crypto', alertProfile: 'binary', eventSlug: 'btc-oct', marketSlug: '',
    title: 'What price will Bitcoin hit in October?', outcomeLabel: 'Yes', lifecycle: 'open', endAt: null,
    liquidity: '9000', volume24h: '10', totalVolume: '20', probability: '0.62',
    sourceUrl: 'https://polymarket.com/event/btc-oct', updatedAt: now,
  };
  try {
    const repository = temporary.store.repositories.polymarket;
    repository.saveWatchlist({
      outcomes: [
        outcome,
        { ...outcome, eventId: '9', marketId: 'other', outcomeKey: 'other', watched: false, eventSlug: 'old', title: 'Unwatched', sourceUrl: 'https://polymarket.com/event/old' },
      ],
      points: [
        { eventId: '1', marketId: 'm', outcomeKey: 'yes', observedAt: now - 480 * hour, probability: '0.11', granularity: '5m' },
        { eventId: '9', marketId: 'other', outcomeKey: 'other', observedAt: now - 15 * hour, probability: '0.01', granularity: '5m' },
        { eventId: '1', marketId: 'm', outcomeKey: 'yes', observedAt: now - 20 * 60 * 1000, probability: '0.70', granularity: '5m' },
      ],
      at: now,
    });
    const ancient = readStoredPolymarketView(repository, now);
    assert.equal(ancient.quotes.length, 1);
    assert.equal('midPrice24hAgo' in ancient.quotes[0], false);
    assert.equal('changeBasis' in ancient.quotes[0], false);
    assert.equal(JSON.stringify(ancient.quotes[0]).includes('0.11'), false);

    repository.saveWatchlist({
      outcomes: [],
      points: [{
        eventId: '1', marketId: 'm', outcomeKey: 'yes', observedAt: now - 20 * hour, probability: '0.50', granularity: '5m',
      }],
      at: now,
    });
    const bounded = readStoredPolymarketView(repository, now);
    assert.equal(bounded.quotes[0].midPrice24hAgo, '0.50');
    assert.equal(bounded.quotes[0].changeBasis, 20);
    assert.equal(bounded.quotes[0].changeBasis < 27, true);
  } finally {
    temporary.remove();
  }
});

test('multi-outcome card shows each result and 较昨日 without backend fields', () => {
  const now = Date.UTC(2026, 9, 16, 12, 0, 0);
  const outcomes = [
    outcomeRow('50+ bps decrease', '0.01', 0),
    outcomeRow('No change', '0.62', 1),
    rangeRow('25 bps decrease', '0.20', 'cut-25'),
    rangeRow('50 bps decrease', '0.08', 'cut-50'),
    rangeRow('75 bps decrease', '0.04', 'cut-75'),
    rangeRow('100 bps decrease', '0.02', 'cut-100'),
  ];
  const points = [
    { eventId: '606422', marketId: 'm-1', outcomeKey: 'no-change', observedAt: now - POLYMARKET_DAY_MS, probability: '0.50', granularity: '5m' },
    { eventId: '606422', marketId: 'cut-25', outcomeKey: 'cut-25', observedAt: now - POLYMARKET_DAY_MS, probability: '0.10', granularity: '5m' },
  ];
  const [quote] = projectWatchlistQuotes(outcomes, points, now);
  assert.equal(quote.outcome, 'No change');
  assert.equal(quote.midPrice, '0.62');
  assert.equal(quote.midPrice24hAgo, '0.50');
  assert.equal('changeBasis' in quote, false);
  assert.equal(quote.outcomes.length, 6);
  assert.equal(quote.outcomes[0].midPrice24hAgo, '0.50');
  assert.equal(JSON.stringify(quote).includes('alertProfile'), false);
  const appSource = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../apps/web/public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.prediction-outcomes/);
  const context = vm.createContext({
    document: { createElement: (tag) => element(tag) },
    localizedCopy: (_id, text) => text,
    formatTime: () => '10月29日',
    marketNativeAmount: () => '$1.2K',
    attachGuardedOpen: () => {},
    openExternalHttpUrl: () => {},
  });
  vm.runInContext(['predictionShare', 'formatPredictionShare', 'predictionDayChange', 'predictionChangeNode', 'appendPredictionQuote']
    .map((name) => functionSource(appSource, name)).join('\n'), context);
  const root = element('div');
  context.appendPredictionQuote(root, { ...quote, notices: ['1 小时上升 6.0 个百分点'], statusLabel: '下一期尚未出现' });
  const text = textOf(root);
  const main = findNodes(root, (node) => hasClass(node, 'prediction-side'))[0];
  assert.match(textOf(main), /No change/);
  assert.match(textOf(main), /62\.0%/);
  assert.match(textOf(main), /较昨日 \+12\.0/);
  assert.equal(textOf(main).includes('25 bps'), false);
  const details = findNodes(root, (node) => node.tag === 'details')[0];
  assert.equal(Boolean(details.open), false);
  assert.equal(details.children[0].textContent, '其余区间');
  const listed = findNodes(details, (node) => hasClass(node, 'prediction-outcome'));
  assert.equal(listed.length, 3);
  assert.match(textOf(listed[0]), /25 bps decrease/);
  assert.match(textOf(listed[0]), /较昨日 \+10\.0/);
  assert.equal(text.includes('100 bps decrease'), false);
  assert.match(text, /1 小时上升 6\.0 个百分点/);
  assert.match(text, /下一期尚未出现/);
  assert.equal(text.includes('上次'), false);
  assert.equal(text.includes('606422'), false);
  assert.equal(text.includes('btc-monthly'), false);
  assert.equal(text.includes('alertProfile'), false);

  const young = projectWatchlistQuotes([
    rangeRow('150k', '0.11', '150k'),
    rangeRow('140k', '0.46', '140k'),
    rangeRow('130k', '0.22', '130k'),
    rangeRow('120k', '0.09', '120k'),
  ], [
    { eventId: '606422', marketId: '140k', outcomeKey: '140k', observedAt: now - 8 * 60 * 60 * 1000, probability: '0.40', granularity: '5m' },
    { eventId: '606422', marketId: '140k', outcomeKey: '140k', observedAt: now - 30 * 60 * 1000, probability: '0.44', granularity: '5m' },
  ], now)[0];
  assert.equal(young.outcome, '140k');
  assert.equal(young.midPrice24hAgo, '0.40');
  assert.equal(young.changeBasis, 8);
  const youngRoot = element('div');
  context.appendPredictionQuote(youngRoot, young);
  const youngMain = findNodes(youngRoot, (node) => hasClass(node, 'prediction-side'))[0];
  assert.match(textOf(youngMain), /140k/);
  assert.match(textOf(youngMain), /较 8h 前 \+6\.0/);
  assert.equal(textOf(youngRoot).includes('上次'), false);
  assert.equal(Boolean(findNodes(youngRoot, (node) => node.tag === 'details')[0].open), false);

  const twinRoot = element('div');
  context.appendPredictionQuote(twinRoot, {
    ...quote,
    key: 'no-change',
    outcomes: [
      { key: 'no-change', label: 'No change', midPrice: '0.62', midPrice24hAgo: '0.50' },
      { key: 'also-no-change', label: 'No change', midPrice: '0.15' },
    ],
  });
  const twinList = findNodes(findNodes(twinRoot, (node) => node.tag === 'details')[0], (node) => hasClass(node, 'prediction-outcome'));
  assert.equal(twinList.length, 1);
  assert.match(textOf(twinList[0]), /15\.0%/);
});

test('numeric changeBasis says 较 Nh 前, and 上次 only uses a real lastPrice', () => {
  const appSource = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');
  const context = vm.createContext({
    document: { createElement: (tag) => element(tag) },
    localizedCopy: (_id, text) => text,
    formatTime: () => '10月29日',
    marketNativeAmount: () => '$1',
    attachGuardedOpen: () => {},
    openExternalHttpUrl: () => {},
  });
  vm.runInContext(['predictionShare', 'formatPredictionShare', 'predictionDayChange', 'predictionChangeNode', 'appendPredictionQuote']
    .map((name) => functionSource(appSource, name)).join('\n'), context);
  assert.equal(context.predictionShare(null), null);
  assert.equal(context.predictionShare(''), null);
  assert.equal(context.formatPredictionShare(null), '—');
  assert.equal(context.predictionDayChange('0.62', '0.50', 4).text, '较 4h 前 +12.0');
  assert.equal(context.predictionDayChange('0.62', '0.50', 3).text, '较 3h 前 +12.0');
  assert.equal(context.predictionDayChange('0.62', '0.50', '4').text, '较 4h 前 +12.0');
  assert.equal(context.predictionDayChange('0.62', '0.50').text, '较昨日 +12.0');

  const quote = {
    quoteId: 'polymarket:event:606422',
    venue: 'polymarket',
    marketQuestion: 'Fed Decision in October?',
    outcome: 'No change',
    key: 'no-change',
    midPrice: '0.62',
    midPrice24hAgo: '0.50',
    changeBasis: 4,
    lastPrice: null,
    volume24h: '1',
    endAt: Date.UTC(2026, 9, 29),
    sourceUrl: 'https://polymarket.com/event/fed-decision-in-october',
    outcomes: [
      { key: 'no-change', label: 'No change', midPrice: '0.62', midPrice24hAgo: '0.50', changeBasis: 4 },
      { key: 'cut-25', label: '25 bps decrease', midPrice: '0.20', midPrice24hAgo: '0.17', changeBasis: 3 },
    ],
  };
  const fourHours = element('div');
  context.appendPredictionQuote(fourHours, quote);
  const fourText = textOf(fourHours);
  assert.match(fourText, /较 4h 前 \+12\.0/);
  assert.match(fourText, /较 3h 前 \+3\.0/);
  assert.equal(fourText.includes('较昨日'), false);
  assert.equal(fourText.includes('上次'), false);

  const blank = element('div');
  context.appendPredictionQuote(blank, { ...quote, outcomes: undefined, lastPrice: '' });
  assert.equal(textOf(blank).includes('上次'), false);

  const traded = element('div');
  context.appendPredictionQuote(traded, { ...quote, lastPrice: '0.42' });
  assert.match(textOf(traded), /上次 42\.0%/);
  assert.match(textOf(traded), /较 4h 前 \+12\.0/);

  const zero = element('div');
  context.appendPredictionQuote(zero, { ...quote, outcomes: undefined, changeBasis: 3, lastPrice: '0' });
  const zeroText = textOf(zero);
  assert.match(zeroText, /较 3h 前 \+12\.0/);
  assert.match(zeroText, /上次 0\.0%/);
});

function rangeRow(label, probability, key) {
  return {
    ...outcomeRow(label, probability, 1),
    marketId: key,
    outcomeKey: key,
  };
}

function outcomeRow(label, probability, offset) {
  return {
    eventId: '606422',
    marketId: offset === 0 ? 'm-0' : 'm-1',
    outcomeKey: offset === 0 ? '50-bps-decrease' : 'no-change',
    watched: true,
    sortOrder: 0,
    title: 'Fed Decision in October?',
    outcomeLabel: label,
    lifecycle: 'open',
    probability,
    volume24h: '1200',
    totalVolume: '9000',
    liquidity: '8000',
    endAt: Date.UTC(2026, 9, 29),
    sourceUrl: 'https://polymarket.com/event/fed-decision-in-october-20260617190323537',
    updatedAt: Date.UTC(2026, 9, 16, 12, 0, 0),
  };
}

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

function textOf(node) {
  return [node.textContent || '', ...(node.children || []).map(textOf)].join(' ');
}

function findNodes(node, predicate, found = []) {
  if (predicate(node)) found.push(node);
  for (const child of node.children || []) findNodes(child, predicate, found);
  return found;
}

function hasClass(node, name) {
  return String(node.className || '').split(/\s+/).includes(name);
}

function functionSource(source, name) {
  const match = source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, name);
  return match[0];
}
