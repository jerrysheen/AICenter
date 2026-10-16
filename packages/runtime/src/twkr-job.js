import { enqueueMediaIndexEnrich } from '../../connectors/src/media/index.js';
import { readTwkrSource, resolveTwkrSources } from '../../connectors/src/twkr-sources.js';
import { ingestTwkrNews, ingestTwkrRevenue } from '../../domain/src/twkr-ingestion.js';
import { nextDailyInstant } from '../../domain/src/zoned-time.js';

export const TWKR_NEWS_JOB_TYPE = 'feed.twkr.news';
export const TWKR_REVENUE_JOB_TYPE = 'feed.twkr.revenue';
const REVENUE_CLOCK = { timeZone: 'Asia/Shanghai', hour: 8, minute: 30 };

function sourceOf(deps, sourceKey) {
  const sources = deps.sources || resolveTwkrSources({ env: deps.env || process.env, flags: deps.flags || {} });
  return sources.find((item) => item.sourceKey === sourceKey) || null;
}

function busy(store, type, sourceKey, jobId) {
  const open = store?.listOpenJobs?.(type) || [];
  return open.some((job) => job.input?.sourceKey === sourceKey && job.id !== jobId);
}

function logTwkr(fields) {
  const parts = Object.entries(fields).map(([key, value]) => `${key}=${String(value ?? '').replace(/\s+/g, ' ').slice(0, 180)}`);
  console.log(`[worker] twkr ${parts.join(' ')}`);
}

async function runSource(deps, context, sourceKey, kind) {
  const started = Date.now();
  const source = sourceOf(deps, sourceKey);
  const workspaceId = context?.job?.workspaceId || 'local';
  if (!source || !source.enabled || source.kind !== kind) {
    logTwkr({ source: sourceKey, status: 'disabled', durationMs: 0, added: 0 });
    return { sourceKey, status: 'disabled', added: 0, durationMs: 0 };
  }
  if (busy(context?.store, kind === 'revenue' ? TWKR_REVENUE_JOB_TYPE : TWKR_NEWS_JOB_TYPE, sourceKey, context?.job?.id)) {
    logTwkr({ source: sourceKey, status: 'already-running', durationMs: 0, added: 0 });
    return { sourceKey, status: 'already-running', added: 0, durationMs: 0 };
  }
  const fetched = await readTwkrSource(source, {
    env: deps.env,
    fetchImpl: deps.fetchImpl,
    timeoutImpl: deps.timeoutImpl,
    timeoutMs: deps.timeoutMs,
  });
  if (!fetched.ok) {
    logTwkr({ source: sourceKey, status: fetched.health, durationMs: Date.now() - started, added: 0 });
    return { sourceKey, status: fetched.health, added: 0, durationMs: Date.now() - started, note: fetched.note || '' };
  }
  if (kind === 'revenue') {
    const saved = ingestTwkrRevenue(deps.revenueRepository, workspaceId, fetched.rows, deps.now?.() || Date.now());
    logTwkr({ source: sourceKey, status: 'ready', durationMs: Date.now() - started, added: 0, saved: saved.saved });
    return { sourceKey, status: 'ready', added: 0, saved: saved.saved, months: saved.months, durationMs: Date.now() - started };
  }
  const indexed = ingestTwkrNews(deps.mediaService, workspaceId, source, fetched.items, deps.now?.() || Date.now());
  if (indexed.added > 0) {
    const enqueue = deps.enqueueTranslation || enqueueMediaIndexEnrich;
    enqueue(context?.store, workspaceId);
  }
  logTwkr({ source: sourceKey, status: 'ready', durationMs: Date.now() - started, added: indexed.added });
  return { sourceKey, status: 'ready', added: indexed.added, durationMs: Date.now() - started };
}

export function createTwkrJobHandlers(deps = {}) {
  return {
    [TWKR_NEWS_JOB_TYPE]: (input = {}, context) => runSource(deps, context, input.sourceKey, 'news'),
    [TWKR_REVENUE_JOB_TYPE]: (input = {}, context) => runSource(deps, context, input.sourceKey, 'revenue'),
  };
}

export function prepareTwkrEnqueue(store, schedule) {
  if (schedule?.jobType !== TWKR_NEWS_JOB_TYPE && schedule?.jobType !== TWKR_REVENUE_JOB_TYPE) return true;
  const sourceKey = schedule.input?.sourceKey;
  if (!sourceKey) return false;
  return !busy(store, schedule.jobType, sourceKey);
}

export function ensureTwkrSchedules(store, { env = process.env, flags = {}, now = Date.now() } = {}) {
  const saved = [];
  for (const source of resolveTwkrSources({ env, flags })) {
    const revenue = source.kind === 'revenue';
    saved.push(store.upsertJobSchedule({
      workspaceId: 'local',
      key: `feed.twkr.${source.sourceKey}`,
      jobType: revenue ? TWKR_REVENUE_JOB_TYPE : TWKR_NEWS_JOB_TYPE,
      enabled: source.enabled,
      schedule: revenue
        ? { kind: 'daily', timezone: REVENUE_CLOCK.timeZone, hour: REVENUE_CLOCK.hour, minute: REVENUE_CLOCK.minute }
        : { kind: 'interval', intervalMinutes: source.intervalMinutes },
      input: { sourceKey: source.sourceKey },
      priority: 0,
      maxAttempts: 1,
      nextRunAt: revenue ? nextDailyInstant(now - 1, REVENUE_CLOCK) : now,
    }));
  }
  return saved;
}
