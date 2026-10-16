import { absorbReadingIndex, homeRequestPlan, hourlyEditions, shanghaiHourStart } from './home-timeline.js?v=dev';
import { dateKey } from './shanghai-time.js?v=dev';

export const HOME_BOOTSTRAP_PATH = '/api/v1/home/bootstrap';

export function homeBootstrapCachePath(nowMs = Date.now()) {
  return `${HOME_BOOTSTRAP_PATH}?day=${dateKey(nowMs)}`;
}

export function homeBootstrapNewestStart(payload) {
  const start = Number(hourlyEditions(payload?.tree)[0]?.window?.startAt);
  return Number.isFinite(start) ? start : null;
}

// The prepared snapshot's window ends at the next Shanghai hour. A body whose
// window already closed is yesterday's representation of the same URL.
export function homeBootstrapCoversNow(payload, nowMs = Date.now()) {
  const end = Number(payload?.window?.endAt);
  if (!Number.isFinite(end)) return false;
  return end > shanghaiHourStart(nowMs);
}

export function chooseHomeBootstrap({ cached = null, fresh = null, nowMs = Date.now() } = {}) {
  const network = fresh && fresh.notModified !== true && fresh.ok !== false && fresh.pending !== true
    ? fresh
    : null;
  const networkStart = homeBootstrapNewestStart(network);
  const cachedStart = homeBootstrapNewestStart(cached);
  if (network && homeBootstrapCoversNow(network, nowMs)) return { source: 'fresh', body: network };
  if (
    cached
    && homeBootstrapCoversNow(cached, nowMs)
    && (networkStart == null || (cachedStart != null && cachedStart >= networkStart))
  ) {
    return { source: 'cache', body: cached };
  }
  if (network) return { source: 'stale', body: null };
  return { source: 'none', body: null };
}

export function projectHomeBootstrap(payload) {
  if (!payload || payload.ok === false || payload.notModified) return null;
  const readings = payload.readingIndex ? absorbReadingIndex(payload.readingIndex) : {};
  for (const [key, snapshot] of Object.entries(payload.readings || {})) {
    if (snapshot && typeof snapshot === 'object') readings[key] = snapshot;
  }
  const brief = payload.daily && typeof payload.daily === 'object' && 'daily' in payload.daily
    ? payload.daily.daily
    : null;
  return {
    tree: payload.tree || null,
    readings,
    market: payload.market?.market || null,
    marketPending: Boolean(payload.market?.pending),
    brief,
    board: payload.board?.board || null,
    boardPending: Boolean(payload.board?.pending),
    posts: Array.isArray(payload.posts?.posts) ? payload.posts.posts : null,
    x: payload.feeds?.x || null,
    xueqiu: payload.feeds?.xueqiu || null,
  };
}

export function homeColdLoadRequests({ useBootstrap = true, nowMs = Date.now(), visibleHours = 4 } = {}) {
  if (useBootstrap) return [HOME_BOOTSTRAP_PATH];
  const plan = homeRequestPlan(nowMs);
  return [
    plan.tree,
    plan.readingIndex,
    plan.market,
    plan.daily,
    plan.board,
    ...Array.from({ length: visibleHours }, (_, index) => `${plan.readingHour(index, index + 1)}`),
    '/api/v1/posts',
    '/api/v1/feed/x?platform=x&limit=50',
    '/api/v1/feed/xueqiu?platform=xueqiu&limit=50',
    plan.board,
  ];
}
