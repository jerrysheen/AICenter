import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createStore } from '../packages/database/src/index.js';
import { parseXFeedQuery } from '../packages/contracts/src/index.js';
import { createFeedService } from '../packages/domain/src/feed-service.js';

const app = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');

function functionSource(name) {
  const match = app.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, name);
  return match[0];
}

function extract(names) {
  return names.map((name) => functionSource(name)).join('\n');
}

const countContext = vm.createContext({});
vm.runInContext([
  app.match(/const FEED_SOURCE_READING_LABEL = \{[^]*?\n\};/)[0],
  extract([
    'feedSourceFlags', 'feedSourceSettled', 'pendingFeedSourceLabels',
    'feedAllCountText', 'focusFeedPending', 'mergeLoadedFeedItem', 'mergeLoadedFeed', 'feedSortAt', 'sortFeedItems',
  ]),
].join('\n'), countContext);

test('全部 waits to publish 共 N 条 until every declared source has returned', () => {
  const sources = ['posts', 'x', 'xueqiu', 'official'];
  const waiting = {
    postsLoaded: true,
    xLoaded: true,
    xueqiuLoaded: false,
    xueqiuLoading: true,
    officialLoaded: false,
    officialLoading: true,
  };
  const partial = countContext.feedAllCountText(12, 12, sources, waiting, '按收录顺序', '全部日期');
  assert.match(partial, /雪球读取中…/);
  assert.match(partial, /官方读取中…/);
  assert.doesNotMatch(partial, /已显示/);
  assert.doesNotMatch(partial, /共 /);
  const onlyOfficial = countContext.feedAllCountText(50, 50, sources, {
    postsLoaded: true, xLoaded: true, xueqiuLoaded: true, officialLoaded: false,
  }, '按收录顺序', '全部日期');
  assert.equal(onlyOfficial, '按收录顺序 · 全部日期 · 官方读取中…');
  const done = countContext.feedAllCountText(12, 60, sources, {
    postsLoaded: true, xLoaded: true, xueqiuLoaded: true, officialLoaded: true,
  }, '按收录顺序', '全部日期');
  assert.equal(done, '按收录顺序 · 全部日期 · 共 60 条');
  const failed = countContext.feedAllCountText(12, 12, sources, {
    postsLoaded: true, xLoaded: true, xueqiuLoaded: true, officialLoaded: false, officialError: '超时',
  }, '按收录顺序', '全部日期');
  assert.equal(failed, '按收录顺序 · 全部日期 · 共 12 条');
});

test('arriving sources merge by id, keep updated fields in front, then reorder by time', () => {
  const merged = countContext.mergeLoadedFeed(
    [{ id: 'xq', title: '旧雪球', body: '留下', publishedAt: 10 }],
    [{ id: 'xq', title: '新雪球', publishedAt: 10 }, { id: 'off', title: '官方', publishedAt: 30 }],
  );
  assert.deepEqual(Array.from(merged, (item) => item.id), ['xq', 'off']);
  assert.equal(merged[0].title, '新雪球');
  assert.equal(merged[0].body, '留下');
  countContext.state = { channel: 'all', feedSort: 'published' };
  const ordered = countContext.sortFeedItems(merged);
  assert.deepEqual(Array.from(ordered, (item) => item.id), ['off', 'xq']);
});

