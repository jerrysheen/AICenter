import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const authorSource = readFileSync(new URL('../apps/web/public/author-view.js', import.meta.url), 'utf8')
  .replace(/^export function /gm, 'function ');
const appSource = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');

function extract(source, name) {
  const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, name);
  return match[0];
}

function classListFor(el) {
  const names = () => String(el.className || '').split(/\s+/).filter(Boolean);
  return { contains: (name) => names().includes(name) };
}

function createDom() {
  const window = {
    scrollY: 0,
    moved: 0,
    usedScrollIntoView: false,
    scrollTo(x, y) {
      const top = typeof y === 'number' ? y : Number(x?.top);
      if (!Number.isFinite(top) || top === this.scrollY) return;
      this.scrollY = top;
      this.moved += 1;
    },
    requestAnimationFrame(fn) { fn(); return 1; },
    innerHeight: 800,
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    dispatchEvent(event) { for (const fn of this.listeners[event?.type] || []) fn(event); },
  };
  class El {
    constructor(tag = 'div') {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.dataset = {};
      this.attrs = {};
      this.listeners = {};
      this.className = '';
      this.textContent = '';
      this.style = {};
      this.classList = classListFor(this);
      this.scrollLeft = 0;
      this.disabled = false;
      this.type = '';
      this._connected = false;
    }
    get parentElement() { return this.parentNode; }
    get isConnected() {
      let node = this;
      while (node) {
        if (node._connected) return true;
        node = node.parentNode;
      }
      return false;
    }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    append(...nodes) {
      for (const node of nodes.flat()) {
        if (!node || typeof node !== 'object') continue;
        const previous = node.parentNode?.children;
        if (previous) {
          const index = previous.indexOf(node);
          if (index >= 0) previous.splice(index, 1);
        }
        node.parentNode = this;
        this.children.push(node);
      }
    }
    prepend(...nodes) {
      const list = nodes.flat().filter((node) => node && typeof node === 'object');
      for (const node of list) {
        const previous = node.parentNode?.children;
        if (previous) {
          const index = previous.indexOf(node);
          if (index >= 0) previous.splice(index, 1);
        }
        node.parentNode = this;
      }
      this.children.unshift(...list);
    }
    replaceChildren(...nodes) {
      this.replaceCount = (this.replaceCount || 0) + 1;
      for (const child of this.children) child.parentNode = null;
      this.children = [];
      if (nodes.length) this.append(...nodes);
    }
    replaceWith(node) {
      const parent = this.parentNode;
      if (!parent) return;
      const index = parent.children.indexOf(this);
      if (index < 0) return;
      node.parentNode = parent;
      parent.children.splice(index, 1, node);
      this.parentNode = null;
    }
    remove() {
      const list = this.parentNode?.children;
      if (!list) return;
      const index = list.indexOf(this);
      if (index >= 0) list.splice(index, 1);
      this.parentNode = null;
    }
    get offsetLeft() { return this.classList.contains('is-active') ? 240 : 0; }
    get offsetWidth() { return 48; }
    get clientWidth() { return this.classList.contains('author-switch') ? 120 : 0; }
    scrollIntoView() { window.usedScrollIntoView = true; }
    getBoundingClientRect() {
      if (this.classList.contains('author-list-rows')) {
        const top = -(Number(window.scrollY) || 0);
        return { top, bottom: top };
      }
      if (!this.classList.contains('author-row')) return { top: 0, bottom: 0 };
      let host = this.parentNode;
      while (host && !host.classList?.contains('author-list-rows')) host = host.parentNode;
      const rows = host?.querySelectorAll('.author-row') || [];
      const index = rows.indexOf(this);
      const spacer = Number.parseFloat(host?.querySelector('.author-spacer-top')?.style?.height) || 0;
      const stride = spacer ? 72 : 80;
      const top = spacer + index * stride - (Number(window.scrollY) || 0);
      return { top, bottom: top + 72 };
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) {
      const out = [];
      const walk = (node) => {
        for (const child of node.children || []) {
          if (matches(child, selector)) out.push(child);
          walk(child);
        }
      };
      walk(this);
      return out;
    }
  }
  function matches(node, selector) {
    if (selector.startsWith('.')) return node.classList.contains(selector.slice(1));
    return node.tagName === selector.toUpperCase();
  }
  const feed = new El('div');
  feed._connected = true;
  const body = { dataset: { view: 'feed' }, classList: { contains: () => false } };
  const document = {
    body,
    createElement: (tag) => new El(tag),
    querySelector: (selector) => (selector === '#feed' ? feed : null),
  };
  return { window, document, feed, body };
}

