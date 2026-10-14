import { zonedCalendarParts, zonedClockParts } from './shanghai-time.js?v=dev';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ZONE = 'Asia/Shanghai';

export const HOME_QUOTE_PRIORITY = {
  cn: ['000016.SS', '399673.SZ', '000688.SS', '^HSI'],
  us: ['^GSPC', '^IXIC', '^DJI', '^VIX'],
};

const HOME_QUOTE_NAMES = {
  '000016.SS': '上证50',
  '399673.SZ': '创业板50',
  '000688.SS': '科创50',
  '^HSI': '恒生指数',
  '^GSPC': '标普 500',
  '^IXIC': '纳斯达克',
  '^DJI': '道琼斯',
  '^VIX': 'VIX 恐慌',
};

export const HOME_QUOTE_CAPTION = {
  cn: 'A股 / 港股 · 工作日 05:00–17:00',
  us: '美股 · 北京时间 17:00–次日 05:00 及周末',
};

export const HOME_VISIBLE_HOURS = { wide: 4, narrow: 3 };
export const HOME_RECENT_EDITION_HOURS = 48;

export function shanghaiParts(nowMs) {
  const date = zonedCalendarParts(nowMs, ZONE);
  const clock = zonedClockParts(nowMs, ZONE);
  return {
    year: date.year,
    month: date.month,
    day: date.day,
    hour: String(clock.hour).padStart(2, '0'),
    minute: String(clock.minute).padStart(2, '0'),
    weekday: date.weekday,
  };
}

export function shanghaiMidnight(nowMs) {
  const parts = shanghaiParts(nowMs);
  return Date.UTC(parts.year, parts.month - 1, parts.day) - 8 * HOUR;
}

export function shanghaiHourStart(nowMs) {
  return shanghaiMidnight(nowMs) + Number(shanghaiParts(nowMs).hour) * HOUR;
}

export function shanghaiHourLabel(nowMs) {
  const parts = shanghaiParts(nowMs);
  return { hour: parts.hour, hhmm: `${parts.hour}:${parts.minute}`, hourText: `${parts.hour}:00` };
}

export function preferredOverviewFocus(nowMs = Date.now()) {
  const parts = shanghaiParts(nowMs);
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  if (parts.weekday !== 'Sat' && parts.weekday !== 'Sun' && minutes >= 5 * 60 && minutes < 17 * 60) return 'cn';
  return 'us';
}

export function reportHourHref(startAt) {
  return `#report?hour=${shanghaiHourLabel(startAt).hour}`;
}

export function pickHomeQuoteCards({ focus, indices = [], sectionIndices = [] } = {}) {
  const priority = HOME_QUOTE_PRIORITY[focus] || HOME_QUOTE_PRIORITY.us;
  const live = (indices || []).filter((item) => item?.symbol);
  const section = (sectionIndices?.length ? sectionIndices : live).filter((item) => item?.symbol);
  if (!live.length && !section.length) {
    return priority.map((symbol) => ({
      symbol,
      name: HOME_QUOTE_NAMES[symbol] || symbol,
      lastPrice: null,
      changePct: null,
    }));
  }
  const bySymbol = new Map();
  for (const item of [...section, ...live]) bySymbol.set(item.symbol, item);
  const picked = [];
  const used = new Set();
  for (const symbol of priority) {
    const found = bySymbol.get(symbol);
    if (!found) continue;
    picked.push(found);
    used.add(symbol);
    if (picked.length >= 4) return picked;
  }
  for (const item of section) {
    if (picked.length >= 4) break;
    if (used.has(item.symbol)) continue;
    picked.push(item);
    used.add(item.symbol);
  }
  return picked.slice(0, 4);
}

export function marketPayloadHasQuotes(payload) {
  if (Array.isArray(payload)) return payload.some((item) => item && item.lastPrice != null);
  if (!payload || typeof payload !== 'object') return false;
  const rows = [
    ...(payload.indices || []),
    ...(payload.watchlist || []),
    ...((payload.sections || []).flatMap((section) => [
      ...(section?.indices || []),
      ...(section?.gainers || []),
      ...(section?.losers || []),
    ])),
  ];
  return rows.some((item) => item && item.lastPrice != null);
}

export function acceptMarketPayload(previous, incoming) {
  if (marketPayloadHasQuotes(previous) && !marketPayloadHasQuotes(incoming)) return previous;
  return incoming;
}

