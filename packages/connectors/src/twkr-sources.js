import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseFeedXml } from './media/feed-xml.js';
import { parseFeedDate } from './media/dates.js';
import { isPublicHttpsUrl } from './media/article-url.js';

export const TWKR_NEWS_TIMEOUT_MS = 15_000;
export const TWKR_REVENUE_TIMEOUT_MS = 15_000;
const NEWS_MAX_BYTES = 2_097_152;
const REVENUE_MAX_BYTES = 8_388_608;
const TEXT_LIMIT = 2_000;

const OFFSET_MINUTES = {
  'Asia/Taipei': 8 * 60,
  'Asia/Seoul': 9 * 60,
};

export const TWKR_SOURCES = Object.freeze([
  {
    sourceKey: 'twsematerial',
    publisher: '台湾证交所',
    publisherKey: 'twsematerial',
    channel: 'tech',
    kind: 'news',
    format: 'twse-material',
    url: 'https://openapi.twse.com.tw/v1/opendata/t187ap04_L',
    intervalMinutes: 15,
    lookbackHours: 72,
    timeZone: 'Asia/Taipei',
    summaryOnly: true,
    enabled: true,
  },
  {
    sourceKey: 'twserevenue',
    publisher: '台湾证交所',
    publisherKey: 'twserevenue',
    channel: 'tech',
    kind: 'revenue',
    format: 'twse-revenue',
    url: 'https://openapi.twse.com.tw/v1/opendata/t187ap05_L',
    intervalMinutes: 24 * 60,
    lookbackHours: 0,
    timeZone: 'Asia/Taipei',
    enabled: true,
  },
  {
    sourceKey: 'cnyes',
    publisher: '钜亨网',
    publisherKey: 'cnyes',
    channel: 'tech',
    kind: 'news',
    format: 'cnyes',
    url: 'https://api.cnyes.com/media/api/v1/newslist/category/tw_stock?limit=30',
    intervalMinutes: 12,
    lookbackHours: 48,
    timeZone: 'Asia/Taipei',
    enabled: true,
  },
  {
    sourceKey: 'ctee',
    publisher: '工商时报',
    publisherKey: 'ctee',
    channel: 'tech',
    kind: 'news',
    format: 'rss',
    url: 'https://www.ctee.com.tw/rss_web/livenews/stock',
    intervalMinutes: 12,
    lookbackHours: 48,
    timeZone: 'Asia/Taipei',
    enabled: true,
  },
  {
    sourceKey: 'udnmoney',
    publisher: '经济日报',
    publisherKey: 'udnmoney',
    channel: 'tech',
    kind: 'news',
    format: 'rss',
    url: 'https://money.udn.com/rssfeed/news/1001/5590?ch=money',
    intervalMinutes: 12,
    lookbackHours: 48,
    timeZone: 'Asia/Taipei',
    enabled: true,
  },
  {
    sourceKey: 'digitimesrss',
    publisher: 'DIGITIMES',
    publisherKey: 'digitimes',
    channel: 'tech',
    kind: 'news',
    format: 'rss',
    url: 'https://www.digitimes.com/rss/daily.xml',
    intervalMinutes: 15,
    lookbackHours: 48,
    timeZone: 'UTC',
    summaryOnly: true,
    enabled: true,
  },
  {
    sourceKey: 'thelec',
    publisher: 'THE ELEC',
    publisherKey: 'thelec',
    channel: 'tech',
    kind: 'news',
    format: 'rss',
    url: 'https://www.thelec.net/rss/allArticle.xml',
    intervalMinutes: 15,
    lookbackHours: 48,
    timeZone: 'Asia/Seoul',
    identityParams: ['idxno'],
    enabled: true,
  },
]);

function clampTimeout(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(5_000, parsed));
}

export function twkrNewsTimeoutMs(env = process.env) {
  return clampTimeout(env.AI_CENTER_TWKR_TIMEOUT_MS, TWKR_NEWS_TIMEOUT_MS, 30_000);
}

