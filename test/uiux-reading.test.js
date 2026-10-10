import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { renderQuantLab } from '../apps/web/public/quant-lab.js';

const app = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = app.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, name);
  return match[0];
}
const helpers = vm.createContext({ document: { createElement: tag => globalThis.document.createElement(tag) } });
vm.runInContext(['normalizeRoute', 'routeLabel', 'renderViewState'].map(functionSource).join('\n'), helpers);
const { normalizeRoute, routeLabel, renderViewState } = helpers;
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('canonical and slash-prefixed deep links resolve to the same target and return label', () => {
  const context = vm.createContext({ normalizeRoute, URLSearchParams,
    location: { hash: '#sources' }, viewCopy: { sources: {}, market: {}, assets: {}, report: {}, ask: {}, settings: {}, inspire: {} },
    pageKinds: { article: {} },
  });
  vm.runInContext(`${functionSource('resolveView')}\n${functionSource('parseLocation')}`, context);
  for (const route of ['sources/catalog', 'sources/schedule', 'market/global', 'assets/analysis', 'assets/holdings', 'report/history', 'ask/new', 'article/x:123']) {
    const canonical = JSON.stringify(context.parseLocation(route));
    for (const prefix of ['#', '/', '#/']) assert.equal(JSON.stringify(context.parseLocation(prefix + route)), canonical);
  }
  assert.equal(routeLabel('#/sources/catalog'), '信源目录');
  assert.equal(routeLabel('feed'), '信息流');
  assert.equal(routeLabel('tools'), '工具');
  assert.equal(context.parseLocation('assets').assetPane, 'holdings');
  assert.equal(context.parseLocation('assets/analysis').assetPane, 'analysis');
  assert.equal(context.parseLocation('report').reportHour, null);
  assert.equal(context.parseLocation('report?hour=15').reportHour, 15);
  assert.equal(context.parseLocation('report?hour=15').reportPane, 'today');
  assert.equal(context.parseLocation('#report/2026-10-09?hour=15').reportHour, 15);
  assert.equal(context.parseLocation('#report/2026-10-09?hour=15').reportDate, '2026-10-09');
  assert.equal(context.parseLocation('report/2026-10-09?hour=15').reportPane, 'day');
  assert.equal(context.parseLocation('report?hour=00').reportHour, 0);
  assert.equal(context.parseLocation('report?hour=24').reportHour, null);
  assert.equal(context.parseLocation('report?hour=3a').reportHour, null);
  assert.equal(context.parseLocation('market/global').marketTab, '');
  assert.equal(context.parseLocation('market/global?tab=events').marketTab, 'events');
  assert.equal(context.parseLocation('market/global?tab=events').marketPane, 'assets');
  assert.equal(context.parseLocation('#market/global?tab=events').view, 'market');
  assert.equal(context.parseLocation('market/global?tab=other').marketTab, '');
  assert.equal(context.parseLocation('#/market/global?tab=events').marketTab, 'events');
  assert.equal(routeLabel('#report?hour=15'), '简报');
  assert.equal(routeLabel('#report/2026-10-09?hour=8'), '简报');
});

test('overview primary navigation enters feed and then cycles from the selected submenu', () => {
  const state = { tradePane: 'stocks', overviewPane: 'home' };
  const context = vm.createContext({ state, document: { body: { dataset: { view: 'tools' } } } });
  vm.runInContext(`${app.match(/const hubLanes = \[[^]*?\];/)[0]}\n${app.match(/const overviewViews = \[[^]*?\];/)[0]}\n${functionSource('overviewLane')}\n${functionSource('primaryNavTarget')}`, context);
  for (const view of ['tools', 'assets', 'ask', 'inspire', 'page']) assert.equal(context.primaryNavTarget('sources', view), 'feed');
  assert.equal(context.primaryNavTarget('sources', 'sources'), 'feed');
  assert.equal(context.primaryNavTarget('sources', 'feed'), 'market');
  assert.equal(context.primaryNavTarget('sources', 'market'), 'market/global');
  state.tradePane = 'assets';assert.equal(context.primaryNavTarget('sources', 'market'), 'report');
  assert.equal(context.primaryNavTarget('sources', 'report'), 'sources');
  state.overviewPane = 'catalog';assert.equal(context.primaryNavTarget('sources', 'sources'), 'feed');
  assert.equal(context.primaryNavTarget('ask', 'ask'), 'ask');
});

