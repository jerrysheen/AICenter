import { icon } from './icons.js?v=dev';
import { decodeHtmlEntities } from './html-text.js?v=dev';
import { zonedCalendarParts, zonedClockParts } from './shanghai-time.js?v=dev';

const SHANGHAI = 'Asia/Shanghai';

function parts(at, options = {}) {
  const date = zonedCalendarParts(at, SHANGHAI);
  const clock = zonedClockParts(at, SHANGHAI);
  const list = [];
  const push = (type, value) => list.push({ type, value: String(value) });
  if (options.year) push('year', date.year);
  if (options.month) push('month', date.month);
  if (options.day) push('day', date.day);
  if (options.hour) push('hour', String(clock.hour).padStart(2, '0'));
  if (options.minute) push('minute', String(clock.minute).padStart(2, '0'));
  return list;
}

function part(list, type) {
  return list.find((item) => item.type === type)?.value || '';
}

export function newsDayLabel(at) {
  const value = Number(at);
  if (!Number.isFinite(value) || value <= 0) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: SHANGHAI,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  }).format(new Date(value));
}

export function newsEffectiveLabel(at) {
  const value = Number(at);
  if (!Number.isFinite(value) || value <= 0) return '';
  const current = parts(value, { month: 'numeric', day: 'numeric' });
  return `生效：${Number(part(current, 'month'))}月${Number(part(current, 'day'))}日`;
}

const PUBLISHED_HINT_GAP_MS = 60 * 60 * 1000;

export function newsIngestAt(item) {
  const ingested = Number(item?.firstIngestedAt);
  if (Number.isFinite(ingested) && ingested > 0) return ingested;
  const published = Number(item?.publishedAt);
  return Number.isFinite(published) && published > 0 ? published : 0;
}

export function reportItemTime(item, edition) {
  const start = Number(edition?.window?.startAt);
  const windowStamp = Number.isFinite(start) && start > 0 ? start : 0;
  const ok = (at) => Number.isFinite(at) && at > 0 && at !== windowStamp;
  for (const value of [item?.publishedAt, item?.firstIngestedAt, item?.eventAt]) {
    const at = Number(value);
    if (ok(at)) return at;
  }
  const refAt = (Array.isArray(item?.sourceRefs) ? item.sourceRefs : [])
    .map((ref) => Number(ref?.at))
    .find((at) => ok(at));
  if (refAt) return refAt;
  return 0;
}