export function twkrRevenueTimeoutMs(env = process.env) {
  return clampTimeout(env.AI_CENTER_TWKR_REVENUE_TIMEOUT_MS, TWKR_REVENUE_TIMEOUT_MS, 60_000);
}

export function loadTwkrFlags(file) {
  if (!file || !existsSync(file)) return {};
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
  const sources = parsed?.sources;
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)) return {};
  const flags = {};
  for (const [key, value] of Object.entries(sources)) {
    if (!/^[a-z0-9]+$/.test(key)) continue;
    flags[key] = value === true || value === 1;
  }
  return flags;
}

function envEnabled(sourceKey, env) {
  const raw = String(env[`AI_CENTER_TWKR_${String(sourceKey || '').toUpperCase()}`] ?? '').trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off') return false;
  if (raw === '1' || raw === 'true' || raw === 'on') return true;
  return null;
}

export function resolveTwkrSources({ env = process.env, flags = {} } = {}) {
  return TWKR_SOURCES.map((source) => {
    const override = envEnabled(source.sourceKey, env);
    const configured = Object.prototype.hasOwnProperty.call(flags, source.sourceKey) ? flags[source.sourceKey] !== false : source.enabled !== false;
    return { ...source, enabled: override == null ? configured : override };
  });
}

function clip(value, max = TEXT_LIMIT) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function htmlText(value) {
  return clip(decodeEntities(value).replace(/<[^>]+>/g, ' '));
}

function shortHash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 10);
}

export function rocDateParts(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 7) {
    return { year: Number(digits.slice(0, 3)) + 1911, month: Number(digits.slice(3, 5)), day: Number(digits.slice(5, 7)) };
  }
  if (digits.length === 6) {
    return { year: Number(digits.slice(0, 2)) + 1911, month: Number(digits.slice(2, 4)), day: Number(digits.slice(4, 6)) };
  }
  if (digits.length === 5) {
    return { year: Number(digits.slice(0, 3)) + 1911, month: Number(digits.slice(3, 5)), day: 1 };
  }
  return null;
}

function validDate(parts, { allowDay = true } = {}) {
  if (!parts) return false;
  if (parts.year < 1990 || parts.year > 2100) return false;
  if (parts.month < 1 || parts.month > 12) return false;
  if (!allowDay) return true;
  return parts.day >= 1 && parts.day <= 31;
}

function clockParts(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return null;
  const padded = digits.padStart(6, '0').slice(-6);
  const hour = Number(padded.slice(0, 2));
  const minute = Number(padded.slice(2, 4));
  const second = Number(padded.slice(4, 6));
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { hour, minute, second };
}

export function zonedEpoch(parts, clock, offsetMinutes) {
  if (!validDate(parts) || offsetMinutes == null) return null;
  const hour = clock?.hour || 0;
  const minute = clock?.minute || 0;
  const second = clock?.second || 0;
  const utc = Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute, second);
  return utc - offsetMinutes * 60_000;
}

export function twkrSourceSkipsBody(sourceKey) {
  return TWKR_SOURCES.some((item) => item.sourceKey === sourceKey && item.summaryOnly === true);
}

export function parseZonedFeedDate(value, offsetMinutes) {
  const parsed = parseFeedDate(value);
  if (parsed.publishedAt != null || offsetMinutes == null) return parsed;
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return parsed;
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6] || 0));
  return { publishedAt: utc - offsetMinutes * 60_000, publishedAtRaw: raw };
}

function field(row, ...keys) {
  for (const key of keys) {
    if (row[key] != null && String(row[key]).trim()) return String(row[key]).trim();
  }
  return '';
}

