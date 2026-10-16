import { parsePolymarketEvent } from '../../connectors/src/polymarket-gamma.js';
import { fixedEntries } from '../../connectors/src/polymarket-watchlist.js';
import { evaluatePolymarketAlerts } from '../../domain/src/polymarket-alerts.js';
import { alertProfileForDiscovered } from '../../domain/src/polymarket-discovery.js';
import {
  heldSeriesEvents,
  pickOpenSeriesEvent,
  rollingWindow,
} from '../../domain/src/polymarket-rollover.js';
import { bucketObservedAt, POLYMARKET_DAY_MS } from '../../domain/src/polymarket-series.js';

export const POLYMARKET_WATCHLIST_JOB_TYPE = 'market.polymarket.watchlist';
export const POLYMARKET_WATCHLIST_SCHEDULE_KEY = 'market.polymarket.watchlist';

export const polymarketWatchlistManifest = Object.freeze({
  id: 'market.polymarket-watchlist',
  version: '1.0.0',
  capabilities: [POLYMARKET_WATCHLIST_JOB_TYPE],
  jobTypes: [POLYMARKET_WATCHLIST_JOB_TYPE],
});

export function planWatchlistRequests(config, seriesRows = []) {
  const entries = fixedEntries(config);
  const series = Array.isArray(config?.rollingSeries) ? config.rollingSeries : [];
  if (!series.length) return { slugs: entries.map((entry) => entry.slug), eventIds: [] };
  const seriesIds = new Set(series.map((item) => item.id));
  const active = new Set(seriesRows.map((row) => row.seriesId).filter((id) => seriesIds.has(id)));
  const slugs = entries
    .filter((entry) => !seriesIds.has(entry.seriesId) || !active.has(entry.seriesId))
    .map((entry) => entry.slug);
  const eventIds = [...new Set(seriesRows.filter((row) => seriesIds.has(row.seriesId)).map((row) => row.eventId))];
  return { slugs, eventIds };
}

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

function storedSeriesRows(repository, config) {
  if (!repository?.listSeriesOutcomes) return [];
  const rows = [];
  for (const series of config?.rollingSeries || []) rows.push(...repository.listSeriesOutcomes(series.id));
  return rows;
}

function seedEntry(config, seriesId) {
  return fixedEntries(config).find((entry) => entry.seriesId === seriesId) || null;
}

function rowsForEvent(event, meta, observedAt) {
  return parsePolymarketEvent(event, observedAt).map((row) => ({
    ...row,
    seriesId: meta.seriesId,
    watched: true,
    sortOrder: meta.sortOrder,
    groupKey: meta.groupKey,
    alertProfile: meta.alertProfile,
    lifecycle: row.closed ? 'closed' : 'open',
    updatedAt: observedAt,
  }));
}

function attachStoredSeriesEvents(events, outcomes, seriesRows, observedAt) {
  const known = new Set(outcomes.map((row) => row.eventId));
  const extra = [];
  for (const event of events || []) {
    const eventId = String(event?.id || '');
    if (!eventId || known.has(eventId)) continue;
    const stored = seriesRows.find((row) => row.eventId === eventId);
    if (!stored) continue;
    extra.push(...rowsForEvent(event, {
      seriesId: stored.seriesId,
      sortOrder: stored.sortOrder,
      groupKey: stored.groupKey,
      alertProfile: stored.alertProfile,
    }, observedAt));
    known.add(eventId);
  }
  return extra;
}

async function rollSeries(client, config, outcomes, observedAt) {
  const months = config.months || [];
  const releaseIds = [];
  const added = [];
  for (const series of config.rollingSeries || []) {
    const held = heldSeriesEvents(outcomes, series.id);
    const plan = rollingWindow(series, held, months);
    const foundMonths = new Set();
    if (plan.seekMonths.length && series.seriesSlug && client?.fetchEventsBySeries) {
      const events = await client.fetchEventsBySeries(series.seriesSlug, { closed: false, limit: 50 });
      const seed = seedEntry(config, series.id);
      for (const month of plan.seekMonths) {
        const event = pickOpenSeriesEvent(events, series.titleTemplate, month);
        if (!event) continue;
        const eventId = String(event.id);
        if (outcomes.some((row) => row.eventId === eventId) || added.some((row) => row.eventId === eventId)) {
          foundMonths.add(month);
          continue;
        }
        added.push(...rowsForEvent(event, {
          seriesId: series.id,
          sortOrder: seed?.sortOrder ?? 800,
          groupKey: seed?.group || series.id,
          alertProfile: seed?.alertProfile || 'multi',
        }, observedAt));
        foundMonths.add(month);
      }
    }
    const stillMissing = plan.seekMonths.filter((month) => !foundMonths.has(month));
    const pendingIds = stillMissing.length ? plan.pendingIds : [];
    for (const row of outcomes) {
      if (pendingIds.includes(row.eventId)) row.lifecycle = 'pending_rollover';
    }
    for (const row of added) {
      if (pendingIds.includes(row.eventId)) row.lifecycle = 'pending_rollover';
    }
    if (stillMissing.length) releaseIds.push(...plan.releaseIds);
    else releaseIds.push(...plan.releaseIds, ...plan.pendingIds.filter((id) => foundMonths.size === plan.seekMonths.length));
  }
  const dropping = new Set(releaseIds);
  return {
    outcomes: [...outcomes.filter((row) => !dropping.has(row.eventId)), ...added],
    releaseIds: [...dropping],
  };
}

