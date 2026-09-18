const URLS = Object.freeze({
  bls: 'https://www.bls.gov/schedule/news_release/bls.ics',
  bea: 'https://www.bea.gov/news/schedule',
  census: 'https://www.census.gov/economic-indicators/calendar-listview.html',
  ism: 'https://www.ismworld.org/supply-management-news-and-reports/reports/rob-report-calendar/',
  dolClaims: 'https://oui.doleta.gov/unemploy/claims_arch.asp',
  nbs: 'https://www.stats.gov.cn/sj/fbrc/bnxxfb/',
  customs: 'https://english.customs.gov.cn/Statistics/Statistics?ColumnId=4',
  fedCalendar: 'https://www.federalreserve.gov/newsevents/calendar.htm',
  fomc: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
  fedMonetary: 'https://www.federalreserve.gov/feeds/press_monetary.xml',
  fedSpeeches: 'https://www.federalreserve.gov/feeds/speeches_and_testimony.xml',
  fedBoardMeetings: 'https://www.federalreserve.gov/feeds/boardmeetings.xml',
  fedReleases: 'https://www.federalreserve.gov/feeds/feeds.htm',
  federalRegister: 'https://www.federalregister.gov/api/v1/documents.json',
  whiteHouse: 'https://www.whitehouse.gov/news/',
  govCn: 'https://sousuo.www.gov.cn/search-gov/data',
  govNews: 'https://www.gov.cn/yaowen/liebiao/YAOWENLIEBIAO.json',
  pboc: 'https://www.pbc.gov.cn/goutongjiaoliu/113456/113469/index.html',
  // The SCIO English host currently presents a mismatched HTTPS certificate. The product owner
  // explicitly accepts its official HTTP listing as the source; keep this exception URL-scoped.
  scio: 'http://english.scio.gov.cn/pressroom/node_7248351.htm',
  lprRule: 'https://www.pbc.gov.cn/goutongjiaoliu/113456/113469/2025092212550010243/index.html',
  lpr: 'https://www.pbc.gov.cn/goutongjiaoliu/113456/113469/2025092212550010243/index.html',
});

const MONTHS = Object.freeze({
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
});
const MONTH_NAMES = Object.keys(MONTHS);
const NBS_YEAR_URLS = Object.freeze({
  2026: 'https://www.stats.gov.cn/xw/tjxw/tzgg/202512/t20251224_1962137.html',
});

function decodeHtml(value = '') {
  return String(value)
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function text(value = '') {
  return decodeHtml(String(value).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim();
}

const OFFICIAL_DETAIL_HOSTS = Object.freeze([
  'bls.gov', 'bea.gov', 'census.gov', 'ismworld.org', 'doleta.gov', 'stats.gov.cn',
  'customs.gov.cn', 'federalreserve.gov', 'pbc.gov.cn', 'scio.gov.cn',
  'federalregister.gov', 'whitehouse.gov', 'gov.cn',
]);
const DETAIL_RAW_BYTE_LIMIT = 2 * 1024 * 1024;
const DETAIL_SUMMARY_BYTE_LIMIT = 8 * 1024;
const DETAIL_BODY_BYTE_LIMIT = 36 * 1024;

function utf8Clip(value, maxBytes) {
  const chars = Array.from(String(value || ''));
  let used = 0;
  let end = 0;
  for (; end < chars.length; end += 1) {
    const bytes = Buffer.byteLength(chars[end], 'utf8');
    if (used + bytes > maxBytes) break;
    used += bytes;
  }
  return { value: chars.slice(0, end).join('').trim(), truncated: end < chars.length };
}

function officialDetailUrl(value) {
  const url = new URL(String(value || ''));
  const hostname = url.hostname.toLowerCase();
  const allowed = OFFICIAL_DETAIL_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
  const scioHttp = url.protocol === 'http:' && hostname === 'english.scio.gov.cn';
  if (!allowed || (url.protocol !== 'https:' && !scioHttp)) {
    throw new Error('详情读取只允许已登记的官方 HTTPS 域名及 SCIO 英文站 HTTP 例外');
  }
  url.hash = '';
  return url.toString();
}

function metaValue(html, keys) {
  for (const match of String(html).matchAll(/<meta\b([^>]*)>/gi)) {
    const attributes = match[1];
    const name = (attr(attributes, 'name') || attr(attributes, 'property') || attr(attributes, 'itemprop')).toLowerCase();
    if (keys.includes(name)) return text(attr(attributes, 'content'));
  }
  return '';
}

function jsonLdFacts(html) {
  const facts = [];
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (value.headline || value.articleBody || value.description || value.datePublished) facts.push(value);
    Object.values(value).forEach(visit);
  };
  for (const match of String(html).matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(decodeHtml(match[1]).trim())); } catch { /* Invalid optional metadata is ignored. */ }
  }
  return facts.sort((left, right) => String(right.articleBody || '').length - String(left.articleBody || '').length);
}

function namedBlocks(html, names) {
  const blocks = [];
  for (const name of names) {
    const pattern = new RegExp(`<([a-z][\\w:-]*)\\b[^>]*(?:id|class)=["'][^"']*${name}[^"']*["'][^>]*>([\\s\\S]*?)<\\/\\1>`, 'gi');
    for (const match of String(html).matchAll(pattern)) {
      const value = text(match[2]);
      if (value) blocks.push(value);
    }
  }
  return blocks;
}

function paragraphText(html) {
  const rows = [...String(html).matchAll(/<(?:p|h[2-6]|li)\b[^>]*>([\s\S]*?)<\/(?:p|h[2-6]|li)>/gi)]
    .map((match) => text(match[1]))
    .filter((value) => value.length >= 20 && !/^(home|top news|press room|search|print|share|网站地图|联系我们|版权所有)/i.test(value));
  return [...new Set(rows)].join('\n\n');
}

