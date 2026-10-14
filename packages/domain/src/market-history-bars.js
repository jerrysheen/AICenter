import { isCnYahooSymbol } from '../../connectors/src/cn-quotes.js';
import { isConsistentOhlcBar } from '../../connectors/src/tushare.js';
import { cnTradingCalendarAt } from './cn-trading-calendar.js';

const DAY = 86_400_000;

export function shanghaiDateFromMs(at) {
  const value = Number(at);
  if (!Number.isFinite(value)) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value));
}

export function lastCompletedCnTradingDate(now = Date.now()) {
  const calendar = cnTradingCalendarAt(now);
  if (calendar.tradingDay === true && calendar.session === 'closed') return calendar.date;
  const noon = Date.parse(`${calendar.date}T12:00:00+08:00`);
  if (!Number.isFinite(noon)) return null;
  for (let offset = 1; offset <= 30; offset += 1) {
    const previous = cnTradingCalendarAt(noon - offset * DAY);
    if (previous.tradingDay === true) return previous.date;
    if (previous.tradingDay == null) return null;
  }
  return null;
}

export function cnDailyHistoryHasGap(bars, now = Date.now()) {
  const dates = [...new Set((bars || []).map((bar) => shanghaiDateFromMs(bar?.at)).filter(Boolean))].sort();
  if (!dates.length) return false;
  const lastCompleted = lastCompletedCnTradingDate(now);
  const end = lastCompleted && lastCompleted > dates.at(-1) ? lastCompleted : dates.at(-1);
  const startMs = Date.parse(`${dates[0]}T12:00:00+08:00`);
  const endMs = Date.parse(`${end}T12:00:00+08:00`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return false;
  const present = new Set(dates);
  for (let at = startMs; at <= endMs; at += DAY) {
    const calendar = cnTradingCalendarAt(at);
    if (calendar.tradingDay !== true) continue;
    if (calendar.date > end) break;
    if (!present.has(calendar.date)) return true;
  }
  return false;
}

function dropUnfinishedToday(bars, now) {
  const calendar = cnTradingCalendarAt(now);
  const dropToday = calendar.tradingDay === false
    || (calendar.tradingDay === true && calendar.session !== 'closed');
  if (!dropToday) return { bars, dropped: false };
  const next = bars.filter((bar) => shanghaiDateFromMs(bar.at) !== calendar.date);
  return { bars: next, dropped: next.length !== bars.length };
}

export function prepareMarketHistoryBars(bars, { symbol = '', interval = '1d', now = Date.now() } = {}) {
  const input = Array.isArray(bars) ? bars : [];
  const consistent = input.filter((bar) => isConsistentOhlcBar(bar));
  const cnDaily = interval === '1d' && isCnYahooSymbol(symbol);
  let completed = consistent;
  let droppedToday = false;
  if (cnDaily) {
    const dropped = dropUnfinishedToday(consistent, now);
    completed = dropped.bars;
    droppedToday = dropped.dropped;
  }
  return {
    bars: completed,
    gap: Boolean(cnDaily && cnDailyHistoryHasGap(completed, now)),
    changed: consistent.length !== input.length || droppedToday,
  };
}