function authorRows(count) {
  return Array.from({ length: count }, (_, index) => ({
    authorId: `x:${index}`,
    name: `作者${index}`,
    handle: `u${index}`,
    platform: 'x',
    followed: false,
    unreadCount: 0,
    latestItemAt: 1_700_000_000_000 + index * 1000,
    latestTitleZh: `标题${index}`,
    avatarUrl: '',
  }));
}

function listPayload(rows, extra = {}) {
  return {
    counts: { all: rows.length, x: rows.length, xueqiu: 0, bilibili: 0, youtube: 0, official: 0, media: 0 },
    followed: rows.filter((row) => row.followed),
    others: rows.filter((row) => !row.followed),
    nextCursor: extra.nextCursor || '',
  };
}

function mountAuthorView(rows, api, options = {}) {
  const dom = createDom();
  if (options.wide) dom.window.matchMedia = (query) => ({ matches: String(query).includes('840px') });
  const context = vm.createContext({
    URLSearchParams,
    document: dom.document,
    window: dom.window,
    api,
    console,
  });
  vm.runInContext(`${authorSource}\nthis.createAuthorView = createAuthorView`, context);
  const view = context.createAuthorView({
    api,
    openAuthor() {},
    openArticle() {},
  });
  return { ...dom, view, calls: [] };
}

test('author list stays put while the same payload is painted again', async () => {
  const rows = authorRows(8);
  let calls = 0;
  const api = async () => {
    calls += 1;
    return listPayload(rows);
  };
  const { feed, view, window } = mountAuthorView(rows, api);
  await view.renderList(feed);
  const row = feed.querySelectorAll('.author-row')[6];
  const rowsHost = feed.querySelector('.author-list-rows');
  const replaced = rowsHost.replaceCount;
  const chipScroll = feed.querySelector('.author-switch').scrollLeft;
  window.scrollY = 400;
  for (let i = 0; i < 30; i += 1) await view.renderList(feed);
  assert.equal(calls, 1);
  assert.equal(window.scrollY, 400);
  assert.equal(window.moved, 0);
  assert.equal(window.usedScrollIntoView, false);
  assert.equal(feed.querySelectorAll('.author-row')[6], row);
  assert.equal(rowsHost.replaceCount, replaced);
  assert.equal(feed.querySelector('.author-switch').scrollLeft, chipScroll);
  assert.equal(chipScroll, 168);
  rows[6].unreadCount = 4;
  rows[6].latestTitleZh = '更新了';
  await view.renderList(feed);
  assert.equal(feed.querySelectorAll('.author-row')[6], row);
  assert.equal(row.querySelector('.author-unread').textContent, '4');
  assert.match(row.querySelector('.author-row-preview').textContent, /更新了/);
  assert.equal(rowsHost.replaceCount, replaced);
  assert.equal(window.scrollY, 400);
  assert.equal(window.moved, 0);
});

test('reordering authors keeps the anchored row at the same viewport offset', async () => {
  const rows = authorRows(8);
  const api = async (url, options = {}) => {
    if (String(url).includes('/follow')) {
      const id = decodeURIComponent(String(url).split('/authors/')[1].split('/')[0]);
      const row = rows.find((item) => item.authorId === id);
      row.followed = options.method !== 'DELETE';
      return { author: row };
    }
    return listPayload(rows);
  };
  const { feed, view, window } = mountAuthorView(rows, api);
  await view.renderList(feed);
  window.scrollY = 400;
  const anchor = feed.querySelectorAll('.author-row')[6];
  const moved = feed.querySelectorAll('.author-row')[7];
  assert.equal(anchor.dataset.authorId, 'x:6');
  assert.equal(moved.dataset.authorId, 'x:7');
  await moved.querySelector('.author-follow').listeners.click[0]({ preventDefault() {}, stopPropagation() {} });
  const painted = feed.querySelectorAll('.author-row');
  assert.equal(painted[0], moved);
  assert.equal(painted[0].dataset.authorId, 'x:7');
  assert.equal(painted[0].querySelector('.author-follow').textContent, '已关注');
  const anchorNow = painted.find((row) => row.dataset.authorId === 'x:6');
  assert.equal(anchorNow, anchor);
  assert.equal(window.scrollY, 480);
  assert.equal(anchorNow.getBoundingClientRect().top, 80);
  assert.equal(window.usedScrollIntoView, false);
});

