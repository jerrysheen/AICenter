import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { feedTextToHtml, splitFeedText } from '../apps/web/public/markdown.js';
import { channels, platformFilters, tools } from '../apps/web/public/mock.js';

test('saved X and Xueqiu comment blocks render separately with one row per comment', () => {
  const text = '正文第一段。\n\n正文第二段。\n\n评论\n· 甲：看好。\n· 乙：继续观察。';
  assert.deepEqual(splitFeedText(text), {
    body: '正文第一段。\n\n正文第二段。', comments: ['甲：看好。', '乙：继续观察。'], notes: '',
  });
  const html = feedTextToHtml(text);
  assert.match(html, /<p>正文第一段。<\/p><p>正文第二段。<\/p>/);
  assert.match(html, /<section class="feed-comments"[^>]*><h4>评论 · 2<\/h4><ul><li>甲：看好。<\/li><li>乙：继续观察。<\/li>/);
  assert.equal(text, '正文第一段。\n\n正文第二段。\n\n评论\n· 甲：看好。\n· 乙：继续观察。');
});

test('translated comment headings and wrapped comments preserve authors and media notes', () => {
  const result = splitFeedText('Body\r\n\r\n## **Comments**:\r\n- Alice: line one\r\nline two\r\n- Bob: reply\r\n\r\n[未抓取] 图片 ×2');
  assert.deepEqual(result, { body: 'Body', comments: ['Alice: line one\nline two', 'Bob: reply'], notes: '[未抓取] 图片 ×2' });
  const html = feedTextToHtml('正文\n\n评论\n· 作者：回复\n\n[未抓取] 视频');
  assert.match(html, /<\/section><div class="feed-media-notes">/);
  assert.doesNotMatch(html, /<li>[^<]*未抓取/);
});

test('mentions of comments in prose and non-comment headings stay in the body', () => {
  for (const text of ['大家评论：观点不同。', '评论\n作者自己的论述。', 'No comments yet.']) {
    assert.deepEqual(splitFeedText(text), { body: text, comments: [], notes: '' });
    assert.doesNotMatch(feedTextToHtml(text), /class="feed-comments"/);
  }
});

test('long prose breaks only at complete sentences and preserves facts, lists and links', () => {
  const sentence = '本季度收入增长 12.5%，股票代码 ABC，产品型号 V2。';
  const text = sentence.repeat(18);
  const html = feedTextToHtml(text);
  assert.ok((html.match(/<p>/g) || []).length > 1);
  const renderedText = html.replace(/<[^>]+>/g, '');
  assert.equal(renderedText, text);
  assert.match(feedTextToHtml('1. 收入增长\n2. 成本下降\n\n链接 https://example.com/a'), /<ol><li>收入增长<\/li><li>成本下降<\/li><\/ol>/);
  assert.match(feedTextToHtml('https://example.com/a'), /rel="noopener noreferrer"/);
  const unbroken = '字'.repeat(400);
  assert.equal(feedTextToHtml(unbroken).match(/<p>/g).length, 1);
});

test('untrusted body and comment HTML is escaped', () => {
  const html = feedTextToHtml('<script>alert(1)</script>\n\n评论\n· 作者：<img src=x onerror=alert(1)>');
  assert.doesNotMatch(html, /<script>|<img /);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img /);
});

const app = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = app.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, name);
  return match[0];
}

test('one social entry combines X and Xueqiu while Bilibili stays in tools', () => {
  assert.equal(channels.filter(row => row.id === 'social').length, 1);
  assert.ok(platformFilters.some(row => row.id === 'social'));
  assert.ok(!platformFilters.some(row => ['x', 'xueqiu', 'bilibili'].includes(row.id)));
  assert.ok(tools.some(row => row.id === 'bilibili' && row.ready));
  const tabs = app.match(/const feedSourceTabs = \[[^]*?\];/)[0];
  assert.doesNotMatch(tabs, /id: '(?:x|xueqiu|bilibili)'/);
  const context = vm.createContext({ state: { feedPlatform: 'social' } });
  vm.runInContext(functionSource('matchesPlatform'), context);
  for (const platform of ['x', 'xueqiu']) assert.equal(context.matchesPlatform({ platform }), true);
  for (const platform of ['bilibili', 'manual', 'trendforce']) assert.equal(context.matchesPlatform({ platform }), false);
});