export function extractOfficialSourceDetail(html, sourceUrl, observedAt = Date.now()) {
  const safeUrl = officialDetailUrl(sourceUrl);
  const cleaned = String(html || '')
    .replace(/<(script|style|svg|noscript|template|nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ');
  const structured = jsonLdFacts(html);
  const title = text(structured.find((item) => item.headline)?.headline)
    || metaValue(html, ['og:title', 'twitter:title'])
    || text(cleaned.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '')
    || text(cleaned.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  const summaryBlocks = namedBlocks(cleaned, ['article-description', 'article[_-]?summary', 'abstract', 'summary']);
  const officialSummary = text(structured.find((item) => item.description)?.description)
    || metaValue(html, ['description', 'og:description', 'twitter:description'])
    || summaryBlocks[0]
    || '';
  const articleBody = text(structured.find((item) => item.articleBody)?.articleBody);
  const bodyBlocks = namedBlocks(cleaned, [
    'UCAP-CONTENT', 'TRS_Editor', 'document-contents', 'article[_-]?content', 'article[_-]?body',
    'entry[_-]?content', 'body[_-]?content', 'page[_-]?content', 'pages[_-]?content', 'p_content', 'zoom',
  ]).sort((left, right) => right.length - left.length);
  const article = text(cleaned.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] || '');
  let bodyText = articleBody || bodyBlocks[0] || article || paragraphText(cleaned);
  if (bodyText === title || bodyText === officialSummary) bodyText = '';
  const summaryClip = utf8Clip(officialSummary, DETAIL_SUMMARY_BYTE_LIMIT);
  const bodyClip = utf8Clip(bodyText, DETAIL_BODY_BYTE_LIMIT);
  const dateValue = structured.find((item) => item.datePublished)?.datePublished
    || metaValue(html, ['article:published_time', 'datepublished', 'publishdate', 'pubdate']);
  const parsedDate = Date.parse(String(dateValue || ''));
  const available = Boolean(title || summaryClip.value || bodyClip.value);
  return {
    available,
    sourceUrl: safeUrl,
    title: utf8Clip(title, 4 * 1024).value,
    officialSummary: summaryClip.value,
    bodyText: bodyClip.value,
    publishedAt: Number.isFinite(parsedDate) ? parsedDate : null,
    observedAt,
    truncated: summaryClip.truncated || bodyClip.truncated,
    note: available ? '' : '官方页面未解析到可供 AI 阅读的标题、摘要或正文。',
  };
}

function attr(fragment, name) {
  const match = String(fragment).match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return match ? decodeHtml(match[1]).trim() : '';
}

function absoluteUrl(value, base) {
  try { return new URL(decodeHtml(value), base).toString(); } catch { return base; }
}

function zonedTimestamp(parts, timeZone) {
  const desired = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0);
  let guess = desired;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const found = Object.fromEntries(formatter.formatToParts(new Date(guess)).map((part) => [part.type, part.value]));
    const represented = Date.UTC(
      Number(found.year), Number(found.month) - 1, Number(found.day),
      Number(found.hour), Number(found.minute), Number(found.second),
    );
    guess += desired - represented;
  }
  return guess;
}

function parseClock(value = '') {
  const normalized = text(value).toLowerCase();
  const match = normalized.match(/(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  if (match[3]?.startsWith('p') && hour < 12) hour += 12;
  if (match[3]?.startsWith('a') && hour === 12) hour = 0;
  return { hour, minute };
}

function parseClockList(value = '') {
  const normalized = text(value).toLowerCase();
  return [...normalized.matchAll(/(\d{1,2})(?::(\d{2}))\s*(a\.?m\.?|p\.?m\.?)?/gi)].map((match) => {
    let hour = Number(match[1]);
    const minute = Number(match[2] || 0);
    if (match[3]?.startsWith('p') && hour < 12) hour += 12;
    if (match[3]?.startsWith('a') && hour === 12) hour = 0;
    return { hour, minute };
  });
}

function scheduleStatus(value = '') {
  const normalized = text(value).toLowerCase();
  if (/suspend/.test(normalized)) return 'suspended';
  if (/to\s+be\s+announced|\btba\b/.test(normalized)) return 'tba';
  if (/cancel/.test(normalized)) return 'cancelled';
  if (/reschedul/.test(normalized)) return 'rescheduled';
  return 'scheduled';
}

function parseEnglishDate(value, fallbackYear, time = '', timeZone = 'America/New_York') {
  const match = text(value).match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,\s*(\d{4}))?/i);
  if (!match) return null;
  const clock = parseClock(time) || { hour: 0, minute: 0 };
  return zonedTimestamp({
    year: Number(match[3] || fallbackYear), month: MONTHS[match[1].toLowerCase()], day: Number(match[2]), ...clock,
  }, timeZone);
}

function parseIsoDate(value, timeZone = 'Asia/Shanghai', time = '') {
  const match = String(value).match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (!match) return null;
  const clock = parseClock(time) || { hour: 0, minute: 0 };
  return zonedTimestamp({ year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), ...clock }, timeZone);
}

function stableId(prefix, ...parts) {
  return `${prefix}:${parts.map((part) => String(part ?? '').trim().replace(/\s+/g, '-')).join(':')}`.slice(0, 512);
}

function sourceRange(input, now) {
  const from = Number.isFinite(input?.from) ? input.from : now - 31 * 86_400_000;
  const to = Number.isFinite(input?.to) ? input.to : now + 400 * 86_400_000;
  return { from, to, limit: Math.min(Math.max(Number(input?.limit) || 200, 1), 1_000) };
}

function selectEvents(events, input, now) {
  const { from, to, limit } = sourceRange(input, now);
  return events.filter((event) => event.scheduledAt === null || (event.scheduledAt >= from && event.scheduledAt <= to))
    .sort((left, right) => (left.scheduledAt ?? Number.MAX_SAFE_INTEGER) - (right.scheduledAt ?? Number.MAX_SAFE_INTEGER))
    .slice(0, limit);
}

function selectReleases(releases, input) {
  const limit = Math.min(Math.max(Number(input?.limit) || 50, 1), 200);
  return releases.sort((left, right) => right.publishedAt - left.publishedAt).slice(0, limit);
}

function calendarEvent(fields, observedAt) {
  return {
    scheduledEndAt: null, referencePeriod: null, status: 'scheduled',
    scheduleBasis: 'official-calendar', timePrecision: 'exact', observedAt,
    ...fields,
  };
}

function officialRelease(fields, observedAt) {
  return { effectiveAt: null, documentNumber: null, timePrecision: 'exact', observedAt, ...fields };
}

function unfoldIcs(value) {
  return String(value).replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
}

