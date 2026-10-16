import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../packages/database/src/index.js';
import { loadPolymarketWatchlist } from '../packages/connectors/src/polymarket-watchlist.js';
import { evaluatePolymarketAlerts } from '../packages/domain/src/polymarket-alerts.js';
import { discoveryCandidate } from '../packages/domain/src/polymarket-discovery.js';
import { pickOpenSeriesEvent } from '../packages/domain/src/polymarket-rollover.js';
import { readStoredPolymarketView } from '../packages/domain/src/polymarket-series.js';
import { discoverPolymarketCandidates } from '../packages/runtime/src/polymarket-discovery-job.js';
import { capturePolymarketRelease, releaseSlugsForInstant } from '../packages/runtime/src/polymarket-release-job.js';
import { capturePolymarketWatchlist } from '../packages/runtime/src/polymarket-watchlist-job.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const watchlist = loadPolymarketWatchlist(path.join(process.cwd(), 'config', 'polymarket-watchlist.json'));

function temporaryDatabase() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-polymarket-b-'));
  const store = createStore(path.join(directory, 'test.db'));
  return {
    store,
    remove() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function event(overrides) {
  const id = String(overrides.id);
  const price = overrides.price || '0.40';
  const markets = overrides.markets || [{
    id: `m-${id}`,
    groupItemTitle: overrides.label || 'Yes',
    outcomes: '["Yes","No"]',
    outcomePrices: `["${price}","0.60"]`,
    liquidity: overrides.liquidity ?? 9000,
    closed: Boolean(overrides.closed),
  }];
  return {
    id,
    slug: overrides.slug,
    title: overrides.title,
    closed: Boolean(overrides.closed),
    endDate: overrides.endDate,
    volume24hr: overrides.volume24hr ?? 8000,
    volume: overrides.volume ?? 90000,
    tags: overrides.tags || [],
    markets,
  };
}

function gammaClient({ bySlug = {}, byId = {}, bySeries = {}, byTag = {}, tagErrors = {} } = {}) {
  const calls = { slugs: [], ids: [], series: [], tags: [] };
  return {
    calls,
    async fetchEventsBySlugs(slugs) {
      calls.slugs.push([...slugs]);
      return slugs.map((slug) => bySlug[slug]).filter(Boolean);
    },
    async fetchEventsByIds(ids) {
      calls.ids.push([...ids]);
      return ids.map((id) => byId[String(id)]).filter(Boolean);
    },
    async fetchEventsBySeries(seriesSlug) {
      calls.series.push(seriesSlug);
      return bySeries[seriesSlug] || [];
    },
    async fetchEventsByTag(tag) {
      calls.tags.push(tag);
      if (tagErrors[tag]) throw new Error(tagErrors[tag]);
      return byTag[tag] || [];
    },
  };
}

function titles(repository) {
  return [...new Set(repository.listWatchedOutcomes().map((row) => row.title))];
}

test('discovery keeps macro markets and drops sports, intraday, thin volume, watched rows and rolling titles', async () => {
  const temporary = temporaryDatabase();
  const config = {
    ...watchlist,
    discovery: { ...watchlist.discovery, whitelistTags: ['macro-indicators', 'sports'] },
  };
  const macro = event({
    id: '5001', slug: 'new-macro-print', title: 'New macro print in December?', tags: [{ slug: 'macro-indicators' }],
  });
  const client = gammaClient({
    byTag: {
      'macro-indicators': [
        macro,
        event({ id: '5002', slug: 'bitcoin-up-or-down-on-october-16-2026', title: 'Bitcoin Up or Down on October 16?', volume24hr: 90000, tags: [{ slug: 'macro-indicators' }] }),
        event({ id: '5003', slug: 'thin-print', title: 'Thin macro print?', volume24hr: 10, volume: 20, tags: [{ slug: 'macro-indicators' }] }),
        event({ id: '5004', slug: 'already', title: 'Already watched print?', tags: [{ slug: 'macro-indicators' }] }),
        event({ id: '5005', slug: 'what-price-will-bitcoin-hit-in-december-2026', title: 'What price will Bitcoin hit in December?', volume24hr: 90000, tags: [{ slug: 'bitcoin' }] }),
      ],
      sports: [
        event({ id: '5006', slug: 'game', title: 'Championship game?', volume24hr: 90000, tags: [{ slug: 'sports' }] }),
      ],
    },
    tagErrors: { missing: 'HTTP 404' },
  });
  config.discovery.whitelistTags = ['missing', 'macro-indicators', 'sports'];
  try {
    temporary.store.repositories.polymarket.saveWatchlist({
      outcomes: [{
        eventId: '5004', marketId: 'm-5004', outcomeKey: 'yes', seriesId: '', watched: true, sortOrder: 0,
        groupKey: 'us-data', alertProfile: 'binary', eventSlug: 'already', marketSlug: '',
        title: 'Already watched print?', outcomeLabel: 'Yes', lifecycle: 'open', endAt: null,
        liquidity: '9000', volume24h: '8000', totalVolume: '90000', probability: '0.40',
        sourceUrl: 'https://polymarket.com/event/already', updatedAt: 1,
      }],
      at: 1,
    });
    const found = await discoverPolymarketCandidates({
      client, repository: temporary.store.repositories.polymarket, config, now: () => 10,
    });
    assert.equal(found.inserted, 1);
    assert.equal(found.errors.length, 1);
    const pending = temporary.store.repositories.polymarket.listCandidates('pending');
    assert.deepEqual(pending.map((row) => row.eventId), ['5001']);
    assert.equal(titles(temporary.store.repositories.polymarket).includes('New macro print in December?'), false);
    assert.equal(discoveryCandidate(macro, config, {
      watchedIds: new Set(), candidateIds: new Set(['5001']), fixedSlugs: new Set(), tagSlug: 'macro-indicators',
    }), null);
  } finally {
    temporary.remove();
  }
});

test('approving a candidate adds it on the next watchlist capture', async () => {
  const temporary = temporaryDatabase();
  const config = {
    fixed: [{ slug: 'recession', group: 'us-data', alertProfile: 'binary', seriesId: '' }],
    fetch: { pointIntervalMinutes: 5, downsampleAfterDays: 30 },
  };
  const approved = event({ id: '7001', slug: 'new-macro-print', title: 'New macro print in December?' });
  try {
    temporary.store.repositories.polymarket.insertCandidates([{
      eventId: '7001', eventSlug: 'new-macro-print', title: 'New macro print in December?', tagSlug: 'macro-indicators',
      volume24h: '8000', totalVolume: '90000',
    }], 5);
    assert.equal(temporary.store.repositories.polymarket.reviewCandidate('7001', 'approved', 6), true);
    assert.equal(temporary.store.repositories.polymarket.reviewCandidate('7001', 'approved', 7), false);
    const client = gammaClient({
      bySlug: { recession: event({ id: '48802', slug: 'recession', title: 'US recession by end of 2026?' }) },
      byId: { 7001: approved },
    });
    await capturePolymarketWatchlist({
      client, repository: temporary.store.repositories.polymarket, config, now: () => 20,
    });
    assert.deepEqual(titles(temporary.store.repositories.polymarket).sort(), ['New macro print in December?', 'US recession by end of 2026?']);
    const added = temporary.store.repositories.polymarket.listWatchedOutcomes().find((row) => row.eventId === '7001');
    assert.equal(added.alertProfile, 'binary');
    assert.equal(added.seriesId, '');
  } finally {
    temporary.remove();
  }
});

test('gpu rollover replaces the settled month and waits when the next month is missing', async () => {
  const temporary = temporaryDatabase();
  const config = {
    fixed: [{ slug: 'gpu-rental-prices-h200-end-of-october', group: 'compute', alertProfile: 'multi', seriesId: 'gpu-h200' }],
    months: MONTHS,
    rollingSeries: [{ id: 'gpu-h200', tag: 'ornn', seriesSlug: 'h200-rental-price', titleTemplate: 'GPU rental prices (H200) end of {month}?', hold: 1 }],
    fetch: { pointIntervalMinutes: 5, downsampleAfterDays: 30 },
  };
  const october = (closed) => event({
    id: '836030', slug: 'gpu-rental-prices-h200-end-of-october', title: 'GPU rental prices (H200) end of October?',
    closed, endDate: '2026-11-01T03:59:00Z',
  });
  try {
    const waiting = gammaClient({
      bySlug: { 'gpu-rental-prices-h200-end-of-october': october(true) },
      byId: { 836030: october(true) },
      bySeries: { 'h200-rental-price': [] },
    });
    await capturePolymarketWatchlist({
      client: waiting, repository: temporary.store.repositories.polymarket, config, now: () => Date.parse('2026-11-02T00:00:00Z'),
    });
    const pending = temporary.store.repositories.polymarket.listWatchedOutcomes();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].lifecycle, 'pending_rollover');
    const november = event({
      id: '1200001', slug: 'gpu-rental-prices-h200-end-of-november-999', title: 'GPU rental prices (H200) end of November?',
      endDate: '2026-12-01T04:59:00Z',
    });
    const rolled = gammaClient({
      byId: { 836030: october(true) },
      bySeries: { 'h200-rental-price': [november] },
    });
    await capturePolymarketWatchlist({
      client: rolled, repository: temporary.store.repositories.polymarket, config, now: () => Date.parse('2026-11-02T00:05:00Z'),
    });
    assert.deepEqual(rolled.calls.slugs, []);
    assert.deepEqual(titles(temporary.store.repositories.polymarket), ['GPU rental prices (H200) end of November?']);
  } finally {
    temporary.remove();
  }
});

