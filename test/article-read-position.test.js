import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ARTICLE_READ_POSITION_KEY,
  articleIsLong,
  articleReadKey,
  clearArticleReadPosition,
  createArticleReadPosition,
  loadArticleReadPositions,
  pickReadAnchor,
  positionWorthRestoring,
  reachedArticleEnd,
  readAnchorId,
  saveArticleReadPosition,
  scrollTopForAnchor,
} from '../apps/web/public/article-read-position.js';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); },
  };
}

test('reading position uses a stable anchor and offset, not only pixels', () => {
  const seen = new Map();
  const first = readAnchorId({ kind: 'h3', text: '利率路径（00:12:03）' }, seen);
  const again = readAnchorId({ kind: 'h3', text: '利率路径（00:12:03）' }, seen);
  assert.equal(first.startsWith('h3:'), true);
  assert.equal(again, `${first}.1`);
  assert.equal(readAnchorId({ paragraphId: 'p-9', text: '别的' }, new Map()), 'para:p-9');
  const blocks = [
    { id: first, top: 20, bottom: 80 },
    { id: 'h3:later', top: 400, bottom: 460 },
  ];
  assert.deepEqual(pickReadAnchor(blocks, 100), { anchorId: 'h3:later', offset: 300 });
  assert.equal(scrollTopForAnchor({ scrollY: 900, anchorTop: 120, line: 60, offset: 300 }), 660);
  assert.equal(positionWorthRestoring({ anchorId: first, offset: 4 }, { firstAnchorId: first }), false);
  assert.equal(positionWorthRestoring({ anchorId: 'h3:later', offset: -20 }, { firstAnchorId: first }), true);
});

test('positions are stored per article and cleared at the end or from the start', () => {
  const storage = memoryStorage();
  assert.equal(articleIsLong({ scrollHeight: 2000, viewport: 800 }), true);
  assert.equal(articleIsLong({ scrollHeight: 900, viewport: 800 }), false);
  assert.equal(reachedArticleEnd({ scrollY: 1140, viewport: 800, scrollHeight: 2000 }), true);
  assert.equal(reachedArticleEnd({ scrollY: 400, viewport: 800, scrollHeight: 2000 }), false);
  assert.equal(reachedArticleEnd({ scrollY: 100, viewport: 800, scrollHeight: 900 }), false);
  saveArticleReadPosition(storage, 'article-a', { anchorId: 'h3:later', offset: -12 }, 10);
  saveArticleReadPosition(storage, 'article-b', { anchorId: 'p:1', offset: 4 }, 20);
  assert.deepEqual(loadArticleReadPositions(storage)['article-a'], { anchorId: 'h3:later', offset: -12, at: 10 });
  assert.equal(clearArticleReadPosition(storage, 'article-a'), true);
  assert.equal(loadArticleReadPositions(storage)['article-a'], undefined);
  assert.equal(loadArticleReadPositions(storage)['article-b'].anchorId, 'p:1');
  assert.match(storage.getItem(ARTICLE_READ_POSITION_KEY), /article-b/);
  const broken = memoryStorage({ [ARTICLE_READ_POSITION_KEY]: '{oops' });
  assert.deepEqual(loadArticleReadPositions(broken), {});
  assert.equal(articleReadKey('youtube%3ApC3QbOu7_s4'), 'youtube:pC3QbOu7_s4');
  assert.equal(articleReadKey('youtube:pC3QbOu7_s4'), 'youtube:pC3QbOu7_s4');
});

test('leaving a youtube article keeps the paragraph when the page scroll jumps home', () => {
  const appSource = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');
  assert.match(appSource, /articleReadKey\(itemId\)/);
  assert.match(appSource, /pageKind === 'article'\) \{\s*try \{ history\.scrollRestoration = 'manual'; \}/);

  const storage = memoryStorage();
  const view = { scrollY: 0, viewport: 800, scrollHeight: 8000, line: 60 };
  const scrolls = [];
  const listeners = new Map();
  const previous = {
    addEventListener: globalThis.addEventListener,
    removeEventListener: globalThis.removeEventListener,
    scrollTo: globalThis.scrollTo,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    history: globalThis.history,
    document: globalThis.document,
  };
  function listen(type, fn) {
    const list = listeners.get(type) || [];
    list.push(fn);
    listeners.set(type, list);
  }
  function unlisten(type, fn) {
    listeners.set(type, (listeners.get(type) || []).filter((item) => item !== fn));
  }
  function element(tag, text, top) {
    return {
      tagName: tag,
      textContent: text,
      dataset: {},
      docTop: top,
      closest: () => null,
      getBoundingClientRect() {
        return { top: this.docTop - view.scrollY, bottom: this.docTop + 40 - view.scrollY };
      },
      setAttribute() {},
    };
  }
  const title = element('H3', '对话开场', 80);
  const section = element('H3', '部署逻辑与 Scaling Law（00:06:06）', 2400);
  const content = {
    classList: { contains: () => false },
    querySelectorAll: () => [title, section],
  };
  const shell = {
    isConnected: true,
    prepend() {},
    querySelector(selector) {
      if (selector === '.reader-content') return content;
      return null;
    },
  };
  globalThis.addEventListener = listen;
  globalThis.removeEventListener = unlisten;
  globalThis.scrollTo = (arg) => {
    const top = typeof arg === 'number' ? arg : Number(arg?.top) || 0;
    scrolls.push(top);
    view.scrollY = top;
  };
  globalThis.requestAnimationFrame = (fn) => {
    fn();
    return 1;
  };
  globalThis.history = { scrollRestoration: 'auto' };
  globalThis.document = {
    createElement() {
      return {
        className: '',
        textContent: '',
        setAttribute() {},
        append() {},
        addEventListener() {},
      };
    },
  };
  const reader = createArticleReadPosition({ storage: () => storage, metrics: () => view });
  try {
    reader.mount({ articleId: 'youtube%3ApC3QbOu7_s4', shell });
    assert.equal(globalThis.history.scrollRestoration, 'manual');
    view.scrollY = 2200;
    for (const fn of listeners.get('scroll') || []) fn();
    view.scrollY = 0;
    for (const fn of [...(listeners.get('scroll') || [])]) fn();
    reader.unmount();
    const saved = loadArticleReadPositions(storage)['youtube:pC3QbOu7_s4'];
    assert.equal(saved.anchorId, readAnchorId({ kind: 'h3', text: '部署逻辑与 Scaling Law（00:06:06）' }, new Map()));
    assert.notEqual(saved.anchorId, readAnchorId({ kind: 'h3', text: '对话开场' }, new Map()));

    scrolls.length = 0;
    view.scrollY = 0;
    reader.mount({ articleId: 'youtube:pC3QbOu7_s4', shell });
    assert.ok(scrolls.some((top) => top > 1000));
    reader.unmount();
    assert.equal(loadArticleReadPositions(storage)['youtube:pC3QbOu7_s4'].anchorId, saved.anchorId);
  } finally {
    globalThis.addEventListener = previous.addEventListener;
    globalThis.removeEventListener = previous.removeEventListener;
    globalThis.scrollTo = previous.scrollTo;
    globalThis.requestAnimationFrame = previous.requestAnimationFrame;
    globalThis.history = previous.history;
    globalThis.document = previous.document;
  }
});