test('background author refresh does not move an article or hourly report', async () => {
  const rows = authorRows(4);
  const api = async () => listPayload(rows);
  const { feed, view, window, body } = mountAuthorView(rows, api);
  await view.renderList(feed);
  window.scrollY = 640;
  body.dataset.view = 'page';
  rows[1].latestTitleZh = '文章还在读';
  await view.renderList(feed);
  assert.equal(window.scrollY, 640);
  assert.match(feed.querySelectorAll('.author-row')[1].querySelector('.author-row-preview').textContent, /文章还在读/);
  body.dataset.view = 'report';
  rows[1].latestTitleZh = '小时报还在读';
  await view.renderList(feed);
  assert.equal(window.scrollY, 640);
  assert.equal(window.moved, 0);
  assert.match(feed.querySelectorAll('.author-row')[1].querySelector('.author-row-preview').textContent, /小时报还在读/);
});

test('loading more authors keeps the current anchor', async () => {
  const rows = authorRows(8);
  const api = async (url) => {
    if (String(url).includes('cursor=')) {
      return {
        others: [{ authorId: 'x:more', name: '更多', platform: 'x', followed: false, unreadCount: 0, latestTitleZh: '后加', latestItemAt: 1_700_000_100_000 }],
        nextCursor: '',
      };
    }
    return listPayload(rows, { nextCursor: 'p2' });
  };
  const { feed, view, window } = mountAuthorView(rows, api);
  await view.renderList(feed);
  window.scrollY = 400;
  const anchor = feed.querySelectorAll('.author-row')[6];
  const more = feed.querySelector('.author-more');
  await more.onclick();
  const painted = feed.querySelectorAll('.author-row');
  assert.equal(painted.at(-1).dataset.authorId, 'x:more');
  assert.equal(painted.find((row) => row.dataset.authorId === 'x:6'), anchor);
  assert.equal(window.scrollY, 400);
  assert.equal(anchor.getBoundingClientRect().top, 80);
});

test('social feed polling does not repaint the author list', async () => {
  const calls = [];
  let rendered = 0;
  const context = vm.createContext({
    URLSearchParams,
    FEED_PAGE_SIZE: 12,
    state: {
      session: {}, channel: 'author', feedPlatform: 'all', feedEpoch: 3, feedShown: 12,
      xFeed: 'following', xItems: [], xNextCursor: '',
      xueqiuFeed: 'following', xueqiuItems: [], xueqiuNextCursor: '',
    },
    api: async (url) => {
      calls.push(url);
      if (String(url).includes('/feed/xueqiu')) {
        return { feed: { items: [{ id: 'q:new', resourceId: 'rq' }], nextCursor: '', feed: 'following' } };
      }
      return { feed: { items: [{ id: 'x:new', resourceId: 'rx' }], nextCursor: '', feed: 'following' } };
    },
    isHiddenFeedItem: () => false,
    hydrateFeedTranslations: () => {},
    renderPosts() { rendered += 1; },
    renderXToolbar: () => {},
    renderXueqiuToolbar: () => {},
    syncLocalTranslationsToServer: () => Promise.resolve(),
    loadFeedTaggings: () => Promise.resolve(),
    translateXBatch: async () => {},
    document: { body: { dataset: { view: 'feed' } } },
    renderOverviewTimeline: () => {},
  });
  vm.runInContext([
    extract(appSource, 'paintLoadedSocialFeed'),
    extract(appSource, 'mergeLoadedFeedItem'),
    extract(appSource, 'feedTagRefreshPaused'),
    extract(appSource, 'loadXFeed'),
    extract(appSource, 'loadXueqiuFeed'),
    'this.loadX = loadXFeed; this.loadQ = loadXueqiuFeed;',
  ].join('\n'), context);
  await context.loadX({ autoTranslate: false });
  await context.loadQ();
  await Promise.resolve();
  assert.equal(rendered, 0);
  assert.deepEqual(Array.from(context.state.xItems, (item) => item.id), ['x:new']);
  assert.deepEqual(Array.from(context.state.xueqiuItems, (item) => item.id), ['q:new']);
  assert.ok(calls.some((url) => url.includes('/api/v1/feed/x?') && url.includes('feed=following')));
  assert.ok(calls.some((url) => url.includes('/api/v1/feed/xueqiu?') && url.includes('feed=following')));
  context.state.channel = 'recent';
  await context.loadX({ autoTranslate: false });
  assert.equal(rendered, 0);
  context.state.channel = 'official';
  await context.loadX({ autoTranslate: false });
  assert.equal(rendered, 0);
  context.state.channel = 'all';
  context.state.xItems = [];
  await context.loadX({ autoTranslate: false });
  assert.ok(rendered >= 2);
  const socialRendered = rendered;
  context.state.channel = 'social';
  context.state.xItems = [];
  await context.loadX({ autoTranslate: false });
  assert.ok(rendered > socialRendered);
});

