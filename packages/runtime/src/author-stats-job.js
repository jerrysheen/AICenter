import { nextDailyInstant } from '../../domain/src/zoned-time.js';

export const AUTHOR_STATS_JOB_TYPE = 'authors.stats.recompute';
export const AUTHOR_STATS_BATCH = 500;
export const AUTHOR_STATS_SCHEDULE_KEY = 'authors.stats.recompute';

export const authorStatsManifest = Object.freeze({
  id: 'authors.stats.recompute',
  version: '1.0.0',
  capabilities: ['authors.stats.recompute'],
  jobTypes: [AUTHOR_STATS_JOB_TYPE],
});

function parseClock(value, fallback, name) {
  const match = String(value || fallback).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error(`${name} 需要 HH:MM`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`${name} 需要 HH:MM`);
  return { hour, minute };
}

export function authorStatsScheduleConfig(env = process.env) {
  const clock = parseClock(env.AI_CENTER_AUTHOR_STATS_AT, '00:10', 'AI_CENTER_AUTHOR_STATS_AT');
  return {
    enabled: String(env.AI_CENTER_AUTHOR_STATS_SYNC ?? '1') !== '0',
    timeZone: String(env.AI_CENTER_AUTHOR_STATS_TIMEZONE || 'Asia/Shanghai').trim() || 'Asia/Shanghai',
    hour: clock.hour,
    minute: clock.minute,
  };
}

export function ensureAuthorStatsSchedule(store, env = process.env, now = Date.now()) {
  const config = authorStatsScheduleConfig(env);
  return store.upsertJobSchedule({
    workspaceId: 'local',
    key: AUTHOR_STATS_SCHEDULE_KEY,
    jobType: AUTHOR_STATS_JOB_TYPE,
    enabled: config.enabled,
    schedule: { kind: 'daily', timezone: config.timeZone, hour: config.hour, minute: config.minute },
    input: {},
    priority: 0,
    maxAttempts: 2,
    nextRunAt: nextDailyInstant(now - 1, config),
  });
}

function yieldTurn() {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

export async function recomputeAuthorStatsJob({
  authorRepository,
  workspaceId,
  now = Date.now(),
  batchSize = AUTHOR_STATS_BATCH,
  yieldBetween = yieldTurn,
  onProgress,
} = {}) {
  const pageSize = Math.max(1, Math.min(Number(batchSize) || AUTHOR_STATS_BATCH, AUTHOR_STATS_BATCH));
  let after = '';
  let total = 0;
  let batches = 0;
  const progress = [];
  for (;;) {
    const ids = authorRepository.listAuthorIds(workspaceId, after, pageSize);
    if (!ids.length) break;
    for (const id of ids) authorRepository.recomputeAuthor(workspaceId, id, now);
    total += ids.length;
    batches += 1;
    after = ids.at(-1);
    const entry = { batch: batches, count: ids.length, lastAuthorId: after, total };
    progress.push(entry);
    if (onProgress) onProgress(entry);
    else console.log('[authors.stats.recompute]', JSON.stringify(entry));
    if (ids.length < pageSize) break;
    await yieldBetween();
  }
  return { workspaceId, total, batches, lastAuthorId: after, progress };
}

export function createAuthorStatsJobHandlers({ authorRepository, onProgress } = {}) {
  return {
    [AUTHOR_STATS_JOB_TYPE]: (input, context) => recomputeAuthorStatsJob({
      authorRepository,
      workspaceId: context?.job?.workspaceId || input?.workspaceId || 'local',
      onProgress,
    }),
  };
}
