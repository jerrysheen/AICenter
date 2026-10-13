import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');
const newsList = readFileSync(new URL('../apps/web/public/news-list.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '')
  .replace(/^export /gm, '');

function functionSource(name) {
  const match = app.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, name);
  return match[0];
}

test('social tab sinks read rows after unread, and other tabs keep time order', () => {
  const context = vm.createContext({ state: { channel: 'social' }, URL, zonedCalendarParts: () => ({ year: 2026, month: 10, day: 13, weekday: 'Tue' }), zonedClockParts: () => ({ hour: 0, minute: 0 }) });
  vm.runInContext(`${newsList}\n${functionSource('orderFeedRows')}`, context);
  const rows = [
    { id: 'read-new', at: 300, isRead: true, title: '新已读' },
    { id: 'unread-old', at: 100, isRead: false, title: '旧未读' },
    { id: 'unread-new', at: 200, isRead: false, title: '新未读' },
  ];
  const ids = (list) => Array.from(list, (row) => String(row.id)).join(',');
  const ordered = context.orderFeedRows(context.prioritizeReadableFeedRows(rows));
  assert.equal(ids(ordered), 'unread-new,unread-old,read-new');
  assert.equal(Boolean(ordered.at(-1).muted), true);
  assert.equal(Boolean(ordered.at(-1).stayInDay), false);
  context.state.channel = 'all';
  const unchanged = context.orderFeedRows(context.prioritizeReadableFeedRows(rows));
  assert.equal(ids(unchanged), 'read-new,unread-new,unread-old');
  context.state.channel = 'official';
  assert.equal(String(context.orderFeedRows(rows)[0].id), 'read-new');
});

test('opening a social article marks the stored post read and persists the content item', () => {
  const calls = [];
  const row = { id: 'x:1', resourceId: '11111111-1111-1111-1111-111111111111', isRead: false };
  const context = vm.createContext({
    state: {
      xItems: [row],
      bilibiliItems: [],
      trendforceItems: [],
      xueqiuItems: [],
      mediaItems: [],
      posts: [],
      focusItems: {},
      session: { role: 'device', device: { id: 'reader' } },
      feedViewEpoch: 0,
    },
    rememberRecentItem() {},
    persistFocusItems() {},
    api(url, input) {
      calls.push({ url, input });
      return Promise.resolve();
    },
  });
  vm.runInContext(functionSource('markFeedItemRead'), context);
  const post = {
    id: 'x:1',
    platform: 'x',
    resourceId: row.resourceId,
    resourceType: 'content-item',
    contentItemId: row.resourceId,
    isRead: false,
  };
  context.markFeedItemRead(post);
  context.markFeedItemRead(post);
  assert.equal(row.isRead, true);
  assert.equal(post.isRead, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `/api/v1/content-items/${row.resourceId}/state`);
  assert.deepEqual(JSON.parse(calls[0].input.body), { isRead: true });
  const article = app.slice(app.indexOf('function renderArticlePage'), app.indexOf('function renderArticlePage') + 8000);
  const restoreAt = article.indexOf('restoreSocialArticle(itemId, post)');
  const markAt = article.lastIndexOf('markFeedItemRead(post)', restoreAt);
  assert.ok(restoreAt > 0 && markAt > 0 && markAt < restoreAt);
});

test('feed rows keep isRead, and a reload does not clear a local read mark', () => {
  const context = vm.createContext({
    state: { channel: 'social' },
    feedListTitle: () => ({ title: '标题', tag: '' }),
    postTagNames: () => [],
    feedListMoment: () => ({ at: 20, ingested: false, effectiveLabel: '' }),
    itemIsFocused: () => false,
    feedCommentCount: () => 0,
    feedSourceLine: () => 'X',
    attachGuardedOpen() {},
    openArticle() {},
    attachSwipe() {},
    toggleFocus() {},
    renderPosts() {},
    renderHub() {},
    hideFeedItem() {},
    removeFocusItem() {},
    removeRecentItem() {},
    presentShareCard() {},
    postShareInput: () => ({}),
    FEED_SWIPE_WIDTH: 72,
  });
  vm.runInContext(`${functionSource('feedToNewsRow')}\n${functionSource('mergeLoadedFeedItem')}`, context);
  const row = context.feedToNewsRow({ id: 'x:9', platform: 'x', isRead: true, lowValue: false });
  assert.equal(row.isRead, true);
  assert.equal(row.muted, false);
  const merged = context.mergeLoadedFeedItem(
    { id: 'x:9', isRead: true, detail: 'list', body: '' },
    { id: 'x:9', isRead: false, summary: '新摘要' },
  );
  assert.equal(merged.isRead, true);
  assert.equal(merged.summary, '新摘要');
  const fromServer = context.mergeLoadedFeedItem(
    { id: 'x:8', isRead: false, detail: 'list' },
    { id: 'x:8', isRead: true },
  );
  assert.equal(fromServer.isRead, true);
});
