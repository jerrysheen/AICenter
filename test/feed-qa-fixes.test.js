import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createStore } from '../packages/database/src/index.js';
import { parseFeedBefore } from '../packages/contracts/src/index.js';
import { createInformationTreeReader, pickNodeTime } from '../packages/domain/src/information-tree-service.js';
import { newsTimeLabel, reportItemTime } from '../apps/web/public/news-list.js';

const app = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');
const windowStart = Date.parse('2026-10-11T08:00:00+08:00');
const published = Date.parse('2026-10-11T14:30:00+08:00');

function functionSource(name) {
  const match = app.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, name);
  return match[0];
}

function extract(names) {
  return names.map((name) => functionSource(name)).join('\n');
}

function ids(list) {
  return Array.from(list, (item) => String(item.id)).join(',');
}

test('daily rows use the item time and skip the edition window start', () => {
  const edition = { window: { startAt: windowStart, endAt: windowStart + 86_400_000 } };
  const now = Date.parse('2026-10-13T02:00:00+08:00');
  assert.equal(newsTimeLabel(windowStart, { now }).text, '10月11日 08:00');
  const stamped = {
    publishedAt: published,
    firstIngestedAt: windowStart,
    eventAt: windowStart,
    sourceRefs: [{ at: windowStart }],
  };
  assert.equal(reportItemTime(stamped, edition), published);
  assert.equal(newsTimeLabel(reportItemTime(stamped, edition), { now }).text, '10月11日 14:30');
  assert.equal(reportItemTime({ firstIngestedAt: windowStart, eventAt: windowStart }, edition), 0);
  assert.equal(reportItemTime({ eventAt: published, firstIngestedAt: windowStart }, edition), published);
  assert.equal(reportItemTime({ sourceRefs: [{ at: published }], eventAt: windowStart }, edition), published);
});

test('edition nodes project a descendant time without storing the window start', () => {
  assert.equal(pickNodeTime({ eventAt: windowStart, window: { startAt: windowStart } }, [published]), published);
  assert.equal(pickNodeTime({ publishedAt: published, eventAt: windowStart, window: { startAt: windowStart } }, []), published);
  assert.equal(pickNodeTime({ eventAt: windowStart, window: { startAt: windowStart } }, []), 0);
  const stored = {
    d1: { id: 'd1', layer: 'daily', window: { startAt: windowStart, endAt: windowStart + 86_400_000 }, children: ['h1'], articleIds: ['a'] },
    h1: { id: 'h1', layer: 'hourly', window: { startAt: windowStart, endAt: windowStart + 3_600_000 }, children: ['i1'], articleIds: ['a'] },
    i1: {
      id: 'i1', layer: 'information', window: { startAt: windowStart, endAt: windowStart + 3_600_000 },
      eventAt: windowStart, publishedAt: published, children: [], articleIds: ['a'],
      sourceRefs: [{ type: 'content-item', id: 'a', at: published }],
    },
  };
  const reader = createInformationTreeReader({
    repository: { getNode: (_workspace, id) => (stored[id] ? { ...stored[id], children: [...stored[id].children], articleIds: [...stored[id].articleIds] } : null) },
  });
  const daily = reader.node('local', 'd1');
  assert.equal(daily.eventAt, published);
  assert.equal(stored.d1.eventAt, undefined);
  assert.equal(stored.i1.eventAt, windowStart);
});

test('all tab keeps manual, trendforce and official rows when the platform filter is still social', () => {
  const context = vm.createContext({
    state: {
      channel: 'all', feedPlatform: 'social', platform: 'social', feedSort: 'published', feedRange: 'all', feedQuery: '',
      posts: [{ id: 'post:1', platform: 'manual' }],
      xItems: [{ id: 'x:1', platform: 'x' }],
      xueqiuItems: [],
      trendforceItems: [{ id: 'tf:1', platform: 'trendforce' }],
      bilibiliItems: [],
      mediaItems: [],
      staticBoard: null,
      feedViewEpoch: 1,
    },
    liveAsItem: (item) => item,
    xAsItem: (item) => item,
    xueqiuAsItem: (item) => item,
    bilibiliAsItem: (item) => item,
    trendforceAsItem: (item) => item,
    isHiddenFeedItem: () => false,
    officialFeedItems: () => [{ id: 'off', platform: 'official' }],
    matchesFeedQuery: () => true,
    matchesFeedRange: () => true,
    sortFeedItems: (rows) => rows,
  });
  vm.runInContext(`${extract(['matchesPlatform', 'socialFeedItems', 'sinkLowValue', 'visibleFeedItems'])}`, context);
  assert.equal(ids(context.visibleFeedItems()), 'tf:1,x:1,post:1,off');
  context.state.channel = 'social';
  context.state.feedViewEpoch = 2;
  assert.equal(ids(context.socialFeedItems()), 'x:1');
  assert.match(functionSource('visibleFeedItems'), /socialFeedItems\(state\.channel === 'all' \? \{ ignorePlatform: true \} : \{\}\)/);
});

