export const ASK_RUNS_MIN_INTERVAL_MS = 15_000;

export function planAskRunsFetch({
  view = '',
  visible = true,
  liveJobs = 0,
  lastFetchAt = 0,
  now = 0,
  reason = 'event',
} = {}) {
  if (!visible) return { fetch: false, reason: 'hidden' };
  const needed = view === 'ask' || Number(liveJobs) > 0;
  if (!needed) return { fetch: false, reason: 'idle' };
  const elapsed = Number(now) - Number(lastFetchAt || 0);
  if (lastFetchAt && elapsed < ASK_RUNS_MIN_INTERVAL_MS) return { fetch: false, reason: 'backoff' };
  return { fetch: true, reason };
}
