export const SHANGHAI = 'Asia/Shanghai';

function partValue(parts, type) {
  return parts.find((part) => part.type === type)?.value || '';
}

export function normalizeHour(value) {
  const hour = Number(value);
  if (!Number.isFinite(hour)) return 0;
  return hour === 24 ? 0 : hour;
}

// Calendar fields stay in their own formatter. Mixing them with hourCycle h23
// makes WebKit shift the day (often by one, and by another day at midnight).
export function zonedCalendarParts(at, timeZone = SHANGHAI) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(new Date(at));
  return {
    year: Number(partValue(parts, 'year')),
    month: Number(partValue(parts, 'month')),
    day: Number(partValue(parts, 'day')),
    weekday: partValue(parts, 'weekday'),
  };
}

export function zonedClockParts(at, timeZone = SHANGHAI) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(at));
  return {
    hour: normalizeHour(partValue(parts, 'hour')),
    minute: Number(partValue(parts, 'minute')),
    second: Number(partValue(parts, 'second')),
  };
}

export function monthDayLabel(at, timeZone = SHANGHAI) {
  const date = zonedCalendarParts(at, timeZone);
  return `${date.month}月${date.day}日`;
}

export function clockLabel(at, timeZone = SHANGHAI) {
  const clock = zonedClockParts(at, timeZone);
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(clock.hour)}:${pad(clock.minute)}`;
}

export function dateKey(at, timeZone = SHANGHAI) {
  const date = zonedCalendarParts(at, timeZone);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.year}-${pad(date.month)}-${pad(date.day)}`;
}

// Half-open [start, end) that lands on 00:00 belongs to the previous calendar day.
export function inclusiveWindowInstant(at, timeZone = SHANGHAI) {
  const value = Number(at);
  if (!Number.isFinite(value)) return value;
  const clock = zonedClockParts(value, timeZone);
  if (clock.hour === 0 && clock.minute === 0 && clock.second === 0) return value - 1;
  return value;
}