export function quoteStatusText({ cards = [], fetchedAt, error = false, pending = false, slow = false } = {}) {
  const live = cards.some((item) => item?.lastPrice != null);
  if (error && !live) return { kind: 'error', text: '行情暂不可用 · 重试' };
  if (!live && (slow || (pending && slow))) return { kind: 'slow', text: '读取较慢 · 重试' };
  if (!live && pending) return { kind: 'loading', text: '' };
  if (live || fetchedAt) return { kind: 'ready', text: '' };
  return { kind: 'loading', text: '' };
}

export function homeEditionNote(startAt, endAt, nowMs = Date.now()) {
  const clock = (at) => {
    const parts = shanghaiParts(at);
    return `${parts.hour}:${parts.minute}`;
  };
  const range = `${clock(startAt)}–${clock(endAt)}`;
  const start = shanghaiParts(startAt);
  const end = shanghaiParts(endAt);
  const today = shanghaiParts(nowMs);
  const sameDay = (left, right) => left.year === right.year && left.month === right.month && left.day === right.day;
  if (sameDay(start, today) && sameDay(start, end)) return range;
  return `${start.month}月${start.day}日 · ${range}`;
}

const HOUR_LIST_FUTURE_SLACK_MS = 2 * 60 * 1000;

function positiveAt(value) {
  const at = Number(value);
  return Number.isFinite(at) && at > 0 ? at : 0;
}

export function homeHourItemTime(item, now = Date.now()) {
  const published = positiveAt(item?.publishedAt);
  const ingested = positiveAt(item?.firstIngestedAt) || positiveAt(item?.eventAt);
  const clock = positiveAt(now);
  const within = (at) => at > 0 && (!clock || at <= clock + HOUR_LIST_FUTURE_SLACK_MS);
  const clamp = (at) => (clock && at > clock ? clock : at);
  if (within(published)) return clamp(published);
  if (published > 0) {
    if (within(ingested)) return clamp(ingested);
    return clock || ingested || published;
  }
  if (within(ingested)) return clamp(ingested);
  return clock && ingested ? Math.min(ingested, clock) : ingested;
}

export function selectHomeHourHits(snapshot) {
  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
  return items
    .filter((item) => item?.readingDirectionName && item.readingDirectionName !== '待分类' && item.disposition === 'hit' && item.timely !== false)
    .sort((left, right) => homeHourItemTime(right) - homeHourItemTime(left)
      || String(left?.nodeId || left?.title || '').localeCompare(String(right?.nodeId || right?.title || '')));
}

export function homeReadingReady(snapshot) {
  return Array.isArray(snapshot?.items) && snapshot.missing !== true;
}

export function homeHourSections({ editions = [], readings = {}, sectionLimit = 4, nowMs = Date.now() } = {}) {
  const sections = [];
  const cap = Math.max(1, Number(sectionLimit) || 4);
  const list = (editions || []).filter((edition) => Number.isFinite(Number(edition?.window?.startAt)));
  const usable = list.filter((edition) => homeReadingReady(readings[Number(edition.window.startAt)]));
  if (!usable.length) return sections;
  const anchor = Number(usable[0].window.startAt);
  for (const edition of usable) {
    const startAt = Number(edition.window.startAt);
    const endAt = Number(edition.window.endAt);
    const snapshot = readings[startAt];
    const items = selectHomeHourHits(snapshot).slice(0, sections.length === 0 ? 5 : 2);
    if (!items.length && startAt !== anchor) continue;
    sections.push({
      startAt,
      endAt,
      label: homeEditionNote(startAt, endAt, nowMs),
      items,
    });
    if (sections.length >= cap) break;
  }
  return sections;
}

export function homeRequestPlan(nowMs = Date.now()) {
  const end = shanghaiHourStart(nowMs) + HOUR;
  const from = end - HOME_RECENT_EDITION_HOURS * HOUR;
  const boardFrom = shanghaiMidnight(nowMs);
  const boardTo = nowMs + DAY;
  const tree = `/api/v1/reports/tree?view=index&startAt=${from}&endAt=${end}`;
  const readingIndex = `/api/v1/reports/reading-hour/index?startAt=${from}&endAt=${end}&scope=hour`;
  const market = '/api/v1/markets?board=overview';
  const daily = '/api/v1/reports/daily/latest/brief';
  const board = `/api/v1/static-signals/board?from=${boardFrom}&to=${boardTo}&focus=1&limit=40&releaseLimit=60`;
  return {
    tree,
    readingIndex,
    market,
    daily,
    board,
    parallel: [tree, readingIndex, market, daily],
    readingHour(startAt, endAt) {
      return `/api/v1/reports/reading-hour?startAt=${startAt}&endAt=${endAt}&scope=hour`;
    },
  };
}