function unescapeIcs(value = '') {
  return String(value).replace(/\\n/gi, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\').trim();
}

function parseIcsDate(property, value) {
  const match = String(value).match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?Z?)?$/);
  if (!match) return { at: null, precision: 'unknown' };
  const parts = {
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(match[4] || 0), minute: Number(match[5] || 0), second: Number(match[6] || 0),
  };
  if (value.endsWith('Z')) return { at: Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second), precision: match[4] ? 'exact' : 'date' };
  const rawZone = property.match(/TZID=([^;:]+)/i)?.[1] || 'America/New_York';
  const zone = ({ 'US-Eastern': 'America/New_York', 'Eastern Standard Time': 'America/New_York' })[rawZone] || rawZone;
  return { at: zonedTimestamp(parts, zone), precision: match[4] ? 'exact' : 'date' };
}

export function parseBlsIcs(value, observedAt = Date.now()) {
  const events = [];
  const lines = unfoldIcs(value);
  let record = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { record = {}; continue; }
    if (line === 'END:VEVENT' && record) {
      const startProperty = Object.keys(record).find((key) => key.startsWith('DTSTART')) || '';
      const parsed = parseIcsDate(startProperty, record[startProperty]);
      const title = unescapeIcs(record.SUMMARY || 'BLS release');
      if (parsed.at !== null) {
        events.push(calendarEvent({
          eventId: String(record.UID || stableId('bls', parsed.at, title)).slice(0, 512),
          country: 'US', authority: 'U.S. Bureau of Labor Statistics', eventType: 'economic-release',
          title, scheduledAt: parsed.at, timePrecision: parsed.precision,
          sourceUrl: absoluteUrl(record.URL || URLS.bls, URLS.bls),
        }, observedAt));
      }
      record = null;
      continue;
    }
    if (!record) continue;
    const index = line.indexOf(':');
    if (index > 0) record[line.slice(0, index)] = line.slice(index + 1);
  }
  return events;
}

