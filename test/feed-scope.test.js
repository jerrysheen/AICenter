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

const table = app.match(/const FEED_SCOPE_SOURCES = \{[^]*?\n\};/);
assert.ok(table);
const context = vm.createContext({});
vm.runInContext([
  table[0],
  'feedSourcesForScope',
  'overviewTimelineSources',
  'feedSourceFlags',
  'missingFeedSources',
  'feedScopePresentation',
  'inspirationSavePlan',
].map((name) => (name.endsWith(';') ? name : functionSource(name))).join('\n'), context);

const list = (value) => [...value];

test('each feed tab names the sources it still needs', () => {
  assert.deepEqual(list(context.feedSourcesForScope('all', 'all')), ['posts', 'x', 'xueqiu', 'official']);
  assert.deepEqual(list(context.feedSourcesForScope('focus', 'all')), ['posts', 'x', 'xueqiu', 'official']);
  assert.deepEqual(list(context.feedSourcesForScope('social', 'social')), ['x', 'xueqiu']);
  assert.deepEqual(list(context.feedSourcesForScope('official', 'all')), ['official']);
  assert.deepEqual(list(context.feedSourcesForScope('recent', 'all')), []);
  assert.deepEqual(list(context.feedSourcesForScope('official', 'media')), ['media']);
  assert.deepEqual(list(context.missingFeedSources(['posts', 'x', 'xueqiu', 'official'], {
    postsLoaded: true,
    xLoaded: false,
    xLoading: false,
    xueqiuLoaded: true,
    officialLoaded: false,
    officialLoading: true,
  })), ['x']);
});

test('overview 全部 waits for posts and official, and 社媒 does not look empty while loading', () => {
  assert.deepEqual(list(context.overviewTimelineSources('latest')), ['posts', 'official']);
  assert.deepEqual(list(context.overviewTimelineSources('focus')), ['posts', 'official']);
  assert.deepEqual(list(context.overviewTimelineSources('social')), ['x', 'xueqiu']);
  assert.deepEqual(list(context.overviewTimelineSources('recent')), []);
  const social = ['x', 'xueqiu'];
  assert.equal(context.feedScopePresentation(social, { count: 0, xLoaded: false, xueqiuLoaded: false }), 'loading');
  assert.equal(context.feedScopePresentation(social, { count: 0, xLoaded: true, xueqiuLoaded: true }), 'empty');
  assert.equal(context.feedScopePresentation(social, { count: 2, xLoaded: false }), 'ready');
  assert.equal(context.feedScopePresentation(social, {
    count: 0, xLoaded: false, xError: 'nope', xueqiuLoaded: true,
  }), 'error');
  const home = ['posts', 'official'];
  assert.equal(context.feedScopePresentation(home, { count: 0, postsLoaded: false, officialLoaded: true }), 'loading');
  assert.equal(context.feedScopePresentation(home, { count: 0, postsLoaded: true, officialLoaded: true }), 'empty');
  assert.equal(context.feedScopePresentation(home, {
    count: 0, postsLoaded: false, postsError: 'fail', officialLoaded: true,
  }), 'error');
});

test('saving to inspiration checks notes before creating another one', () => {
  assert.equal(context.inspirationSavePlan({ notesLoaded: false, existing: null, saved: false }), 'load-notes');
  assert.equal(context.inspirationSavePlan({ notesLoaded: true, existing: { id: 'n' }, saved: true }), 'open');
  assert.equal(context.inspirationSavePlan({ notesLoaded: true, existing: null, saved: true }), 'already');
  assert.equal(context.inspirationSavePlan({ notesLoaded: true, existing: null, saved: false }), 'create');
});