test('重点 stays loading until the saved window finishes, and a fresh tab triggers that window', async () => {
  const sources = ['posts', 'x', 'xueqiu', 'official'];
  assert.equal(countContext.focusFeedPending(sources, {
    postsLoaded: true, officialLoaded: true,
    xLoaded: true, xFocusLoaded: false, xFocusLoading: true, xError: '',
    xueqiuLoaded: true, xueqiuFocusLoaded: false, xueqiuError: '',
  }), true);
  assert.equal(countContext.focusFeedPending(sources, {
    postsLoaded: true, officialLoaded: true,
    xLoaded: true, xFocusLoaded: true, xFocusLoading: false, xError: '',
    xueqiuLoaded: true, xueqiuFocusLoaded: true, xueqiuFocusLoading: false, xueqiuError: '',
  }), false);
  const calls = [];
  const state = {
    channel: 'focus',
    postsLoaded: true, postsLoading: false, postsError: '',
    xLoaded: false, xLoading: false, xError: '', xFocusLoaded: false, xFocusLoading: false,
    xueqiuLoaded: true, xueqiuLoading: false, xueqiuError: '', xueqiuFocusLoaded: true, xueqiuFocusLoading: false,
    staticBoard: { releases: [] }, staticBoardLoading: false, staticBoardError: '',
    mediaLoaded: true, mediaLoading: false, mediaError: '',
  };
  const box = vm.createContext({
    state,
    showToast() {},
    loadPosts: () => Promise.resolve(),
    loadXFeed: () => { calls.push('x'); return Promise.resolve(); },
    loadXueqiuFeed: () => { calls.push('xueqiu'); return Promise.resolve(); },
    loadFocusFeedWindow: (kind) => { calls.push(`focus:${kind}`); return Promise.resolve(); },
    loadStaticSignalBoard: () => Promise.resolve(),
    loadMediaFeed: () => Promise.resolve(),
  });
  vm.runInContext([
    extract(['feedSourceFlags', 'missingFeedSources', 'feedLoadFlags', 'ensureFeedSources']),
  ].join('\n'), box);
  await box.ensureFeedSources(sources);
  assert.deepEqual(calls, ['focus:x']);
  calls.length = 0;
  state.xLoaded = true;
  state.xFocusLoaded = false;
  await box.ensureFeedSources(sources);
  assert.deepEqual(calls, ['focus:x']);
});

test('a saved page merges into the open list and does not replace the normal cursor', async () => {
  const calls = [];
  const context = vm.createContext({
    URLSearchParams,
    FEED_PAGE_SIZE: 12,
    state: {
      session: {}, xFeed: 'for-you', channel: 'focus',
      xItems: [{ id: 'x:old', title: '旧' }], xNextCursor: '0,10,keep', feedShown: 12,
      xFocusLoaded: false, xFocusLoading: true,
    },
    api: async (url) => {
      calls.push(url);
      return { feed: { items: [{ id: 'x:star', title: '星标' }, { id: 'x:old', title: '更新' }], nextCursor: '1,1,saved' } };
    },
    isHiddenFeedItem: () => false,
    hydrateFeedTranslations: () => {},
    renderPosts: () => {},
    renderXToolbar: () => {},
    syncLocalTranslationsToServer: () => Promise.resolve(),
    loadFeedTaggings: () => Promise.resolve(),
    translateXBatch: async () => {},
    document: { body: { dataset: {} } },
    renderOverviewTimeline: () => {},
    showToast() {},
    loadFocusFeedWindow: () => Promise.resolve(),
  });
  vm.runInContext(`${extract(['paintLoadedSocialFeed', 'mergeLoadedFeedItem', 'mergeLoadedFeed', 'loadXFeed'])}\nthis.load=loadXFeed`, context);
  const feed = await context.load({ saved: true, before: '', autoTranslate: false });
  assert.match(calls[0], /saved=1/);
  assert.match(calls[0], /limit=50/);
  assert.equal(calls[0].includes('before='), false);
  assert.equal(context.state.xNextCursor, '0,10,keep');
  assert.deepEqual(Array.from(context.state.xItems, (item) => [item.id, item.title]), [['x:star', '星标'], ['x:old', '更新']]);
  assert.equal(feed.nextCursor, '1,1,saved');
});