test('mixed list excludes Bilibili and its tool history can read untagged saved subtitles', () => {
  const context = vm.createContext({
    state: { posts: [], xItems: [{ platform: 'x' }], xueqiuItems: [{ platform: 'xueqiu' }], bilibiliItems: [{ platform: 'bilibili' }], trendforceItems: [], feedPlatform: 'all' },
    feedItems: [], liveAsItem: item => item, xAsItem: item => item, xueqiuAsItem: item => item,
    bilibiliAsItem: item => item, trendforceAsItem: item => item, hasDisplayTags: item => item.platform !== 'bilibili', isHiddenFeedItem: () => false,
  });
  vm.runInContext(`${functionSource('matchesPlatform')}\n${functionSource('socialFeedItems')}`, context);
  assert.deepEqual(Array.from(context.socialFeedItems(), row => row.platform).sort(), ['x', 'xueqiu']);
  assert.deepEqual(Array.from(context.socialFeedItems({ platform: 'bilibili', includeTools: true }), row => row.platform), ['bilibili']);
  assert.equal(context.state.feedPlatform, 'all');
});

test('approved feeds keep untagged items and empty live feeds never substitute demo items', () => {
  const context = vm.createContext({
    state: { posts: [], xItems: [{ id: 'approved', platform: 'x', tags: [] }], xueqiuItems: [], bilibiliItems: [], trendforceItems: [], feedPlatform: 'all' },
    feedItems: [{ id: 'demo', platform: 'xueqiu' }],
    liveAsItem: item => item, xAsItem: item => item, xueqiuAsItem: item => item,
    bilibiliAsItem: item => item, trendforceAsItem: item => item, hasDisplayTags: () => false, isHiddenFeedItem: () => false,
  });
  vm.runInContext(`${functionSource('matchesPlatform')}\n${functionSource('socialFeedItems')}\n${functionSource('hubFeedPicks')}`, context);
  assert.deepEqual(Array.from(context.socialFeedItems(), row => row.id), ['approved']);
  assert.deepEqual(Array.from(context.hubFeedPicks(), row => row.id), ['approved']);
  context.state.xItems = [];
  assert.equal(context.socialFeedItems().length, 0);
  assert.equal(context.hubFeedPicks().length, 0);
});

test('old X and Xueqiu browse positions restore to social; Bilibili restores to all', () => {
  for (const platform of ['x', 'xueqiu', 'bilibili']) {
    const context = vm.createContext({
      state: { feedShown: 20, channel: 'all' }, viewScrollY: {}, pendingFeedDialogId: '', FEED_BROWSE_KEY: 'browse',
      window: { localStorage: { getItem: () => JSON.stringify({ platform, channel: platform === 'bilibili' ? 'all' : 'social' }) } },
    });
    vm.runInContext(functionSource('restorePersistedFeedBrowseState'), context);
    context.restorePersistedFeedBrowseState();
    assert.equal(context.state.feedPlatform, platform === 'bilibili' ? 'all' : 'social');
    assert.equal(context.state.channel, platform === 'bilibili' ? 'all' : 'social');
  }
});

test('focus and recent feed projections omit Bilibili without deleting saved history', () => {
  const history = [{ platform: 'bilibili' }, { platform: 'x' }, { platform: 'xueqiu' }];
  const context = vm.createContext({
    state: { channel: 'focus', feedPlatform: 'all' },
    socialFeedItems: () => [], officialFeedItems: () => [], focusedFeedItems: () => history, recentFeedItems: () => history,
    hasDisplayTags: () => true, matchesFeedQuery: () => true, matchesFeedRange: () => true, sortFeedItems: rows => rows,
  });
  vm.runInContext(functionSource('visibleFeedItems'), context);
  for (const channel of ['focus', 'recent']) {
    context.state.channel = channel;
    assert.deepEqual(Array.from(context.visibleFeedItems(), row => row.platform), ['x', 'xueqiu']);
    assert.equal(history.length, 3);
  }
});

test('Bilibili tool opens its subtitle reader independently of the main feed selection', () => {
  const subtitle = { id: 'bilibili:video-1', platform: 'bilibili' };
  const context = vm.createContext({
    state: { posts: [], xItems: [], xueqiuItems: [], bilibiliItems: [subtitle], trendforceItems: [], feedPlatform: 'social', focusItems: {}, recentItems: {} },
    feedItems: [], liveAsItem: item => item, xAsItem: item => item, xueqiuAsItem: item => item,
    bilibiliAsItem: item => item, trendforceAsItem: item => item, hasDisplayTags: () => false, isHiddenFeedItem: () => false,
    visibleFeedItems: () => [], officialFeedItems: () => [],
  });
  vm.runInContext(`${functionSource('matchesPlatform')}\n${functionSource('socialFeedItems')}\n${functionSource('findUnifiedItem')}`, context);
  assert.equal(context.findUnifiedItem(subtitle.id), subtitle);
  assert.equal(context.socialFeedItems().length, 0);
  assert.equal(context.state.feedPlatform, 'social');
});

