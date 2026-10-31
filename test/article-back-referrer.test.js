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

function navigationContext() {
  const state = { trail: [], pageKind: 'article', pageId: 'feed:abc', navigationFrom: '' };
  const history = {
    state: null,
    url: '/app',
    backCount: 0,
    back() { this.backCount += 1; },
    replaceState(entry, _title, url) {
      this.state = entry;
      this.url = url;
    },
  };
  const location = { pathname: '/app', search: '', hash: '#article/feed:abc' };
  const targets = [];
  const context = vm.createContext({
    state,
    history,
    location,
    document: { body: { dataset: { view: 'page' } } },
    setView: (...args) => targets.push(args),
  });
  vm.runInContext([
    'normalizeRoute',
    'routeLabel',
    'returnTarget',
    'articleBackLabel',
    'goBack',
    'hashFromAbsoluteUrl',
    'rememberArticleHashReferrer',
  ].map(functionSource).join('\n'), context);
  context.targets = targets;
  return context;
}

test('an article opened from an hourly brief keeps that hour as the in-app back target', () => {
  const context = navigationContext();
  const previous = context.rememberArticleHashReferrer({
    oldURL: 'https://tradingplus.cn/app#report?hour=20',
  }, false);
  assert.equal(previous, '#report?hour=20');
  assert.equal(context.history.state.aiCenterPrevious, '#report?hour=20');
  assert.equal(context.history.state.hash, '#article/feed:abc');
  assert.equal(context.history.url, '/app#article/feed:abc');
  assert.equal(context.returnTarget(), 'report?hour=20');
  assert.equal(context.articleBackLabel(), '返回简报');
  context.goBack();
  assert.equal(context.history.backCount, 1);
  assert.equal(context.targets.length, 0);
});

test('an article opened from the feed still returns to the feed', () => {
  const context = navigationContext();
  context.location.hash = '#article/feed:abc';
  context.rememberArticleHashReferrer({ oldURL: 'https://tradingplus.cn/app#feed?tab=author' }, false);
  assert.equal(context.history.state.aiCenterPrevious, '#feed?tab=author');
  assert.equal(context.articleBackLabel(), '返回信息流');
  context.goBack();
  assert.equal(context.history.backCount, 1);
  assert.equal(context.targets.length, 0);
});

test('a direct article link still falls back to the feed, and browser traversal does not rewrite history', () => {
  const context = navigationContext();
  assert.equal(context.rememberArticleHashReferrer({ oldURL: 'https://tradingplus.cn/app' }, false), '');
  assert.equal(context.history.state, null);
  assert.equal(context.articleBackLabel(), '返回信息流');
  context.goBack();
  assert.equal(context.targets[0][0], 'feed');

  context.history.state = { aiCenter: true, hash: '#report?hour=20', aiCenterPrevious: '#sources' };
  context.location.hash = '#report?hour=20';
  assert.equal(context.rememberArticleHashReferrer({
    oldURL: 'https://tradingplus.cn/app#article/feed:abc',
  }, true), '');
  assert.equal(context.history.state.aiCenterPrevious, '#sources');
  assert.equal(context.history.state.hash, '#report?hour=20');
});

test('a later hashchange does not replace an article referrer already stored on that entry', () => {
  const context = navigationContext();
  context.history.state = {
    aiCenter: true,
    hash: '#article/feed:abc',
    aiCenterPrevious: '#report?hour=20',
  };
  assert.equal(context.rememberArticleHashReferrer({
    oldURL: 'https://tradingplus.cn/app#feed',
  }, false), '');
  assert.equal(context.history.state.aiCenterPrevious, '#report?hour=20');

  context.history.state = { aiCenter: true, hash: '#report?hour=20', aiCenterPrevious: '#feed' };
  context.location.hash = '#article/feed:abc';
  context.rememberArticleHashReferrer({ oldURL: 'https://tradingplus.cn/app#report?hour=20' }, false);
  assert.equal(context.history.state.hash, '#article/feed:abc');
  assert.equal(context.history.state.aiCenterPrevious, '#report?hour=20');
  assert.equal(context.articleBackLabel(), '返回简报');
});

test('article back copy follows the referrer and hash changes record it before rendering', () => {
  const render = app.slice(app.indexOf('function renderArticlePage'), app.indexOf('function loadOfficialArticle'));
  assert.equal(render.includes('返回信息流'), false);
  assert.match(render, /articleBackLabel\(\)/);
  const failure = functionSource('paintArticleReadFailure');
  assert.equal(failure.includes('返回信息流'), false);
  assert.match(failure, /articleBackLabel\(\)/);
  const hashchange = app.slice(app.indexOf("window.addEventListener('popstate'"), app.indexOf("document.addEventListener('visibilitychange'"));
  assert.match(hashchange, /articleReferrerFromTraversal/);
  assert.match(hashchange, /rememberArticleHashReferrer\(event, fromTraversal\)/);
  assert.match(hashchange, /setView\(location\.hash\.slice\(1\), \{ fromHistory: true \}\)/);
});