export function hourlyEditions(tree) {
  const editions = [];
  const seen = new Set();
  for (const row of tree?.hours || []) {
    const edition = row?.edition || row?.attempt || (row?.window ? row : null);
    const startAt = Number(edition?.window?.startAt);
    if (!edition?.window || !Number.isFinite(startAt) || seen.has(startAt)) continue;
    seen.add(startAt);
    editions.push(edition);
  }
  return editions.sort((left, right) => right.window.startAt - left.window.startAt);
}

export function readingTitles(snapshot, limit = 5) {
  if (!snapshot || typeof snapshot !== 'object') return [];
  const items = Array.isArray(snapshot.items) ? snapshot.items : [];
  const hits = items.filter((item) => item?.disposition === 'hit' || (Array.isArray(item?.hits) && item.hits.length));
  const pool = (hits.length ? hits : items).map((item) => String(item?.title || '').trim()).filter(Boolean);
  const headline = String(snapshot.headline?.title || snapshot.title || snapshot.firstTitle || '').trim();
  const titles = [];
  const seen = new Set();
  for (const text of [...pool, headline]) {
    if (!text || seen.has(text)) continue;
    seen.add(text);
    titles.push(text);
    if (titles.length >= limit) break;
  }
  return titles;
}

export function readingSummary(snapshot) {
  const titles = readingTitles(snapshot, 5);
  if (!titles.length) return null;
  const items = Array.isArray(snapshot.items) ? snapshot.items : [];
  const hits = items.filter((item) => item?.disposition === 'hit' || (Array.isArray(item?.hits) && item.hits.length));
  const count = Number.isFinite(Number(snapshot.selected))
    ? Number(snapshot.selected)
    : Number.isFinite(Number(snapshot.hitCount))
      ? Number(snapshot.hitCount)
      : (items.length ? hits.length : null);
  return { count, lead: titles[0], preview: titles.slice(0, 3), titles };
}

export function absorbReadingIndex(payload) {
  const rows = payload?.hours || payload?.snapshots || payload?.items || payload?.index || [];
  const map = {};
  if (!Array.isArray(rows)) return map;
  for (const row of rows) {
    const window = row?.window || row?.snapshot?.window || {};
    const startAt = Number(row?.startAt ?? window.startAt);
    if (!Number.isFinite(startAt)) continue;
    map[startAt] = row?.snapshot || row;
  }
  return map;
}

export function mergeReadingHours(current = {}, incoming = {}) {
  const next = { ...current };
  for (const [key, row] of Object.entries(incoming || {})) {
    const prior = next[key];
    if (prior && Array.isArray(prior.items) && !Array.isArray(row?.items)) {
      next[key] = { ...row, ...prior, items: prior.items };
      continue;
    }
    next[key] = row;
  }
  return next;
}

