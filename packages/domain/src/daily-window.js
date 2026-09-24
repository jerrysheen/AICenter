import { ValidationError } from '../../contracts/src/index.js';
import { addCalendarDays, assertTimeZone, formatYmd, zonedLocalToUtc, zonedParts } from './zoned-time.js';

export function resolveDailyConfig(env = {}) {
  const timezone = String(env.AI_CENTER_DAILY_TIMEZONE || 'Asia/Shanghai').trim() || 'Asia/Shanghai';
  const cutoff = String(env.AI_CENTER_DAILY_CUTOFF || '08:00').trim();
  const match = cutoff.match(/^(\d{1,2}):(\d{2})$/);
  const cutoffHour = match ? Number(match[1]) : NaN;
  const cutoffMinute = match ? Number(match[2]) : NaN;
  if (!Number.isInteger(cutoffHour) || cutoffHour > 23 || !Number.isInteger(cutoffMinute) || cutoffMinute > 59) {
    throw new ValidationError('日报截止时间必须是 HH:mm', ['AI_CENTER_DAILY_CUTOFF']);
  }
  try {
    assertTimeZone(timezone);
  } catch {
    throw new ValidationError('日报时区无法识别', ['AI_CENTER_DAILY_TIMEZONE']);
  }
  const upcomingHours = Number(env.AI_CENTER_DAILY_UPCOMING_HOURS);
  return {
    timezone,
    cutoffHour,
    cutoffMinute,
    upcomingHours: Number.isFinite(upcomingHours) && upcomingHours > 0 ? upcomingHours : 36,
  };
}

export function resolveDailyWindow({ reportDate, timezone, cutoffHour, cutoffMinute }) {
  const match = String(reportDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new ValidationError('日报日期必须是 YYYY-MM-DD', ['reportDate']);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const endAt = zonedLocalToUtc(year, month, day, cutoffHour, cutoffMinute, timezone);
  const previous = addCalendarDays(year, month, day, -1);
  const startAt = zonedLocalToUtc(previous.year, previous.month, previous.day, cutoffHour, cutoffMinute, timezone);
  return {
    reportDate: `${match[1]}-${match[2]}-${match[3]}`,
    timezone,
    startAt,
    endAt,
  };
}

export function resolveReportDate(now, { timezone, cutoffHour, cutoffMinute }) {
  const parts = zonedParts(now, timezone);
  const cutoff = zonedLocalToUtc(parts.year, parts.month, parts.day, cutoffHour, cutoffMinute, timezone);
  if (now >= cutoff) return formatYmd(parts);
  return formatYmd(addCalendarDays(parts.year, parts.month, parts.day, -1));
}

export function resolveDailyTimeContext({
  reportDate,
  timezone,
  cutoffHour,
  cutoffMinute,
  generatedAt,
  upcomingHours = 36,
}) {
  const contentWindow = resolveDailyWindow({ reportDate, timezone, cutoffHour, cutoffMinute });
  return {
    reportDate: contentWindow.reportDate,
    timezone,
    contentWindow: { startAt: contentWindow.startAt, endAt: contentWindow.endAt },
    upcomingWindow: {
      startAt: contentWindow.endAt,
      endAt: contentWindow.endAt + upcomingHours * 3_600_000,
    },
    generatedAt,
  };
}

export function inHalfOpenWindow(at, window) {
  return Number.isFinite(at) && at >= window.startAt && at < window.endAt;
}