test('TrendForce reloads media when the filter changes and nothing is loading', async () => {
  const calls = [];
  const state = {
    mediaChannel: 'tech', mediaView: 'all', mediaSourceKey: '',
    mediaLoaded: true, mediaLoading: false, bootstrapped: true,
    channel: 'all', feedPlatform: 'media', platform: 'media',
    trendforceLoaded: false, trendforceLoading: false,
  };
  const noop = () => {};
  const box = vm.createContext({
    state,
    document: { body: { dataset: { view: 'feed' } } },
    showToast: noop,
    resetFeedWindow: noop,
    renderChannels: noop,
    renderPlatformFilters: noop,
    renderXToolbar: noop,
    renderXueqiuToolbar: noop,
    renderBilibiliToolbar: noop,
    renderTrendForceToolbar: noop,
    renderMediaToolbar: noop,
    renderPosts: noop,
    loadTrendForceFeed: () => Promise.resolve(),
    loadMediaFeed: () => { calls.push('media'); return Promise.resolve(); },
    ensureFeedSources: () => { calls.push('ensure'); return Promise.resolve(); },
  });
  vm.runInContext([
    table[0],
    functionSource('isSourceFeedScope'),
    functionSource('feedSourcesForScope'),
    functionSource('mediaSelectionKey'),
    functionSource('mediaFeedNeedsReload'),
    functionSource('applyFeedPlatform'),
  ].join('\n'), box);
  await box.applyFeedPlatform('trendforce');
  assert.deepEqual(calls, ['media', 'ensure']);
  assert.equal(state.mediaSourceKey, 'trendforce');
  calls.length = 0;
  await box.applyFeedPlatform('trendforce');
  assert.deepEqual(calls, ['ensure']);
  calls.length = 0;
  state.mediaSourceKey = '';
  state.mediaLoading = true;
  await box.applyFeedPlatform('trendforce');
  assert.deepEqual(calls, ['ensure']);
});

test('feed and schedule entry load before bootstrap finishes', () => {
  const view = functionSource('setView');
  assert.match(view, /view === 'feed' && \(state\.bootstrapped \|\| state\.session\)/);
  assert.match(view, /ensureVisibleFeedLoaded\(\)/);
  assert.match(view, /state\.overviewPane === 'schedule'/);
  assert.doesNotMatch(view, /state\.overviewPane === 'home' \|\| state\.overviewPane === 'schedule'/);
  assert.match(view, /!state\.staticBoard/);
  assert.match(view, /loadStaticSignalBoard\(\)/);
  assert.match(functionSource('renderStaticSignalBoard'), /近期没有日程/);
  assert.match(functionSource('appendStaticSignalItem'), /article\.append\(time, copy\)/);
  assert.match(functionSource('ensureFeedSources'), /state\.channel === 'focus'/);
  assert.match(functionSource('ensureFeedSources'), /loadFocusFeedWindow\('x'\)/);
  assert.match(functionSource('loadFocusFeedWindow'), /FOCUS_FEED_WINDOW/);
  assert.match(functionSource('loadXFeed'), /focusWindow \|\| refresh \|\| saved \? '50'/);
  assert.match(functionSource('loadFocusFeedWindow'), /saved: true/);
  assert.match(functionSource('applyFeedPlatform'), /state\.bootstrapped \|\| state\.session/);
  assert.match(functionSource('renderMarket'), /paintMarketPlaceholder\(isOverview\)/);
});

test('overview startup does not request X or Xueqiu', () => {
  const sourcesPage = functionSource('loadSourcesPage');
  const schedule = functionSource('scheduleOverviewManualPosts');
  assert.match(sourcesPage, /homeRequestPlan\(/);
  assert.doesNotMatch(sourcesPage, /scheduleOverviewManualPosts\(\)|loadGlobalAssets|loadMarketNativeBoard|loadXFeed|loadXueqiuFeed|loadPosts\(/);
  assert.match(schedule, /loadPosts\(\)/);
  assert.doesNotMatch(schedule, /loadXFeed|loadXueqiuFeed/);
  assert.match(app, /ai-center\.startup-fallback\.session/);
  assert.match(app, /ai-center\.startup-fallback\.ui-revision/);
});