test('reading one unread drops the detail and list counts before the next fetch', async () => {
  const author = {
    authorId: 'x:wolfram',
    name: 'wolfram capital',
    platform: 'x',
    followed: true,
    unreadCount: 7,
    totalCount: 10,
    latestTitleZh: '最新',
    latestItemAt: 1_700_000_000_000,
  };
  const unread = Array.from({ length: 7 }, (_, index) => ({
    id: `item-${index}`,
    title: `未读${index}`,
    preview: `未读${index}`,
    publishedAt: 1_700_000_000_000 - index * 1000,
    isRead: false,
  }));
  const read = [{ id: 'old', title: '已读', preview: '已读', publishedAt: 1_600_000_000_000, isRead: true }];
  let listCalls = 0;
  const api = async (url) => {
    const path = String(url);
    if (path.includes('/items')) {
      return path.includes('read=unread')
        ? { items: unread, nextCursor: '' }
        : { items: read, nextCursor: '' };
    }
    if (path.includes('/authors?')) {
      listCalls += 1;
      return listPayload([{ ...author }]);
    }
    return { author: { ...author } };
  };
  const { feed, view, document } = mountAuthorView([], api);
  await view.renderList(feed);
  assert.equal(feed.querySelector('.author-unread').textContent, '7');
  const pageRoot = document.createElement('div');
  pageRoot._connected = true;
  await view.renderPage(pageRoot, 'x:wolfram');
  const item = [...pageRoot.querySelectorAll('.author-item')].find((node) => node.querySelector('strong').textContent === '未读0');
  item.listeners.click[0]();
  await view.renderPage(pageRoot, 'x:wolfram');
  assert.equal(pageRoot.querySelector('h3').textContent, '未读 · 6');
  const blocks = pageRoot.querySelectorAll('.author-items');
  assert.equal([...blocks[0].querySelectorAll('strong')].some((node) => node.textContent === '未读0'), false);
  assert.equal([...blocks[1].querySelectorAll('strong')].some((node) => node.textContent === '未读0'), true);
  await view.renderList(feed);
  assert.equal(feed.querySelector('.author-unread').textContent, '6');
  assert.equal(listCalls, 1);
  view.noteRead('x:wolfram', 'item-0');
  await view.renderPage(pageRoot, 'x:wolfram');
  await view.renderList(feed);
  assert.equal(pageRoot.querySelector('h3').textContent, '未读 · 6');
  assert.equal(feed.querySelector('.author-unread').textContent, '6');
});

test('a long author list paints a window and keeps the anchored row', async () => {
  const rows = authorRows(3500);
  const api = async () => listPayload(rows);
  const { feed, view, window } = mountAuthorView(rows, api);
  await view.renderList(feed);
  assert.ok(feed.querySelectorAll('.author-row').length < 40);
  assert.equal(feed.querySelector('.author-row').dataset.authorId, 'x:0');
  assert.equal(feed.querySelectorAll('.author-row').some((row) => row.dataset.authorId === 'x:3000'), false);
  window.scrollY = 1000 * 72;
  window.dispatchEvent({ type: 'scroll' });
  const deep = feed.querySelectorAll('.author-row');
  assert.ok(deep.length < 40);
  assert.equal(deep.some((row) => row.dataset.authorId === 'x:991'), true);
  assert.equal(deep.some((row) => row.dataset.authorId === 'x:0'), false);
  window.scrollY = 0;
  window.dispatchEvent({ type: 'scroll' });
  assert.equal(feed.querySelector('.author-row').dataset.authorId, 'x:0');
  assert.ok(feed.querySelectorAll('.author-row').length < 40);

  const shorter = authorRows(120);
  const again = mountAuthorView(shorter, async () => listPayload(shorter));
  await again.view.renderList(again.feed);
  again.window.scrollY = 40 * 72;
  again.window.dispatchEvent({ type: 'scroll' });
  const anchor = [...again.feed.querySelectorAll('.author-row')].find((row) => row.getBoundingClientRect().bottom > 96);
  const before = anchor.getBoundingClientRect().top;
  const anchorId = anchor.dataset.authorId;
  const moved = shorter[shorter.length - 1];
  shorter.splice(shorter.length - 1, 1);
  shorter.unshift(moved);
  await again.view.renderList(again.feed);
  const kept = [...again.feed.querySelectorAll('.author-row')].find((row) => row.dataset.authorId === anchorId);
  assert.ok(kept);
  assert.equal(kept.getBoundingClientRect().top, before);
  assert.notEqual(again.window.scrollY, 0);
  assert.equal(again.window.usedScrollIntoView, false);
});