test('bitcoin keeps this month and the next, then slides when the current month settles', async () => {
  const temporary = temporaryDatabase();
  const config = {
    fixed: [
      { slug: 'recession', group: 'us-data', alertProfile: 'binary', seriesId: '' },
      { slug: 'what-price-will-bitcoin-hit-in-october-2026', group: 'crypto', alertProfile: 'multi', seriesId: 'btc-monthly' },
      { slug: 'what-price-will-bitcoin-hit-in-november-2026', group: 'crypto', alertProfile: 'multi', seriesId: 'btc-monthly' },
    ],
    months: MONTHS,
    rollingSeries: [{ id: 'btc-monthly', tag: 'bitcoin', seriesSlug: 'bitcoin-hit-price-monthly', titleTemplate: 'What price will Bitcoin hit in {month}?', hold: 2 }],
    fetch: { pointIntervalMinutes: 5, downsampleAfterDays: 30 },
  };
  const october = (closed) => event({
    id: '1112205', slug: 'what-price-will-bitcoin-hit-in-october-2026', title: 'What price will Bitcoin hit in October?',
    closed, endDate: '2026-11-01T04:00:00Z',
  });
  const november = event({
    id: '1300001', slug: 'what-price-will-bitcoin-hit-in-november-2026-181818', title: 'What price will Bitcoin hit in November?',
    endDate: '2026-12-01T05:00:00Z',
  });
  const december = event({
    id: '1300002', slug: 'what-price-will-bitcoin-hit-in-december-2026-191919', title: 'What price will Bitcoin hit in December?',
    endDate: '2027-01-01T05:00:00Z',
  });
  const year = event({
    id: '89502', slug: 'what-price-will-bitcoin-hit-before-2027', title: 'What price will Bitcoin hit in 2026?',
    endDate: '2027-01-01T05:00:00Z',
  });
  const oldNovember = event({
    id: '13945', slug: 'what-price-will-bitcoin-hit-in-november', title: 'What price will Bitcoin hit in November?',
    closed: true, endDate: '2024-12-01T05:00:00Z',
  });
  const week = event({
    id: '1174954', slug: 'what-price-will-bitcoin-hit-october-12-18-2026', title: 'What price will Bitcoin hit October 12-18?',
    endDate: '2026-10-19T04:00:00Z',
  });
  const seriesEvents = [year, oldNovember, week, november];
  try {
    assert.equal(pickOpenSeriesEvent(seriesEvents, config.rollingSeries[0].titleTemplate, 'November').id, '1300001');
    assert.equal(pickOpenSeriesEvent([year, oldNovember, week], config.rollingSeries[0].titleTemplate, 'November'), null);
    const opened = gammaClient({
      bySlug: {
        recession: event({ id: '48802', slug: 'recession', title: 'US recession by end of 2026?' }),
        'what-price-will-bitcoin-hit-in-october-2026': october(false),
      },
      bySeries: { 'bitcoin-hit-price-monthly': seriesEvents },
    });
    await capturePolymarketWatchlist({
      client: opened, repository: temporary.store.repositories.polymarket, config, now: () => Date.parse('2026-10-16T12:00:00Z'),
    });
    assert.deepEqual(titles(temporary.store.repositories.polymarket).sort(), [
      'US recession by end of 2026?',
      'What price will Bitcoin hit in November?',
      'What price will Bitcoin hit in October?',
    ].sort());
    const settled = gammaClient({
      bySlug: { recession: event({ id: '48802', slug: 'recession', title: 'US recession by end of 2026?' }) },
      byId: { 1112205: october(true), 1300001: november },
      bySeries: { 'bitcoin-hit-price-monthly': seriesEvents },
    });
    await capturePolymarketWatchlist({
      client: settled, repository: temporary.store.repositories.polymarket, config, now: () => Date.parse('2026-11-02T12:00:00Z'),
    });
    assert.equal(settled.calls.slugs.flat().includes('what-price-will-bitcoin-hit-in-october-2026'), false);
    const waiting = temporary.store.repositories.polymarket.listWatchedOutcomes();
    assert.equal(waiting.find((row) => row.eventId === '1112205').lifecycle, 'pending_rollover');
    assert.equal(waiting.some((row) => row.title === 'What price will Bitcoin hit in 2026?'), false);
    assert.equal(waiting.some((row) => row.eventId === '13945'), false);
    const slid = gammaClient({
      bySlug: { recession: event({ id: '48802', slug: 'recession', title: 'US recession by end of 2026?' }) },
      byId: { 1112205: october(true), 1300001: november },
      bySeries: { 'bitcoin-hit-price-monthly': [...seriesEvents, december] },
    });
    await capturePolymarketWatchlist({
      client: slid, repository: temporary.store.repositories.polymarket, config, now: () => Date.parse('2026-11-02T12:05:00Z'),
    });
    const live = temporary.store.repositories.polymarket.listWatchedOutcomes();
    assert.deepEqual([...new Set(live.map((row) => row.title))].sort(), [
      'US recession by end of 2026?',
      'What price will Bitcoin hit in December?',
      'What price will Bitcoin hit in November?',
    ].sort());
    assert.equal(live.some((row) => row.eventId === '1112205'), false);
  } finally {
    temporary.remove();
  }
});