export function foldOfficialByHour(releases) {
  const groups = new Map();
  for (const release of releases || []) {
    const at = Number(release?.publishedAt);
    if (!Number.isFinite(at)) continue;
    const startAt = shanghaiHourStart(at);
    if (!groups.has(startAt)) groups.set(startAt, []);
    groups.get(startAt).push(release);
  }
  return [...groups.entries()].sort((left, right) => right[0] - left[0]).map(([startAt, items]) => {
    const counts = new Map();
    for (const item of items) {
      const name = item.authority || item.sourceTitle || '官方';
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    const sources = [...counts.entries()].map(([name, count]) => ({ name, count }));
    return {
      startAt,
      items,
      sources,
      text: `官方 · ${sources.map((source) => `${source.name} ${source.count} 条`).join(' · ')}`,
    };
  });
}

export function nextEvents(events, nowMs, limit = 2) {
  const end = nowMs + DAY;
  return (events || [])
    .filter((event) => Number.isFinite(Number(event?.scheduledAt)) && event.scheduledAt > nowMs && event.scheduledAt <= end)
    .sort((left, right) => left.scheduledAt - right.scheduledAt || String(left.title || '').localeCompare(String(right.title || '')))
    .slice(0, limit);
}

export function hourCoverage({ editions = [], nowMs }) {
  const midnight = shanghaiMidnight(nowMs);
  const currentHour = shanghaiHourStart(nowMs);
  const expectedStart = currentHour - HOUR;
  if (expectedStart < midnight) return { delay: null, gaps: [], expectedStart: null };
  const present = new Set(editions.map((edition) => edition.window.startAt));
  const missing = [];
  for (let at = midnight; at <= expectedStart; at += HOUR) {
    if (!present.has(at)) missing.push(at);
  }
  const gaps = [];
  let group = [];
  const flush = () => {
    if (!group.length) return;
    const first = group[0];
    const last = group[group.length - 1];
    gaps.push({
      startAt: first,
      endAt: last + HOUR,
      count: group.length,
      text: `${shanghaiHourLabel(first).hourText}–${shanghaiHourLabel(last + HOUR).hourText}`,
    });
    group = [];
  };
  for (const at of missing) {
    if (group.length && at - group[group.length - 1] !== HOUR) flush();
    group.push(at);
  }
  flush();
  const latest = editions.map((edition) => edition.window.startAt).filter((at) => at <= expectedStart).sort((left, right) => right - left)[0];
  const delay = latest != null && latest < expectedStart
    ? {
      latest,
      hours: Math.round((expectedStart - latest) / HOUR),
    }
    : null;
  return { delay, gaps, expectedStart };
}

export function visibleHourGaps(coverage, shown) {
  if (!shown.length) return coverage.gaps;
  const oldest = Math.min(...shown.map((edition) => edition.window.startAt));
  return coverage.gaps
    .map((gap) => {
      const startAt = Math.max(gap.startAt, oldest);
      if (gap.endAt <= startAt) return null;
      const count = Math.round((gap.endAt - startAt) / HOUR);
      if (count <= 0) return null;
      return {
        startAt,
        endAt: gap.endAt,
        count,
        text: `${shanghaiHourLabel(startAt).hourText}–${shanghaiHourLabel(gap.endAt).hourText}`,
      };
    })
    .filter(Boolean);
}

export const CHRONIC_UNAVAILABLE_MS = 24 * 60 * 60 * 1000;
const CHRONIC_SOURCE_FALLBACK = new Set(['calendar.cn.customs', 'calendar.us.bls', 'calendar.us.census']);

function freshOfficialUnavailable(item, nowMs) {
  if (item?.status !== 'unavailable') return false;
  const since = Number(item?.failingSince);
  if (Number.isFinite(since) && since > 0) return nowMs - since <= CHRONIC_UNAVAILABLE_MS;
  return !CHRONIC_SOURCE_FALLBACK.has(item?.sourceId);
}

export function unavailableOfficialCount(health, nowMs = Date.now()) {
  return (health || []).filter((item) => freshOfficialUnavailable(item, nowMs)).length;
}

export function buildHomeTimelineModel({
  nowMs,
  editions = [],
  readings = {},
  releases = [],
  upcoming = [],
  earlier = false,
  narrow = false,
  treeStatus = 'loading',
  boardStatus = 'loading',
} = {}) {
  const limit = narrow ? HOME_VISIBLE_HOURS.narrow : HOME_VISIBLE_HOURS.wide;
  const sorted = [];
  const seenStart = new Set();
  for (const edition of [...editions].sort((left, right) => right.window.startAt - left.window.startAt)) {
    const startAt = Number(edition?.window?.startAt);
    if (!Number.isFinite(startAt) || seenStart.has(startAt)) continue;
    seenStart.add(startAt);
    sorted.push(edition);
  }
  const shown = earlier ? sorted : sorted.slice(0, limit);
  const verified = treeStatus === 'ready';
  const coverage = verified ? hourCoverage({ editions: sorted, nowMs }) : { delay: null, gaps: [] };
  const gaps = verified ? visibleHourGaps(coverage, shown.length ? shown : sorted) : [];
  const official = foldOfficialByHour(releases);
  const officialByStart = new Map(official.map((group) => [group.startAt, group]));
  const latest = sorted[0] || null;
  const readingsPending = shown.some((edition) => !Array.isArray(readings[edition.window.startAt]?.items));
  const hours = shown.map((edition, index) => {
    const startAt = edition.window.startAt;
    const clock = shanghaiHourLabel(startAt);
    const snapshot = readings[startAt];
    const ready = Array.isArray(snapshot?.items);
    const summary = ready ? readingSummary(snapshot) : null;
    const titles = ready ? readingTitles(snapshot, index === 0 ? 5 : 2) : [];
    return {
      startAt,
      endAt: edition.window.endAt,
      label: clock.hourText,
      href: `#report?hour=${clock.hour}`,
      lead: titles[0] || '',
      titles,
      hitCount: summary && Number.isFinite(summary.count) ? summary.count : null,
      official: officialByStart.get(startAt) || null,
    };
  }).filter((hour) => hour.titles.length > 0);
  return {
    header: '今天',
    latestText: latest ? `最新小时报 ${shanghaiHourLabel(latest.window.startAt).hourText}` : '',
    briefHref: latest ? reportHourHref(latest.window.startAt) : '#report',
    nowText: `现在 ${shanghaiHourLabel(nowMs).hhmm}`,
    statusText: '',
    events: nextEvents(upcoming, nowMs, 2),
    delay: coverage.delay,
    gaps,
    earlierCount: earlier ? 0 : Math.max(sorted.length - limit, 0),
    treeStatus,
    boardStatus,
    readingsPending,
    hours,
  };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function retryButton(text, onRetry) {
  const button = el('button', 'text-button', text);
  button.type = 'button';
  button.addEventListener('click', onRetry);
  return button;
}

export function renderHomeTimeline(root, model, handlers = {}) {
  if (!root || !model) return;
  root.replaceChildren();
  const head = el('div', 'home-timeline-head');
  head.append(el('h2', '', model.header || '今天'));
  if (model.latestText) head.append(el('span', 'home-latest', model.latestText));
  const brief = el('a', 'text-button', '完整简报 ›');
  brief.href = model.briefHref;
  head.append(brief);
  root.append(head);
  if (model.statusText) root.append(el('p', 'home-status-line', model.statusText));

  if (model.treeStatus === 'error') {
    const retry = retryButton('小时报读取失败 · 重试', handlers.onRetry);
    retry.classList.add('home-reading-retry');
    root.append(retry);
  } else if (model.treeStatus === 'slow' && !model.hours.length) {
    const retry = retryButton('读取较慢 · 重试', handlers.onRetry);
    retry.classList.add('home-reading-retry');
    root.append(retry);
  }

  if (model.events.length || model.boardStatus === 'error' || model.boardStatus === 'slow') {
    root.append(el('p', 'home-kicker', '接下来'));
  }
  if (model.boardStatus === 'error') root.append(retryButton('日程读取失败 · 重试', handlers.onRetryBoard));
  else if (model.boardStatus === 'slow' && !model.events.length) root.append(retryButton('读取较慢 · 重试', handlers.onRetryBoard));
  for (const event of model.events) {
    const row = el('div', 'home-row');
    row.append(el('i', 'home-dot'));
    const copy = el('div', 'home-copy');
    const open = el('button', 'home-title', event.title || '日程');
    open.type = 'button';
    open.addEventListener('click', () => handlers.onEvent?.(event));
    copy.append(open);
    if (Number.isFinite(Number(event.scheduledAt))) {
      copy.append(el('p', 'home-meta', shanghaiHourLabel(event.scheduledAt).hhmm));
    }
    row.append(copy);
    root.append(row);
  }

  const now = el('div', 'home-now');
  now.append(el('span', 'home-now-label', model.nowText));
  const rule = el('i', 'home-now-rule');
  rule.setAttribute('aria-hidden', 'true');
  now.append(rule);
  root.append(now);

  if ((model.treeStatus === 'loading' || model.readingsPending) && !model.hours.length) {
    const skeleton = el('div', 'home-timeline-skeleton');
    skeleton.setAttribute('aria-busy', 'true');
    skeleton.append(el('span', ''), el('span', ''), el('span', ''));
    root.append(skeleton);
  }

  const rail = el('div', 'home-rail');
  for (const hour of model.hours) {
    const row = el('div', 'home-row');
    row.append(el('i', 'home-dot is-hour'));
    const copy = el('div', 'home-copy');
    copy.append(el('time', 'home-meta', hour.label));
    for (const text of hour.titles) {
      const link = el('a', 'home-title', text);
      link.href = hour.href;
      copy.append(link);
    }
    if (hour.official?.text) copy.append(el('p', 'home-official', hour.official.text));
    row.append(copy);
    rail.append(row);
  }
  if (rail.childElementCount) root.append(rail);

  if (model.earlierCount > 0) {
    const earlier = el('button', 'text-button home-earlier', `更早 ${model.earlierCount} 期 ›`);
    earlier.type = 'button';
    earlier.addEventListener('click', () => handlers.onEarlier?.());
    root.append(earlier);
  }
}