function parseMaterial(body) {
  const rows = JSON.parse(body);
  if (!Array.isArray(rows)) return { ok: false, health: 'parse_failed', items: [], note: '重大讯息不是数组' };
  const offset = OFFSET_MINUTES['Asia/Taipei'];
  const items = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const code = field(row, '公司代號', '公司代号');
    const subject = field(row, '主旨', '主旨 ');
    const spoke = rocDateParts(field(row, '發言日期', '发言日期'));
    const clock = clockParts(field(row, '發言時間', '发言时间'));
    const publishedAt = zonedEpoch(spoke, clock, offset);
    if (!/^\d{4,6}$/.test(code) || !subject || publishedAt == null) continue;
    const spokeKey = field(row, '發言日期', '发言日期').replace(/\D/g, '');
    const timeKey = clock ? String(clock.hour).padStart(2, '0') + String(clock.minute).padStart(2, '0') + String(clock.second).padStart(2, '0') : '000000';
    const name = field(row, '公司名稱', '公司名称') || code;
    items.push({
      externalId: `twsematerial:${code}:${spokeKey}:${timeKey}:${shortHash(subject)}`,
      title: clip(`${name}(${code}) ${subject}`, 500),
      summary: clip(field(row, '說明', '说明')),
      sourceUrl: `https://mops.twse.com.tw/mops/web/t05st01?co_id=${code}`,
      publishedAt,
      publishedAtRaw: `${spokeKey} ${timeKey}`,
      authorName: name,
    });
  }
  return { ok: true, health: items.length ? 'ready' : 'empty', items, rows: [] };
}

function parseRevenue(body) {
  const rows = JSON.parse(body);
  if (!Array.isArray(rows)) return { ok: false, health: 'parse_failed', items: [], rows: [], note: '月营收不是数组' };
  const offset = OFFSET_MINUTES['Asia/Taipei'];
  const parsed = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const code = field(row, '公司代號', '公司代号');
    const period = rocDateParts(field(row, '資料年月', '资料年月'));
    if (!/^\d{4,6}$/.test(code) || !validDate(period, { allowDay: false })) continue;
    const published = rocDateParts(field(row, '出表日期'));
    const yearMonth = `${period.year}${String(period.month).padStart(2, '0')}`;
    parsed.push({
      companyCode: code,
      yearMonth,
      rocYearMonth: field(row, '資料年月', '资料年月').replace(/\D/g, ''),
      companyName: field(row, '公司名稱', '公司名称'),
      industry: field(row, '產業別', '产业别'),
      revenueMonth: field(row, '營業收入-當月營收', '营业收入-当月营收'),
      revenuePreviousMonth: field(row, '營業收入-上月營收', '营业收入-上月营收'),
      revenueYearAgo: field(row, '營業收入-去年當月營收', '营业收入-去年当月营收'),
      revenueMomPct: field(row, '營業收入-上月比較增減(%)', '营业收入-上月比较增减(%)'),
      revenueYoyPct: field(row, '營業收入-去年同月增減(%)', '营业收入-去年同月增减(%)'),
      revenueYtd: field(row, '累計營業收入-當月累計營收', '累计营业收入-当月累计营收'),
      revenueYtdYearAgo: field(row, '累計營業收入-去年累計營收', '累计营业收入-去年累计营收'),
      revenueYtdPct: field(row, '累計營業收入-前期比較增減(%)', '累计营业收入-前期比较增减(%)'),
      note: field(row, '備註', '备注').replace(/^-$/, ''),
      publishedOn: validDate(published) ? `${published.year}-${String(published.month).padStart(2, '0')}-${String(published.day).padStart(2, '0')}` : '',
      publishedAt: validDate(published) ? zonedEpoch(published, { hour: 0, minute: 0, second: 0 }, offset) : null,
    });
  }
  return { ok: true, health: parsed.length ? 'ready' : 'empty', items: [], rows: parsed };
}

function unixMillis(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed < 1e12 ? Math.round(parsed * 1000) : Math.round(parsed);
}

function parseCnyes(body) {
  const document = JSON.parse(body);
  const rows = document?.items?.data;
  if (!Array.isArray(rows)) return { ok: false, health: 'parse_failed', items: [], note: '钜亨网没有 items.data' };
  const items = [];
  for (const row of rows) {
    const newsId = String(row?.newsId || '').trim();
    const publishedAt = unixMillis(row?.publishAt);
    const title = clip(decodeEntities(row?.title || ''), 500);
    if (!/^\d+$/.test(newsId) || !title || publishedAt == null) continue;
    const summary = clip(row?.summary) || htmlText(row?.content);
    items.push({
      externalId: `cnyes:${newsId}`,
      title,
      summary,
      sourceUrl: `https://news.cnyes.com/news/id/${newsId}`,
      publishedAt,
      publishedAtRaw: String(row.publishAt),
      authorName: clip(row?.source || '钜亨网', 200),
    });
  }
  return { ok: true, health: items.length ? 'ready' : 'empty', items, rows: [] };
}

