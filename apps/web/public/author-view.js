const PLATFORM_LABEL = { all: '全部', x: 'X', xueqiu: '雪球', bilibili: 'B站', youtube: 'YouTube', official: '官方', media: '媒体' };
const PLATFORM_ORDER = ['all', 'x', 'xueqiu', 'bilibili', 'youtube', 'official', 'media'];
const PLATFORM_COLOR = { x: '#111111', xueqiu: '#c0392b', bilibili: '#fb7299', youtube: '#cc0000', official: '#0A59F7', media: '#0f6b4c' };
const PAGE_SIZE = 30;

const pages = new Map();
let listPlatform = 'all';
let listCache = null;
let listFetchToken = 0;

function platformLabel(platform) {
  return PLATFORM_LABEL[platform] || platform || '';
}

function initial(name) {
  const text = String(name || '').trim();
  return text ? text.slice(0, 1) : '作';
}

function clock(at) {
  const time = Number(at) || 0;
  if (!time) return '';
  const date = new Date(time);
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  if (sameDay) return `${hh}:${mm}`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${hh}:${mm}`;
}

function avatar(author) {
  const node = document.createElement(author.avatarUrl ? 'img' : 'span');
  node.className = 'author-avatar';
  if (author.avatarUrl) {
    node.alt = '';
    node.src = author.avatarUrl;
    node.dataset.avatarUrl = author.avatarUrl;
    node.addEventListener('error', () => {
      const fallback = document.createElement('span');
      fallback.className = 'author-avatar';
      fallback.textContent = initial(author.name);
      fallback.style.background = PLATFORM_COLOR[author.platform] || '#5c6b7a';
      node.replaceWith(fallback);
    });
  } else {
    node.textContent = initial(author.name);
    node.style.background = PLATFORM_COLOR[author.platform] || '#5c6b7a';
  }
  return node;
}

function followButton(author, onToggle) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `author-follow${author.followed ? ' is-on' : ''}`;
  button.textContent = author.followed ? '已关注' : '关注';
  button._author = author;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    return onToggle(button._author || author);
  });
  return button;
}

const AUTHOR_ANCHOR_LINE = 96;
const AUTHOR_ROW_STRIDE = 72;
const AUTHOR_WINDOW_OVERSCAN = 8;
const AUTHOR_WINDOW_MIN = 64;

let authorRowHandlers = null;
let authorWindowBound = false;

function authorListStamp(platform, payload) {
  const counts = payload?.counts || {};
  const countPart = PLATFORM_ORDER.map((id) => `${id}:${Number(counts[id]) || 0}`).join(',');
  const rows = (list) => (Array.isArray(list) ? list : []).map((author) => [
    author?.authorId || '',
    author?.name || '',
    author?.handle || '',
    author?.platform || '',
    author?.followed ? 1 : 0,
    Number(author?.unreadCount) || 0,
    Number(author?.latestUnreadAt || author?.latestItemAt) || 0,
    author?.latestTitleZh || '',
    author?.avatarUrl || '',
  ].join('\u001f')).join('\u001e');
  return [platform || 'all', countPart, payload?.nextCursor || '', rows(payload?.followed), rows(payload?.others)].join('\u001d');
}

function childByClass(parent, className) {
  for (const node of parent?.children || []) {
    if (node?.classList?.contains(className)) return node;
  }
  return null;
}

function authorListSkeleton(rows = 8) {
  const box = document.createElement('div');
  box.className = 'list-skeleton';
  box.setAttribute('role', 'status');
  box.setAttribute('aria-busy', 'true');
  box.setAttribute('aria-label', '正在读取作者…');
  if (box.dataset) box.dataset.rows = String(rows);
  const list = document.createElement('div');
  list.className = 'list-skeleton-rows';
  for (let index = 0; index < rows; index += 1) {
    const row = document.createElement('div');
    row.className = 'list-skeleton-row';
    row.setAttribute('aria-hidden', 'true');
    const title = document.createElement('span');
    title.className = 'list-skeleton-title';
    const meta = document.createElement('span');
    meta.className = 'list-skeleton-meta';
    row.append(title, meta);
    list.append(row);
  }
  box.append(list);
  return box;
}

function authorListOnScreen() {
  if (document.body?.dataset?.view !== 'feed') return false;
  if (document.body?.classList?.contains('is-dialog-open')) return false;
  return true;
}

function revealActiveChip(switcher) {
  // 列表左右滑会和 iOS 边缘返回、Android 返回手势抢水平滑动，所以只让这一行标签自己横滑。
  const active = switcher?.querySelector?.('.is-active');
  if (!active) return;
  const view = Number(switcher.clientWidth) || 0;
  if (!view) return;
  const left = Number(active.offsetLeft) || 0;
  const width = Number(active.offsetWidth) || 0;
  const start = Number(switcher.scrollLeft) || 0;
  if (left < start) switcher.scrollLeft = left;
  else if (left + width > start + view) switcher.scrollLeft = left + width - view;
}

function captureListAnchor(root) {
  const scrollY = Number(window.scrollY) || 0;
  const rows = root?.querySelectorAll?.('.author-row') || [];
  for (const row of rows) {
    const rect = row.getBoundingClientRect?.() || { top: 0, bottom: 0 };
    if (rect.bottom > AUTHOR_ANCHOR_LINE) {
      return { scrollY, authorId: row.dataset?.authorId || '', offset: rect.top };
    }
  }
  return { scrollY, authorId: '', offset: 0 };
}

function restoreListAnchor(root, saved) {
  if (!saved?.authorId || !authorListOnScreen()) return;
  const apply = () => {
    if (!authorListOnScreen()) return;
    let row = null;
    for (const item of root?.querySelectorAll?.('.author-row') || []) {
      if (item.dataset?.authorId === saved.authorId) { row = item; break; }
    }
    if (!row?.getBoundingClientRect) return;
    const delta = row.getBoundingClientRect().top - (Number(saved.offset) || 0);
    if (Math.abs(delta) > 1) window.scrollTo(0, (Number(window.scrollY) || 0) + delta);
  };
  apply();
  const frame = window.requestAnimationFrame?.bind(window);
  if (typeof frame !== 'function') return;
  frame(() => { apply(); frame(apply); });
}

function syncAvatar(row, author) {
  const open = row.querySelector('.author-row-main');
  if (!open) return;
  const current = open.querySelector('.author-avatar');
  const url = author.avatarUrl || '';
  if (url && current?.dataset?.avatarUrl === url) return;
  if (!url && current && !current.dataset?.avatarUrl && current.textContent === initial(author.name)) return;
  const next = avatar(author);
  if (current) current.replaceWith(next);
  else open.prepend(next);
}

function applyAuthorRow(row, author) {
  row._author = author;
  row.dataset.authorId = author.authorId || '';
  row.className = `author-row${author.unreadCount ? '' : ' is-quiet'}`;
  syncAvatar(row, author);
  const name = row.querySelector('strong');
  if (name) name.textContent = author.name || author.handle || '未命名作者';
  const badge = row.querySelector('.author-platform');
  if (badge) badge.textContent = platformLabel(author.platform);
  const title = row.querySelector('.author-row-title');
  let unread = title?.querySelector('.author-unread') || null;
  if (author.unreadCount > 0) {
    if (!unread && title) {
      unread = document.createElement('span');
      unread.className = 'author-unread';
      title.append(unread);
    }
    if (unread) unread.textContent = String(author.unreadCount);
  } else if (unread) unread.remove();
  const preview = row.querySelector('.author-row-preview');
  if (preview) {
    const when = clock(author.latestUnreadAt || author.latestItemAt);
    preview.textContent = [when, author.latestTitleZh].filter(Boolean).join('  ');
  }
  const follow = row.querySelector('.author-follow');
  if (follow) {
    follow._author = author;
    follow.className = `author-follow${author.followed ? ' is-on' : ''}`;
    follow.textContent = author.followed ? '已关注' : '关注';
  }
}

function authorRow(author, handlers) {
  const row = document.createElement('article');
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'author-row-main';
  const copy = document.createElement('span');
  copy.className = 'author-row-copy';
  const title = document.createElement('span');
  title.className = 'author-row-title';
  const name = document.createElement('strong');
  const badge = document.createElement('span');
  badge.className = 'author-platform';
  title.append(name, badge);
  const preview = document.createElement('span');
  preview.className = 'author-row-preview';
  copy.append(title, preview);
  open.append(copy);
  open.addEventListener('click', () => handlers.onOpen(row._author));
  row.append(open, followButton(author, handlers.onFollow));
  applyAuthorRow(row, author);
  return row;
}

function sameRowOrder(rowsHost, followed, others) {
  const current = [...(rowsHost?.querySelectorAll?.('.author-row') || [])].map((row) => row.dataset?.authorId || '');
  const next = [...followed, ...others].map((author) => author.authorId || '');
  if (current.length !== next.length) return false;
  for (let index = 0; index < current.length; index += 1) {
    if (current[index] !== next[index]) return false;
  }
  const labels = [...(rowsHost?.querySelectorAll?.('.author-group') || [])].map((node) => node.textContent);
  const wanted = [];
  if (followed.length) wanted.push('已关注');
  if (others.length) wanted.push(followed.length ? '其他' : '作者');
  if (labels.length !== wanted.length) return false;
  return labels.every((text, index) => text === wanted[index]);
}

function updateRowsInPlace(rowsHost, followed, others) {
  const rows = [...rowsHost.querySelectorAll('.author-row')];
  [...followed, ...others].forEach((author, index) => applyAuthorRow(rows[index], author));
}

function authorEntries(followed, others) {
  const entries = [];
  if (followed.length) {
    entries.push({ kind: 'head', text: '已关注' });
    for (const author of followed) entries.push({ kind: 'row', author });
  }
  if (others.length) {
    entries.push({ kind: 'head', text: followed.length ? '其他' : '作者' });
    for (const author of others) entries.push({ kind: 'row', author });
  }
  return entries;
}

function setAuthorVirtual(rowsHost, enabled) {
  const names = String(rowsHost.className || '').split(/\s+/).filter((name) => name && name !== 'is-virtual');
  if (enabled) names.push('is-virtual');
  rowsHost.className = names.join(' ');
}

function authorStride(rowsHost) {
  const saved = Number(rowsHost?.dataset?.stride);
  if (saved >= 48 && saved <= 160) return saved;
  return AUTHOR_ROW_STRIDE;
}

function rememberAuthorStride(rowsHost) {
  const row = rowsHost.querySelector?.('.author-row');
  const height = Number(row?.offsetHeight) || 0;
  if (height >= 48 && height <= 160) rowsHost.dataset.stride = String(Math.round(height));
}

function authorHiddenAbove(rowsHost) {
  const top = Number(rowsHost?.getBoundingClientRect?.().top);
  if (Number.isFinite(top) && top < 0) return -top;
  const y = Number(window.scrollY) || 0;
  return y > 160 ? y - 160 : 0;
}

function authorColumnCount() {
  const query = window.matchMedia;
  if (typeof query !== 'function') return 1;
  try {
    return query.call(window, '(min-width: 840px)').matches ? 2 : 1;
  } catch {
    return 1;
  }
}

function authorVisualLayout(entries, columns) {
  const cols = Math.max(1, Number(columns) || 1);
  const rowOf = new Array(entries.length);
  const indexAtRow = [];
  let row = 0;
  let slot = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const full = cols === 1 || entries[index]?.kind === 'head';
    if (full && slot) {
      row += 1;
      slot = 0;
    }
    if (indexAtRow[row] == null) indexAtRow[row] = index;
    rowOf[index] = row;
    if (full) {
      row += 1;
      slot = 0;
    } else {
      slot += 1;
      if (slot >= cols) {
        row += 1;
        slot = 0;
      }
    }
  }
  if (slot) row += 1;
  return { rowOf, indexAtRow, totalRows: row };
}

function authorWindowRange(rowsHost, entries, anchorIndex) {
  const columns = authorColumnCount();
  const stride = authorStride(rowsHost);
  const view = Math.max(320, Number(window.innerHeight) || 800);
  const visibleRows = Math.ceil(view / stride) + AUTHOR_WINDOW_OVERSCAN * 2;
  const layout = authorVisualLayout(entries, columns);
  let startRow = Math.max(0, Math.floor(authorHiddenAbove(rowsHost) / stride) - AUTHOR_WINDOW_OVERSCAN);
  if (anchorIndex >= 0) {
    const anchorRow = Number(layout.rowOf[anchorIndex]);
    if (anchorRow < startRow || anchorRow >= startRow + visibleRows) {
      startRow = Math.max(0, anchorRow - AUTHOR_WINDOW_OVERSCAN);
    }
  }
  const endRow = Math.min(layout.totalRows, Math.max(startRow + 1, startRow + visibleRows));
  const start = layout.indexAtRow[startRow] ?? entries.length;
  const end = endRow >= layout.totalRows ? entries.length : (layout.indexAtRow[endRow] ?? entries.length);
  return {
    start,
    end,
    topRows: startRow,
    bottomRows: Math.max(0, layout.totalRows - endRow),
    columns,
    stride,
  };
}

function placeAuthorWindow(rowsHost, followed, others, handlers, options = {}) {
  setAuthorVirtual(rowsHost, true);
  const entries = authorEntries(followed, others);
  const anchorIndex = options.anchorId
    ? entries.findIndex((entry) => entry.kind === 'row' && entry.author?.authorId === options.anchorId)
    : -1;
  const range = authorWindowRange(rowsHost, entries, anchorIndex);
  const stride = range.stride;
  const key = `${range.start}:${range.end}:${stride}:${range.columns}`;
  const rows = [...(rowsHost.querySelectorAll?.('.author-row') || [])];
  const expected = [];
  for (let index = range.start; index < range.end; index += 1) {
    if (entries[index]?.kind === 'row') expected.push(entries[index].author);
  }
  const sameWindow = rowsHost.dataset.window === key && rows.length > 0;
  if (sameWindow && !options.force) return;
  if (
    sameWindow
    && rows.length === expected.length
    && rows.every((row, index) => (row.dataset?.authorId || '') === (expected[index]?.authorId || ''))
  ) {
    expected.forEach((author, index) => applyAuthorRow(rows[index], author));
    return;
  }
  const existing = new Map();
  for (const row of rows) {
    const id = row.dataset?.authorId || '';
    if (id && !existing.has(id)) existing.set(id, row);
  }
  let top = childByClass(rowsHost, 'author-spacer-top');
  let bottom = childByClass(rowsHost, 'author-spacer-bottom');
  if (!top) {
    top = document.createElement('div');
    top.className = 'author-spacer author-spacer-top';
    top.setAttribute('aria-hidden', 'true');
  }
  if (!bottom) {
    bottom = document.createElement('div');
    bottom.className = 'author-spacer author-spacer-bottom';
    bottom.setAttribute('aria-hidden', 'true');
  }
  top.style.height = `${range.topRows * stride}px`;
  bottom.style.height = `${range.bottomRows * stride}px`;
  const nodes = [top];
  for (let index = range.start; index < range.end; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (entry.kind === 'head') {
      const heading = document.createElement('h3');
      heading.className = 'author-group';
      heading.textContent = entry.text;
      nodes.push(heading);
    } else {
      const id = entry.author?.authorId || '';
      let row = existing.get(id);
      if (row) {
        applyAuthorRow(row, entry.author);
        existing.delete(id);
      } else row = authorRow(entry.author, handlers);
      nodes.push(row);
    }
  }
  for (const stale of existing.values()) stale.remove();
  nodes.push(bottom);
  rowsHost.replaceChildren(...nodes);
  rowsHost.dataset.window = key;
  rememberAuthorStride(rowsHost);
}

function syncAuthorWindow() {
  if (!authorListOnScreen() || !authorRowHandlers) return;
  const shell = childByClass(document.querySelector('#feed'), 'author-screen');
  if (shell?.dataset?.virtual !== '1' || !listCache || listCache.platform !== listPlatform) return;
  const rows = childByClass(shell, 'author-list-rows');
  const payload = listCache.payload || {};
  if (!rows) return;
  placeAuthorWindow(
    rows,
    Array.isArray(payload.followed) ? payload.followed : [],
    Array.isArray(payload.others) ? payload.others : [],
    authorRowHandlers,
  );
}

function bindAuthorWindow() {
  if (authorWindowBound || typeof window.addEventListener !== 'function') return;
  authorWindowBound = true;
  let queued = false;
  const schedule = window.requestAnimationFrame?.bind(window);
  const run = () => {
    queued = false;
    syncAuthorWindow();
  };
  const onChange = () => {
    if (queued) return;
    queued = true;
    if (typeof schedule === 'function') schedule(run);
    else run();
  };
  window.addEventListener('scroll', onChange, { passive: true });
  window.addEventListener('resize', onChange);
}

function rebuildRows(rowsHost, followed, others, handlers) {
  const existing = new Map();
  for (const row of [...rowsHost.querySelectorAll('.author-row')]) {
    const id = row.dataset?.authorId || '';
    if (id && !existing.has(id)) existing.set(id, row);
  }
  const nodes = [];
  const addGroup = (label, authors) => {
    if (!authors.length) return;
    const heading = document.createElement('h3');
    heading.className = 'author-group';
    heading.textContent = label;
    nodes.push(heading);
    for (const author of authors) {
      const id = author.authorId || '';
      let row = existing.get(id);
      if (row) {
        applyAuthorRow(row, author);
        existing.delete(id);
      } else row = authorRow(author, handlers);
      nodes.push(row);
    }
  };
  addGroup('已关注', followed);
  addGroup(followed.length ? '其他' : '作者', others);
  if (!nodes.length) {
    const empty = document.createElement('p');
    empty.className = 'feed-empty';
    empty.textContent = '这里还没有符合条件的作者。';
    nodes.push(empty);
  }
  for (const stale of existing.values()) stale.remove();
  rowsHost.replaceChildren(...nodes);
}

export function createAuthorView({ api, openAuthor, openArticle }) {
  async function loadList(platform, cursor = '') {
    const query = new URLSearchParams({ platform: platform || 'all' });
    if (cursor) query.set('cursor', cursor);
    return api(`/api/v1/authors?${query}`, { fresh: true, priority: 1 });
  }

  function showLoading(shell) {
    shell.replaceChildren();
    shell.append(authorListSkeleton(8));
    shell.dataset.listStamp = '';
    shell.dataset.platform = '';
  }

  async function renderList(root, options = {}) {
    const preserveScroll = options.preserveScroll !== false;
    const platform = listPlatform;
    let shell = childByClass(root, 'author-screen');
    const cached = listCache && listCache.platform === platform ? listCache.payload : null;
    if (
      cached
      && shell
      && shell.dataset.platform === platform
      && shell.dataset.listStamp === authorListStamp(platform, cached)
    ) return;
    const anchor = preserveScroll && authorListOnScreen() && shell ? captureListAnchor(shell) : null;
    if (!shell) {
      root.replaceChildren();
      shell = document.createElement('div');
      shell.className = 'author-screen';
      root.append(shell);
    }
    let payload = cached;
    if (!payload) {
      const token = ++listFetchToken;
      const switching = shell.dataset.platform !== platform;
      if (!preserveScroll || switching || !shell.dataset.listStamp) showLoading(shell);
      try {
        payload = await loadList(platform);
        if (token !== listFetchToken || platform !== listPlatform) return;
        listCache = { platform, payload };
      } catch (error) {
        if (token !== listFetchToken || platform !== listPlatform) return;
        if (!childByClass(shell, 'author-list-rows')) {
          shell.replaceChildren();
          const failed = document.createElement('p');
          failed.className = 'feed-empty';
          failed.textContent = error?.message || '作者列表读取失败';
          shell.append(failed);
        }
        return;
      }
    }
    if (!root.isConnected || !shell.isConnected) return;
    paintList(shell, payload, { preserveScroll, anchor });
  }

  function syncSwitcher(switcher, counts) {
    let buttons = [...switcher.querySelectorAll('.author-switch-item')];
    if (buttons.length !== PLATFORM_ORDER.length) {
      switcher.replaceChildren();
      switcher.setAttribute('role', 'tablist');
      switcher.setAttribute('aria-label', '作者平台');
      for (const id of PLATFORM_ORDER) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'author-switch-item';
        button.dataset.platform = id;
        button.addEventListener('click', () => {
          if (id === listPlatform) return;
          listPlatform = id;
          listCache = null;
          const host = switcher.parentElement?.parentElement;
          if (host) return renderList(host, { preserveScroll: false });
        });
        switcher.append(button);
      }
      buttons = [...switcher.querySelectorAll('.author-switch-item')];
    }
    PLATFORM_ORDER.forEach((id, index) => {
      const button = buttons[index];
      button.className = `author-switch-item${id === listPlatform ? ' is-active' : ''}`;
      button.textContent = `${platformLabel(id)} ${Number(counts[id]) || 0}`;
    });
  }

  function syncMore(shell, payload) {
    let more = childByClass(shell, 'author-more');
    if (!payload.nextCursor) {
      more?.remove();
      return;
    }
    if (!more) {
      more = document.createElement('button');
      more.type = 'button';
      more.className = 'author-more';
      shell.append(more);
    }
    more.disabled = false;
    more.textContent = '继续加载';
    more.onclick = async () => {
      const cursor = payload.nextCursor;
      if (!cursor) return;
      more.disabled = true;
      more.textContent = '正在读取…';
      try {
        const next = await loadList(listPlatform, cursor);
        const followed = Array.isArray(payload.followed) ? payload.followed : [];
        const others = Array.isArray(payload.others) ? payload.others : [];
        payload.others = others.concat(next.others || []);
        payload.followed = followed;
        payload.nextCursor = next.nextCursor || '';
        listCache = { platform: listPlatform, payload };
        paintList(shell, payload);
      } catch (error) {
        more.disabled = false;
        more.textContent = error?.message || '继续加载失败';
      }
    };
  }

  function paintList(shell, payload, options = {}) {
    const platform = listPlatform;
    const stamp = authorListStamp(platform, payload);
    if (shell.dataset.platform === platform && shell.dataset.listStamp === stamp) return;
    const preserveScroll = options.preserveScroll !== false;
    const anchor = !preserveScroll ? null : (options.anchor || (authorListOnScreen() ? captureListAnchor(shell) : null));
    let switcher = childByClass(shell, 'author-switch');
    if (!switcher) {
      switcher = document.createElement('div');
      switcher.className = 'author-switch';
      shell.prepend(switcher);
    }
    syncSwitcher(switcher, payload.counts || {});
    revealActiveChip(switcher);
    let rows = childByClass(shell, 'author-list-rows');
    if (!rows) {
      rows = document.createElement('div');
      rows.className = 'author-list-rows';
      shell.append(rows);
    }
    const followed = Array.isArray(payload.followed) ? payload.followed : [];
    const others = Array.isArray(payload.others) ? payload.others : [];
    const handlers = { onOpen: openRow, onFollow: toggleFollow };
    authorRowHandlers = handlers;
    bindAuthorWindow();
    const virtual = followed.length + others.length > AUTHOR_WINDOW_MIN;
    shell.dataset.virtual = virtual ? '1' : '';
    if (virtual) {
      placeAuthorWindow(rows, followed, others, handlers, { force: true, anchorId: anchor?.authorId || '' });
    } else {
      setAuthorVirtual(rows, false);
      rows.dataset.window = '';
      const same = sameRowOrder(rows, followed, others);
      if (same) updateRowsInPlace(rows, followed, others);
      else rebuildRows(rows, followed, others, handlers);
    }
    syncMore(shell, payload);
    childByClass(shell, 'list-skeleton')?.remove();
    childByClass(shell, 'feed-empty')?.remove();
    shell.dataset.platform = platform;
    shell.dataset.listStamp = stamp;
    if (!authorListOnScreen()) return;
    if (!preserveScroll) {
      window.scrollTo(0, 0);
      return;
    }
    if (anchor?.authorId) restoreListAnchor(shell, anchor);
  }

  function openRow(author) {
    openAuthor(author.authorId);
  }

  async function toggleFollow(author) {
    try {
      const method = author.followed ? 'DELETE' : 'PUT';
      await api(`/api/v1/authors/${encodeURIComponent(author.authorId)}/follow`, { method });
      listCache = null;
      pages.delete(author.authorId);
      const root = document.querySelector('#feed');
      if (root && document.body.dataset.view === 'feed') return renderList(root);
    } catch {
      listCache = null;
    }
  }

  function remember(authorId) {
    const page = pages.get(authorId) || { justRead: new Set() };
    page.scrollY = window.scrollY;
    pages.set(authorId, page);
  }

  function noteRead(authorId, itemId) {
    if (!authorId || !itemId) return;
    const page = pages.get(authorId) || { justRead: new Set() };
    page.justRead = page.justRead || new Set();
    page.justRead.add(itemId);
    page.scrollY = window.scrollY;
    const unreadItems = page.unread?.items;
    const index = Array.isArray(unreadItems)
      ? unreadItems.findIndex((item) => item && item.id === itemId)
      : -1;
    if (index >= 0) {
      const [item] = unreadItems.splice(index, 1);
      if (item) item.isRead = true;
      if (Array.isArray(page.read?.items) && item) page.read.items.unshift(item);
      const touched = new Set();
      const dropUnread = (row) => {
        if (!row || touched.has(row)) return;
        touched.add(row);
        row.unreadCount = Math.max(0, (Number(row.unreadCount) || 0) - 1);
      };
      dropUnread(page.author);
      const lists = [listCache?.payload?.followed, listCache?.payload?.others];
      for (const list of lists) {
        if (!Array.isArray(list)) continue;
        const author = list.find((row) => row && row.authorId === authorId);
        if (!author) continue;
        dropUnread(author);
        break;
      }
    }
    pages.set(authorId, page);
  }

  async function loadItems(authorId, read, cursor = '') {
    const query = new URLSearchParams({ read, limit: String(PAGE_SIZE) });
    if (cursor) query.set('cursor', cursor);
    return api(`/api/v1/authors/${encodeURIComponent(authorId)}/items?${query}`, { fresh: true });
  }

  async function renderPage(root, authorId) {
    const cached = pages.get(authorId);
    if (cached?.author && cached.unread) {
      paintPage(root, authorId, cached);
      return;
    }
    root.replaceChildren();
    root.append(authorListSkeleton(6));
    try {
      const detail = await api(`/api/v1/authors/${encodeURIComponent(authorId)}`, { fresh: true });
      const unread = await loadItems(authorId, 'unread');
      const page = {
        author: detail.author,
        unread,
        read: null,
        justRead: cached?.justRead || new Set(),
        scrollY: cached?.scrollY || 0,
      };
      if ((unread.items || []).length < PAGE_SIZE) page.read = await loadItems(authorId, 'read');
      pages.set(authorId, page);
      if (root.isConnected) paintPage(root, authorId, page);
    } catch (error) {
      if (!root.isConnected) return;
      root.replaceChildren();
      const failed = document.createElement('p');
      failed.className = 'feed-empty';
      failed.textContent = error?.message || '作者不存在';
      root.append(failed);
    }
  }

  function paintPage(root, authorId, page) {
    const author = page.author;
    root.replaceChildren();
    const shell = document.createElement('article');
    shell.className = 'author-page';
    const head = document.createElement('header');
    head.className = 'author-page-head';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'author-back';
    back.textContent = '返回';
    back.addEventListener('click', () => {
      if (history.state?.aiCenterPrevious) history.back();
      else location.hash = '#feed?tab=author';
    });
    const title = document.createElement('div');
    title.className = 'author-page-title';
    const name = document.createElement('strong');
    name.textContent = author.name || author.handle || '未命名作者';
    const badge = document.createElement('span');
    badge.className = 'author-platform';
    badge.textContent = platformLabel(author.platform);
    title.append(name, badge);
    const actions = document.createElement('div');
    actions.className = 'author-page-actions';
    actions.append(followButton(author, async (row) => {
      const method = row.followed ? 'DELETE' : 'PUT';
      const result = await api(`/api/v1/authors/${encodeURIComponent(author.authorId)}/follow`, { method });
      page.author = result.author || { ...row, followed: !row.followed };
      listCache = null;
      paintPage(root, authorId, page);
    }));
    const readAll = document.createElement('button');
    readAll.type = 'button';
    readAll.className = 'author-read-all';
    readAll.textContent = '全部已读';
    readAll.addEventListener('click', async () => {
      readAll.disabled = true;
      const result = await api(`/api/v1/authors/${encodeURIComponent(author.authorId)}/read-all`, { method: 'POST' });
      pages.delete(authorId);
      listCache = null;
      if (result) renderPage(root, authorId);
    });
    actions.append(readAll);
    head.append(back, title, actions);
    shell.append(head);
    const meta = document.createElement('div');
    meta.className = 'author-page-meta';
    if (author.bio) {
      const bio = document.createElement('p');
      bio.textContent = author.bio;
      meta.append(bio);
    }
    const facts = document.createElement('p');
    const bits = [];
    if (author.followers != null) bits.push(`${author.followers} 关注者`);
    facts.textContent = bits.join(' · ');
    if (author.profileUrl) {
      const home = document.createElement('a');
      home.href = author.profileUrl;
      home.target = '_blank';
      home.rel = 'noreferrer';
      home.textContent = '打开主页↗';
      facts.append(document.createTextNode(facts.textContent ? ' · ' : ''), home);
    }
    if (facts.textContent || facts.childElementCount) meta.append(facts);
    shell.append(meta);
    shell.append(section(author, page, 'unread', `未读 · ${author.unreadCount || 0}`));
    if (page.read) shell.append(section(author, page, 'read', `已读 · ${Math.max(0, (author.totalCount || 0) - (author.unreadCount || 0))}`, true));
    root.append(shell);
    const y = page.scrollY || 0;
    const frame = window.requestAnimationFrame?.bind(window);
    if (typeof frame === 'function') frame(() => window.scrollTo(0, y));
    else window.scrollTo(0, y);
  }

  function section(author, page, key, label, quiet = false) {
    const block = document.createElement('section');
    block.className = `author-items${quiet ? ' is-quiet' : ''}`;
    const heading = document.createElement('h3');
    heading.textContent = label;
    block.append(heading);
    const list = document.createElement('div');
    const bundle = page[key] || { items: [], nextCursor: '' };
    for (const item of bundle.items || []) {
      const readHere = key === 'unread' && page.justRead?.has(item.id);
      list.append(itemRow(author, item, readHere));
    }
    if (!(bundle.items || []).length) {
      const empty = document.createElement('p');
      empty.className = 'feed-empty';
      empty.textContent = key === 'unread' ? '没有未读' : '没有已读';
      list.append(empty);
    }
    block.append(list);
    if (bundle.nextCursor) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'author-more';
      more.textContent = '继续加载';
      more.addEventListener('click', async () => {
        more.disabled = true;
        const next = await loadItems(author.authorId, key, bundle.nextCursor);
        bundle.items = (bundle.items || []).concat(next.items || []);
        bundle.nextCursor = next.nextCursor || '';
        const root = block.closest('.page-root, #page-root') || document.getElementById('page-root');
        if (root) paintPage(root, author.authorId, page);
      });
      block.append(more);
    } else if (key === 'unread' && !page.read) {
      loadItems(author.authorId, 'read').then((read) => {
        page.read = read;
        const root = block.closest('#page-root') || document.getElementById('page-root');
        if (root) paintPage(root, author.authorId, page);
      }).catch(() => {});
    }
    return block;
  }

  function itemRow(author, item, grey) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `author-item${grey || item.isRead ? ' is-quiet' : ''}`;
    const when = document.createElement('time');
    when.textContent = clock(item.publishedAt);
    const title = document.createElement('strong');
    title.textContent = item.preview || item.title || '无标题';
    row.append(when, title);
    row.addEventListener('click', () => {
      remember(author.authorId);
      noteRead(author.authorId, item.id);
      openArticle({
        id: item.provider && item.externalId ? `${item.provider}:${item.externalId}` : item.id,
        resourceId: item.id,
        authorId: author.authorId,
        author: author.name,
        platform: item.provider || author.platform,
        title: item.title,
        sourceUrl: item.sourceUrl,
        publishedAt: item.publishedAt,
        kind: 'social',
      });
    });
    return row;
  }

  return { renderList, renderPage, noteRead, remember, syncWindow: syncAuthorWindow };
}