export function parseBeaCalendar(html, observedAt = Date.now()) {
  const year = Number(text(html).match(/Year\s+(\d{4})/i)?.[1] || new Date(observedAt).getUTCFullYear());
  return [...String(html).matchAll(/<tr[^>]*class=["'][^"']*scheduled-releases[^"']*["'][^>]*>([\s\S]*?)<\/tr>/gi)].flatMap((match) => {
    const row = match[1];
    const dateCell = row.match(/<td[^>]*class=["'][^"']*scheduled-date[^"']*["'][^>]*>([\s\S]*?)<\/td>/i)?.[1] || '';
    const date = text(row.match(/class=["'][^"']*release-date[^"']*["'][^>]*>([\s\S]*?)<\//i)?.[1] || dateCell);
    const time = text(dateCell.match(/<small[^>]*>([\s\S]*?)<\/small>/i)?.[1]
      || row.match(/<small[^>]*>([\s\S]*?)<\/small>/i)?.[1] || '');
    const title = text(row.match(/class=["'][^"']*release-title[^"']*["'][^>]*>([\s\S]*?)<\/td>/i)?.[1] || '');
    const status = scheduleStatus(date);
    const scheduledAt = parseEnglishDate(date, year, time);
    if (!title || (scheduledAt === null && !['tba', 'suspended', 'cancelled'].includes(status))) return [];
    return [calendarEvent({
      eventId: stableId('bea', scheduledAt ?? status, title), country: 'US', authority: 'U.S. Bureau of Economic Analysis',
      eventType: 'economic-release', title, scheduledAt, status,
      timePrecision: scheduledAt === null ? 'unknown' : 'exact', sourceUrl: URLS.bea,
    }, observedAt)];
  });
}

function tableMatrix(html) {
  const carries = [];
  const matrix = [];
  for (const rowMatch of String(html).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = [];
    let column = 0;
    const fillCarry = () => {
      while (carries[column]) {
        row[column] = carries[column].value;
        carries[column].remaining -= 1;
        if (carries[column].remaining <= 0) carries[column] = null;
        column += 1;
      }
    };
    for (const cell of rowMatch[1].matchAll(/<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
      fillCarry();
      const value = text(cell[3]);
      const rowSpan = Math.max(Number(attr(cell[2], 'rowspan')) || 1, 1);
      const colSpan = Math.max(Number(attr(cell[2], 'colspan')) || 1, 1);
      for (let offset = 0; offset < colSpan; offset += 1) {
        row[column + offset] = value;
        if (rowSpan > 1) carries[column + offset] = { value, remaining: rowSpan - 1 };
      }
      column += colSpan;
    }
    while (column < carries.length) { fillCarry(); if (!carries[column] && row[column] === undefined) column += 1; }
    if (row.some(Boolean)) matrix.push(row);
  }
  return matrix;
}

export function parseCensusCalendar(html, observedAt = Date.now()) {
  const events = [...String(html).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].flatMap((match) => {
    const cells = [...match[1].matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)];
    if (cells.length < 4) return [];
    const title = text(cells[0][2]);
    const date = text(cells[1][2]);
    const time = text(cells[2][2]);
    const referencePeriod = text(cells[3][2]) || null;
    const status = scheduleStatus(date);
    const scheduledAt = parseEnglishDate(date, new Date(observedAt).getUTCFullYear(), time);
    if (!title || (scheduledAt === null && !['tba', 'suspended', 'cancelled'].includes(status))) return [];
    const href = cells[0][2].match(/href=["']([^"']+)/i)?.[1] || URLS.census;
    return [calendarEvent({
      eventId: stableId('census', scheduledAt ?? status, title, referencePeriod), country: 'US',
      authority: 'U.S. Census Bureau', eventType: 'economic-release', title, scheduledAt,
      referencePeriod, status, timePrecision: scheduledAt === null ? 'unknown' : 'exact',
      sourceUrl: absoluteUrl(href, URLS.census),
    }, observedAt)];
  });
  return [...new Map(events.map((event) => [event.eventId, event])).values()];
}

function nthWeekdayOfMonth(year, month, weekday, ordinal) {
  const date = new Date(Date.UTC(year, month - 1, 1));
  const delta = (weekday - date.getUTCDay() + 7) % 7;
  return 1 + delta + (ordinal - 1) * 7;
}

function nthBusinessDay(year, month, ordinal) {
  let seen = 0;
  for (let day = 1; day <= 31; day += 1) {
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCMonth() !== month - 1) break;
    if (![0, 6].includes(date.getUTCDay())) seen += 1;
    if (seen === ordinal) return day;
  }
  return 1;
}

export function generateIsmRuleEvents(input = {}, observedAt = Date.now()) {
  const { from, to } = sourceRange(input, observedAt);
  const startYear = new Date(from).getUTCFullYear();
  const endYear = new Date(to).getUTCFullYear();
  const events = [];
  for (let year = startYear; year <= endYear; year += 1) {
    for (let month = 1; month <= 12; month += 1) {
      for (const [title, ordinal] of [['ISM Manufacturing PMI', 1], ['ISM Services PMI', 3]]) {
        const day = nthBusinessDay(year, month, ordinal);
        const scheduledAt = zonedTimestamp({ year, month, day, hour: 10, minute: 0 }, 'America/New_York');
        events.push(calendarEvent({
          eventId: stableId('ism-rule', year, month, ordinal), country: 'US', authority: 'Institute for Supply Management',
          eventType: 'economic-release', title, scheduledAt, status: 'tentative', scheduleBasis: 'official-rule',
          sourceUrl: URLS.ism,
        }, observedAt));
      }
    }
  }
  return events;
}

export function parseIsmCalendar(html, observedAt = Date.now()) {
  const year = Number(text(html).match(/(20\d{2})\s+ISM/i)?.[1] || new Date(observedAt).getUTCFullYear());
  const events = [];
  for (const row of tableMatrix(html)) {
    const month = MONTHS[String(row[0] || '').toLowerCase().match(/[a-z]+/)?.[0]];
    if (!month) continue;
    for (const [index, title] of [[1, 'ISM Manufacturing PMI'], [2, 'ISM Services PMI']]) {
      const day = Number(String(row[index] || '').match(/\d{1,2}/)?.[0]);
      if (!day) continue;
      const scheduledAt = zonedTimestamp({ year, month, day, hour: 10, minute: 0 }, 'America/New_York');
      events.push(calendarEvent({
        eventId: stableId('ism', scheduledAt, title), country: 'US', authority: 'Institute for Supply Management',
        eventType: 'economic-release', title, scheduledAt, sourceUrl: URLS.ism,
      }, observedAt));
    }
  }
  return events;
}

export function generateDolClaimsEvents(input = {}, observedAt = Date.now()) {
  const { from, to } = sourceRange(input, observedAt);
  const first = new Date(from);
  const cursor = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate()));
  cursor.setUTCDate(cursor.getUTCDate() + ((4 - cursor.getUTCDay() + 7) % 7));
  const events = [];
  while (cursor.getTime() <= to) {
    const year = cursor.getUTCFullYear(); const month = cursor.getUTCMonth() + 1; const day = cursor.getUTCDate();
    const scheduledAt = zonedTimestamp({ year, month, day, hour: 8, minute: 30 }, 'America/New_York');
    events.push(calendarEvent({
      eventId: stableId('dol-claims-rule', year, month, day), country: 'US',
      authority: 'U.S. Department of Labor', eventType: 'economic-release', title: 'Initial Jobless Claims',
      scheduledAt, status: 'tentative', scheduleBasis: 'official-rule', sourceUrl: URLS.dolClaims,
    }, observedAt));
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return events;
}

function parseDayList(value = '') {
  const normalized = text(value).replace(/注\s*\d+/g, ' ');
  const marked = [...normalized.matchAll(/(?:^|\s)(\d{1,2})\s*(?:日|\/)/g)].map((match) => Number(match[1]));
  if (marked.length) return marked;
  return [...normalized.matchAll(/(?:^|\s)(\d{1,2})(?=\s|$)/g)].map((match) => Number(match[1]));
}

export function parseNbsCalendar(html, observedAt = Date.now(), sourceUrl = URLS.nbs) {
  const year = Number(text(html).match(/(20\d{2})年国家统计局/)?.[1] || new Date(observedAt).getUTCFullYear());
  const rows = tableMatrix(html);
  const header = rows.find((row) => row.some((cell) => /\d{1,2}月/.test(cell))) || [];
  const monthColumns = new Map();
  header.forEach((cell, index) => { const month = Number(String(cell).match(/(\d{1,2})月/)?.[1]); if (month) monthColumns.set(index, month); });
  const events = [];
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    const next = rows[index + 1] || [];
    const sequence = String(row[0] || '').match(/^\d+$/)?.[0];
    const title = text(row[1] || '');
    if (!sequence || !title || row[0] !== next[0] || row[1] !== next[1]) continue;
    for (const [column, month] of monthColumns) {
      const days = parseDayList(row[column] || '');
      const clocks = parseClockList(next[column] || '');
      days.forEach((day, dayIndex) => {
        const clock = clocks[dayIndex] || (clocks.length === 1 ? clocks[0] : null);
        if (!day || !clock) return;
        const scheduledAt = zonedTimestamp({ year, month, day, ...clock }, 'Asia/Shanghai');
        events.push(calendarEvent({
          eventId: stableId('nbs', sequence, scheduledAt), country: 'CN', authority: '国家统计局',
          eventType: 'economic-release', title, scheduledAt, sourceUrl,
        }, observedAt));
      });
    }
  }
  return [...new Map(events.map((event) => [event.eventId, event])).values()];
}

export function parseCustomsCalendar(html, observedAt = Date.now(), sourceUrl = URLS.customs) {
  const content = text(html);
  const year = Number(content.match(/(?:Release Calendar of|calendar of|发布日程)[^\d]*(20\d{2})/i)?.[1] || new Date(observedAt).getUTCFullYear());
  const events = [];
  for (const row of tableMatrix(html)) {
    const monthName = String(row[0] || '').toLowerCase().match(/[a-z]+/)?.[0];
    const month = MONTHS[monthName];
    if (!month) continue;
    for (const [column, title] of [[1, '海关统计初步数据'], [2, '海关统计月报'], [3, '海关统计在线查询数据']]) {
      const day = Number(String(row[column] || '').replace(/\s+/g, '').match(/\d{1,2}/)?.[0]);
      if (!day) continue;
      const scheduledAt = zonedTimestamp({ year, month, day, hour: 0, minute: 0 }, 'Asia/Shanghai');
      events.push(calendarEvent({
        eventId: stableId('gacc', scheduledAt, column), country: 'CN', authority: '海关总署',
        eventType: 'economic-release', title, scheduledAt, timePrecision: 'date', sourceUrl,
      }, observedAt));
    }
  }
  return events;
}

export function parseScioCalendar(html, observedAt = Date.now(), sourceUrl = URLS.scio) {
  const events = [];
  const seen = new Set();
  for (const anchor of String(html).matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const title = text(anchor[2]);
    const match = title.match(/Notice of (.+?) on\s+(Jan\.?|Feb\.?|Mar\.?|Apr\.?|May|Jun\.?|Jul\.?|Aug\.?|Sep\.?|Sept\.?|Oct\.?|Nov\.?|Dec\.?)\s+(\d{1,2})\s*\((\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\)/i);
    if (!match) continue;
    const href = absoluteUrl(anchor[1], sourceUrl);
    if (seen.has(href)) continue;
    seen.add(href);
    const year = Number(href.match(/\/(20\d{2})-/)?.[1] || new Date(observedAt).getUTCFullYear());
    const monthKey = match[2].replace(/\./g, '').toLowerCase();
    const month = ({ jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 })[monthKey];
    let hour = Number(match[4]);
    if (match[6].toLowerCase().startsWith('p') && hour < 12) hour += 12;
    if (match[6].toLowerCase().startsWith('a') && hour === 12) hour = 0;
    if (!month) continue;
    const scheduledAt = zonedTimestamp({ year, month, day: Number(match[3]), hour, minute: Number(match[5] || 0) }, 'Asia/Shanghai');
    events.push(calendarEvent({
      eventId: stableId('scio', href), country: 'CN', authority: '国务院新闻办公室',
      eventType: 'government-meeting', title, scheduledAt, sourceUrl: href,
    }, observedAt));
  }
  return events;
}

function monthPageUrl(year, month) {
  return `https://www.federalreserve.gov/newsevents/${year}-${MONTH_NAMES[month - 1]}.htm`;
}

export function parseFedMonthCalendar(html, year, month, observedAt = Date.now(), sourceUrl = URLS.fedCalendar) {
  const events = [];
  const headings = [...String(html).matchAll(/<div[^>]*class=["'][^"']*cal-nojs__rowTitle[^"']*["'][^>]*>[\s\S]*?<h4[^>]*>([\s\S]*?)<\/h4>/gi)];
  for (let headingIndex = 0; headingIndex < headings.length; headingIndex += 1) {
    const category = text(headings[headingIndex][1]);
    const start = headings[headingIndex].index + headings[headingIndex][0].length;
    const end = headings[headingIndex + 1]?.index ?? html.length;
    const segment = html.slice(start, end);
    const panels = [...segment.matchAll(/<div[^>]*class=["'][^"']*panel border[^"']*["'][^>]*>/gi)];
    for (let panelIndex = 0; panelIndex < panels.length; panelIndex += 1) {
      const panelStart = panels[panelIndex].index + panels[panelIndex][0].length;
      const panelEnd = panels[panelIndex + 1]?.index ?? segment.length;
      const block = segment.slice(panelStart, panelEnd);
      const columns = [...block.matchAll(/<div[^>]*class=["'][^"']*col-xs-(?:2|7|3)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi)].map((item) => text(item[1]));
      if (columns.length < 3) continue;
      const clock = parseClock(columns[0]);
      const day = Number(columns.at(-1).match(/\d{1,2}/)?.[0]);
      const title = columns[1];
      if (!day || !title) continue;
      const scheduledAt = zonedTimestamp({ year, month, day, ...(clock || { hour: 0, minute: 0 }) }, 'America/New_York');
      const lower = category.toLowerCase();
      const eventType = lower.includes('speech') || lower.includes('testimony')
        ? 'central-bank-speech' : lower.includes('fomc') || lower.includes('board meeting')
          ? 'central-bank-meeting' : 'statistical-release';
      events.push(calendarEvent({
        eventId: stableId('fed-calendar', scheduledAt, category, title), country: 'US',
        authority: 'Federal Reserve Board', eventType, title: `${category}: ${title}`,
        scheduledAt, timePrecision: clock ? 'exact' : 'date', sourceUrl,
      }, observedAt));
    }
  }
  return events;
}

export function parseFomcCalendar(html, observedAt = Date.now()) {
  const events = [];
  const headings = [...String(html).matchAll(/<h[234][^>]*>\s*(?:<a[^>]*>)?\s*(20\d{2})\s+FOMC Meetings[\s\S]*?<\/h[234]>/gi)];
  for (let index = 0; index < headings.length; index += 1) {
    const year = Number(headings[index][1]);
    const start = headings[index].index + headings[index][0].length;
    const end = headings[index + 1]?.index ?? html.length;
    const segment = html.slice(start, end);
    for (const meeting of segment.matchAll(/<div[^>]*class=["'][^"']*\brow\b[^"']*\bfomc-meeting\b[^"']*["'][^>]*>([\s\S]*?)(?=<div[^>]*class=["'][^"']*\brow\b[^"']*\bfomc-meeting\b|$)/gi)) {
      const monthName = text(meeting[1].match(/fomc-meeting__month[^>]*>[\s\S]*?<strong>([^<]+)/i)?.[1] || '').toLowerCase();
      const month = MONTHS[monthName];
      const dateText = text(meeting[1].match(/fomc-meeting__date[^>]*>([\s\S]*?)<\/div>/i)?.[1] || '');
      const dates = [...dateText.matchAll(/\d{1,2}/g)].map((item) => Number(item[0]));
      if (!month || !dates.length) continue;
      const scheduledAt = zonedTimestamp({ year, month, day: dates[0], hour: 0, minute: 0 }, 'America/New_York');
      const scheduledEndAt = dates[1]
        ? zonedTimestamp({ year, month, day: dates[1], hour: 23, minute: 59 }, 'America/New_York') : null;
      events.push(calendarEvent({
        eventId: stableId('fomc', year, month, dates.join('-')), country: 'US', authority: 'Federal Open Market Committee',
        eventType: 'central-bank-meeting', title: `FOMC Meeting${dateText.includes('*') ? ' (with SEP)' : ''}`,
        scheduledAt, scheduledEndAt, timePrecision: 'date', sourceUrl: URLS.fomc,
      }, observedAt));
    }
  }
  return events;
}

export function generateLprRuleEvents(input = {}, observedAt = Date.now()) {
  const { from, to } = sourceRange(input, observedAt);
  const start = new Date(from); const end = new Date(to);
  const events = [];
  for (let year = start.getUTCFullYear(); year <= end.getUTCFullYear(); year += 1) {
    const firstMonth = year === start.getUTCFullYear() ? start.getUTCMonth() + 1 : 1;
    const lastMonth = year === end.getUTCFullYear() ? end.getUTCMonth() + 1 : 12;
    for (let month = firstMonth; month <= lastMonth; month += 1) {
      const scheduledAt = zonedTimestamp({ year, month, day: 20, hour: 9, minute: 30 }, 'Asia/Shanghai');
      events.push(calendarEvent({
        eventId: stableId('lpr-rule', year, month), country: 'CN', authority: '中国人民银行 / 全国银行间同业拆借中心',
        eventType: 'economic-release', title: '贷款市场报价利率（LPR，遇节假日顺延）',
        scheduledAt, status: 'tentative', scheduleBasis: 'official-rule', sourceUrl: URLS.lprRule,
      }, observedAt));
    }
  }
  return events;
}

function documentTypeFrom(value = '') {
  const normalized = text(value).toLowerCase();
  if (normalized.includes('executive order')) return 'executive-order';
  if (normalized.includes('memorand')) return 'memorandum';
  if (normalized.includes('proclamation')) return 'proclamation';
  if (normalized.includes('proposed rule')) return 'proposed-rule';
  if (normalized === 'rule' || normalized.includes('final rule')) return 'rule';
  if (normalized.includes('notice')) return 'notice';
  if (normalized.includes('speech')) return 'speech';
  if (normalized.includes('testimony')) return 'testimony';
  if (normalized.includes('board meeting')) return 'board-meeting';
  if (normalized.includes('statistic') || normalized.includes('data report')) return 'statistical-release';
  if (normalized.includes('press') || normalized.includes('statement') || normalized.includes('release')) return 'press-release';
  if (normalized.includes('presidential')) return 'presidential-document';
  if (normalized.includes('公告') || normalized.includes('公示')) return 'announcement';
  if (normalized.includes('统计') || normalized.includes('数据报告')) return 'statistical-release';
  if (normalized.includes('政策') || normalized.includes('意见') || normalized.includes('办法') || normalized.includes('通知')) return 'policy-document';
  return 'other';
}

export function parseFederalRegister(payload, observedAt = Date.now()) {
  return (payload?.results || []).flatMap((item) => {
    const publishedAt = parseIsoDate(item.publication_date, 'America/New_York');
    if (!item.title || publishedAt === null || !item.html_url) return [];
    const type = Array.isArray(item.type) ? item.type.join(' ') : item.type;
    return [officialRelease({
      releaseId: String(item.document_number || item.html_url).slice(0, 512), country: 'US',
      authority: (item.agencies || []).map((agency) => agency.name).filter(Boolean).join('; ') || 'Federal Register',
      documentType: documentTypeFrom(type), title: text(item.title), publishedAt,
      timePrecision: 'date',
      effectiveAt: parseIsoDate(item.effective_on, 'America/New_York'),
      documentNumber: item.document_number ? String(item.document_number) : null,
      sourceUrl: item.html_url,
    }, observedAt)];
  });
}

export function parseWhiteHouse(html, observedAt = Date.now()) {
  return [...String(html).matchAll(/<li\b[^>]*class=["'][^"']*wp-block-post[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi)].flatMap((match) => {
    const href = match[1].match(/wp-block-post-title[\s\S]*?<a[^>]+href=["']([^"']+)/i)?.[1];
    const title = text(match[1].match(/wp-block-post-title[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] || '');
    const category = text(match[1].match(/taxonomy-category[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] || '');
    const date = match[1].match(/<time[^>]+datetime=["']([^"']+)/i)?.[1];
    const publishedAt = date ? Date.parse(date) : Number.NaN;
    if (!href || !title || !Number.isFinite(publishedAt)) return [];
    return [officialRelease({
      releaseId: href.slice(0, 512), country: 'US', authority: 'The White House',
      documentType: documentTypeFrom(category || href), title, publishedAt,
      timePrecision: /T\d{2}:\d{2}/.test(date) ? 'exact' : 'date', sourceUrl: absoluteUrl(href, URLS.whiteHouse),
    }, observedAt)];
  });
}

export function parseFedRss(xml, observedAt = Date.now(), sourceUrl = URLS.fedMonetary) {
  return [...String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].flatMap((match) => {
    const title = text(match[1].match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
    const link = text(match[1].match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1] || '');
    const date = text(match[1].match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i)?.[1] || '');
    const category = text(match[1].match(/<category[^>]*>([\s\S]*?)<\/category>/i)?.[1] || '');
    const publishedAt = Date.parse(date);
    if (!title || !link || !Number.isFinite(publishedAt)) return [];
    return [officialRelease({
      releaseId: link.slice(0, 512), country: 'US', authority: 'Federal Reserve Board',
      documentType: documentTypeFrom(`${category} ${title}`), title, publishedAt,
      sourceUrl: absoluteUrl(link, sourceUrl),
    }, observedAt)];
  });
}

export function parseGovCn(payload, observedAt = Date.now()) {
  const groups = payload?.searchVO?.catMap || {};
  const rows = ['gongwen', 'bumenfile'].flatMap((key) => groups[key]?.listVO || []);
  const seen = new Set();
  return rows.flatMap((item) => {
    if (!item?.url || !item?.title || seen.has(item.url)) return [];
    seen.add(item.url);
    const publishedAt = Number(item.pubtime) || parseIsoDate(item.pubtimeStr, 'Asia/Shanghai');
    if (!Number.isFinite(publishedAt)) return [];
    return [officialRelease({
      releaseId: String(item.id || item.url).slice(0, 512), country: 'CN', authority: text(item.puborg || '中国政府网'),
      documentType: documentTypeFrom(`${item.wjlx || ''} ${item.pcode || ''} ${item.title}`), title: text(item.title),
      publishedAt, timePrecision: 'date', documentNumber: text(item.pcode || item.wenhao || '') || null, sourceUrl: item.url,
    }, observedAt)];
  });
}

export function parseGovNews(payload, observedAt = Date.now()) {
  const rows = Array.isArray(payload) ? payload : [];
  const seen = new Set();
  return rows.flatMap((item) => {
    const title = text(item?.TITLE || item?.title || '');
    const rawUrl = item?.URL || item?.url || '';
    const sourceUrl = absoluteUrl(rawUrl, URLS.govNews);
    const isMeeting = /中共中央政治局召开会议|国务院(?:常务会议|全体会议|专题学习)|国务院党组会议/.test(title);
    if (!rawUrl || !isMeeting || !/^https:\/\/www\.gov\.cn\//i.test(sourceUrl) || seen.has(sourceUrl)) return [];
    const publishedAt = parseIsoDate(item?.DOCRELPUBTIME || item?.pubtime || '', 'Asia/Shanghai');
    if (publishedAt === null) return [];
    seen.add(sourceUrl);
    const authority = title.includes('中共中央政治局') ? '中共中央政治局' : '国务院';
    return [officialRelease({
      releaseId: sourceUrl.slice(0, 512), country: 'CN', authority,
      documentType: 'press-release', title, publishedAt, timePrecision: 'date', sourceUrl,
    }, observedAt)];
  });
}

export function parsePboc(html, observedAt = Date.now()) {
  return [...String(html).matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].flatMap((match) => {
    const anchor = match[1].match(/<a[^>]+href=["']([^"']+)["'][^>]*(?:title=["']([^"']*)["'])?[^>]*>([\s\S]*?)<\/a>/i);
    const date = match[1].match(/class=["']hui12["'][^>]*>\s*(\d{4}-\d{2}-\d{2})/i)?.[1];
    if (!anchor || !date || !/\/goutongjiaoliu\//.test(anchor[1])) return [];
    const title = text(anchor[2] || anchor[3]);
    const sourceUrl = absoluteUrl(anchor[1], URLS.pboc);
    const publishedAt = parseIsoDate(date, 'Asia/Shanghai');
    if (!title || publishedAt === null) return [];
    return [officialRelease({
      releaseId: sourceUrl.slice(0, 512), country: 'CN', authority: '中国人民银行',
      documentType: documentTypeFrom(title), title, publishedAt, timePrecision: 'date', sourceUrl,
    }, observedAt)];
  });
}

async function responseText(response) {
  if (!response?.ok) throw new Error(`HTTP ${response?.status || 'unavailable'}`);
  return response.text();
}

async function limitedDetailText(response) {
  if (!response?.ok) throw new Error(`HTTP ${response?.status || 'unavailable'}`);
  const length = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(length) && length > DETAIL_RAW_BYTE_LIMIT) throw new Error('官方详情页超过读取大小限制');
  const value = await response.text();
  const clipped = utf8Clip(value, DETAIL_RAW_BYTE_LIMIT);
  return clipped.value;
}

export function createOfficialSourcesClient(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const now = options.now || (() => Date.now());
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (typeof fetchImpl !== 'function') throw new TypeError('official sources require fetch');

  async function request(url, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, {
        ...init,
        signal: controller.signal,
        headers: {
          accept: init.accept || 'text/html,application/xhtml+xml,application/json,text/calendar,application/xml;q=0.9,*/*;q=0.8',
          'user-agent': 'AI-Center/0.2 (local official-source reader)',
          ...(init.headers || {}),
        },
      });
    } finally { clearTimeout(timer); }
  }

  async function federalRegisterDetail(sourceUrl, observedAt) {
    const documentNumber = new URL(sourceUrl).pathname.match(/\/(20\d{2}-\d+)(?:\/|$)/)?.[1];
    if (!documentNumber) return null;
    const apiUrl = `https://www.federalregister.gov/api/v1/documents/${documentNumber}.json`;
    const response = await request(apiUrl, { accept: 'application/json' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    let rawBody = '';
    if (payload.raw_text_url) {
      const rawUrl = officialDetailUrl(payload.raw_text_url);
      const rawResponse = await request(rawUrl, { accept: 'text/plain,*/*;q=0.5' });
      if (rawResponse.url) officialDetailUrl(rawResponse.url);
      rawBody = await limitedDetailText(rawResponse);
    }
    const summaryClip = utf8Clip(text(payload.abstract || ''), DETAIL_SUMMARY_BYTE_LIMIT);
    const bodyClip = utf8Clip(text(rawBody), DETAIL_BODY_BYTE_LIMIT);
    const publishedAt = Date.parse(String(payload.publication_date || ''));
    return {
      available: Boolean(payload.title || summaryClip.value || bodyClip.value),
      sourceUrl,
      title: utf8Clip(text(payload.title || ''), 4 * 1024).value,
      officialSummary: summaryClip.value,
      bodyText: bodyClip.value,
      publishedAt: Number.isFinite(publishedAt) ? publishedAt : null,
      observedAt,
      truncated: summaryClip.truncated || bodyClip.truncated,
      note: '',
    };
  }

  async function calendar(sourceUrl, input, loader, note = '') {
    const observedAt = now();
    const events = selectEvents(await loader(observedAt), input, observedAt);
    return { available: true, observedAt, sourceUrl, events, note };
  }

  async function releases(sourceUrl, input, loader) {
    const observedAt = now();
    const result = selectReleases(await loader(observedAt), input);
    return { available: true, observedAt, sourceUrl, releases: result, note: '' };
  }

  function requestedCalendarYear(input, observedAt) {
    const { from } = sourceRange(input, observedAt);
    return new Date(from).getUTCFullYear();
  }

  function calendarLinks(html, baseUrl) {
    return [...String(html).matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
      .map((match) => ({ href: absoluteUrl(match[1], baseUrl), title: text(match[2]) }));
  }

  return Object.freeze({
    urls: URLS,
    async detail(input) {
      const sourceUrl = officialDetailUrl(input?.sourceUrl);
      const observedAt = now();
      if (new URL(sourceUrl).hostname.endsWith('federalregister.gov')) {
        const detail = await federalRegisterDetail(sourceUrl, observedAt);
        if (detail) return detail;
      }
      const response = await request(sourceUrl, { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' });
      if (response.url) officialDetailUrl(response.url);
      return extractOfficialSourceDetail(await limitedDetailText(response), response.url || sourceUrl, observedAt);
    },
    bls(input) { return calendar(URLS.bls, input, async (at) => parseBlsIcs(await responseText(await request(URLS.bls)), at)); },
    bea(input) { return calendar(URLS.bea, input, async (at) => parseBeaCalendar(await responseText(await request(URLS.bea)), at)); },
    census(input) { return calendar(URLS.census, input, async (at) => parseCensusCalendar(await responseText(await request(URLS.census)), at)); },
    async ism(input) {
      const observedAt = now();
      try {
        const parsed = parseIsmCalendar(await responseText(await request(URLS.ism)), observedAt);
        if (parsed.length) return { available: true, observedAt, sourceUrl: URLS.ism, events: selectEvents(parsed, input, observedAt), note: '' };
      } catch { /* Official rule fallback below. */ }
      return {
        available: true, observedAt, sourceUrl: URLS.ism,
        events: selectEvents(generateIsmRuleEvents(input, observedAt), input, observedAt),
        note: '年度表暂不可读取；当前条目按官网公布的第一/第三个工作日规则生成，并标记为 tentative。',
      };
    },
    async dolClaims(input) {
      const observedAt = now();
      let note = '按劳工部公布的每周四 8:30 ET 规则生成；节假日例外需以官方页面复核。';
      try { await responseText(await request(URLS.dolClaims)); } catch { note = `官方页面暂不可读取；${note}`; }
      return { available: true, observedAt, sourceUrl: URLS.dolClaims, events: selectEvents(generateDolClaimsEvents(input, observedAt), input, observedAt), note };
    },
    async nbs(input) {
      const observedAt = now();
      const year = requestedCalendarYear(input, observedAt);
      const knownUrl = NBS_YEAR_URLS[year];
      const listing = knownUrl ? '' : await responseText(await request(URLS.nbs));
      const link = knownUrl ? null : calendarLinks(listing, URLS.nbs).find((item) => (
        item.title.includes(`${year}年`) && /统计信息发布日程/.test(item.title)
      ));
      const sourceUrl = knownUrl || link?.href || URLS.nbs;
      const html = knownUrl || link ? await responseText(await request(sourceUrl)) : listing;
      return {
        available: true, observedAt, sourceUrl,
        events: selectEvents(parseNbsCalendar(html, observedAt, sourceUrl), input, observedAt),
        note: knownUrl || link ? '' : `未找到 ${year} 年具体日程页，当前使用国家统计局日程入口。`,
      };
    },
    async customs(input) {
      const observedAt = now();
      const year = requestedCalendarYear(input, observedAt);
      const listing = await responseText(await request(URLS.customs));
      const links = calendarLinks(listing, URLS.customs)
        .filter((item) => /release\s+cal[ea]ndar/i.test(item.title));
      const link = links.find((item) => new RegExp(`\\b${year}\\b`).test(item.title));
      if (!link) {
        return {
          available: false, observedAt, sourceUrl: URLS.customs, events: [],
          note: `海关总署官方页面尚未提供 ${year} 年发布日历；未按往年规律推算。`,
        };
      }
      const html = await responseText(await request(link.href));
      const events = selectEvents(parseCustomsCalendar(html, observedAt, link.href), input, observedAt);
      return {
        available: events.length > 0, observedAt, sourceUrl: link.href, events,
        note: events.length ? '' : `${year} 年官方日历页未解析到日程条目。`,
      };
    },
    scio(input) { return calendar(URLS.scio, input, async (at) => parseScioCalendar(await responseText(await request(URLS.scio)), at)); },
    async fedCalendar(input) {
      const observedAt = now();
      const { from, to } = sourceRange(input, observedAt);
      const cursor = new Date(Date.UTC(new Date(from).getUTCFullYear(), new Date(from).getUTCMonth(), 1));
      const last = new Date(Date.UTC(new Date(to).getUTCFullYear(), new Date(to).getUTCMonth(), 1));
      const pages = [];
      while (cursor <= last && pages.length < 18) {
        pages.push({ year: cursor.getUTCFullYear(), month: cursor.getUTCMonth() + 1 });
        cursor.setUTCMonth(cursor.getUTCMonth() + 1);
      }
      const batches = await Promise.all(pages.map(async ({ year, month }) => {
        const url = monthPageUrl(year, month);
        try { return parseFedMonthCalendar(await responseText(await request(url)), year, month, observedAt, url); } catch { return []; }
      }));
      const events = selectEvents(batches.flat(), input, observedAt);
      return { available: events.length > 0, observedAt, sourceUrl: URLS.fedCalendar, events, note: events.length ? '' : '所选时间范围未读取到 Fed 日程。' };
    },
    fomc(input) { return calendar(URLS.fomc, input, async (at) => parseFomcCalendar(await responseText(await request(URLS.fomc)), at)); },
    lpr(input) {
      const observedAt = now();
      return Promise.resolve({
        available: true, observedAt, sourceUrl: URLS.lprRule,
        events: selectEvents(generateLprRuleEvents(input, observedAt), input, observedAt),
        note: '按央行公布的每月 20 日 9:30、遇节假日顺延规则生成；条目均标记为 tentative。',
      });
    },
    federalRegister(input) {
      return releases(URLS.federalRegister, input, async (at) => {
        const limit = Math.min(Math.max(Number(input?.limit) || 50, 1), 100);
        const params = new URLSearchParams({ per_page: String(limit), order: 'newest' });
        const response = await request(`${URLS.federalRegister}?${params}`, { accept: 'application/json' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return parseFederalRegister(await response.json(), at);
      });
    },
    whiteHouse(input) { return releases(URLS.whiteHouse, input, async (at) => parseWhiteHouse(await responseText(await request(URLS.whiteHouse)), at)); },
    fedReleases(input) {
      return releases(URLS.fedMonetary, input, async (at) => {
        const feeds = await Promise.all([URLS.fedMonetary, URLS.fedSpeeches, URLS.fedBoardMeetings]
          .map(async (url) => parseFedRss(await responseText(await request(url)), at, url)));
        return feeds.flat();
      });
    },
    govCn(input) {
      return releases('https://sousuo.www.gov.cn/zcwjk/policyDocumentLibrary', input, async (at) => {
        const params = new URLSearchParams({
          t: 'zhengcelibrary', q: '', timetype: '', mintime: '', maxtime: '', sort: 'score', sortType: '1',
          searchfield: 'title', p: '1', n: String(Math.min(Math.max(Number(input?.limit) || 50, 5), 100)), type: 'gwyzcwjk',
        });
        const response = await request(`${URLS.govCn}?${params}`, { accept: 'application/json' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return parseGovCn(await response.json(), at);
      });
    },
    govNews(input) {
      return releases(URLS.govNews, input, async (at) => {
        const response = await request(URLS.govNews, { accept: 'application/json' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return parseGovNews(await response.json(), at);
      });
    },
    pboc(input) { return releases(URLS.pboc, input, async (at) => parsePboc(await responseText(await request(URLS.pboc)), at)); },
  });
}

export { URLS as OFFICIAL_SOURCE_URLS };