test('alerts cover moves, level hysteresis, geopolitics, lead changes, illiquid markets and cooldown', () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  const base = {
    eventId: '1', marketId: 'm', outcomeKey: 'yes', watched: true, lifecycle: 'open',
    outcomeLabel: 'Yes', liquidity: '9000', probability: '0.55', alertProfile: 'binary',
  };
  function run(extra) {
    return evaluatePolymarketAlerts({
      outcomes: extra.outcomes,
      points: extra.points || [],
      states: extra.states || [],
      recentAlerts: extra.recentAlerts || [],
      config: watchlist,
      now,
    });
  }
  const hourAgo = { eventId: '1', marketId: 'm', outcomeKey: 'yes', observedAt: now - 60 * 60 * 1000, probability: '0.48', granularity: '5m' };
  const dayAgo = { eventId: '1', marketId: 'm', outcomeKey: 'yes', observedAt: now - 24 * 60 * 60 * 1000, probability: '0.40', granularity: '5m' };
  const moved = run({ outcomes: [{ ...base }], points: [hourAgo, dayAgo] });
  assert.equal(moved.alerts.find((alert) => alert.alertType === 'move_1h').message, '1 小时上升 7.0 个百分点');
  assert.equal(moved.alerts.find((alert) => alert.alertType === 'move_24h').message, '24 小时上升 15.0 个百分点');

  const first = run({ outcomes: [{ ...base, probability: '0.10' }] });
  assert.equal(first.alerts.some((alert) => alert.alertType === 'level_cross'), false);
  const crossed = run({
    outcomes: [{ ...base, probability: '0.21' }],
    states: first.states,
  });
  assert.equal(crossed.alerts.find((alert) => alert.alertType === 'level_cross').message, '概率越过 20%');
  const held = run({
    outcomes: [{ ...base, probability: '0.21' }],
    states: [...first.states, ...crossed.states],
    recentAlerts: crossed.alerts,
  });
  assert.equal(held.alerts.some((alert) => alert.alertType === 'level_cross'), false);

  const geo = run({
    outcomes: [{ ...base, alertProfile: 'geopolitics', probability: '0.24' }],
    points: [{ ...hourAgo, probability: '0.20' }],
  });
  assert.equal(geo.alerts.some((alert) => alert.alertType === 'move_1h'), true);
  const quietGeo = run({
    outcomes: [{ ...base, alertProfile: 'geopolitics', probability: '0.22' }],
    points: [{ ...hourAgo, probability: '0.20' }],
  });
  assert.equal(quietGeo.alerts.some((alert) => alert.alertType === 'move_1h'), false);

  const leader = { ...base, eventId: '9', marketId: 'lead', outcomeKey: 'cut', outcomeLabel: '降息', alertProfile: 'multi', probability: '0.42' };
  const other = { ...base, eventId: '9', marketId: 'other', outcomeKey: 'hike', outcomeLabel: '加息', alertProfile: 'multi', probability: '0.20' };
  const seen = run({ outcomes: [leader, other] });
  const flipped = run({
    outcomes: [{ ...leader, probability: '0.18' }, { ...other, probability: '0.61' }],
    states: seen.states,
    points: [{ eventId: '9', marketId: 'other', outcomeKey: 'hike', observedAt: now - 24 * 60 * 60 * 1000, probability: '0.40', granularity: '5m' }],
  });
  assert.equal(flipped.alerts.find((alert) => alert.alertType === 'lead_change').message, '领先结果变为 加息');
  assert.equal(flipped.alerts.find((alert) => alert.alertType === 'move_24h').message, '24 小时上升 21.0 个百分点');
  const small = run({
    outcomes: [leader],
    points: [{ eventId: '9', marketId: 'lead', outcomeKey: 'cut', observedAt: now - 24 * 60 * 60 * 1000, probability: '0.50', granularity: '5m' }],
  });
  assert.equal(small.alerts.some((alert) => alert.alertType === 'move_24h'), false);

  const dry = run({
    outcomes: [{ ...base, liquidity: '2999', probability: '0.70' }],
    points: [hourAgo, dayAgo],
    states: [{ eventId: '1', marketId: 'm', outcomeKey: 'yes', stateKey: 'level:0.5', stateValue: 'below', updatedAt: now - 1 }],
  });
  assert.deepEqual(dry.alerts, []);
  const unknownLiquidity = run({
    outcomes: [{ ...base, liquidity: null, probability: '0.70' }],
    points: [{ ...hourAgo, probability: '0.60' }],
  });
  assert.equal(unknownLiquidity.alerts.some((alert) => alert.alertType === 'move_1h'), true);
});

