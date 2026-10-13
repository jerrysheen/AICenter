import { absorbReadingIndex, homeRequestPlan } from './home-timeline.js?v=dev';

export const HOME_BOOTSTRAP_PATH = '/api/v1/home/bootstrap';

export function projectHomeBootstrap(payload) {
  if (!payload || payload.ok === false || payload.notModified) return null;
  const readings = payload.readingIndex ? absorbReadingIndex(payload.readingIndex) : {};
  for (const [key, snapshot] of Object.entries(payload.readings || {})) {
    if (snapshot && typeof snapshot === 'object') readings[key] = snapshot;
  }
  const brief = payload.brief && typeof payload.brief === 'object' && 'brief' in payload.brief
    ? payload.brief.brief
    : null;
  return {
    tree: payload.tree || null,
    readings,
    market: payload.market?.market || null,
    marketPending: Boolean(payload.market?.pending),
    brief,
    board: payload.board?.board || null,
    boardPending: Boolean(payload.board?.pending),
    posts: Array.isArray(payload.posts?.posts) ? payload.posts.posts : [],
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
