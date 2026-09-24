function readPart(parts, type) {
  const value = Number(parts.find((part) => part.type === type)?.value);
  return Number.isFinite(value) ? value : 0;
}

export function zonedParts(utcMs, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(new Date(utcMs));
  let hour = readPart(parts, 'hour');
  if (hour === 24) hour = 0;
  return {
    year: readPart(parts, 'year'),
    month: readPart(parts, 'month'),
    day: readPart(parts, 'day'),
    hour,
    minute: readPart(parts, 'minute'),
    second: readPart(parts, 'second'),
  };
}

export function formatYmd(parts) {
  const year = String(parts.year).padStart(4, '0');
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function addCalendarDays(year, month, day, days) {
  const utc = Date.UTC(year, month - 1, day) + days * 86_400_000;
  const date = new Date(utc);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

export function assertTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
  } catch {
    throw new Error(`无法识别时区 ${timeZone}`);
  }
}

export function zonedLocalToUtc(year, month, day, hour, minute, timeZone) {
  assertTimeZone(timeZone);
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let utc = localAsUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = zonedParts(utc, timeZone);
    const rendered = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const next = utc + (localAsUtc - rendered);
    if (next === utc) return utc;
    utc = next;
  }
  return utc;
}

export function nextDailyInstant(afterMs, { timeZone, hour, minute }) {
  const parts = zonedParts(afterMs, timeZone);
  let cursor = { year: parts.year, month: parts.month, day: parts.day };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const instant = zonedLocalToUtc(cursor.year, cursor.month, cursor.day, hour, minute, timeZone);
    if (instant > afterMs) return instant;
    cursor = addCalendarDays(cursor.year, cursor.month, cursor.day, 1);
  }
  throw new Error('无法计算下一次每日时刻');
}

export function previousDailyInstant(atOrBeforeMs, { timeZone, hour, minute }) {
  const upcoming = nextDailyInstant(atOrBeforeMs, { timeZone, hour, minute });
  const parts = zonedParts(upcoming, timeZone);
  const previous = addCalendarDays(parts.year, parts.month, parts.day, -1);
  return zonedLocalToUtc(previous.year, previous.month, previous.day, hour, minute, timeZone);
}

export function dailySlotOnInstant(now, { timeZone, hour, minute }) {
  const parts = zonedParts(now, timeZone);
  return zonedLocalToUtc(parts.year, parts.month, parts.day, hour, minute, timeZone);
}
