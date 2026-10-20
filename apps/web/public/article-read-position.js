export const ARTICLE_READ_POSITION_KEY = 'ai-center.article-read-position';
const POSITION_LIMIT = 80;

export function hash32(text) {
  let hash = 5381;
  const value = String(text || '');
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash * 33) ^ value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

export function readAnchorId(descriptor, seen = new Map()) {
  const paragraphId = String(descriptor?.paragraphId || '').trim();
  if (paragraphId) return `para:${paragraphId}`;
  const text = String(descriptor?.text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!text) return '';
  const kind = String(descriptor?.kind || 'p').toLowerCase();
  const base = `${kind}:${hash32(text).toString(36)}`;
  const count = seen.get(base) || 0;
  seen.set(base, count + 1);
  return count ? `${base}.${count}` : base;
}

export function loadArticleReadPositions(storage) {
  if (!storage || typeof storage.getItem !== 'function') return {};
  try {
    const parsed = JSON.parse(storage.getItem(ARTICLE_READ_POSITION_KEY) || '{}');
    const items = parsed?.items;
    if (!items || typeof items !== 'object' || Array.isArray(items)) return {};
    return items;
  } catch {
    return {};
  }
}

function writeItems(storage, items) {
  try {
    storage.setItem(ARTICLE_READ_POSITION_KEY, JSON.stringify({ version: 1, items }));
    return true;
  } catch {
    return false;
  }
}

export function saveArticleReadPosition(storage, articleId, position, now = Date.now()) {
  const id = String(articleId || '').trim();
  if (!storage || typeof storage.setItem !== 'function' || !id || !position?.anchorId) return false;
  const items = loadArticleReadPositions(storage);
  items[id] = {
    anchorId: String(position.anchorId),
    offset: Math.round(Number(position.offset) || 0),
    at: Number(now) || Date.now(),
  };
  const entries = Object.entries(items)
    .sort((left, right) => (Number(right[1]?.at) || 0) - (Number(left[1]?.at) || 0))
    .slice(0, POSITION_LIMIT);
  return writeItems(storage, Object.fromEntries(entries));
}

export function clearArticleReadPosition(storage, articleId) {
  const id = String(articleId || '').trim();
  if (!storage || typeof storage.setItem !== 'function' || !id) return false;
  const items = loadArticleReadPositions(storage);
  if (!items[id]) return false;
  delete items[id];
  return writeItems(storage, items);
}

export function pickReadAnchor(blocks, line = 0) {
  const mark = Number(line) || 0;
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block?.id) continue;
    const top = Number(block.top);
    const bottom = Number(block.bottom);
    if (!Number.isFinite(top) || !Number.isFinite(bottom)) continue;
    if (bottom <= mark + 1) continue;
    return { anchorId: String(block.id), offset: top - mark };
  }
  return null;
}

export function scrollTopForAnchor({ scrollY = 0, anchorTop = 0, line = 0, offset = 0 } = {}) {
  const top = Number(scrollY) + Number(anchorTop) - Number(line) - Number(offset);
  if (!Number.isFinite(top)) return 0;
  return Math.max(0, Math.round(top));
}

export function articleIsLong({ scrollHeight = 0, viewport = 0, minExtra = 240 } = {}) {
  const height = Number(scrollHeight) || 0;
  const view = Number(viewport) || 0;
  if (view <= 0) return height > 800;
  return height > view + minExtra;
}

export function reachedArticleEnd({ scrollY = 0, viewport = 0, scrollHeight = 0, threshold = 64 } = {}) {
  if (!articleIsLong({ scrollHeight, viewport })) return false;
  return (Number(scrollY) || 0) + (Number(viewport) || 0) >= (Number(scrollHeight) || 0) - threshold;
}

export function positionWorthRestoring(position, { firstAnchorId = '' } = {}) {
  if (!position?.anchorId) return false;
  const offset = Number(position.offset);
  if (!Number.isFinite(offset)) return false;
  if (position.anchorId === firstAnchorId && offset > -24 && offset < 80) return false;
  return true;
}

function anchorNodes(content) {
  if (!content || typeof content.querySelectorAll !== 'function') return [];
  const media = content.classList?.contains?.('media-article-content');
  const nodes = media
    ? content.querySelectorAll('[data-paragraph-id]')
    : content.querySelectorAll('h1, h2, h3, h4, p, li, blockquote');
  const list = [];
  for (const node of nodes) {
    if (typeof node.closest === 'function' && node.closest('.read-resume')) continue;
    if (!media && node.tagName !== 'LI' && typeof node.closest === 'function' && node.closest('li')) continue;
    list.push(node);
  }
  return list;
}

export function assignReadAnchors(content) {
  const seen = new Map();
  let count = 0;
  for (const node of anchorNodes(content)) {
    const id = readAnchorId({
      kind: String(node.tagName || 'p').toLowerCase(),
      text: node.textContent || '',
      paragraphId: node.dataset?.paragraphId || node.getAttribute?.('data-paragraph-id') || '',
    }, seen);
    if (!id) continue;
    if (node.dataset) node.dataset.readAnchor = id;
    else node.setAttribute?.('data-read-anchor', id);
    count += 1;
  }
  return count;
}

function defaultMetrics() {
  const scrollY = Number(globalThis.scrollY) || 0;
  const viewport = Number(globalThis.innerHeight) || 0;
  const scrollHeight = Number(globalThis.document?.documentElement?.scrollHeight) || 0;
  const toolbar = globalThis.document?.querySelector?.('.reading-toolbar');
  let line = 52;
  if (toolbar && typeof toolbar.getBoundingClientRect === 'function') {
    const hidden = globalThis.getComputedStyle?.(toolbar)?.display === 'none';
    if (!hidden) {
      const bottom = Number(toolbar.getBoundingClientRect().bottom);
      if (Number.isFinite(bottom)) line = Math.max(line, bottom);
    }
  }
  return { scrollY, viewport, scrollHeight, line: line + 8 };
}

