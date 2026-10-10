import { icon } from './icons.js?v=dev';
import { decodeHtmlEntities } from './html-text.js?v=dev';

const SHANGHAI = 'Asia/Shanghai';

function parts(at, options) {
  return new Intl.DateTimeFormat('en-US', { timeZone: SHANGHAI, hourCycle: 'h23', ...options }).formatToParts(new Date(at));
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

function appendDayGroups(wrap, rows) {
  const groups = [];
  const index = new Map();
  for (const row of rows) {
    const key = row.day || newsDayLabel(row.at) || '时间待公布';
    if (!index.has(key)) {
      const group = { key, rows: [] };
      index.set(key, group);
      groups.push(group);
    }
    index.get(key).rows.push(row);
  }
  for (const group of groups) {
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
  const shown = sinkMuted
    ? [...limited.filter((row) => !row.muted), ...limited.filter((row) => row.muted)]
    : limited;
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
  const main = sinkMuted ? shown.filter((row) => !row.muted) : shown;
  const tail = sinkMuted ? shown.filter((row) => row.muted) : [];
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