test('recent feed reads browse history and does not project social or official lists', () => {
  let socialCalls = 0;
  let officialCalls = 0;
  const context = vm.createContext({
    state: {
      channel: 'recent', feedPlatform: 'all', feedSort: 'published', feedRange: 'all', feedQuery: '',
      recentItems: {}, xItems: [{ id: 'x:1' }], xueqiuItems: [{ id: 'xq:1' }],
    },
    socialFeedItems() { socialCalls += 1; return [{ id: 'x:1', platform: 'x', createdAt: 9 }]; },
    officialFeedItems() { officialCalls += 1; return [{ id: 'off', platform: 'official', createdAt: 8 }]; },
    recentFeedItems() { return [{ id: 'r-new', platform: 'x', viewedAt: 5 }, { id: 'r-old', platform: 'xueqiu', viewedAt: 1 }]; },
    focusedFeedItems() { throw new Error('focus projection'); },
    matchesFeedQuery: () => true,
    matchesFeedRange: () => true,
    sortFeedItems: rows => rows,
    mediaAsItem: item => item,
  });
  vm.runInContext(functionSource('visibleFeedItems'), context);
  assert.deepEqual(Array.from(context.visibleFeedItems(), row => row.id), ['r-new', 'r-old']);
  assert.equal(socialCalls, 0);
  assert.equal(officialCalls, 0);
  context.visibleFeedItems();
  assert.equal(socialCalls, 0);
  context.state.channel = 'all';
  context.state.feedViewEpoch = 1;
  assert.deepEqual(Array.from(context.visibleFeedItems(), row => row.id), ['x:1', 'off']);
  assert.equal(socialCalls, 1);
  assert.equal(officialCalls, 1);
});

test('recent rows stay ordered by viewed time', () => {
  const context = vm.createContext({
    state: {
      channel: 'recent',
      feedSort: 'published',
      recentItems: {
        a: { id: 'a', platform: 'x', kind: 'social', viewedAt: 1 },
        b: { id: 'b', platform: 'xueqiu', kind: 'social', viewedAt: 3 },
        c: { id: 'c', platform: 'bilibili', kind: 'social', viewedAt: 9 },
      },
    },
  });
  vm.runInContext(`${functionSource('isFeedFocusItem')}\n${functionSource('recentFeedItems')}\n${functionSource('sortFeedItems')}\n${functionSource('visibleFeedItems')}`, context);
  context.matchesFeedQuery = () => true;
  context.matchesFeedRange = () => true;
  assert.deepEqual(Array.from(context.recentFeedItems(), row => row.id), ['c', 'b', 'a']);
  assert.deepEqual(Array.from(context.sortFeedItems(context.recentFeedItems()), row => row.id), ['c', 'b', 'a']);
  assert.deepEqual(Array.from(context.visibleFeedItems(), row => row.id), ['b', 'a']);
});

test('a social reload does not repaint the recent feed', async () => {
  let rendered = 0;
  const context = vm.createContext({
    URLSearchParams,
    FEED_PAGE_SIZE: 12,
    state: {
      session: {}, channel: 'recent', feedPlatform: 'all', xFeed: 'for-you',
      xItems: [], xNextCursor: '', feedShown: 12,
    },
    api: async () => ({ feed: { items: [{ id: 'x:new', title: '新' }], nextCursor: '0,1,x:new' } }),
    isHiddenFeedItem: () => false,
    hydrateFeedTranslations: () => {},
    renderPosts() { rendered += 1; },
    renderXToolbar: () => {},
    syncLocalTranslationsToServer: () => Promise.resolve(),
    loadFeedTaggings: () => Promise.resolve(),
    translateXBatch: async () => {},
    document: { body: { dataset: { view: 'feed' } } },
    renderOverviewTimeline: () => {},
  });
  vm.runInContext(`${functionSource('paintLoadedSocialFeed')}\n${functionSource('loadXFeed')}\nthis.load=loadXFeed`, context);
  await context.load({ autoTranslate: false });
  assert.equal(rendered, 0);
  assert.deepEqual(Array.from(context.state.xItems, row => row.id), ['x:new']);
  context.state.channel = 'all';
  context.state.xItems = [];
  await context.load({ autoTranslate: false });
  assert.ok(rendered >= 2);
});
