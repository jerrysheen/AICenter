import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');
const cssSource = readFileSync(new URL('../apps/web/public/styles.css', import.meta.url), 'utf8');
const bootSource = readFileSync(new URL('../apps/web/public/ui-boot.js', import.meta.url), 'utf8');
const htmlSource = readFileSync(new URL('../apps/web/public/index.html', import.meta.url), 'utf8');

function functionSource(name) {
  const match = appSource.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, name);
  return match[0];
}

function sourceBetween(start, end) {
  const from = appSource.indexOf(start);
  const to = appSource.indexOf(end);
  assert.ok(from >= 0 && to > from, `${start} → ${end}`);
  return appSource.slice(from, to);
}

class Node {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attrs = {};
    this._text = '';
    this._className = '';
    this.classList = {
      contains: (name) => this._className.split(/\s+/).includes(name),
      add: (...names) => {
        for (const name of names) if (!this.classList.contains(name)) this._className = `${this._className} ${name}`.trim();
      },
      remove: (...names) => {
        const drop = new Set(names);
        this._className = this._className.split(/\s+/).filter((name) => name && !drop.has(name)).join(' ');
      },
      toggle: (name, force) => {
        const on = force === undefined ? !this.classList.contains(name) : Boolean(force);
        if (on) this.classList.add(name);
        else this.classList.remove(name);
        return on;
      },
    };
  }

  get className() { return this._className; }
  set className(value) { this._className = String(value || ''); }

  get textContent() {
    return `${this._text}${this.children.map((child) => child.textContent || '').join('')}`;
  }

  set textContent(value) {
    this._text = String(value ?? '');
    this.children = [];
  }

  setAttribute(key, value) { this.attrs[key] = String(value); }
  removeAttribute(key) { delete this.attrs[key]; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) {
    this._text = '';
    this.children = [];
    this.append(...nodes);
  }
}

function elementTree() {
  const byClass = new Map();
  const make = (tag, className) => {
    const node = new Node(tag);
    node.className = className;
    for (const name of className.split(/\s+/)) if (name) byClass.set(name, node);
    return node;
  };
  const title = make('h2', 'detail-title');
  const meta = make('div', 'detail-meta');
  const last = make('strong', 'last num');
  const change = make('b', 'change');
  const basis = make('p', 'quote-basis');
  const wrap = new Node('article');
  wrap.className = 'detail-shell quote-detail';
  wrap.dataset = { group: '', asset: '' };
  wrap.querySelector = (selector) => {
    const name = selector.replace('.', '');
    return byClass.get(name) || null;
  };
  return { wrap, title, meta, last, change, basis };
}

function quoteContext() {
  const document = {
    createElement: (tag) => new Node(tag),
    createTextNode: (text) => ({ textContent: String(text ?? '') }),
  };
  const context = vm.createContext({ document, state: { pageId: '688361.SS' } });
  vm.runInContext([
    sourceBetween('const QUOTE_ASSET_LABELS', 'function quotePriceReady'),
    functionSource('sessionLabel'),
    functionSource('quotePriceReady'),
    functionSource('quoteMetaParts'),
    functionSource('quoteSkeletonBar'),
    functionSource('quoteTitleText'),
    functionSource('keptQuoteName'),
    functionSource('paintPendingQuoteSlot'),
    functionSource('formatPrice'),
    functionSource('formatPct'),
    functionSource('quoteInstant'),
    functionSource('shanghaiQuoteParts'),
    functionSource('formatQuoteStamp'),
    functionSource('formatQuoteDay'),
    functionSource('quoteBasisText'),
    functionSource('paintQuoteFigures'),
  ].join('\n'), context);
  return context;
}

test('quote subtitle maps asset classes into Chinese and omits unknown English', () => {
  const context = quoteContext();
  assert.equal(context.quoteAssetLabel('equity'), '股票');
  assert.deepEqual(
    ['index', 'fx', 'rate', 'metal', 'energy', 'future', 'crypto', 'fund', 'cash', 'etf'].map((key) => context.quoteAssetLabel(key)),
    ['指数', '外汇', '利率', '贵金属', '能源', '期货', '加密', '基金', '现金', 'ETF'],
  );
  assert.equal(context.quoteAssetLabel('widget'), '');
  assert.equal(context.quoteAssetLabel(''), '');
  const ready = context.quoteMetaParts({
    symbol: '688361.SS',
    name: '中科飞测',
    group: '半导体设备',
    assetClass: 'equity',
    lastPrice: 81.2,
    session: 'break',
  }, '688361.SS');
  assert.equal(ready.pending, false);
  assert.equal(ready.text, '688361.SS · 半导体设备 · 股票 · 午间休市');
  assert.equal(ready.text.includes('equity'), false);
});