test('social refresh keeps loaded read rows at the bottom and can page into the read partition', async () => {
  const calls = [];
  const context = vm.createContext({
    URLSearchParams,
    Number,
    FEED_PAGE_SIZE: 12,
    state: {
      session: {}, channel: 'social', feedEpoch: 4, feedShown: 2,
      xFeed: 'following', xItems: [], xNextCursor: '', xReadCursor: '',
    },
    api: async (url) => {
      calls.push(url);
      if (url.includes('before=1%2C9007199254740991%2C%7E')) {
        return { feed: { items: [{ id: 'x:read', isRead: true, title: '已读' }], nextCursor: '1,20,x:read' } };
      }
      return { feed: { items: [{ id: 'x:new', isRead: false }, { id: 'x:mid', isRead: false }, { id: 'x:old', isRead: false }], nextCursor: '0,30,x:old' } };
    },
    isHiddenFeedItem: () => false,
    hydrateFeedTranslations: () => {},
    renderPosts: () => {},
    renderXToolbar: () => {},
    syncLocalTranslationsToServer: () => Promise.resolve(),
    loadFeedTaggings: () => Promise.resolve(),
    translateXBatch: async () => {},
    document: { body: { dataset: { view: 'feed' } } },
    renderOverviewTimeline: () => {},
  });
  vm.runInContext(`${extract(['paintLoadedSocialFeed', 'mergeLoadedFeedItem', 'mergeLoadedFeed', 'placeSocialItems', 'mergeSocialReadHead', 'loadXFeed', 'socialShownRows'])}\nthis.load=loadXFeed;this.shown=socialShownRows`, context);
  await context.load({ autoTranslate: false });
  assert.equal(calls.length, 2);
  assert.match(calls[1], /before=1%2C9007199254740991%2C%7E/);
  assert.equal(ids(context.state.xItems), 'x:new,x:mid,x:old,x:read');
  assert.equal(context.state.xNextCursor, '0,30,x:old');
  assert.equal(context.state.xReadCursor, '1,20,x:read');
  const rows = context.state.xItems.map((item) => ({ id: item.id, isRead: item.isRead }));
  assert.equal(ids(context.shown(rows)), 'x:new,x:mid,x:read');
});

test('a late social response does not replace the list after the tab changes', async () => {
  const context = vm.createContext({
    URLSearchParams,
    FEED_PAGE_SIZE: 12,
    state: { session: {}, channel: 'social', feedEpoch: 1, xFeed: 'following', xItems: [], xNextCursor: '', feedShown: 12 },
    api: async () => {
      context.state.feedEpoch = 2;
      context.state.channel = 'official';
      return { feed: { items: [{ id: 'x:stale', title: '旧页' }], nextCursor: '0,1,x:stale' } };
    },
    isHiddenFeedItem: () => false,
    hydrateFeedTranslations: () => {},
    renderPosts: () => {},
    renderXToolbar: () => {},
    syncLocalTranslationsToServer: () => Promise.resolve(),
    loadFeedTaggings: () => Promise.resolve(),
    translateXBatch: async () => {},
    document: { body: { dataset: { view: 'feed' } } },
    renderOverviewTimeline: () => {},
  });
  vm.runInContext(`${extract(['paintLoadedSocialFeed', 'loadXFeed'])}\nthis.load=loadXFeed`, context);
  await context.load({ autoTranslate: false });
  assert.equal(context.state.xItems.length, 0);
  assert.match(functionSource('applyFeedPlatform'), /state\.feedEpoch = \(Number\(state\.feedEpoch\) \|\| 0\) \+ 1/);
  assert.match(functionSource('applyFeedPlatform'), /正在读取内容…/);
  assert.match(functionSource('applyFeedPlatform'), /typeof elements !== 'undefined'/);
});

test('read-partition cursor reaches read posts after the unread page', () => {
  const store = createStore(':memory:');
  try {
    const feed = store.repositories.feed;
    const source = feed.upsertSourceAccount({
      workspaceId: 'local', provider: 'x', externalId: 'x:home', displayName: 'X',
    });
    const ids = [];
    for (let index = 0; index < 4; index += 1) {
      const capture = feed.saveCapture({
        workspaceId: 'local', provider: 'x', externalId: `t${index}`, sourceAccountId: source.id,
        sourceUrl: `https://x.com/example/status/${index}`, contentHash: `hash-${index}`, capturedAt: 1_000 + index,
      });
      const item = feed.saveContentItem({
        workspaceId: 'local', captureId: capture.id, originType: 'subscription', contentType: 'post',
        title: `标题 ${index}`, body: '正文', summary: '摘要',
        sourceUrl: `https://x.com/example/status/${index}`, authorName: 'Example', publishedAt: 1_000 + index,
      });
      ids.push(item.id);
    }
    feed.upsertUserItemState({ workspaceId: 'local', contentItemId: ids[0], isRead: true });
    feed.upsertUserItemState({ workspaceId: 'local', contentItemId: ids[1], isRead: true });
    const unread = feed.listContentItemsByProvider('local', 'x', { limit: 2 });
    assert.equal(unread.every((item) => item.isRead), false);
    const read = feed.listContentItemsByProvider('local', 'x', {
      limit: 12,
      before: parseFeedBefore(`1,${Number.MAX_SAFE_INTEGER},~`),
    });
    assert.deepEqual(read.map((item) => item.id), [ids[1], ids[0]]);
    assert.equal(read.every((item) => item.isRead), true);
  } finally {
    store.close();
  }
});
