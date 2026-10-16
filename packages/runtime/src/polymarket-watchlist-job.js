import { parsePolymarketEvent } from '../../connectors/src/polymarket-gamma.js';
import { fixedEntries } from '../../connectors/src/polymarket-watchlist.js';
import { bucketObservedAt, POLYMARKET_DAY_MS } from '../../domain/src/polymarket-series.js';

export const POLYMARKET_WATCHLIST_JOB_TYPE = 'market.polymarket.watchlist';
export const POLYMARKET_WATCHLIST_SCHEDULE_KEY = 'market.polymarket.watchlist';

export const polymarketWatchlistManifest = Object.freeze({
  id: 'market.polymarket-watchlist',
  version: '1.0.0',
  capabilities: [POLYMARKET_WATCHLIST_JOB_TYPE],
  jobTypes: [POLYMARKET_WATCHLIST_JOB_TYPE],
});

export function watchlistRowsFromEvents(events, config, observedAt) {
  const entries = new Map(fixedEntries(config).map((entry) => [entry.slug, entry]));
  const outcomes = [];
  const seenSlugs = new Set();
  for (const event of events || []) {
    const entry = entries.get(String(event?.slug || ''));
    if (!entry) continue;
    seenSlugs.add(entry.slug);
    for (const row of parsePolymarketEvent(event, observedAt)) {
      outcomes.push({
        ...row,
        seriesId: entry.seriesId,
        watched: true,
        sortOrder: entry.sortOrder,
        groupKey: entry.group,
        alertProfile: entry.alertProfile,
        lifecycle: row.closed ? 'closed' : 'open',
        updatedAt: observedAt,
      });
    }
  }
  const missing = fixedEntries(config).map((entry) => entry.slug).filter((slug) => !seenSlugs.has(slug));
  return { outcomes, missing, syncedEventIds: [...new Set(outcomes.map((row) => row.eventId))] };
}

export async function capturePolymarketWatchlist({
  client,
  repository,
  config,
  now = () => Date.now(),
}) {
  if (!client?.fetchEventsBySlugs) throw new Error('Polymarket 观察清单需要事件客户端');
  if (!repository?.saveWatchlist) throw new Error('Polymarket 观察清单需要存储');
  const at = Math.trunc(now());
  const entries = fixedEntries(config);
  const events = await client.fetchEventsBySlugs(entries.map((entry) => entry.slug));
  const { outcomes, missing, syncedEventIds } = watchlistRowsFromEvents(events, config, at);
  if (!outcomes.length && missing.length === entries.length) {
    throw new Error('Polymarket 观察清单没有返回任何事件');
  }
  const stepMs = Math.max(1, Number(config.fetch?.pointIntervalMinutes) || 5) * 60_000;
  const observedAt = bucketObservedAt(at, stepMs);
  const points = outcomes.filter((row) => row.probability).map((row) => ({
    eventId: row.eventId,
    marketId: row.marketId,
    outcomeKey: row.outcomeKey,
    observedAt,
    probability: row.probability,
    granularity: stepMs <= 60_000 ? '1m' : '5m',
  }));
  const downsampleBefore = at - (Number(config.fetch?.downsampleAfterDays) || 30) * POLYMARKET_DAY_MS;
  const saved = repository.saveWatchlist({ outcomes, points, syncedEventIds, downsampleBefore, at });
  return { ...saved, missing, observedAt: at };
}

export function createPolymarketWatchlistJobHandlers({ client, repository, config, now = () => Date.now() }) {
  return {
    [POLYMARKET_WATCHLIST_JOB_TYPE]: async () => capturePolymarketWatchlist({ client, repository, config, now }),
  };
}

export function ensurePolymarketWatchlistSchedule(store, config, now = Date.now(), { enabled = true } = {}) {
  const nextRunAt = Math.trunc(Number(now));
  return store.upsertJobSchedule({
    workspaceId: 'local',
    key: POLYMARKET_WATCHLIST_SCHEDULE_KEY,
    jobType: POLYMARKET_WATCHLIST_JOB_TYPE,
    enabled: Boolean(enabled),
    schedule: { kind: 'interval', intervalMinutes: Number(config?.fetch?.intervalMinutes) || 5 },
    input: {},
    priority: 0,
    maxAttempts: 2,
    nextRunAt,
  });
}
