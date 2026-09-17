export const DEFAULT_USER_TIME_ZONE = 'Asia/Shanghai';

function partValue(parts, type) {
  return parts.find((part) => part.type === type)?.value || '';
}

function normalizeOffset(raw) {
  const match = String(raw || '').match(/([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!match) return '+00:00';
  const hours = String(match[2]).padStart(2, '0');
  const minutes = String(match[3] || '00').padStart(2, '0');
  return `${match[1]}${hours}:${minutes}`;
}

export function formatOffsetIso(date, timeZone = DEFAULT_USER_TIME_ZONE) {
  const instant = date instanceof Date ? date : new Date(date);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).formatToParts(instant);
  return `${partValue(parts, 'year')}-${partValue(parts, 'month')}-${partValue(parts, 'day')}`
    + `T${partValue(parts, 'hour')}:${partValue(parts, 'minute')}:${partValue(parts, 'second')}`
    + normalizeOffset(partValue(parts, 'timeZoneName'));
}

export function buildRuntimeContext(now = new Date(), timeZone = DEFAULT_USER_TIME_ZONE) {
  const instant = now instanceof Date ? now : new Date(now);
  return {
    currentTime: instant.toISOString(),
    currentUtcTime: instant.toISOString(),
    timeZone,
    currentLocalTime: formatOffsetIso(instant, timeZone),
  };
}

export function formatRuntimeContextNote(runtimeContext) {
  return [
    `Current UTC time: ${runtimeContext.currentUtcTime}`,
    `User/local timezone: ${runtimeContext.timeZone}`,
    `Current local time: ${runtimeContext.currentLocalTime}`,
    'The current date/time above is authoritative.',
    'Do not rely on model training knowledge for the current date.',
  ].join('\n');
}

function localOffset(runtimeContext) {
  return String(runtimeContext?.currentLocalTime || '').match(/([+-]\d{2}:\d{2})$/)?.[1] || '+00:00';
}

function localDatePart(runtimeContext) {
  return String(runtimeContext?.currentLocalTime || '').slice(0, 10);
}

export function resolveTimeRangeWindow(timeRange, runtimeContext = {}) {
  const range = timeRange === 'today' || timeRange === 'yesterday' || timeRange === 'last-24h' || timeRange === 'last-48h'
    ? timeRange
    : 'all';
  if (range === 'all') return { timeRange: 'all', startMs: null, endMs: null };
  const nowMs = Date.parse(runtimeContext.currentUtcTime || runtimeContext.currentTime);
  const datePart = localDatePart(runtimeContext);
  const offset = localOffset(runtimeContext);
  const todayStart = Date.parse(`${datePart}T00:00:00${offset}`);
  const todayEnd = Date.parse(`${datePart}T23:59:59.999${offset}`);
  if (range === 'today') return { timeRange: range, startMs: todayStart, endMs: todayEnd };
  if (range === 'yesterday') {
    return { timeRange: range, startMs: todayStart - 86_400_000, endMs: todayStart - 1 };
  }
  const end = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (range === 'last-24h') return { timeRange: range, startMs: end - 86_400_000, endMs: end };
  return { timeRange: range, startMs: end - 172_800_000, endMs: end };
}

export function contentItemTimestamp(item) {
  if (Number.isFinite(item?.publishedAt)) return item.publishedAt;
  if (Number.isFinite(item?.createdAt)) return item.createdAt;
  return null;
}

export function contentItemInTimeRange(item, window) {
  if (!window || window.startMs == null) return true;
  const asOf = contentItemTimestamp(item);
  if (!Number.isFinite(asOf)) return false;
  if (asOf < window.startMs) return false;
  if (window.endMs != null && asOf > window.endMs) return false;
  return true;
}
