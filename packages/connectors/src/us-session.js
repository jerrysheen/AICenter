// NYSE cash equities, 2026 and 2027. Full holidays and 1:00 p.m. early closes:
// https://www.nyse.com/markets/hours-calendars
// A year missing from this table still follows weekends and the clock, and warns once.
const HOLIDAYS = {
  2026: new Set([
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
  ]),
  2027: new Set([
    '2027-01-01',
    '2027-01-18',
    '2027-02-15',
    '2027-03-26',
    '2027-05-31',
    '2027-06-18',
    '2027-07-05',
    '2027-09-06',
    '2027-11-25',
    '2027-12-24',
  ]),
};

const EARLY_CLOSE = {
  2026: new Set([
    '2026-11-27',
    '2026-12-24',
  ]),
  2027: new Set([
    '2027-11-26',
  ]),
};

const warnedHolidayYears = new Set();

function warnMissingHolidayYear(year) {
  if (warnedHolidayYears.has(year)) return;
  warnedHolidayYears.add(year);
  console.warn(`[market] ${year} 年纽交所休市日还没有写入假日表，这一年只按周末和美东时钟判断`);
}

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
  const year = Number(date.slice(0, 4));
  const holidays = HOLIDAYS[year];
  if (!holidays) warnMissingHolidayYear(year);
  if (weekday === 'Sat' || weekday === 'Sun') return 'closed';
  if (holidays?.has(date)) return 'closed';
  const early = EARLY_CLOSE[year]?.has(date) === true;
  const regularEnd = early ? 13 * 60 : 16 * 60;
  const postEnd = early ? 17 * 60 : 20 * 60;
  if (minute >= 4 * 60 && minute < 9 * 60 + 30) return 'pre';
  if (minute >= 9 * 60 + 30 && minute < regularEnd) return 'regular';
  if (minute >= regularEnd && minute < postEnd) return 'post';
  return 'closed';
}
