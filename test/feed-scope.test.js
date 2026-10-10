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

test('overview startup does not request X or Xueqiu', () => {
  const sourcesPage = functionSource('loadSourcesPage');
  const schedule = functionSource('scheduleOverviewManualPosts');
  assert.match(sourcesPage, /scheduleOverviewManualPosts\(\)/);
  assert.doesNotMatch(sourcesPage, /loadXFeed|loadXueqiuFeed/);
  assert.match(schedule, /loadPosts\(\)/);
  assert.doesNotMatch(schedule, /loadXFeed|loadXueqiuFeed/);
  assert.match(app, /ai-center\.startup-fallback\.session/);
  assert.match(app, /ai-center\.startup-fallback\.ui-revision/);
});
