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

export function shanghaiParts(nowMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(new Date(nowMs));
  const read = (type) => parts.find((part) => part.type === type)?.value || '';
  return {
    year: Number(read('year')),
    month: Number(read('month')),
    day: Number(read('day')),
    hour: read('hour').padStart(2, '0'),
    minute: read('minute').padStart(2, '0'),
    weekday: read('weekday'),
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

export function quoteStatusText({ cards = [], fetchedAt, error = false, pending = false, slow = false } = {}) {
  const live = cards.some((item) => item?.lastPrice != null);
  if (error && !live) return { kind: 'error', text: '行情暂不可用 · 重试' };
  if (!live && (slow || (pending && slow))) return { kind: 'slow', text: '读取较慢 · 重试' };
  if (!live && pending) return { kind: 'loading', text: '' };
  if (live || fetchedAt) return { kind: 'ready', text: '' };
  return { kind: 'loading', text: '' };
}

export function homeRequestPlan(nowMs = Date.now()) {
  const from = shanghaiMidnight(nowMs);
  const dayEnd = from + DAY;
  const boardTo = nowMs + DAY;
  const tree = `/api/v1/reports/tree?view=index&startAt=${from}&endAt=${dayEnd}`;
  const readingIndex = `/api/v1/reports/reading-hour/index?startAt=${from}&endAt=${dayEnd}&scope=hour`;
  const market = '/api/v1/markets?board=overview';
  const daily = '/api/v1/reports/daily/latest/brief';
  const board = `/api/v1/static-signals/board?from=${from}&to=${boardTo}&focus=1&limit=40&releaseLimit=60`;
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
  for (const row of tree?.hours || []) {
    const edition = row?.edition || (row?.window ? row : null);
    if (!edition?.window || !Number.isFinite(Number(edition.window.startAt))) continue;
    editions.push(edition);
  }
  return editions.sort((left, right) => right.window.startAt - left.window.startAt);
}

export function readingSummary(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const items = Array.isArray(snapshot.items) ? snapshot.items : [];
  const hits = items.filter((item) => item?.disposition === 'hit' || (Array.isArray(item?.hits) && item.hits.length));
  const count = Number.isFinite(Number(snapshot.selected))
    ? Number(snapshot.selected)
    : Number.isFinite(Number(snapshot.hitCount))
      ? Number(snapshot.hitCount)
      : (items.length ? hits.length : null);
  const lead = snapshot.title || snapshot.firstTitle || hits[0]?.title || items[0]?.title || '';
  const preview = (hits.length ? hits : items).map((item) => item?.title).filter(Boolean).slice(0, 3);
  if (count == null && !lead && !preview.length) return null;
  return { count, lead, preview };
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
      text: `${shanghaiHourLabel(first).hourText}–${shanghaiHourLabel(last + HOUR).hourText} · ${group.length} 期未生成`,
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
      text: `最新一期 ${shanghaiHourLabel(latest).hourText} · 已延迟 ${Math.round((expectedStart - latest) / HOUR)} 小时`,
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
        text: `${shanghaiHourLabel(startAt).hourText}–${shanghaiHourLabel(gap.endAt).hourText} · ${count} 期未生成`,
      };
    })
    .filter(Boolean);
}

export function unavailableOfficialCount(health) {
  return (health || []).filter((item) => item?.status === 'unavailable').length;
}