test('release polling fetches only the series scheduled for that timezone day', async () => {
  const temporary = temporaryDatabase();
  const fedDay = Date.parse('2026-10-28T18:00:00Z');
  const chinaDay = Date.parse('2026-10-20T16:30:00Z');
  assert.deepEqual(releaseSlugsForInstant(watchlist.releaseCalendar, fedDay), ['fed-decision-in-october-20260617190323537']);
  assert.deepEqual(releaseSlugsForInstant(watchlist.releaseCalendar, chinaDay), ['china-gdp-growth-yy-in-q3-2026-20260716161116873']);
  assert.deepEqual(releaseSlugsForInstant(watchlist.releaseCalendar, Date.parse('2026-10-16T12:00:00Z')), []);
  const client = gammaClient({
    bySlug: {
      'fed-decision-in-october-20260617190323537': event({
        id: '606422', slug: 'fed-decision-in-october-20260617190323537', title: 'Fed Decision in October?',
      }),
    },
  });
  try {
    const quiet = await capturePolymarketRelease({
      client, repository: temporary.store.repositories.polymarket, config: watchlist, now: () => Date.parse('2026-10-16T12:00:00Z'),
    });
    assert.equal(quiet.skipped, true);
    assert.deepEqual(client.calls.slugs, []);
    const saved = await capturePolymarketRelease({
      client, repository: temporary.store.repositories.polymarket, config: watchlist, now: () => fedDay,
    });
    assert.deepEqual(client.calls.slugs, [['fed-decision-in-october-20260617190323537']]);
    assert.equal(saved.outcomes > 0, true);
    const point = temporary.store.repositories.polymarket.listPointsBetween(fedDay - 60_000, fedDay + 60_000)[0];
    assert.equal(point.granularity, '1m');
    const view = readStoredPolymarketView(temporary.store.repositories.polymarket, fedDay);
    assert.equal(view.quotes[0].marketQuestion, 'Fed Decision in October?');
    assert.equal('alertType' in view.quotes[0], false);
  } finally {
    temporary.remove();
  }
});