test('saved query returns a read star that the unread page does not include', async () => {
  const store = createStore(':memory:');
  try {
    const feed = store.repositories.feed;
    const source = feed.upsertSourceAccount({
      workspaceId: 'local', provider: 'x', externalId: 'x:home', displayName: 'X',
    });
    const ids = [];
    for (let index = 0; index < 20; index += 1) {
      const externalId = `t${index}`;
      const capture = feed.saveCapture({
        workspaceId: 'local', provider: 'x', externalId, sourceAccountId: source.id,
        sourceUrl: `https://x.com/example/status/${index}`, contentHash: `hash-${index}`, capturedAt: 1_000 + index,
      });
      const item = feed.saveContentItem({
        workspaceId: 'local', captureId: capture.id, originType: 'subscription', contentType: 'post',
        title: `标题 ${externalId}`, body: '正文', summary: '摘要',
        sourceUrl: `https://x.com/example/status/${index}`, authorName: 'Example', publishedAt: 1_000 + index,
      });
      ids.push(item.id);
    }
    feed.upsertUserItemState({ workspaceId: 'local', contentItemId: ids[0], isRead: true, isSaved: true });
    const service = createFeedService({
      legacyRepository: {},
      feedRepository: feed,
      sourcePort: {
        findByProvider: () => ({ id: 'content.x' }),
        persistence: () => ({ providerId: 'x', sourceAccount: { externalId: 'x:home' }, emptyNote: '' }),
        read: async () => { throw new Error('saved query must not refresh'); },
      },
    });
    const page = await service.getExternalFeed('x', parseXFeedQuery({ limit: '12' }));
    assert.equal(page.items.some((item) => item.isSaved), false);
    const stars = await service.getExternalFeed('x', parseXFeedQuery({ limit: '50', saved: '1' }));
    assert.equal(stars.items.length, 1);
    assert.equal(stars.items[0].isSaved, true);
    assert.equal(stars.items[0].externalId, 't0');
  } finally {
    store.close();
  }
});

test('a retrieved body with an english excerpt still shows the client translation on the card', () => {
  const context = vm.createContext({
    formatTime: () => '',
    postTagNames: () => [],
    FEED_TITLE_MAX: 72,
    FEED_EXCERPT_MAX: 96,
    splitFeedText: (value) => ({ body: String(value || ''), comments: [] }),
    translationStoreKey: () => 'key',
    loadTranslationStore: () => ({}),
    state: { translations: {}, xTranslating: false },
  });
  vm.runInContext(`${extract([
    'textNeedsZhView', 'chineseReaderText', 'readerTranslationCut', 'postNeedsChineseTranslation', 'postIsTranslating', 'socialListPlaceholder',
    'translationFor', 'plainFeedText', 'clipFeedText', 'firstFeedSentence', 'textAfterLead',
    'postDisplayTitle', 'socialBodyText', 'listCardExcerpt', 'postListExcerpt', 'feedCardExcerpt', 'feedAsItem',
  ])}\nthis.feedAsItem=feedAsItem;this.card=feedCardExcerpt;`, context);
  const post = context.feedAsItem({
    id: 'x:body',
    title: 'CapCut for students',
    summary: 'Verified students get 50% off in selected markets.',
    excerpt: 'Verified students get 50% off in selected markets.',
    body: 'Verified students get 50% off in selected markets. Terms apply.',
  }, 'x');
  assert.match(post.excerpt, /Verified students/);
  context.state.translations['x:body'] = { text: '认证学生可享五折优惠。仅限部分市场，条款适用。', engine: 'manual' };
  const shown = context.card(post);
  assert.match(shown, /仅限部分市场/);
  assert.equal(/[A-Za-z]/.test(shown), false);
  const waiting = context.feedAsItem({
    id: 'x:wait', title: 'Market note', summary: 'Another English sentence about markets today.', body: '',
    translation: { status: 'pending', title: '' },
  }, 'x');
  assert.equal(waiting.excerpt, '正在翻译…');
  context.state.xTranslating = false;
  const missed = context.feedAsItem({
    id: 'x:miss', title: 'Market note', summary: 'Another English sentence about markets today.', body: '',
    translation: { status: 'ready', title: '' },
  }, 'x');
  assert.equal(missed.excerpt, '暂未翻译');
});