test('quote page keeps status and placeholder price off the screen until a price arrives', () => {
  const context = quoteContext();
  const pendingQuote = {
    symbol: '688361.SS',
    name: '688361.SS',
    lastPrice: null,
    changePct: null,
    prevClose: null,
    asOf: null,
    session: 'closed',
    group: '半导体设备',
    assetClass: 'equity',
  };
  const parts = context.quoteMetaParts(pendingQuote, '688361.SS');
  assert.equal(parts.pending, true);
  assert.equal(parts.text.includes('休市'), false);
  assert.equal(parts.text.includes('equity'), false);
  const view = elementTree();
  context.paintQuoteFigures(view.wrap, pendingQuote);
  assert.equal(view.title.textContent, '');
  assert.equal(view.title.classList.contains('is-pending'), true);
  assert.equal(view.title.textContent.includes('688361'), false);
  assert.equal(view.meta.textContent.includes('688361'), false);
  assert.equal(view.meta.textContent.includes('·'), false);
  assert.equal(view.meta.textContent.includes('半导体'), false);
  assert.equal(view.meta.textContent.includes('股票'), false);
  assert.equal(view.meta.textContent.includes('休市'), false);
  assert.equal(view.meta.attrs['aria-busy'], 'true');
  assert.equal(view.meta.children.some((child) => child.className === 'quote-skeleton'), true);
  assert.equal(view.last.textContent.includes('—'), false);
  assert.equal(view.last.classList.contains('is-pending'), true);
  assert.equal(view.change.textContent.includes('—'), false);
  assert.equal(view.change.classList.contains('is-pending'), true);
  assert.equal(view.basis.textContent, '');

  context.paintQuoteFigures(view.wrap, {
    symbol: '688361.SS',
    name: '中科飞测',
    group: '半导体设备',
    assetClass: 'equity',
    lastPrice: 81.2,
    changePct: -2.4,
    prevClose: 83.2,
    session: 'break',
    asOf: Date.parse('2026-10-20T04:00:00Z'),
  });
  assert.equal(view.title.textContent, '中科飞测');
  assert.equal(view.title.classList.contains('is-pending'), false);
  assert.equal(view.meta.textContent, '688361.SS · 半导体设备 · 股票 · 午间休市');
  assert.equal(view.meta.attrs['aria-busy'], undefined);
  assert.equal(view.last.classList.contains('is-pending'), false);
  assert.equal(view.last.textContent.includes('—'), false);
  assert.equal(view.last.textContent.includes('81.2'), true);
  assert.equal(view.change.classList.contains('is-pending'), false);
  assert.equal(view.change.textContent, '-2.40%');
});

