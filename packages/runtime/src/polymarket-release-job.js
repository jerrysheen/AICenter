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

export function nextReleaseCheckAt(calendar, now) {
  const at = Number(now);
  if (!Number.isFinite(at)) return Date.now();
  if (releaseSlugsForInstant(calendar, at).length) return at;
  let best = null;
  for (const entry of calendar || []) {
    const start = Date.parse(`${entry?.date || ''}T00:00:00Z`);
    if (!Number.isFinite(start)) continue;
    for (let offset = -36; offset <= 36; offset += 1) {
      const candidate = start + offset * 60 * 60 * 1000;
      if (candidate <= at) continue;
      if (!releaseSlugsForInstant([entry], candidate).length) continue;
      if (best == null || candidate < best) best = candidate;
      break;
    }
  }
  return best ?? at + 24 * 60 * 60 * 1000;
}

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
  translate = null,
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
  const alerts = await storePolymarketAlerts(repository, config, at, { translate });
  return { skipped: false, slugs, missing, ...saved, alerts: alerts.alerts };
}

export function createPolymarketReleaseJobHandlers({ client, repository, config, store, now = () => Date.now(), translate = null }) {
  return {
    [POLYMARKET_RELEASE_JOB_TYPE]: async () => {
      const at = Math.trunc(now());
      const result = await capturePolymarketRelease({ client, repository, config, now, translate });
      if (store?.getJobSchedule && store?.upsertJobSchedule) {
        const active = releaseSlugsForInstant(config?.releaseCalendar, at).length > 0;
        const want = active ? (Number(config?.fetch?.releaseIntervalMinutes) || 1) : 24 * 60;
        const current = store.getJobSchedule('local', POLYMARKET_RELEASE_SCHEDULE_KEY);
        if (Number(current?.schedule?.intervalMinutes) !== want) {
          ensurePolymarketReleaseSchedule(store, config, active ? at + want * 60_000 : at, {
            enabled: current?.enabled !== false,
          });
        }
      }
      return result;
    },
  };
}

export function ensurePolymarketReleaseSchedule(store, config, now = Date.now(), { enabled = true } = {}) {
  const at = Math.trunc(Number(now));
  const active = releaseSlugsForInstant(config?.releaseCalendar, at).length > 0;
  const intervalMinutes = active ? (Number(config?.fetch?.releaseIntervalMinutes) || 1) : 24 * 60;
  return store.upsertJobSchedule({
    workspaceId: 'local',
    key: POLYMARKET_RELEASE_SCHEDULE_KEY,
    jobType: POLYMARKET_RELEASE_JOB_TYPE,
    enabled: Boolean(enabled),
    schedule: { kind: 'interval', intervalMinutes },
    input: {},
    priority: 0,
    maxAttempts: 2,
    nextRunAt: active ? at : nextReleaseCheckAt(config?.releaseCalendar, at),
    resetNextRunAt: !active,
  });
}
