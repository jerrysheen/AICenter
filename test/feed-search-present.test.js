import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  feedSearchCountText,
  feedSearchExcerpt,
  feedSearchMoreText,
  feedSearchPhase,
  highlightParts,
} from '../apps/web/public/feed-search.js';

test('a search stays on 搜索中 until that query has settled', () => {
  assert.equal(feedSearchPhase({ query: '美', pending: true, settledQuery: '' }), 'idle');
  assert.equal(feedSearchPhase({ query: '美联储', pending: true, settledQuery: '' }), 'loading');
  assert.equal(feedSearchPhase({ query: '美联储', pending: false, settledQuery: '' }), 'loading');
  assert.equal(feedSearchPhase({ query: '美联储', pending: false, settledQuery: '美联储' }), 'ready');
  assert.equal(feedSearchCountText({ phase: 'loading', shown: 2, total: 2 }), '搜索中…');
  assert.equal(feedSearchCountText({ phase: 'ready', shown: 0, total: 0 }), '共 0 条');
  assert.equal(feedSearchMoreText({ phase: 'ready', shown: 0, total: 0 }), '');
  assert.equal(feedSearchMoreText({ phase: 'loading', shown: 0, total: 4 }), '');
});

test('a short result window says how many are still hidden', () => {
  assert.equal(feedSearchCountText({ phase: 'ready', shown: 24, total: 124 }), '已显示 24 / 124 条');
  assert.equal(feedSearchMoreText({ phase: 'ready', shown: 24, total: 124 }), '加载更多');
  assert.equal(feedSearchCountText({ phase: 'ready', shown: 124, total: 124 }), '共 124 条');
  assert.equal(feedSearchMoreText({ phase: 'ready', shown: 124, total: 124 }), '已经到底了');
});

test('title hits are marked and a body-only hit becomes one excerpt line', () => {
  const parts = highlightParts('美联储维持利率', '美联储');
  assert.deepEqual(parts.filter((part) => part.hit).map((part) => part.text), ['美联储']);
  assert.equal(feedSearchExcerpt({
    title: '美联储维持利率',
    body: '正文里也有美联储',
    query: '美联储',
  }), '');
  const excerpt = feedSearchExcerpt({
    title: '利率决议',
    body: '今天的会议上美联储维持利率不变，市场等待声明。',
    query: '美联储',
  });
  assert.match(excerpt, /美联储/);
  assert.equal(excerpt.includes('\n'), false);
  const fromSummary = feedSearchExcerpt({
    title: '利率决议',
    body: '没有这个词',
    summary: '摘要里提到美联储',
    query: '美联储',
  });
  assert.match(fromSummary, /美联储/);
});

test('the feed keeps the skeleton until the finished list is ready', () => {
  const app = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');
  const render = app.slice(app.indexOf('function renderPosts()'), app.indexOf('function syncDialogTranslation'));
  assert.match(render, /currentFeedSearchPhase\(\) === 'loading'/);
  assert.match(render, /label: '搜索中…', variant: 'feed'/);
  assert.equal(render.includes('elements.feed.replaceChildren()'), false);
  assert.match(render, /replaceChildren\(\.\.\.painted\)/);
  const keep = render.indexOf('const keepReading');
  const continueText = render.indexOf('继续读取文章');
  const listHost = render.indexOf('const listHost');
  assert.ok(keep > 0 && continueText > keep && continueText < listHost);
  assert.match(render.slice(keep, continueText), /!searchSettled && !state\.feedQuery/);
  assert.match(render, /feedSearchMoreText/);
  const schedule = app.slice(app.indexOf('function scheduleFeedSearch'), app.indexOf('async function loadFeedSearch'));
  assert.match(schedule, /state\.feedSearchPending = true/);
  const loadStart = app.indexOf('async function loadFeedSearch');
  const load = app.slice(loadStart, app.indexOf("elements['global-search']", loadStart));
  assert.match(load, /error\?\.name === 'AbortError' \|\| loadFeedSearch\.token !== token\) return;/);
  const caught = load.slice(load.indexOf('} catch'));
  assert.match(caught, /AbortError[\s\S]*?state\.feedSearchPending = false/);
});
