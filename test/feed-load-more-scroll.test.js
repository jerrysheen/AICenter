import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');

function extract(name) {
  const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, name);
  return match[0];
}

function classListFor(el) {
  const names = () => String(el.className || '').split(/\s+/).filter(Boolean);
  return { contains: (name) => names().includes(name) };
}

test('a background reload keeps paged posts and puts new posts in front', async () => {
  const calls = [];
  let xReads = 0;
  let qReads = 0;
  const context = vm.createContext({
    URLSearchParams,
    FEED_PAGE_SIZE: 12,
    state: {
      session: {}, xFeed: 'following', xItems: [], xNextCursor: '', xReadCursor: '', feedShown: 12,
      xueqiuFeed: 'following', xueqiuItems: [], xueqiuNextCursor: '', xueqiuReadCursor: '',
    },
    api: async (url) => {
      calls.push(url);
      const path = String(url);
      if (path.includes('/feed/xueqiu')) {
        qReads += 1;
        if (path.includes('before=')) return { feed: { items: [{ id: 'q:2', summary: '第二页' }], nextCursor: '0,2,q:2' } };
        if (qReads === 1) return { feed: { items: [{ id: 'q:1', summary: '第一页' }], nextCursor: '0,1,q:1' } };
        return { feed: { items: [{ id: 'q:0', summary: '更新' }, { id: 'q:1', summary: '第一页' }], nextCursor: '0,9,reset' } };
      }
      xReads += 1;
      if (path.includes('before=')) return { feed: { items: [{ id: 'x:2', summary: '第二页' }], nextCursor: '0,2,x:2' } };
      if (xReads === 1) return { feed: { items: [{ id: 'x:1', summary: '第一页' }], nextCursor: '0,1,x:1' } };
      return { feed: { items: [{ id: 'x:0', summary: '新的一条' }, { id: 'x:1', summary: '第一页再次' }], nextCursor: '0,9,reset' } };
    },
    isHiddenFeedItem: () => false,
    hydrateFeedTranslations: () => {},
    renderPosts: () => {},
    renderXToolbar: () => {},
    renderXueqiuToolbar: () => {},
    syncLocalTranslationsToServer: () => Promise.resolve(),
    loadFeedTaggings: () => Promise.resolve(),
    translateXBatch: async () => {},
    document: { body: { dataset: {} } },
    renderOverviewTimeline: () => {},
  });
  vm.runInContext([
    extract('paintLoadedSocialFeed'),
    extract('mergeLoadedFeedItem'),
    extract('loadXFeed'),
    extract('loadXueqiuFeed'),
    'this.loadX = loadXFeed; this.loadQ = loadXueqiuFeed;',
  ].join('\n'), context);
  await context.loadX({ autoTranslate: false });
  await context.loadX({ append: true, autoTranslate: false });
  const opened = context.state.xItems.find((item) => item.id === 'x:1');
  opened.detail = 'full';
  opened.body = '已展开的全文';
  opened.translation = { text: '中文全文', engine: 'test' };
  const cursor = context.state.xNextCursor;
  const shown = context.state.feedShown;
  context.state.xReadCursor = 'read';
  await context.loadX({ autoTranslate: false });
  assert.deepEqual(Array.from(context.state.xItems, (item) => item.id), ['x:0', 'x:1', 'x:2']);
  assert.equal(context.state.xItems[1].body, '已展开的全文');
  assert.equal(context.state.xItems[1].translation.text, '中文全文');
  assert.equal(context.state.xNextCursor, cursor);
  assert.equal(context.state.xReadCursor, 'read');
  assert.equal(context.state.feedShown, shown + 1);
  assert.equal(calls.at(-1).includes('before='), false);

  await context.loadQ();
  await context.loadQ({ append: true });
  const qCursor = context.state.xueqiuNextCursor;
  await context.loadQ();
  assert.deepEqual(Array.from(context.state.xueqiuItems, (item) => item.id), ['q:0', 'q:1', 'q:2']);
  assert.equal(context.state.xueqiuNextCursor, qCursor);
});

test('rebuilding the feed keeps the visible card in place', () => {
  const window = {
    scrollY: 150,
    scrollTo(_x, y) { this.scrollY = y; },
    requestAnimationFrame(fn) { fn(); return 1; },
  };
  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.className = '';
      this.dataset = {};
      this.classList = classListFor(this);
      this.style = {};
    }
    append(...nodes) {
      for (const node of nodes) {
        node.parentNode = this;
        this.children.push(node);
      }
    }
    replaceChildren(...nodes) {
      this.children = [];
      if (nodes.length) this.append(...nodes);
    }
    querySelector() { return null; }
    querySelectorAll(selector) {
      const out = [];
      const visit = (node) => {
        for (const child of node.children || []) {
          if (matches(child, selector)) out.push(child);
          visit(child);
        }
      };
      visit(this);
      return out;
    }
    getBoundingClientRect() {
      const rows = [];
      const visit = (node) => {
        for (const child of node.children || []) {
          if (child.classList.contains('news-row')) rows.push(child);
          visit(child);
        }
      };
      visit(feed);
      const index = rows.indexOf(this);
      const top = index * 100 - window.scrollY;
      return { top, bottom: top + 100 };
    }
  }
  function matches(node, selector) {
    return selector.split(',').some((part) => {
      const one = part.trim();
      const className = one.match(/\.([A-Za-z0-9_-]+)/)?.[1];
      if (className && !node.classList.contains(className)) return false;
      const attr = one.match(/\[data-([a-z-]+)\]/)?.[1];
      if (!attr) return Boolean(className);
      const key = attr.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      return Boolean(node.dataset[key]);
    });
  }
  const feed = new El('div');
  const state = {
    channel: 'all',
    feedShown: 20,
    items: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id })),
  };
  const context = vm.createContext({
    window,
    document: {
      body: { dataset: { view: 'feed' }, classList: { contains: () => false } },
      querySelector: () => null,
      createElement: (tag) => new El(tag),
    },
    elements: { feed, 'feed-count': { textContent: '' } },
    state,
    restoringViewScroll: false,
    FEED_PAGE_SIZE: 12,
    visibleFeedItems: () => state.items,
    feedToNewsRow: (post) => ({ id: post.id }),
    feedCountLabel: () => '',
    renderNewsList(host, rows) {
      for (const row of rows) {
        const item = new El('li');
        item.className = 'news-row';
        item.dataset.nodeId = row.id;
        host.append(item);
      }
    },
    observeFeedSentinel() {},
    socialFeedHasMore: () => false,
    renderXToolbar() {},
    renderBilibiliToolbar() {},
  });
  vm.runInContext([
    extract('feedPaintId'),
    extract('captureFeedPaintAnchor'),
    extract('restoreFeedPaintAnchor'),
    extract('renderPosts'),
    'this.renderPosts = renderPosts;',
  ].join('\n'), context);
  context.renderPosts();
  const before = [...feed.querySelectorAll('.news-row')].find((row) => row.dataset.nodeId === 'c').getBoundingClientRect().top;
  state.items = [{ id: 'new' }, ...state.items];
  context.renderPosts();
  const card = [...feed.querySelectorAll('.news-row')].find((row) => row.dataset.nodeId === 'c');
  assert.equal(card.getBoundingClientRect().top, before);
  assert.equal(window.scrollY, 250);
  assert.deepEqual(feed.querySelectorAll('.news-row').map((row) => row.dataset.nodeId), ['new', 'a', 'b', 'c', 'd', 'e']);
});