test('assets primary navigation starts at holdings and alternates both panes', () => {
  const state = { tradePane: 'analysis' };
  const context = vm.createContext({ state });
  vm.runInContext(functionSource('primaryNavTarget'), context);
  for (const view of ['tools', 'feed', 'page', 'sources']) assert.equal(context.primaryNavTarget('assets', view), 'assets');
  assert.equal(context.primaryNavTarget('assets', 'assets'), 'assets');
  state.tradePane = 'holdings';assert.equal(context.primaryNavTarget('assets', 'assets'), 'assets/analysis');
});

test('article return uses the local browser history; direct links have a deterministic fallback', () => {
  const state = { trail: [], pageKind: 'article', pageId: 'one' };
  const history = { state: null, backCount: 0, back() { this.backCount++; } };
  const targets = [];
  const context = vm.createContext({ normalizeRoute, state, history,
    document: { body: { dataset: { view: 'page' } } }, setView: (...args) => targets.push(args),
  });
  vm.runInContext(`${functionSource('returnTarget')}\n${functionSource('goBack')}`, context);
  assert.equal(context.returnTarget(), 'feed');
  context.goBack();assert.equal(targets[0][0], 'feed');
  history.state = { aiCenterPrevious: '#feed' };
  state.trail = ['#feed'];context.goBack();
  assert.equal(history.backCount, 1);assert.equal(state.trail.length, 0);
  state.navigationFrom = '#sources/catalog';
  assert.equal(context.returnTarget(), 'sources/catalog');
  state.navigationFrom = '';history.state = null;state.pageKind = 'source';state.pageId = 'bilibili';
  assert.equal(context.returnTarget(), 'tools');
});

test('browse persistence restores query, sort, date, platform, list size and position together', () => {
  const saved = { platform: 'media', channel: 'all', query: '混排', sort: 'published', range: '7d', y: 912, shown: 48, anchorId: 'item-20' };
  const context = vm.createContext({ state: { feedShown: 12 }, viewScrollY: {}, pendingFeedDialogId: '', FEED_BROWSE_KEY: 'browse',
    window: { localStorage: { getItem: () => JSON.stringify(saved) } },
  });
  vm.runInContext(functionSource('restorePersistedFeedBrowseState'), context);
  context.restorePersistedFeedBrowseState();
  for (const [key, value] of Object.entries({ feedQuery: '混排', feedSort: 'published', feedRange: '7d', feedPlatform: 'media', feedShown: 48, feedAnchorId: 'item-20' })) assert.equal(context.state[key], value);
  assert.equal(context.viewScrollY.feed, 912);
});

test('legacy TrendForce browse selection becomes tech media with an isolated source cache',()=>{
  const saved={platform:'trendforce',mediaChannel:'macro',mediaView:'full'};
  const context=vm.createContext({state:{feedShown:12},viewScrollY:{},pendingFeedDialogId:'',FEED_BROWSE_KEY:'browse',window:{localStorage:{getItem:()=>JSON.stringify(saved)}}});
  vm.runInContext(functionSource('restorePersistedFeedBrowseState'),context);context.restorePersistedFeedBrowseState();
  assert.equal(context.state.feedPlatform,'media');assert.equal(context.state.mediaChannel,'tech');assert.equal(context.state.mediaView,'all');assert.equal(context.state.mediaSourceKey,'trendforce');
});

test('history read shows loading immediately, coalesces reads and releases failure before retry', async () => {
  const first = deferred(), retry = deferred();let calls = 0;const renders = [];
  const state = { session: { role: 'device' }, askSessions: [], askSessionsLoaded: false };
  const context = vm.createContext({ state, api: () => (++calls === 1 ? first.promise : retry.promise),
    renderAskRecords: () => renders.push({ loading: state.askSessionsLoading, loaded: state.askSessionsLoaded, error: state.askSessionsError }),
    adoptPendingRuns: () => {},
  });
  vm.runInContext(functionSource('loadAskSessions'), context);
  const one = context.loadAskSessions(), two = context.loadAskSessions();
  assert.equal(calls, 1);assert.equal(renders[0].loading, true);assert.equal(state.askSessionsLoaded, false);
  first.reject(new Error('offline'));await Promise.all([assert.rejects(one, /offline/), assert.rejects(two, /offline/)]);
  assert.equal(state.askSessionsLoading, false);assert.equal(state.askSessionsError, 'offline');
  const three = context.loadAskSessions();retry.resolve({ sessions: [{ id: 'existing' }] });await three;
  assert.equal(calls, 2);assert.equal(state.askSessionsLoaded, true);assert.equal(state.askSessions[0].id, 'existing');assert.equal(state.askSessionsError, '');
});

