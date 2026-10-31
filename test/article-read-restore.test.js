import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');

function functionSource(name) {
  const match = app.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, name);
  return match[0];
}

function element(tag) {
  return {
    tag,
    children: [],
    className: '',
    textContent: '',
    type: '',
    dataset: {},
    attrs: {},
    listeners: {},
    setAttribute(name, value) { this.attrs[name] = value; },
    getAttribute(name) { return this.attrs[name]; },
    append(...nodes) { this.children.push(...nodes); },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    replaceChildren(node) { this.children = node ? [node] : []; },
  };
}

function readerContext(performApi) {
  const timers = [];
  const state = {
    session: { role: 'device', device: { id: 'phone' } },
    restoredArticles: {},
    mediaItems: [{ id: 'media:other', externalId: 'other', title: '别的' }],
    pageKind: 'article',
    pageId: 'media:bbcworld:story',
    bootstrapped: true,
  };
  const context = {
    state,
    restoredArticleRequests: new Set(),
    restoredArticleErrors: new Map(),
    restoredArticleTokens: new Map(),
    MEDIA_ARTICLE_READ_MS: 8_000,
    timers,
    apiCalls: [],
    renders: 0,
    setTimeout(fn, ms) {
      const handle = { fn, ms, cleared: false };
      timers.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      if (handle) handle.cleared = true;
    },
    performApi,
    api(path) {
      context.apiCalls.push(path);
      return Promise.resolve({ item: null });
    },
    mediaAsItem(item) {
      return {
        id: item.id,
        platform: 'media',
        title: item.title,
        body: item.body,
        paragraphs: item.paragraphs || [],
        externalId: item.externalId,
      };
    },
    renderArticlePage() { context.renders += 1; },
    leaveArticle() {},
    document: { createElement: element },
  };
  vm.createContext(context);
  vm.runInContext([
    functionSource('renderViewState'),
    functionSource('mediaArticleRetriable'),
    functionSource('mediaArticleReadError'),
    functionSource('fetchMediaArticle'),
    functionSource('retrySavedArticle'),
    functionSource('paintArticleReadFailure'),
    functionSource('rememberReaderPost'),
    functionSource('articleReadStillCurrent'),
    functionSource('restoreSavedArticle'),
  ].join('\n'), context);
  return context;
}

const story = {
  id: 'media:bbcworld:story',
  externalId: 'bbcworld:story',
  title: 'BBC headline',
  body: 'The full article text.',
  paragraphs: [{ id: 'p1', kind: 'paragraph', text: 'The full article text.' }],
};

test('a media article opened from a report becomes readable and leaves the in-flight set', async () => {
  const calls = [];
  const context = readerContext((path, options, timeoutMs) => {
    calls.push({ path, options, timeoutMs });
    return Promise.resolve({ item: story });
  });
  await context.restoreSavedArticle('media:bbcworld:story');
  const saved = context.state.restoredArticles['media:bbcworld:story'];
  assert.equal(saved.readerLoaded, true);
  assert.equal(saved.platform, 'media');
  assert.equal(saved.title, 'BBC headline');
  assert.equal(saved.body, 'The full article text.');
  assert.equal(context.restoredArticleRequests.has('media:bbcworld:story'), false);
  assert.equal(context.restoredArticleErrors.has('media:bbcworld:story'), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/v1/feed/media/article?externalId=bbcworld%3Astory');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.equal(calls[0].timeoutMs, 8_000);
  assert.equal(context.apiCalls.length, 0);
  assert.equal(context.renders, 1);
  const post = saved.readerLoaded ? saved : null;
  const failedRead = context.restoredArticleErrors.get('media:bbcworld:story') || '';
  const needsReaderLoad = post?.platform !== 'media'
    && !context.state.restoredArticles['media:bbcworld:story']?.readerLoaded
    && !failedRead;
  assert.equal(Boolean(post), true);
  assert.equal(needsReaderLoad, false);
});

test('a dropped media read retries once, then shows a retryable error instead of staying loading', async () => {
  let attempt = 0;
  const context = readerContext(() => {
    attempt += 1;
    const error = new Error('Failed to fetch');
    return Promise.reject(error);
  });
  await context.restoreSavedArticle('media:techmeme:one');
  assert.equal(attempt, 2);
  assert.equal(context.restoredArticleErrors.get('media:techmeme:one'), '网络中断，正文没有读出来。');
  assert.equal(context.restoredArticleRequests.has('media:techmeme:one'), false);
  assert.equal(context.state.restoredArticles['media:techmeme:one'], undefined);
  const root = element('div');
  context.paintArticleReadFailure(root, 'media:techmeme:one', context.restoredArticleErrors.get('media:techmeme:one'));
  assert.equal(root.dataset.loadState, 'error');
  assert.equal(root.getAttribute('aria-busy'), 'false');
  const box = root.children[0];
  assert.equal(box.children[0].textContent, '文章没有读出来');
  assert.equal(box.children[1].textContent, '网络中断，正文没有读出来。');
  assert.equal(box.children[2].textContent, '重试');
  assert.equal(box.children[3].textContent, '返回信息流');
});

test('a missing media article does not retry and a hung read can still be retried', async () => {
  let attempt = 0;
  const missing = readerContext(() => {
    attempt += 1;
    const error = new Error('已保存文章不存在');
    error.status = 404;
    return Promise.reject(error);
  });
  await missing.restoreSavedArticle('media:zaobao:gone');
  assert.equal(attempt, 1);
  assert.equal(missing.restoredArticleErrors.get('media:zaobao:gone'), '已保存文章不存在');
  assert.equal(missing.restoredArticleRequests.has('media:zaobao:gone'), false);

  let release;
  const hung = readerContext(() => new Promise((resolve) => { release = resolve; }));
  const pending = hung.restoreSavedArticle('media:bbcworld:story');
  await Promise.resolve();
  const watch = hung.timers.find((timer) => !timer.cleared);
  assert.equal(watch.ms, 17_000);
  watch.fn();
  assert.equal(hung.restoredArticleErrors.get('media:bbcworld:story'), '正文读取超时，请重试。');
  assert.equal(hung.restoredArticleRequests.has('media:bbcworld:story'), false);
  release({ item: story });
  await pending;
  assert.equal(hung.state.restoredArticles['media:bbcworld:story'], undefined);
  hung.retrySavedArticle('media:bbcworld:story');
  assert.equal(hung.restoredArticleErrors.has('media:bbcworld:story'), false);
});

test('the article page paints a failure with retry and does not treat a saved media body as still loading', () => {
  const render = app.slice(app.indexOf('function renderArticlePage'), app.indexOf('function loadOfficialArticle'));
  assert.match(render, /paintArticleReadFailure\(root, itemId, failedRead\)/);
  assert.match(render, /kind: 'loading',\s*title: '正在读取文章…',\s*message: '正在读取正文和译文。'/);
  const restore = functionSource('restoreSavedArticle');
  assert.match(restore, /rememberReaderPost\(id, mediaAsItem\(item\)\)/);
  assert.match(restore, /fetchMediaArticle\(id\.slice\(6\)\)/);
  assert.equal(restore.includes('state.restoredArticles[id]=mediaAsItem'), false);
});
