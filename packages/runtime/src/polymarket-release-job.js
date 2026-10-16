import { bucketObservedAt, POLYMARKET_DAY_MS } from '../../domain/src/polymarket-series.js';
import { storePolymarketAlerts, watchlistRowsFromEvents } from './polymarket-watchlist-job.js';

export const POLYMARKET_RELEASE_JOB_TYPE = 'market.polymarket.release';
export const POLYMARKET_RELEASE_SCHEDULE_KEY = 'market.polymarket.release';

export const polymarketReleaseManifest = Object.freeze({
  id: 'market.polymarket-release',
  version: '1.0.0',
  capabilities: [POLYMARKET_RELEASE_JOB_TYPE],
  jobTypes: [POLYMARKET_RELEASE_JOB_TYPE],
});

export function releaseSlugsForInstant(calendar, now) {
  const at = new Date(Number(now));
  if (Number.isNaN(at.getTime())) return [];
  const slugs = [];
  for (const entry of calendar || []) {
    let date = '';
    try {
      date = new Intl.DateTimeFormat('en-CA', {
        timeZone: entry.timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(at);
    } catch {
      continue;
    }
    if (date === entry.date) slugs.push(...(entry.slugs || []));
  }
  return [...new Set(slugs)];
}

export async function capturePolymarketRelease({
  client,
  repository,
  config,
  now = () => Date.now(),
}) {
  if (!client?.fetchEventsBySlugs) throw new Error('Polymarket 发布日读取需要事件客户端');
  if (!repository?.saveWatchlist) throw new Error('Polymarket 发布日读取需要存储');
  const at = Math.trunc(now());
  const slugs = releaseSlugsForInstant(config?.releaseCalendar, at);
  if (!slugs.length) return { skipped: true, slugs: [] };
  const events = await client.fetchEventsBySlugs(slugs);
  const { outcomes } = watchlistRowsFromEvents(events, config, at);
  const seen = new Set((events || []).map((event) => String(event?.slug || '')));
  const missing = slugs.filter((slug) => !seen.has(slug));
  const wanted = outcomes.filter((row) => slugs.includes(row.eventSlug));
  if (!wanted.length) return { skipped: false, slugs, missing, outcomes: 0 };
  const observedAt = bucketObservedAt(at, 60_000);
  const points = wanted.filter((row) => row.probability).map((row) => ({
    eventId: row.eventId,
    marketId: row.marketId,
    outcomeKey: row.outcomeKey,
    observedAt,
    probability: row.probability,
    granularity: '1m',
  }));
  const saved = repository.saveWatchlist({
    outcomes: wanted,
    points,
    syncedEventIds: [...new Set(wanted.map((row) => row.eventId))],
    downsampleBefore: at - (Number(config?.fetch?.downsampleAfterDays) || 30) * POLYMARKET_DAY_MS,
    at,
  });
  const alerts = storePolymarketAlerts(repository, config, at);
  return { skipped: false, slugs, missing, ...saved, alerts: alerts.alerts };
}

export function createPolymarketReleaseJobHandlers({ client, repository, config, now = () => Date.now() }) {
  return {
    [POLYMARKET_RELEASE_JOB_TYPE]: async () => capturePolymarketRelease({ client, repository, config, now }),
  };
}

export function ensurePolymarketReleaseSchedule(store, config, now = Date.now(), { enabled = true } = {}) {
  return store.upsertJobSchedule({
    workspaceId: 'local',
    key: POLYMARKET_RELEASE_SCHEDULE_KEY,
    jobType: POLYMARKET_RELEASE_JOB_TYPE,
    enabled: Boolean(enabled),
    schedule: { kind: 'interval', intervalMinutes: Number(config?.fetch?.releaseIntervalMinutes) || 1 },
    input: {},
    priority: 0,
    maxAttempts: 2,
    nextRunAt: Math.trunc(Number(now)),
  });
}