export function buildHomeTimelineModel({
  nowMs,
  editions = [],
  readings = {},
  releases = [],
  upcoming = [],
  expandedHours = {},
  expandedOfficial = {},
  earlier = false,
  narrow = false,
  treeStatus = 'loading',
  boardStatus = 'loading',
} = {}) {
  const limit = narrow ? HOME_VISIBLE_HOURS.narrow : HOME_VISIBLE_HOURS.wide;
  const sorted = [...editions].sort((left, right) => right.window.startAt - left.window.startAt);
  const shown = earlier ? sorted : sorted.slice(0, limit);
  const coverage = hourCoverage({ editions: sorted, nowMs });
  const gaps = visibleHourGaps(coverage, shown.length ? shown : sorted);
  const official = foldOfficialByHour(releases);
  const officialByStart = new Map(official.map((group) => [group.startAt, group]));
  const latest = sorted[0] || null;
  return {
    header: latest ? `今天 · 最新小时报 ${shanghaiHourLabel(latest.window.startAt).hourText}` : '今天',
    briefHref: latest ? reportHourHref(latest.window.startAt) : '#report',
    nowText: `现在 ${shanghaiHourLabel(nowMs).hhmm}`,
    events: nextEvents(upcoming, nowMs, 2),
    delay: coverage.delay,
    gaps,
    earlierCount: earlier ? 0 : Math.max(sorted.length - limit, 0),
    treeStatus,
    boardStatus,
    hours: shown.map((edition) => {
      const startAt = edition.window.startAt;
      const summary = readingSummary(readings[startAt]);
      return {
        startAt,
        endAt: edition.window.endAt,
        label: shanghaiHourLabel(startAt).hourText,
        href: reportHourHref(startAt),
        lead: summary?.lead || '',
        hitCount: summary ? summary.count : null,
        expanded: Boolean(expandedHours[startAt]),
        preview: summary?.preview || [],
        official: officialByStart.get(startAt) || null,
        officialOpen: Boolean(expandedOfficial[startAt]),
      };
    }),
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
  head.append(el('h2', '', model.header));
  const brief = el('a', 'text-button', '完整简报 ›');
  brief.href = model.briefHref;
  head.append(brief);
  root.append(head);

  if (model.treeStatus === 'error') {
    root.append(retryButton('小时报读取失败 · 重试', handlers.onRetry));
  } else if (model.treeStatus === 'slow' && !model.hours.length) {
    root.append(retryButton('读取较慢 · 重试', handlers.onRetry));
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

  root.append(el('p', 'home-now', model.nowText));
  if (model.delay?.text) root.append(el('p', 'home-delay', model.delay.text));

  const blocks = [];
  const newest = model.hours[0]?.startAt ?? null;
  for (const gap of model.gaps) {
    if (newest == null || gap.startAt >= newest) blocks.push({ kind: 'gap', at: gap.startAt, gap });
  }
  model.hours.forEach((hour, index) => {
    blocks.push({ kind: 'hour', at: hour.startAt, hour });
    const older = model.hours[index + 1]?.startAt ?? -1;
    for (const gap of model.gaps) {
      if (gap.startAt < hour.startAt && gap.startAt >= older) blocks.push({ kind: 'gap', at: gap.startAt, gap });
    }
  });
  const seenGaps = new Set();
  for (const block of blocks.sort((left, right) => right.at - left.at)) {
    if (block.kind === 'gap') {
      if (seenGaps.has(block.gap.startAt)) continue;
      seenGaps.add(block.gap.startAt);
      root.append(el('p', 'home-gap', block.gap.text));
      continue;
    }
    const hour = block.hour;
    const row = el('div', 'home-row');
    row.append(el('i', 'home-dot is-hour'));
    const copy = el('div', 'home-copy');
    const title = el('a', 'home-title', hour.lead || hour.label);
    title.href = hour.href;
    copy.append(title);
    const meta = el('button', 'text-button home-meta', hour.hitCount == null ? '展开' : `命中 ${hour.hitCount} · 展开`);
    meta.type = 'button';
    meta.addEventListener('click', () => handlers.onToggleHour?.(hour));
    copy.append(meta);
    if (hour.expanded) {
      const list = el('div', 'home-expand');
      const titles = hour.preview.slice(0, 3);
      if (!titles.length && hour.hitCount == null && model.treeStatus === 'slow') list.append(retryButton('读取较慢 · 重试', handlers.onRetry));
      else if (!titles.length && hour.hitCount != null) list.append(el('p', 'home-meta', '这一期没有可显示的标题'));
      for (const text of titles) {
        const link = el('a', 'home-title', text);
        link.href = hour.href;
        list.append(link);
      }
      const more = el('a', 'text-button', '完整列表 ›');
      more.href = hour.href;
      list.append(more);
      copy.append(list);
    }
    if (hour.official) {
      const official = el('button', 'text-button home-official', `${hour.official.text} ›`);
      official.type = 'button';
      official.addEventListener('click', () => handlers.onToggleOfficial?.(hour));
      copy.append(official);
      if (hour.officialOpen) {
        const list = el('div', 'home-expand');
        for (const item of hour.official.items.slice(0, 5)) list.append(el('p', 'home-meta', item.title || '官方发布'));
        const feed = el('a', 'text-button', '在信息流中查看全部 ›');
        feed.href = '#feed';
        list.append(feed);
        copy.append(list);
      }
    }
    row.append(copy);
    root.append(row);
  }

  if (model.earlierCount > 0) {
    const earlier = el('button', 'text-button', `更早 ${model.earlierCount} 期 ›`);
    earlier.type = 'button';
    earlier.addEventListener('click', () => handlers.onEarlier?.());
    root.append(earlier);
  }
}