function applyDiscovered(events, outcomes, observedAt) {
  const known = new Set(outcomes.map((row) => row.eventId));
  const extra = [];
  approved: for (const event of events || []) {
    const eventId = String(event?.id || '');
    if (!eventId || known.has(eventId)) continue;
    const parsed = parsePolymarketEvent(event, observedAt);
    if (!parsed.length) continue;
    const profile = alertProfileForDiscovered(parsed[0].tags, parsed.length);
    extra.push(...parsed.map((row) => ({
      ...row,
      seriesId: '',
      watched: true,
      sortOrder: 800,
      groupKey: 'discovered',
      alertProfile: profile,
      lifecycle: row.closed ? 'closed' : 'open',
      updatedAt: observedAt,
    })));
    known.add(eventId);
  }
  return extra;
}

export function storePolymarketAlerts(repository, config, now) {
  if (!config?.alerts || !repository?.listAlertStates || !repository?.recordAlerts) return { alerts: 0, states: 0 };
  const at = Math.trunc(Number(now));
  const cooldownMs = (Number(config.alerts.cooldownMinutes) || 60) * 60_000;
  const from = at - POLYMARKET_DAY_MS - cooldownMs;
  const evaluated = evaluatePolymarketAlerts({
    outcomes: repository.listWatchedOutcomes(),
    points: repository.listPointsBetween(from, at + 60_000),
    states: repository.listAlertStates(),
    recentAlerts: repository.listAlertsSince(at - cooldownMs),
    config,
    now: at,
  });
  return repository.recordAlerts(evaluated);
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
  const seriesRows = storedSeriesRows(repository, config);
  const { slugs, eventIds } = planWatchlistRequests(config, seriesRows);
  const events = slugs.length ? await client.fetchEventsBySlugs(slugs) : [];
  if (eventIds.length) {
    if (!client.fetchEventsByIds) throw new Error('Polymarket 滚动系列需要按事件读取');
    events.push(...await client.fetchEventsByIds(eventIds));
  }
  const built = watchlistRowsFromEvents(events, config, at);
  const outcomes = [
    ...built.outcomes,
    ...attachStoredSeriesEvents(events, built.outcomes, seriesRows, at),
  ];
  const seen = new Set((events || []).map((event) => String(event?.slug || '')));
  const missing = slugs.filter((slug) => !seen.has(slug));
  if (!outcomes.length && (slugs.length + eventIds.length) > 0) {
    throw new Error('Polymarket 观察清单没有返回任何事件');
  }
  const rolled = config?.rollingSeries?.length
    ? await rollSeries(client, config, outcomes, at)
    : { outcomes, releaseIds: [] };
  const approved = repository.listCandidates?.('approved') || [];
  const approvedIds = approved.map((candidate) => candidate.eventId)
    .filter((eventId) => !rolled.outcomes.some((row) => row.eventId === eventId));
  if (approvedIds.length && client.fetchEventsByIds) {
    rolled.outcomes.push(...applyDiscovered(await client.fetchEventsByIds(approvedIds), rolled.outcomes, at));
  }
  const stepMs = Math.max(1, Number(config.fetch?.pointIntervalMinutes) || 5) * 60_000;
  const observedAt = bucketObservedAt(at, stepMs);
  const points = rolled.outcomes.filter((row) => row.probability).map((row) => ({
    eventId: row.eventId,
    marketId: row.marketId,
    outcomeKey: row.outcomeKey,
    observedAt,
    probability: row.probability,
    granularity: stepMs <= 60_000 ? '1m' : '5m',
  }));
  const downsampleBefore = at - (Number(config.fetch?.downsampleAfterDays) || 30) * POLYMARKET_DAY_MS;
  const syncedEventIds = [...new Set(rolled.outcomes.map((row) => row.eventId))];
  const saved = repository.saveWatchlist({
    outcomes: rolled.outcomes,
    points,
    syncedEventIds,
    downsampleBefore,
    at,
  });
  if (rolled.releaseIds.length && repository.unwatchEvents) repository.unwatchEvents(rolled.releaseIds, at);
  const alerts = storePolymarketAlerts(repository, config, at);
  return { ...saved, missing, observedAt: at, released: rolled.releaseIds, alerts: alerts.alerts };
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