function readBlocks(content) {
  const blocks = [];
  for (const node of anchorNodes(content)) {
    const id = node.dataset?.readAnchor || node.getAttribute?.('data-read-anchor') || '';
    if (!id || typeof node.getBoundingClientRect !== 'function') continue;
    const rect = node.getBoundingClientRect();
    const top = Number(rect?.top);
    const bottom = Number(rect?.bottom);
    if (!Number.isFinite(top) || !Number.isFinite(bottom)) continue;
    blocks.push({ id, top, bottom });
  }
  return blocks;
}

function showResumeBanner(shell, onStart) {
  if (!shell || typeof shell.querySelector !== 'function' || shell.querySelector('.read-resume')) return;
  const bar = document.createElement('p');
  bar.className = 'read-resume';
  bar.setAttribute('role', 'status');
  const label = document.createElement('span');
  label.textContent = '已回到上次阅读位置 · ';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '从头读';
  button.addEventListener('click', () => onStart());
  bar.append(label, button);
  const toolbar = typeof shell.querySelector === 'function' ? shell.querySelector('.reading-toolbar') : null;
  if (toolbar && typeof toolbar.after === 'function') toolbar.after(bar);
  else if (typeof shell.prepend === 'function') shell.prepend(bar);
  else shell.append?.(bar);
}

export function createArticleReadPosition(options = {}) {
  const storage = () => {
    try {
      return options.storage ? options.storage() : globalThis.localStorage;
    } catch {
      return null;
    }
  };
  const metrics = () => (options.metrics ? options.metrics() : defaultMetrics());
  let articleId = '';
  let shell = null;
  let timer = 0;
  let restoring = false;
  let listening = false;
  let dismissed = '';
  let restoredY = 0;
  let onScroll = null;
  let onHide = null;

  function contentOf(node = shell) {
    return node?.querySelector?.('.reader-content') || null;
  }

  function capture() {
    if (!articleId || restoring || !shell?.isConnected) return;
    const content = contentOf();
    if (!content) return;
    const view = metrics();
    if (!articleIsLong(view)) return;
    if (reachedArticleEnd(view)) {
      clearArticleReadPosition(storage(), articleId);
      return;
    }
    const picked = pickReadAnchor(readBlocks(content), view.line);
    if (!picked) return;
    saveArticleReadPosition(storage(), articleId, picked);
  }

  function bind() {
    if (listening || typeof globalThis.addEventListener !== 'function') return;
    listening = true;
    onScroll = () => {
      if (restoring) return;
      if (timer) return;
      timer = setTimeout(() => {
        timer = 0;
        capture();
        const banner = shell?.querySelector?.('.read-resume');
        if (!banner) return;
        if (Math.abs((metrics().scrollY || 0) - restoredY) > 160) {
          dismissed = articleId;
          banner.remove();
        }
      }, 120);
    };
    onHide = () => capture();
    globalThis.addEventListener('scroll', onScroll, { passive: true });
    globalThis.addEventListener('pagehide', onHide);
  }

  function unbind() {
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
    if (!listening || typeof globalThis.removeEventListener !== 'function') {
      listening = false;
      return;
    }
    globalThis.removeEventListener('scroll', onScroll);
    globalThis.removeEventListener('pagehide', onHide);
    listening = false;
  }

  function readFromStart() {
    clearArticleReadPosition(storage(), articleId);
    dismissed = articleId;
    shell?.querySelector?.('.read-resume')?.remove();
    restoring = true;
    try {
      globalThis.scrollTo?.({ top: 0, behavior: 'instant' });
    } finally {
      restoring = false;
    }
  }

  function restoreSaved() {
    if (!shell?.isConnected || !articleId) return;
    const content = contentOf();
    if (!content) return;
    assignReadAnchors(content);
    const view = metrics();
    if (!articleIsLong(view)) return;
    const saved = loadArticleReadPositions(storage())[articleId];
    const blocks = readBlocks(content);
    if (!positionWorthRestoring(saved, { firstAnchorId: blocks[0]?.id || '' })) return;
    const node = anchorNodes(content).find((item) => (item.dataset?.readAnchor || item.getAttribute?.('data-read-anchor')) === saved.anchorId);
    if (!node || typeof node.getBoundingClientRect !== 'function') return;
    const rect = node.getBoundingClientRect();
    const top = scrollTopForAnchor({
      scrollY: view.scrollY,
      anchorTop: Number(rect.top) || 0,
      line: view.line,
      offset: saved.offset,
    });
    restoring = true;
    try {
      globalThis.scrollTo?.({ top, behavior: 'instant' });
    } finally {
      restoring = false;
    }
    restoredY = top;
    if (dismissed === articleId) return;
    showResumeBanner(shell, readFromStart);
  }

  function scheduleRestore() {
    const frame = globalThis.requestAnimationFrame;
    if (typeof frame !== 'function') {
      restoreSaved();
      return;
    }
    frame(() => frame(() => frame(restoreSaved)));
  }

  return {
    capture,
    readFromStart,
    mount({ articleId: nextId, shell: nextShell } = {}) {
      const next = String(nextId || '');
      if (articleId && shell?.isConnected) capture();
      if (next !== articleId) dismissed = '';
      articleId = next;
      shell = nextShell || null;
      bind();
      const content = contentOf();
      if (content) assignReadAnchors(content);
      scheduleRestore();
    },
    unmount() {
      capture();
      articleId = '';
      shell = null;
      dismissed = '';
      unbind();
    },
  };
}
