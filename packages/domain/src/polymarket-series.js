import { polymarketOutcomeText } from './polymarket-outcome-zh.js';

export const POLYMARKET_POINT_MS = 5 * 60 * 1000;
export const POLYMARKET_HOUR_MS = 60 * 60 * 1000;
export const POLYMARKET_DAY_MS = 24 * POLYMARKET_HOUR_MS;
export const POLYMARKET_DAY_WINDOW_MS = 3 * POLYMARKET_HOUR_MS;
export const POLYMARKET_HOUR_WINDOW_MS = 15 * 60 * 1000;

export function bucketObservedAt(now, stepMs = POLYMARKET_POINT_MS) {
  const value = Math.trunc(Number(now));
  if (!Number.isFinite(value) || value < 0) throw new Error('观测时间不正确');
  const step = Math.max(1, Math.trunc(stepMs));
  return Math.floor(value / step) * step;
}

export function selectClosestProbability(points, target, windowMs) {
  const moment = Number(target);
  const span = Number(windowMs);
  if (!Number.isFinite(moment) || !Number.isFinite(span)) return null;
  const min = moment - span;
  const max = moment + span;
  let best = null;
  for (const point of points || []) {
    const at = Number(point?.observedAt);
    const probability = point?.probability;
    if (typeof probability !== 'string' || !Number.isFinite(at) || at < min || at > max) continue;
    if (!best) {
      best = { at, probability };
      continue;
    }
    const distance = Math.abs(at - moment);
    const bestDistance = Math.abs(best.at - moment);
    const closer = distance < bestDistance;
    const tiePreferEarlier = distance === bestDistance && at <= moment && best.at > moment;
    if (closer || tiePreferEarlier) best = { at, probability };
  }
  return best ? best.probability : null;
}

export function selectSeriesProbability(points, now, lagMs = POLYMARKET_DAY_MS, windowMs = POLYMARKET_DAY_WINDOW_MS) {
  return selectClosestProbability(points, Number(now) - lagMs, windowMs);
}

function seriesChange(points, now) {
  const prior = selectSeriesProbability(points, now);
  if (prior) return { prior, changeBasis: null };
  const moment = Number(now);
  if (!Number.isFinite(moment)) return { prior: null, changeBasis: null };
  const limit = moment - POLYMARKET_HOUR_MS;
  const floor = moment - POLYMARKET_DAY_MS - POLYMARKET_DAY_WINDOW_MS;
  let earliest = null;
  for (const point of points || []) {
    const at = Number(point?.observedAt);
    const probability = point?.probability;
    if (typeof probability !== 'string' || !Number.isFinite(at) || at > limit || at < floor) continue;
    if (!earliest || at < earliest.at) earliest = { at, probability };
  }
  if (!earliest) return { prior: null, changeBasis: null };
  const hours = Math.max(1, Math.round((moment - earliest.at) / POLYMARKET_HOUR_MS));
  return { prior: earliest.probability, changeBasis: hours };
}

export function pointsKeptAfterDownsample(points, cutoff) {
  const limit = Number(cutoff);
  const fresh = [];
  const oldest = new Map();
  for (const point of points || []) {
    if (Number(point.observedAt) >= limit) {
      fresh.push(point);
      continue;
    }
    const hour = Math.floor(point.observedAt / POLYMARKET_HOUR_MS);
    const key = `${point.eventId}\0${point.marketId}\0${point.outcomeKey}\0${hour}`;
    const previous = oldest.get(key);
    if (!previous || point.observedAt < previous.observedAt) {
      oldest.set(key, { ...point, granularity: '1h' });
    }
  }
  return [...fresh, ...oldest.values()];
}

function pointKey(row) {
  return `${row.eventId}\0${row.marketId}\0${row.outcomeKey}`;
}

function statusLabel(rows) {
  if (rows.every((row) => row.lifecycle === 'pending_rollover')) return '下一期尚未出现';
  if (rows.every((row) => row.lifecycle === 'closed')) return '已结束';
  return '';
}

