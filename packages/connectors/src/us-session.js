// NYSE cash equities, 2026. Full holidays and the two 1:00 p.m. early closes:
// https://www.nyse.com/trade/hours-calendars
// Dates outside 2026 still follow weekends and the clock; that year's holidays are not listed here.
const HOLIDAYS_2026 = new Set([
  '2026-01-01',
  '2026-01-19',
  '2026-02-16',
  '2026-04-03',
  '2026-05-25',
  '2026-06-19',
  '2026-07-03',
  '2026-09-07',
  '2026-11-26',
  '2026-12-25',
]);

const EARLY_CLOSE_2026 = new Set([
  '2026-11-27',
  '2026-12-24',
]);

function etParts(nowMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(nowMs));
  const map = {};
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  let hour = Number(map.hour || 0);
  if (hour === 24) hour = 0;
  return {
    weekday: map.weekday || '',
    date: `${map.year}-${map.month}-${map.day}`,
    minute: hour * 60 + Number(map.minute || 0),
  };
}

export function usSessionAt(nowMs = Date.now()) {
  const { weekday, date, minute } = etParts(nowMs);
  if (weekday === 'Sat' || weekday === 'Sun') return 'closed';
  if (HOLIDAYS_2026.has(date)) return 'closed';
  const early = EARLY_CLOSE_2026.has(date);
  const regularEnd = early ? 13 * 60 : 16 * 60;
  const postEnd = early ? 17 * 60 : 20 * 60;
  if (minute >= 4 * 60 && minute < 9 * 60 + 30) return 'pre';
  if (minute >= 9 * 60 + 30 && minute < regularEnd) return 'regular';
  if (minute >= regularEnd && minute < postEnd) return 'post';
  return 'closed';
}
