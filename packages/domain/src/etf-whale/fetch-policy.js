import { cnTradingCalendarAt } from '../cn-trading-calendar.js';
import { addDays } from './calculate.js';

export const PENDING_TRADING_DAY_LIMIT = 5;

export function shanghaiToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now);
}

function utcWeekday(tradeDate) {
  const [year, month, day] = String(tradeDate).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function quoted(quoteDates, tradeDate) {
  if (!quoteDates) return false;
  return typeof quoteDates.has === 'function' ? quoteDates.has(tradeDate) : quoteDates.includes(tradeDate);
}

export function classifyCalendarDay(tradeDate, { quoteDates = null } = {}) {
  if (quoted(quoteDates, tradeDate)) return 'trading';
  const at = Date.parse(`${tradeDate}T12:00:00+08:00`);
  const calendar = Number.isFinite(at) ? cnTradingCalendarAt(at) : { tradingDay: null };
  if (calendar.tradingDay === false) return 'closed';
  if (calendar.tradingDay === true) return 'trading';
  const weekday = utcWeekday(tradeDate);
  return weekday === 0 || weekday === 6 ? 'closed' : 'trading';
}

export function tradingDaysBetween(startExclusive, endInclusive, options = {}) {
  if (!startExclusive || !endInclusive || endInclusive <= startExclusive) return 0;
  let count = 0;
  for (let cursor = addDays(startExclusive, 1); cursor <= endInclusive; cursor = addDays(cursor, 1)) {
    if (classifyCalendarDay(cursor, options) === 'trading') count += 1;
  }
  return count;
}

export function lastTradingOnOrBefore(date, options = {}) {
  let cursor = date;
  for (let guard = 0; guard < 40; guard += 1) {
    if (classifyCalendarDay(cursor, options) === 'trading') return cursor;
    cursor = addDays(cursor, -1);
  }
  return null;
}

export function expectedShareDate(today, options = {}) {
  return lastTradingOnOrBefore(addDays(today, -1), options);
}

export function emptyShareStatus(tradeDate, today, options = {}) {
  if (classifyCalendarDay(tradeDate, options) === 'closed') return 'holiday';
  const elapsed = tradingDaysBetween(tradeDate, today, options);
  const limit = options.pendingLimit ?? PENDING_TRADING_DAY_LIMIT;
  if (elapsed > limit) return 'stale';
  return 'pending';
}

export function shouldRefetchSzseChunk({ status, chunkEnd, maxShareDate, quoteDates = null } = {}) {
  if (status !== 'ok') return true;
  const lastTrading = lastTradingOnOrBefore(chunkEnd, { quoteDates });
  return !(lastTrading && maxShareDate && maxShareDate >= lastTrading);
}

export function shareSlotCanSkip({ pendingDates, expectedDate, sseStatus, szseCovered }) {
  if (!expectedDate) return false;
  if (pendingDates?.length) return false;
  if (sseStatus !== 'ok') return false;
  return Boolean(szseCovered);
}