export function newsPublishedHint(publishedAt, ingestedAt) {
  const published = Number(publishedAt);
  const ingested = Number(ingestedAt);
  if (!Number.isFinite(published) || published <= 0 || !Number.isFinite(ingested) || ingested <= 0) return '';
  if (Math.abs(published - ingested) <= PUBLISHED_HINT_GAP_MS) return '';
  const publishedParts = parts(published, { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const ingestedParts = parts(ingested, { year: 'numeric', month: 'numeric', day: 'numeric' });
  const sameDay = part(publishedParts, 'year') === part(ingestedParts, 'year')
    && part(publishedParts, 'month') === part(ingestedParts, 'month')
    && part(publishedParts, 'day') === part(ingestedParts, 'day');
  const clock = `${part(publishedParts, 'hour')}:${part(publishedParts, 'minute')}`;
  return sameDay ? `发布 ${clock}` : `发布 ${Number(part(publishedParts, 'month'))}月${Number(part(publishedParts, 'day'))}日 ${clock}`;
}

export function newsTimeLabel(at, { ingested = false, now = Date.now() } = {}) {
  const value = Number(at);
  if (!Number.isFinite(value) || value <= 0) return { text: '', ingested: false };
  const current = parts(value, { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const today = parts(now, { year: 'numeric', month: 'numeric', day: 'numeric' });
  const sameDay = part(current, 'year') === part(today, 'year')
    && part(current, 'month') === part(today, 'month')
    && part(current, 'day') === part(today, 'day');
  const clock = `${part(current, 'hour')}:${part(current, 'minute')}`;
  const text = sameDay ? clock : `${Number(part(current, 'month'))}月${Number(part(current, 'day'))}日 ${clock}`;
  return { text, ingested: Boolean(ingested) };
}

export function newsRow(row) {
  const item = document.createElement('li');
  item.className = `news-row official-event${row.muted ? ' is-muted' : ''}${row.focused ? ' is-focus' : ''}`;
  if (row.id) item.dataset.nodeId = String(row.id);
  let host = item;
  let front = null;
  if (row.swipe) {
    const clip = document.createElement('div');
    clip.className = 'news-swipe swipe-item feed-swipe-item';
    const actions = document.createElement('div');
    actions.className = 'swipe-actions swipe-actions-single';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'swipe-delete';
    remove.textContent = '删除';
    remove.addEventListener('pointerdown', (event) => event.stopPropagation());
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      row.onDelete?.(event);
    });
    actions.append(remove);
    front = document.createElement('div');
    front.className = 'swipe-front';
    if (row.id) front.dataset.postId = String(row.id);
    clip.append(actions, front);
    item.append(clip);
    host = front;
  }
  const copy = document.createElement('div');
  copy.className = 'news-row-copy';
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'news-row-body official-event-body feed-content';
  const when = newsTimeLabel(row.at, { ingested: row.ingested });
  if (when.text) {
    const time = document.createElement('time');
    time.className = 'news-row-time';
    time.dateTime = Number.isFinite(Number(row.at)) ? new Date(Number(row.at)).toISOString() : '';
    time.textContent = when.text;
    if (when.ingested) {
      const mark = document.createElement('span');
      mark.className = 'news-tag';
      mark.textContent = '收录';
      time.append(mark);
    }
    open.append(time);
  }
  const title = document.createElement('h3');
  title.className = 'news-row-title';
  const titleText = decodeHtmlEntities(row.title || '');
  title.textContent = titleText;
  title.title = titleText;
  const effectiveLabel = String(row.effectiveLabel || '').trim();
  if (effectiveLabel) {
    const chip = document.createElement('span');
    chip.className = 'news-tag news-effective';
    chip.textContent = effectiveLabel;
    title.append(chip);
  }
  open.append(title);
  const sourceText = String(row.source || '').trim();
  const tags = (Array.isArray(row.tags) ? row.tags : []).map((tag) => String(tag || '').trim()).filter(Boolean);
  if (sourceText || tags.length) {
    const source = document.createElement('small');
    source.className = 'news-row-source';
    if (sourceText) source.textContent = sourceText;
    for (const tag of tags) {
      const chip = document.createElement('span');
      chip.className = `news-tag${tag === '时效不足' ? ' reading-stale' : ''}`;
      chip.textContent = tag;
      source.append(chip);
    }
    open.append(source);
  }
  const tail = [open];
  const summaryText = String(row.summary || '').trim();
  if (summaryText) {
    const summary = document.createElement('p');
    summary.className = 'news-row-summary';
    summary.textContent = decodeHtmlEntities(summaryText);
    tail.push(summary);
  }
  if (row.commentCount > 0) {
    const comments = document.createElement('p');
    comments.className = 'news-comment feed-comment-preview';
    comments.textContent = `评论 · ${row.commentCount} 条 · 展开查看`;
    tail.push(comments);
  }
  copy.append(...tail);
  if (typeof row.onShare === 'function') {
    const share = document.createElement('button');
    share.type = 'button';
    share.className = 'text-button news-share';
    share.textContent = '分享';
    share.addEventListener('click', (event) => {
      event.stopPropagation();
      event.preventDefault();
      row.onShare(event);
    });
    copy.append(share);
  }
  host.append(copy);
  if (typeof row.onStar === 'function') {
    const star = document.createElement('button');
    star.type = 'button';
    star.className = `icon-button ghost focus-btn${row.focused ? ' on' : ''}`;
    star.setAttribute('aria-label', row.focused ? '取消重点' : '标为重点');
    star.innerHTML = icon('star');
    star.addEventListener('click', (event) => {
      event.stopPropagation();
      event.preventDefault();
      const on = star.classList.toggle('on');
      star.setAttribute('aria-label', on ? '取消重点' : '标为重点');
      row.onStar(event);
    });
    host.append(star);
  }
  if (row.extra) item.append(row.extra);
  if (typeof row.attachOpen === 'function') row.attachOpen(open);
  else if (typeof row.onOpen === 'function') open.addEventListener('click', (event) => row.onOpen(event));
  if (front && typeof row.attachSwipe === 'function') row.attachSwipe(front);
  return item;
}

function appendNewsRows(list, groupRows) {
  for (const row of groupRows) list.append(newsRow(row));
}

const BULK_NOTICE_WINDOW_MS = 120_000;
const BULK_NOTICE_MIN = 8;

export function bulkOfficialSourceKey(item) {
  const url = String(item?.sourceUrl || item?.release?.sourceUrl || '').trim();
  if (url) {
    try { return new URL(url).hostname.replace(/^www\./i, ''); } catch { /* keep the authority fallback */ }
  }
  return String(item?.author || item?.release?.authority || '').trim();
}

export function markBulkOfficialNotices(items) {
  const groups = new Map();
  for (const item of items || []) {
    const official = item?.kind === 'official' || item?.platform === 'official';
    if (!official) continue;
    const captured = Number(item?.createdAt || item?.observedAt || item?.release?.observedAt) || 0;
    if (!captured) continue;
    const source = bulkOfficialSourceKey(item);
    if (!source) continue;
    const key = `${source}|${Math.floor(captured / BULK_NOTICE_WINDOW_MS)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const bulk = new Set();
  for (const group of groups.values()) {
    if (group.length >= BULK_NOTICE_MIN) for (const item of group) bulk.add(item);
  }
  if (!bulk.size) return items || [];
  return (items || []).map((item) => (bulk.has(item) ? { ...item, bulkNotice: true } : item));
}

function dayKey(row) {
  return row.day || newsDayLabel(row.at) || '时间待公布';
}

export function newsDayGroups(rows) {
  const decorated = [...(rows || [])].map((row, index) => ({ row, index }));
  decorated.sort((left, right) => (Number(right.row.at) || 0) - (Number(left.row.at) || 0) || left.index - right.index);
  const groups = [];
  const index = new Map();
  for (const entry of decorated) {
    const row = entry.row;
    const key = dayKey(row);
    if (!index.has(key)) {
      const group = { key, rows: [], at: Number(row.at) || 0 };
      index.set(key, group);
      groups.push(group);
    }
    const group = index.get(key);
    const at = Number(row.at) || 0;
    if (at > group.at) group.at = at;
    group.rows.push(row);
  }
  for (const group of groups) {
    const primary = [];
    const tails = [];
    for (const row of group.rows) {
      if (row?.muted && row?.stayInDay) tails.push(row);
      else primary.push(row);
    }
    group.rows = primary.concat(tails);
  }
  groups.sort((left, right) => right.at - left.at || String(left.key).localeCompare(String(right.key), 'zh-CN'));
  return groups;
}

export function prioritizeReadableFeedRows(rows) {
  return newsDayGroups(rows).flatMap((group) => group.rows);
}

export function splitSinkMuted(rows, sinkMuted) {
  const source = Array.isArray(rows) ? rows : [];
  if (!sinkMuted) return { main: source, tail: [] };
  const main = [];
  const tail = [];
  for (const row of source) {
    if (row?.muted && !row?.stayInDay) tail.push(row);
    else main.push(row);
  }
  return { main, tail };
}

function appendDayGroups(wrap, rows) {
  for (const group of newsDayGroups(rows)) {
    const day = document.createElement('section');
    day.className = 'news-day official-day';
    const label = document.createElement('p');
    label.className = 'news-day-label official-day-label';
    label.textContent = group.key;
    const list = document.createElement('ol');
    list.className = 'news-rows news-day-list official-day-list';
    appendNewsRows(list, group.rows);
    day.append(label, list);
    wrap.append(day);
  }
}

export function renderNewsList(root, rows, { groupByDay = false, limit, emptyText = '这个筛选下还没有信息。', sinkMuted = false } = {}) {
  const source = Array.isArray(rows) ? rows : [];
  const limited = Number.isFinite(limit) ? source.slice(0, limit) : source;
  const { main, tail } = splitSinkMuted(limited, sinkMuted);
  const shown = sinkMuted ? [...main, ...tail] : limited;
  root.replaceChildren();
  if (!shown.length) {
    const empty = document.createElement('p');
    empty.className = 'feed-empty news-empty';
    empty.textContent = emptyText;
    root.append(empty);
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'news-list official-timeline';
  if (!groupByDay) {
    const list = document.createElement('ol');
    list.className = 'news-rows official-day-list';
    appendNewsRows(list, shown);
    wrap.append(list);
  } else {
    if (main.length) appendDayGroups(wrap, main);
    if (tail.length) {
      const list = document.createElement('ol');
      list.className = 'news-rows news-muted-tail official-day-list';
      appendNewsRows(list, tail);
      wrap.append(list);
    }
  }
  root.append(wrap);
}