function quoteFromRows(rows, pointsByKey, now) {
  const usable = rows.some((row) => row.lifecycle !== 'closed')
    ? rows.filter((row) => row.lifecycle !== 'closed')
    : rows;
  const ranked = usable.map((row) => {
    const change = seriesChange(pointsByKey.get(pointKey(row)) || [], now);
    return { ...row, prior: change.prior, changeBasis: change.changeBasis };
  }).sort((left, right) => Number(right.probability ?? -1) - Number(left.probability ?? -1));
  const leader = ranked[0];
  if (!leader) return null;
  const multi = ranked.length > 1;
  const quote = {
    quoteId: `polymarket:event:${leader.eventId}`,
    venue: 'polymarket',
    marketId: String(leader.eventId),
    marketQuestion: leader.title,
    outcome: polymarketOutcomeText(leader.outcomeLabel),
    midPrice: leader.probability,
    bestBid: null,
    bestAsk: null,
    spread: null,
    lastPrice: null,
    volume24h: leader.volume24h,
    totalVolume: leader.totalVolume,
    liquidity: leader.liquidity,
    openInterest: null,
    endAt: leader.endAt,
    sourceUrl: leader.sourceUrl,
    observedAt: Math.max(...rows.map((row) => Number(row.updatedAt) || now)),
  };
  if (leader.outcomeLabel) quote.outcomeLabel = leader.outcomeLabel;
  if (leader.outcomeKey) quote.key = leader.outcomeKey;
  if (leader.prior) quote.midPrice24hAgo = leader.prior;
  if (leader.changeBasis) quote.changeBasis = leader.changeBasis;
  if (multi) {
    quote.outcomes = ranked.slice(0, 6).map((row) => {
      const item = { key: row.outcomeKey, label: polymarketOutcomeText(row.outcomeLabel), midPrice: row.probability };
      if (row.outcomeLabel) item.outcomeLabel = row.outcomeLabel;
      if (row.prior) item.midPrice24hAgo = row.prior;
      if (row.changeBasis) item.changeBasis = row.changeBasis;
      return item;
    });
  }
  const label = statusLabel(rows);
  if (label) quote.statusLabel = label;
  return quote;
}

export function projectWatchlistQuotes(outcomes, points, now = Date.now(), noticesByEvent = new Map()) {
  const pointsByKey = new Map();
  for (const point of points || []) {
    const key = pointKey(point);
    const list = pointsByKey.get(key) || [];
    list.push(point);
    pointsByKey.set(key, list);
  }
  const grouped = new Map();
  for (const row of outcomes || []) {
    if (!row?.watched) continue;
    const list = grouped.get(row.eventId) || [];
    list.push(row);
    grouped.set(row.eventId, list);
  }
  return [...grouped.values()]
    .sort((left, right) => (left[0].sortOrder - right[0].sortOrder) || String(left[0].eventId).localeCompare(String(right[0].eventId)))
    .map((rows) => {
      const quote = quoteFromRows(rows, pointsByKey, now);
      if (!quote) return null;
      const notices = (noticesByEvent.get(quote.marketId) || []).filter(Boolean).slice(0, 3);
      if (notices.length) quote.notices = notices;
      return quote;
    })
    .filter(Boolean);
}

export function readStoredPolymarketView(repository, now = Date.now(), { staleAfterMs = 20 * 60 * 1000 } = {}) {
  const at = Math.trunc(Number(now));
  const outcomes = repository.listWatchedOutcomes();
  const sourceUrl = 'https://polymarket.com';
  if (!outcomes.length) {
    return { available: false, observedAt: at, sourceUrl, quotes: [], note: '观察清单尚未写入' };
  }
  const latest = Math.max(...outcomes.map((row) => Number(row.updatedAt) || 0));
  const moment = latest || at;
  const points = typeof repository.listDashboardPoints === 'function'
    ? repository.listDashboardPoints(moment)
    : repository.listPointsBetween(moment - POLYMARKET_DAY_MS - POLYMARKET_DAY_WINDOW_MS, moment + 60_000);
  const noticesByEvent = new Map();
  if (typeof repository.listAlertsSince === 'function') {
    for (const alert of repository.listAlertsSince(moment - POLYMARKET_DAY_MS)) {
      const list = noticesByEvent.get(alert.eventId) || [];
      if (list.length >= 3) continue;
      list.push(alert.message);
      noticesByEvent.set(alert.eventId, list);
    }
  }
  const quotes = projectWatchlistQuotes(outcomes, points, moment, noticesByEvent);
  const stale = at - latest > staleAfterMs;
  return {
    available: true,
    observedAt: latest || at,
    sourceUrl,
    quotes,
    note: stale ? '观察清单更新延迟' : '',
  };
}