function parseRss(source, body) {
  const parsed = parseFeedXml(body, {
    sourceKey: source.sourceKey,
    trackingParams: [],
    identityParams: source.identityParams || [],
  });
  if (!parsed.ok) return { ok: false, health: parsed.health, items: [], note: parsed.note || '' };
  const offset = OFFSET_MINUTES[source.timeZone] ?? null;
  const items = parsed.items.map((item) => {
    const when = item.publishedAt != null ? { publishedAt: item.publishedAt, publishedAtRaw: item.publishedAtRaw } : parseZonedFeedDate(item.publishedAtRaw, offset);
    return {
      externalId: item.externalId,
      title: clip(item.title, 500),
      summary: clip(item.summary),
      sourceUrl: item.sourceUrl,
      publishedAt: when.publishedAt,
      publishedAtRaw: when.publishedAtRaw || item.publishedAtRaw || '',
      authorName: clip(item.authorName || source.publisher, 200),
    };
  }).filter((item) => item.externalId && item.sourceUrl && item.title && Number.isInteger(item.publishedAt));
  return { ok: true, health: items.length ? 'ready' : 'empty', items, rows: [] };
}

export function parseTwkrPayload(source, body) {
  try {
    if (source.format === 'twse-material') return parseMaterial(body);
    if (source.format === 'twse-revenue') return parseRevenue(body);
    if (source.format === 'cnyes') return parseCnyes(body);
    if (source.format === 'rss') return parseRss(source, body);
  } catch (error) {
    return { ok: false, health: 'parse_failed', items: [], rows: [], note: error instanceof Error ? error.message : '解析失败' };
  }
  return { ok: false, health: 'parse_failed', items: [], rows: [], note: '未知来源格式' };
}

export async function fetchTwkrDocument(url, { timeoutMs = TWKR_NEWS_TIMEOUT_MS, fetchImpl = globalThis.fetch, timeoutImpl = AbortSignal.timeout, maxBytes = NEWS_MAX_BYTES } = {}) {
  if (!isPublicHttpsUrl(url)) return { ok: false, health: 'blocked_url', note: '只接受公网 https' };
  const signal = timeoutImpl(timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal,
      headers: {
        Accept: 'application/json, application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.1',
        'User-Agent': 'AICenterMedia/0.2 (+local)',
      },
    });
    const status = Number(response.status) || 0;
    if (status < 200 || status >= 300) return { ok: false, health: 'http_error', status, note: `HTTP ${status}` };
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) return { ok: false, health: 'oversized', status, note: '响应超过字节上限' };
    return { ok: true, health: 'ready', status, body: buffer.toString('utf8') };
  } catch (error) {
    const name = error?.name || '';
    const timeout = name === 'TimeoutError' || name === 'AbortError' || signal.aborted;
    return { ok: false, health: timeout ? 'timeout' : 'network', note: error instanceof Error ? error.message : '网络失败' };
  }
}

export async function readTwkrSource(source, options = {}) {
  const timeoutMs = source.kind === 'revenue'
    ? (options.timeoutMs ?? twkrRevenueTimeoutMs(options.env))
    : (options.timeoutMs ?? twkrNewsTimeoutMs(options.env));
  const fetched = await fetchTwkrDocument(source.url, {
    timeoutMs,
    fetchImpl: options.fetchImpl,
    timeoutImpl: options.timeoutImpl,
    maxBytes: source.kind === 'revenue' ? REVENUE_MAX_BYTES : NEWS_MAX_BYTES,
  });
  if (!fetched.ok) return { ...fetched, items: [], rows: [] };
  return parseTwkrPayload(source, fetched.body);
}