test('returning to the feed restores the saved position and the scope hash', () => {
  const setView = extract(appSource, 'setView');
  assert.match(setView, /view === 'feed' && options\.replace\) scrollFeedToTop\(\)/);
  assert.match(setView, /view === 'feed' && leaving\) restoreViewScroll\('feed'\)/);
  assert.doesNotMatch(setView, /view === 'feed' && \(leaving \|\| options\.replace\)\) scrollFeedToTop\(\)/);
  assert.match(extract(appSource, 'applyFeedPlatform'), /syncFeedScopeHash\(\)/);
  assert.match(extract(appSource, 'selectFeedScope'), /syncFeedScopeHash\(\)/);
  assert.match(extract(appSource, 'restoreViewScroll'), /syncAuthorListWindow\(\)/);

  const scrolls = [];
  const restore = vm.createContext({
    viewScrollY: { feed: 640 },
    state: { feedAnchorId: '', channel: 'all' },
    restoringViewScroll: false,
    document: {
      body: { classList: { contains: () => false }, dataset: { view: 'feed' } },
      querySelector() { return null; },
    },
    window: {
      scrollY: 0,
      scrollTo(_x, y) { this.scrollY = y; scrolls.push(y); },
      requestAnimationFrame(fn) { fn(); },
    },
    requestAnimationFrame(fn) { fn(); },
    visibleFeedItems: () => [],
    FEED_PAGE_SIZE: 12,
    renderPosts() {},
  });
  vm.runInContext(`${extract(appSource, 'restoreViewScroll')}\nthis.restoreViewScroll = restoreViewScroll;`, restore);
  restore.restoreViewScroll('feed');
  assert.equal(scrolls.at(-1), 640);
  assert.equal(restore.viewScrollY.feed, 640);

  const location = { hash: '#feed?tab=author', pathname: '/', search: '' };
  const history = {
    state: { aiCenter: true },
    replaceState(next, _title, url) {
      this.state = next;
      location.hash = url.slice(url.indexOf('#'));
    },
  };
  const hashBox = vm.createContext({
    state: { channel: 'all' },
    document: { body: { dataset: { view: 'feed' } } },
    history,
    location,
  });
  vm.runInContext(`${extract(appSource, 'syncFeedScopeHash')}\nthis.syncFeedScopeHash = syncFeedScopeHash;`, hashBox);
  hashBox.syncFeedScopeHash();
  assert.equal(location.hash, '#feed');
  hashBox.state.channel = 'author';
  hashBox.syncFeedScopeHash();
  assert.equal(location.hash, '#feed?tab=author');
  hashBox.document.body.dataset.view = 'inspire';
  location.hash = '#feed?tab=author';
  hashBox.state.channel = 'all';
  hashBox.syncFeedScopeHash();
  assert.equal(location.hash, '#feed?tab=author');
});

test('a wide virtual author list sizes the spacer by column count', async () => {
  const rows = authorRows(80);
  const { feed, view, window } = mountAuthorView(rows, async () => listPayload(rows), { wide: true });
  await view.renderList(feed);
  const bottom = Number.parseFloat(feed.querySelector('.author-spacer-bottom')?.style?.height) || 0;
  const singleColumnBottom = (1 + rows.length - 28) * 72;
  assert.equal(bottom, 13 * 72);
  assert.ok(bottom * 2 < singleColumnBottom);
  window.scrollY = 10 * 72;
  window.dispatchEvent({ type: 'scroll' });
  assert.equal(feed.querySelector('.author-row').dataset.authorId, 'x:2');
  assert.equal(Number.parseFloat(feed.querySelector('.author-spacer-top').style.height), 2 * 72);
});