test('page notices stay on the card and omit alert type', async () => {
  const temporary = temporaryDatabase();
  const now = Date.parse('2026-10-16T12:00:00Z');
  try {
    temporary.store.repositories.polymarket.saveWatchlist({
      outcomes: [{
        eventId: '1', marketId: 'm', outcomeKey: 'yes', seriesId: '', watched: true, sortOrder: 0,
        groupKey: 'us-data', alertProfile: 'binary', eventSlug: 'recession', marketSlug: '',
        title: 'US recession by end of 2026?', outcomeLabel: 'Yes', lifecycle: 'open', endAt: null,
        liquidity: '9000', volume24h: '10', totalVolume: '20', probability: '0.55',
        sourceUrl: 'https://polymarket.com/event/recession', updatedAt: now,
      }],
      at: now,
    });
    temporary.store.repositories.polymarket.recordAlerts({
      alerts: [{ eventId: '1', marketId: 'm', outcomeKey: 'yes', alertType: 'move_1h', message: '1 小时上升 6.2 个百分点', createdAt: now }],
    });
    const view = readStoredPolymarketView(temporary.store.repositories.polymarket, now);
    assert.deepEqual(view.quotes[0].notices, ['1 小时上升 6.2 个百分点']);
    assert.equal(JSON.stringify(view).includes('move_1h'), false);
    assert.equal(JSON.stringify(view).includes('alertType'), false);
  } finally {
    temporary.remove();
  }
});