test('opening a quote resets the page scroll and still restores the list', () => {
  const setView = functionSource('setView');
  const lockAt = setView.indexOf('restoringViewScroll = true');
  const tryAt = setView.indexOf('try {', lockAt);
  const swapAt = setView.indexOf('document.body.dataset.view = view');
  const topAt = setView.indexOf('scrollPageToTop()');
  const restoreAt = setView.indexOf('restoreViewScroll(view)');
  const finallyAt = setView.lastIndexOf('finally {');
  assert.ok(lockAt > 0 && tryAt > lockAt && tryAt < swapAt);
  assert.ok(finallyAt > swapAt);
  assert.match(setView, /finally \{[\s\S]*if \(releaseViewScroll\) restoringViewScroll = false/);
  assert.match(setView, /view === 'feed' && \(leaving \|\| options\.replace\)\) scrollFeedToTop\(\)/);
  assert.ok(topAt > 0 && topAt < restoreAt);
  assert.match(setView, /openingQuote \|\| \(leaving && view !== 'feed' && !reportViewOwnsScroll\(view, briefPage\.hasHourScroll\(\)\)\)/);
  assert.match(cssSource, /body\[data-view="page"\]:has\(\.quote-detail\) \{ overflow-anchor: none; \}/);
  assert.match(cssSource, /\.quote-skeleton \{/);

  const scrolls = [];
  let blurred = false;
  const context = vm.createContext({
    viewScrollY: { market: 640, page: 28, report: 400 },
    restoringViewScroll: false,
    document: {
      body: { dataset: { view: 'page' }, classList: { contains: () => false } },
      activeElement: { blur() { blurred = true; } },
    },
    history: { scrollRestoration: 'auto' },
    window: {
      scrollTo(_x, y) { scrolls.push(y); },
      requestAnimationFrame(fn) { fn(); },
    },
  });
  vm.runInContext([
    functionSource('openingQuotePage'),
    functionSource('scrollPageToTop'),
  ].join('\n'), context);
  assert.equal(context.openingQuotePage({
    view: 'page', pageKind: 'quote', previousPageKind: '', previousPageId: '', pageId: '688361.SS',
  }), true);
  assert.equal(context.openingQuotePage({
    view: 'page', pageKind: 'quote', previousPageKind: 'quote', previousPageId: '300852.SZ', pageId: '688361.SS',
  }), true);
  assert.equal(context.openingQuotePage({
    view: 'page', pageKind: 'quote', previousPageKind: 'quote', previousPageId: '688361.SS', pageId: '688361.SS',
  }), false);
  assert.equal(context.openingQuotePage({
    view: 'page', pageKind: 'quote', previousPageKind: '', previousPageId: '', pageId: '688361.SS', fromHistory: true,
  }), false);
  assert.equal(context.openingQuotePage({
    view: 'page', pageKind: 'quote', previousPageKind: '', previousPageId: '', pageId: '688361.SS', back: true,
  }), false);
  assert.equal(context.openingQuotePage({
    view: 'report', pageKind: '', previousPageKind: 'quote', previousPageId: '688361.SS', pageId: '',
  }), false);
  assert.equal(context.openingQuotePage({
    view: 'market', pageKind: '', previousPageKind: 'quote', previousPageId: '688361.SS', pageId: '',
  }), false);
  context.scrollPageToTop();
  assert.deepEqual(scrolls, [0, 0, 0]);
  assert.equal(context.viewScrollY.page, 0);
  assert.equal(context.viewScrollY.market, 640);
  assert.equal(context.viewScrollY.report, 400);
  assert.equal(context.restoringViewScroll, false);
  assert.equal(context.history.scrollRestoration, 'manual');
  assert.equal(blurred, true);
});

test('quote hash paints a skeleton before startup requests and does not leave a partial subtitle', () => {
  const hashContext = vm.createContext({ location: { hash: '#quote/300852.SZ' } });
  vm.runInContext(functionSource('quoteHashPath'), hashContext);
  assert.equal(hashContext.quoteHashPath(), 'quote/300852.SZ');
  hashContext.location.hash = '#quote/300852.SZ?from=list';
  assert.equal(hashContext.quoteHashPath(), 'quote/300852.SZ');
  hashContext.location.hash = '#sources';
  assert.equal(hashContext.quoteHashPath(), '');
  hashContext.location.hash = '#quote';
  assert.equal(hashContext.quoteHashPath(), '');
  assert.match(functionSource('bootQuoteRoute'), /setView\(route, \{ replace: true \}\)/);

  const init = functionSource('initialize');
  const bootAt = init.indexOf('bootQuoteRoute()');
  const awaitAt = init.indexOf('await ');
  assert.ok(bootAt > 0 && bootAt < awaitAt);

  const render = functionSource('renderQuotePage');
  const guardAt = render.indexOf('if (!state.session) return;');
  const historyAt = render.indexOf('loadQuoteHistory(');
  assert.ok(guardAt > 0 && guardAt < historyAt);

  const setView = functionSource('setView');
  const titleAt = setView.indexOf('pageKinds[state.pageKind]?.title');
  const releaseAt = setView.indexOf("classList.remove('quote-boot')");
  assert.ok(titleAt > 0 && releaseAt > titleAt);

  assert.match(bootSource, /quote-boot/);
  assert.match(bootSource, /#quote\\\/\[\^\/\?#\]\+/);
  assert.match(cssSource, /html\.quote-boot \.view \{ display: none; \}/);
  assert.match(cssSource, /html\.quote-boot #view-page \{ display: block; \}/);
  assert.doesNotMatch(cssSource, /html\.quote-boot body\[data-view="sources"\] #view-page/);
  const desktop = cssSource.slice(cssSource.indexOf('@media (min-width: 1200px)'));
  assert.match(desktop, /html\.has-known-session body\.is-unpaired \.app-shell,\s*html\.has-known-session body:not\(\.is-ready\) \.app-shell,\s*html\.quote-boot \.app-shell \{\s*display: grid;/);
  assert.match(cssSource, /html\.quote-boot #page-title \.page-title-boot \{ display: inline; \}/);
  assert.match(htmlSource, /class="page-title-boot">行情</);
  const skeleton = htmlSource.match(/id="quote-boot-skeleton"[\s\S]*?<\/article>/);
  assert.ok(skeleton);
  assert.match(skeleton[0], /quote-skeleton/);
  assert.match(skeleton[0], /is-pending/);
  assert.doesNotMatch(skeleton[0], /·|休市|—|\d{6}/);

  assert.doesNotMatch(functionSource('scheduleOverviewManualPosts'), /showToast/);
  assert.match(functionSource('flushBehavior'), /\.catch\(\(\) => \{\}\)/);
  assert.doesNotMatch(functionSource('flushBehavior'), /showToast/);
  const streamStart = appSource.indexOf('function connectStream()');
  const streamEnd = appSource.indexOf('async function pairFromUrl(');
  const stream = appSource.slice(streamStart, streamEnd);
  assert.match(stream, /onerror = \(\) => setConnection\('waiting', '正在重连'\)/);
  assert.doesNotMatch(stream, /请求超时/);
  const startup = functionSource('completeAuthorizedStart');
  const streamCall = startup.indexOf('connectStream()');
  const awaited = startup.indexOf('await Promise.all(startupLoads)');
  assert.ok(streamCall > 0 && streamCall < awaited);
  assert.doesNotMatch(startup, /await connectStream|await flushBehavior|await loadPosts/);
});
