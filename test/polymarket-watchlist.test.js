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
  'gpu-rental-prices-h100-end-of-november',
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
  const client = createPolymarketGammaClient({ fetch, gate, batchSize: 2 });
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

test('multi-outcome card shows each result and 较昨日 without backend fields', () => {
  const now = Date.UTC(2026, 9, 16, 12, 0, 0);
  const outcomes = [
    outcomeRow('50+ bps decrease', '0.01', 0),
    outcomeRow('No change', '0.62', 1),
  ];
  const points = [
    { eventId: '606422', marketId: 'm-1', outcomeKey: 'no-change', observedAt: now - POLYMARKET_DAY_MS, probability: '0.50', granularity: '5m' },
  ];
  const [quote] = projectWatchlistQuotes(outcomes, points, now);
  assert.equal(quote.outcome, 'No change');
  assert.equal(quote.outcomes.length, 2);
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
  assert.match(text, /No change/);
  assert.match(text, /较昨日 \+12\.0/);
  assert.match(text, /1 小时上升 6\.0 个百分点/);
  assert.match(text, /下一期尚未出现/);
  assert.equal(text.includes('606422'), false);
  assert.equal(text.includes('btc-monthly'), false);
  assert.equal(text.includes('alertProfile'), false);
});

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

function functionSource(source, name) {
  const match = source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, name);
  return match[0];
}