test('a late question session cannot replace a newer session or its pending jobs', async () => {
  const slow = deferred(), fast = deferred();
  const state = { session: {}, askDetailRequest: 0, askSessionId: 'slow', askJobs: [] };
  const node = { replaceChildren() {} };
  const context = vm.createContext({ state, elements: { 'ask-read-state': node },
    api: path => path.endsWith('slow') ? slow.promise : fast.promise,
    renderViewState: () => {}, renderAskSession: () => {}, applySessionAgentMode: () => {}, syncAskLayer: () => {}, adoptPendingRuns: () => {},
  });
  vm.runInContext(functionSource('loadAskSession'), context);
  const oldRead = context.loadAskSession('slow');state.askSessionId = 'fast';
  const newRead = context.loadAskSession('fast');
  fast.resolve({ session: { id: 'fast' }, exchanges: [] });await newRead;
  slow.resolve({ session: { id: 'slow' }, exchanges: [{ id: 'old-job', status: 'running' }] });await oldRead;
  assert.equal(state.askDetail.session.id, 'fast');assert.equal(state.askJobs.length, 0);
});

class Node {
  constructor(tag = 'div') { this.tagName = tag;this.children = [];this.dataset = {};this.attributes = {};this.events = {};this.className = '';this.textContent = ''; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(event, fn) { this.events[event] = fn; }
  querySelector(selector) {
    if (selector === 'span') return new Node('span');
    const all = this.children.filter(n => n instanceof Node);
    return all.find(n => selector.startsWith('.') && n.className.split(' ').includes(selector.slice(1)))
      || all.map(n => n.querySelector(selector)).find(Boolean) || null;
  }
}

test('shared states keep loading, empty, error and success distinguishable and expose retry', () => {
  const old = globalThis.document;globalThis.document = { createElement: tag => new Node(tag) };
  try {
    const root = new Node();let retried = false;
    renderViewState(root, { kind: 'loading', title: '读取中' });assert.equal(root.attributes['aria-busy'], 'true');
    renderViewState(root, { kind: 'error', title: '读取失败', action: '重试', onAction: () => { retried = true; } });
    const action = root.children[0].children.at(-1);action.events.click();assert.equal(retried, true);
    renderViewState(root, { kind: 'empty', title: '暂无日程' });assert.equal(root.dataset.loadState, 'empty');assert.equal(root.attributes['aria-busy'], 'false');
    renderViewState(root, { kind: 'success' });assert.equal(root.dataset.loadState, 'success');
  } finally {globalThis.document = old;}
});

test('quant first read is visible, deduplicated, and recovers from unavailable to ready', async () => {
  const old = globalThis.document;globalThis.document = { createElement: tag => new Node(tag) };
  try {
    const root = new Node(), read = deferred();let calls = 0;let mode = 'fail';
    const deps = { api: async () => { calls++;if(mode === 'fail') return read.promise;return {lab:{overview:{ready:false,segments:null},experiments:[],prepareJobs:[]}}; }, showToast: () => {}, renderViewState };
    const first = renderQuantLab(root, deps), second = renderQuantLab(root, deps);
    assert.equal(calls, 1);assert.equal(root.dataset.loadState, 'loading');
    read.reject(Object.assign(new Error('environment unavailable'), { status: 503 }));await Promise.all([first,second]);
    assert.equal(root.dataset.loadState, 'error');assert.equal(root.attributes['aria-busy'], 'false');
    mode = 'ready';await root.children[0].children.at(-1).events.click();
    assert.equal(calls, 2);assert.equal(root.dataset.loadState, 'success');assert.ok(root.querySelector('.quant-form'));
  } finally {globalThis.document = old;}
});
