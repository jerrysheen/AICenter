import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createStore } from '../packages/database/src/index.js';
import { parseFeedBefore, parseMediaFeedQuery, parseXFeedQuery, ValidationError } from '../packages/contracts/src/index.js';
import { createFeedService } from '../packages/domain/src/feed-service.js';
import { createMediaIngestionService } from '../packages/domain/src/media-ingestion-service.js';

const BODY = `${'公开市场评论与经营数据。'.repeat(180)} END`;
const TRANSLATION = `${'这是对应的中文译文，只应出现在全文响应里。'.repeat(120)} END`;

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function feedService(store, calls) {
  const raw = store.repositories.feed;
  const counted = new Set(['getContentItem', 'listTranslations', 'listTranslationPreviews', 'listContentItemsWithSource']);
  const feed = {};
  for (const key of Object.getOwnPropertyNames(raw)) {
    const value = raw[key];
    if (typeof value !== 'function') continue;
    feed[key] = (...args) => {
      if (counted.has(key)) calls[key] = (calls[key] || 0) + 1;
      return value.apply(raw, args);
    };
  }
  const source = feed.upsertSourceAccount({
    workspaceId: 'local', provider: 'x', externalId: 'x:home', displayName: 'X',
  });
  const ids = [];
  for (let index = 0; index < 55; index += 1) {
    const externalId = `t${String(index).padStart(2, '0')}`;
    const body = `${BODY} ${externalId}`;
    const capture = feed.saveCapture({
      workspaceId: 'local', provider: 'x', externalId, sourceAccountId: source.id,
      sourceUrl: `https://x.com/example/status/${index}`, contentHash: hash(externalId), capturedAt: 1_000 + index,
    });
    const item = feed.saveContentItem({
      workspaceId: 'local', captureId: capture.id, originType: 'subscription', contentType: 'post',
      title: `标题 ${externalId}`, body, summary: `摘要 ${externalId}`,
      sourceUrl: `https://x.com/example/status/${index}`, authorName: 'Example', publishedAt: 1_000 + index,
    });
    feed.saveTranslations([{
      workspaceId: 'local', itemId: `x:${externalId}`, targetLang: 'zh', sourceHash: hash(body),
      translatedText: `${TRANSLATION} ${externalId}`, engine: 'test',
    }]);
    ids.push({ externalId, contentId: item.id, capturedAt: 1_000 + index });
  }
  feed.upsertUserItemState({ workspaceId: 'local', contentItemId: ids.at(-1).contentId, isRead: true });
  const service = createFeedService({
    legacyRepository: {},
    feedRepository: feed,
    taggingRepository: store.repositories.tagging,
    sourcePort: {
      findByProvider: () => ({ id: 'content.x' }),
      persistence: () => ({ providerId: 'x', sourceAccount: { externalId: 'x:home' }, emptyNote: '' }),
      read: async () => { throw new Error('pagination test must not refresh'); },
    },
    normalizedArticlePort: { normalizedArticles: () => new Map() },
  });
  return { service, ids };
}

test('feed cursors and list fields parse, and reject unknown values', () => {
  assert.deepEqual(parseFeedBefore('0,1700000000000,item,with,comma'), {
    isRead: 0, at: 1_700_000_000_000, id: 'item,with,comma',
  });
  assert.equal(parseFeedBefore(''), null);
  assert.throws(() => parseFeedBefore('later'), ValidationError);
  assert.throws(() => parseFeedBefore('2,1,id'), ValidationError);
  assert.equal(parseXFeedQuery({ limit: '12' }).fields, 'list');
  assert.equal(parseXFeedQuery({ limit: '12' }).saved, false);
  assert.equal(parseXFeedQuery({ limit: '12', saved: '1' }).saved, true);
  assert.equal(parseXFeedQuery({ fields: 'full', before: '1,20,abc' }).fields, 'full');
  assert.deepEqual(parseXFeedQuery({ fields: 'full', before: '1,20,abc' }).before, { isRead: 1, at: 20, id: 'abc' });
  assert.throws(() => parseXFeedQuery({ fields: 'body' }), ValidationError);
  assert.equal(parseMediaFeedQuery({ limit: '12' }).fields, 'list');
  assert.equal(parseMediaFeedQuery({ fields: 'full' }).fields, 'full');
  assert.throws(() => parseMediaFeedQuery({ before: 'bad' }), ValidationError);
});

test('stored social feed honours limit, unread-first cursor pages, and keeps association queries constant', async () => {
  const store = createStore(':memory:');
  try {
    const calls = {};
    const { service } = feedService(store, calls);
    const first = await service.getExternalFeed('x', { feed: 'for-you', limit: 12, fields: 'list' });
    assert.equal(first.items.length, 12);
    assert.equal(first.total, 55);
    assert.equal(first.tweetCount, 55);
    assert.ok(first.nextCursor);
    assert.equal(first.items.some((item) => item.isRead), false);
    assert.deepEqual(first.items.map((item) => item.externalId), ['t53', 't52', 't51', 't50', 't49', 't48', 't47', 't46', 't45', 't44', 't43', 't42']);
    const lean = JSON.stringify(first);
    for (const item of first.items) {
      assert.equal(Object.hasOwn(item, 'body'), false);
      assert.equal(item.translation.text, undefined);
      assert.equal(item.translation.status, 'ready');
      assert.match(item.translation.title, /中文译文/);
      assert.ok(item.summary.length <= 201);
      assert.equal(item.excerpt, item.summary);
      assert.match(item.sourceUrl, /^https:\/\/x\.com\//);
    }
    const cursor = parseFeedBefore(first.nextCursor);
    const second = await service.getExternalFeed('x', { feed: 'for-you', limit: 12, fields: 'list', before: cursor });
    const seen = new Set(first.items.map((item) => item.id));
    assert.equal(second.items.length, 12);
    assert.equal(second.items.some((item) => seen.has(item.id)), false);
    assert.equal(second.items[0].externalId, 't41');
    const wide = await service.getExternalFeed('x', { feed: 'for-you', limit: 80, fields: 'full' });
    assert.equal(wide.items.length, 50);
    assert.ok(wide.nextCursor);
    assert.match(wide.items[0].body, /END t53/);
    assert.match(wide.items[0].translation.text, /END t53/);
    const fullPage = await service.getExternalFeed('x', { feed: 'for-you', limit: 12, fields: 'full' });
    const fullBytes = Buffer.byteLength(JSON.stringify(fullPage));
    const listBytes = Buffer.byteLength(lean);
    console.log(`social-feed-bytes list12=${listBytes} full12=${fullBytes} ratio=${(listBytes / fullBytes).toFixed(3)}`);
    assert.ok(listBytes < fullBytes / 5, `list ${listBytes} should be under a fifth of full ${fullBytes}`);
    assert.equal(calls.getContentItem || 0, 0);
    assert.equal(calls.listTranslations, 2);
    assert.equal(calls.listTranslationPreviews, 2);
    // 列表不再为规范化文章重读正文；两次 full 请求仍会读。
    assert.equal(calls.listContentItemsWithSource, 2);
  } finally {
    store.close();
  }
});

test('media pages in SQL, batches associations, and drops article text from the list payload', () => {
  const store = createStore(':memory:');
  try {
    const media = store.repositories.media;
    let scans = 0;
    let legacyReads = 0;
    let briefReads = 0;
    const listEntries = media.listEntries.bind(media);
    media.listEntries = (...args) => { scans += 1; return listEntries(...args); };
    media.legacyLinks = () => { legacyReads += 1; return []; };
    const getBrief = media.getBriefProcessing.bind(media);
    media.getBriefProcessing = (...args) => { briefReads += 1; return getBrief(...args); };
    const now = Date.parse('2026-10-10T00:00:00Z');
    const paragraph = '段落'.repeat(800);
    for (let index = 0; index < 8; index += 1) {
      const externalId = `decoder:${index}`;
      const bodyHash = hash(externalId);
      media.upsertEntry({
        workspaceId: 'local', externalId, sourceKey: 'decoder', publisherKey: 'decoder', publisherName: 'The Decoder',
        channel: 'tech', canonicalUrl: `https://the-decoder.com/${index}`, title: `报道 ${index}`, summary: `索引摘要 ${index}`,
        publishedAt: now + index * 1000, publishedAtRaw: '', contentLevel: index === 0 ? 'summary_only' : 'partial',
        contentHash: bodyHash, revision: 1, status: 'indexed', observedAt: now, createdAt: now, updatedAt: now, bodyHash,
      });
      if (index !== 0) {
        media.saveSnapshot({
          workspaceId: 'local', externalId, revision: 1, bodyHash, truncated: false, contentLevel: 'partial', observedAt: now,
          bodyText: `${paragraph} ${index}`,
          article: { paragraphs: [{ id: 'p0001', kind: 'paragraph', text: `${paragraph} ${index}` }] },
        });
      }
    }
    const source = store.repositories.feed.upsertSourceAccount({
      workspaceId: 'local', provider: 'media', externalId: 'media:default', displayName: '媒体',
    });
    const capture = store.repositories.feed.saveCapture({
      workspaceId: 'local', provider: 'media', externalId: 'decoder:7', sourceAccountId: source.id,
      sourceUrl: 'https://the-decoder.com/7', contentHash: hash('decoder:7'), capturedAt: now,
    });
    const content = store.repositories.feed.saveContentItem({
      workspaceId: 'local', captureId: capture.id, originType: 'subscription', contentType: 'article',
      title: '报道 7', body: '已读', sourceUrl: 'https://the-decoder.com/7',
    });
    store.repositories.feed.upsertUserItemState({ workspaceId: 'local', contentItemId: content.id, isRead: true });
    const service = createMediaIngestionService({
      mediaRepository: media,
      feedRepository: store.repositories.feed,
      taggingRepository: store.repositories.tagging,
      mediaPort: { sources: [], publishers: [], extractorVersion: 'v-test', timeZone: 'Asia/Shanghai' },
      now: () => now,
    });
    const page = service.readFeed({ channel: 'tech', limit: 2, fields: 'list' }, { workspaceId: 'local' });
    assert.equal(scans, 0);
    assert.equal(legacyReads, 0);
    assert.equal(briefReads, 0);
    assert.equal(page.total, 8);
    assert.equal(page.nextOffset, 2);
    assert.deepEqual(page.items.map((item) => item.externalId), ['decoder:6', 'decoder:5']);
    assert.equal(page.items[0].body, '');
    assert.equal(page.items[0].detail, 'list');
    assert.equal(page.items[0].paragraphs, undefined);
    assert.equal(page.items[0].articleTranslation, null);
    assert.match(page.items[0].summary, /索引摘要 6|段落/);
    const next = service.readFeed({ channel: 'tech', limit: 2, offset: 2, fields: 'list' }, { workspaceId: 'local' });
    assert.deepEqual(next.items.map((item) => item.externalId), ['decoder:4', 'decoder:3']);
    const cursorPage = service.readFeed({
      channel: 'tech', limit: 6, before: parseFeedBefore(page.nextCursor), fields: 'list',
    }, { workspaceId: 'local' });
    const seen = new Set(page.items.map((item) => item.externalId));
    assert.equal(cursorPage.items.some((item) => seen.has(item.externalId)), false);
    assert.equal(cursorPage.items.at(-1).externalId, 'decoder:7');
    assert.equal(cursorPage.items.at(-1).isRead, true);
    const indexed = service.readFeed({ channel: 'tech', view: 'index', limit: 20, fields: 'list' }, { workspaceId: 'local' });
    assert.deepEqual(indexed.items.map((item) => item.externalId), ['decoder:0']);
    const full = service.readFeed({ channel: 'tech', limit: 2, fields: 'full' }, { workspaceId: 'local' });
    const fullBytes = Buffer.byteLength(JSON.stringify(full));
    const listBytes = Buffer.byteLength(JSON.stringify(page));
    console.log(`media-feed-bytes list2=${listBytes} full2=${fullBytes} ratio=${(listBytes / fullBytes).toFixed(3)}`);
    assert.match(full.items[0].body, /段落/);
    assert.equal(full.items[0].paragraphs.length, 1);
    assert.ok(listBytes < fullBytes / 5, `list ${listBytes} should be under a fifth of full ${fullBytes}`);
    assert.equal(scans, 0);
  } finally {
    store.close();
  }
});

test('home feed asks for one page and opens the stored social article on demand', async () => {
  const source = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');
  const calls = [];
  const context = vm.createContext({
    URLSearchParams,
    FEED_PAGE_SIZE: 12,
    state: {
      session: {}, xFeed: 'for-you', xItems: [{ id: 'x:old' }], xNextCursor: '0,10,abc',
      xueqiuFeed: 'following', xueqiuItems: [], xueqiuNextCursor: '', feedShown: 12,
    },
    api: async (url) => {
      calls.push(url);
      return { feed: { items: [{ id: 'x:new' }], nextCursor: '0,1,next', note: '已缓存 2 条' } };
    },
    isHiddenFeedItem: () => false,
    hydrateFeedTranslations: () => {},
    renderPosts: () => {},
    renderXToolbar: () => {},
    renderXueqiuToolbar: () => {},
    syncLocalTranslationsToServer: () => Promise.resolve(),
    loadFeedTaggings: () => Promise.resolve(),
    translateXBatch: async () => {},
    document: { body: { dataset: {} } },
    renderOverviewTimeline: () => {},
    settleSourcePage: () => {},
  });
  const paint = source.match(/function paintLoadedSocialFeed\([^]*?\n\}/)[0];
  const mergeItem = source.match(/function mergeLoadedFeedItem\([^]*?\n\}/)[0];
  const loadX = source.match(/async function loadXFeed\([^]*?\n\}/)[0];
  vm.runInContext(`${paint}\n${mergeItem}\n${loadX}\nthis.load=loadXFeed`, context);
  await context.load({ append: true, autoTranslate: false });
  assert.match(calls[0], /limit=12/);
  assert.match(calls[0], /before=0%2C10%2Cabc/);
  assert.equal(Array.from(context.state.xItems, (item) => item.id).join(','), 'x:old,x:new');
  assert.equal(context.state.xNextCursor, '0,1,next');
  assert.equal(context.state.feedShown, 13);
  calls.length = 0;
  await context.load({ refresh: true, autoTranslate: false });
  assert.match(calls[0], /limit=50/);
  assert.equal(calls[0].includes('before='), false);
  assert.match(source, /\/api\/v1\/content-items\/\$\{encodeURIComponent\(resourceId\)\}/);
  assert.match(source, /restoreSocialArticle\(itemId, post\)/);
});

function extractFunctions(source, names) {
  return names.map((name) => {
    const result = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
    assert.ok(result, name);
    return result[0];
  }).join('\n');
}

test('verified translated media list item renders as a summary and does not throw', () => {
  const source = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');
  const context = vm.createContext({
    formatTime: () => 'time',
    state: { translations: {} },
    translationStoreKey: () => 'media-key',
    loadTranslationStore: () => ({}),
  });
  vm.runInContext(`${extractFunctions(source, ['textNeedsZhView', 'chineseReaderText', 'translationFor', 'mediaAsItem'])}\nthis.translationFor=translationFor;this.mediaAsItem=mediaAsItem;`, context);
  const item = {
    id: 'media:decoder:ready',
    externalId: 'decoder:ready',
    detail: 'list',
    contentLevel: 'full',
    truncated: false,
    title: 'API price',
    summary: '索引摘要',
    body: '',
    articleTranslation: { status: 'ready', title: '接口价格', bodyHash: 'abc' },
    publisherName: 'The Decoder',
  };
  const post = context.mediaAsItem(item);
  assert.equal(post.complete, false);
  assert.equal(post.paragraphs.length, 0);
  assert.match(post.excerpt, /索引摘要/);
  assert.doesNotThrow(() => {
    const excerpt = post.excerpt || '';
    const className = context.translationFor(post) ? 'post-excerpt is-translated' : 'post-excerpt';
    assert.match(excerpt, /索引摘要/);
    assert.equal(className, 'post-excerpt');
  });
  assert.equal(context.translationFor({
    ...post,
    complete: true,
    paragraphs: undefined,
    articleTranslation: { status: 'ready', title: '接口价格', bodyHash: 'abc' },
  }), null);
});

test('media list cards prefer the translated title segment', () => {
  const source = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');
  const context = vm.createContext({
    formatTime: () => '',
    FEED_TITLE_MAX: 72,
    FEED_EXCERPT_MAX: 96,
    state: { translations: {}, xTranslating: false },
    translationStoreKey: () => 'media-key',
    loadTranslationStore: () => ({}),
    splitFeedText: (value) => ({ body: String(value || ''), comments: [] }),
  });
  vm.runInContext(`${extractFunctions(source, [
    'textNeedsZhView', 'chineseReaderText', 'postNeedsChineseTranslation', 'postIsTranslating',
    'translationFor', 'plainFeedText', 'clipFeedText', 'firstFeedSentence', 'textAfterLead',
    'postDisplayTitle', 'socialBodyText', 'mediaAsItem',
  ])}\nthis.title=postDisplayTitle;this.mediaAsItem=mediaAsItem;`, context);
  const translated = context.mediaAsItem({
    id: 'media:bbc:1', externalId: 'bbc:1', detail: 'list', contentLevel: 'full',
    title: 'Oil prices rise after the supply cut',
    summary: '供应收紧，油价在亚洲交易时段走高。',
    excerpt: '供应收紧，油价在亚洲交易时段走高。',
    articleTranslation: { status: 'ready', title: '供应削减后油价上涨', bodyHash: 'abc' },
    translation: { status: 'ready', title: '供应削减后油价上涨' },
    translationTitle: '供应削减后油价上涨',
    publisherName: 'BBC',
  });
  assert.equal(context.title(translated), '供应削减后油价上涨');
  const titled = context.mediaAsItem({
    id: 'media:bbc:2', externalId: 'bbc:2', detail: 'list', contentLevel: 'full',
    title: 'Oil prices rise after the supply cut',
    translationTitle: '供应削减后油价上涨',
    summary: '供应收紧。', publisherName: 'BBC',
  });
  assert.equal(context.title(titled), '供应削减后油价上涨');
  const original = context.mediaAsItem({
    id: 'media:bbc:3', externalId: 'bbc:3', detail: 'list', title: 'Oil prices rise after the supply cut',
    summary: 'English summary', publisherName: 'BBC',
  });
  assert.equal(context.title(original), 'Oil prices rise after the supply cut');
});

test('a background reload returns to the first page and keeps opened text', async () => {
  const source = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');
  const calls = [];
  let reads = 0;
  const context = vm.createContext({
    URLSearchParams,
    FEED_PAGE_SIZE: 12,
    state: { session: {}, xFeed: 'for-you', xItems: [], xNextCursor: '', feedShown: 12 },
    api: async (url) => {
      calls.push(url);
      reads += 1;
      if (url.includes('before=')) {
        return { feed: { items: [{ id: 'x:2', summary: 'second page' }], nextCursor: '0,2,x:2' } };
      }
      if (reads === 1) return { feed: { items: [{ id: 'x:1', summary: 'first page' }], nextCursor: '0,1,x:1' } };
      return { feed: { items: [{ id: 'x:1', summary: 'English summary again', body: '' }], nextCursor: '0,9,reset' } };
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
    settleSourcePage: () => {},
  });
  vm.runInContext(`${extractFunctions(source, ['paintLoadedSocialFeed', 'mergeLoadedFeedItem', 'mergeLoadedFeed', 'loadXFeed'])}\nthis.load=loadXFeed`, context);
  await context.load({ autoTranslate: false });
  await context.load({ append: true, autoTranslate: false });
  const opened = Array.from(context.state.xItems).find((item) => item.id === 'x:1');
  opened.detail = 'full';
  opened.body = '已展开的全文';
  opened.translation = { text: '中文全文', engine: 'test' };
  const cursor = context.state.xNextCursor;
  await context.load({ autoTranslate: false });
  const items = Array.from(context.state.xItems);
  assert.deepEqual(items.map((item) => item.id), ['x:1']);
  assert.equal(items[0].body, '已展开的全文');
  assert.equal(items[0].translation.text, '中文全文');
  assert.equal(items[0].detail, 'full');
  assert.equal(context.state.xNextCursor, '0,9,reset');
  assert.notEqual(context.state.xNextCursor, cursor);
  assert.equal(calls.at(-1).includes('before='), false);
  assert.match(calls.at(-1), /limit=12/);
});

test('social cards show translation state instead of the foreign summary, and translate loads the body first', async () => {
  const source = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');
  const context = vm.createContext({
    formatTime: () => '',
    postTagNames: () => [],
    state: { translations: {}, restoredArticles: {}, session: {}, dialogPost: null },
    elements: {},
    showToast(message) { context.toast = message; },
    setView() {},
    translationFor: () => null,
    postNeedsChineseTranslation: () => true,
    shouldQueueTranslation(post) {
      if (String(post?.translation?.text || '').trim()) return false;
      if (context.translationFor(post)) return false;
      return context.postNeedsChineseTranslation(post);
    },
    requestTranslation: async () => ({ translation: { translatedText: '中文全文', engine: 'test' } }),
    rememberTranslation() { context.remembered = true; },
    renderPosts() {},
    findUnifiedItem: (id) => context.state.restoredArticles[id],
    restoreSocialArticle: async (id, post) => {
      context.restored = id;
      context.state.restoredArticles[id] = { ...post, body: 'Verified students get 50% off. Select markets only.' };
    },
  });
  vm.runInContext(`${extractFunctions(source, ['textNeedsZhView', 'socialListPlaceholder', 'listCardExcerpt', 'feedAsItem', 'translatePost'])}\nthis.feedAsItem=feedAsItem;this.translate=translatePost;`, context);
  const translated = context.feedAsItem({
    id: 'x:1', title: 'CapCut for students', summary: 'Verified students get 50% off in selected markets.',
    excerpt: 'Verified students get 50% off in selected markets.', body: '',
    translation: { status: 'ready', title: '认证学生可享优惠' },
  }, 'x');
  const pending = context.feedAsItem({
    id: 'x:2', title: 'Market note', summary: 'Another English sentence about markets today.', body: '',
  }, 'x');
  const chinese = context.feedAsItem({
    id: 'xq:1', title: '季度数据', summary: '公司发布季度经营数据，维持原有指引。', body: '',
  }, 'xueqiu');
  assert.equal(translated.excerpt, '认证学生可享优惠');
  assert.equal(pending.excerpt, '暂未翻译');
  assert.equal(chinese.excerpt, '公司发布季度经营数据，维持原有指引。');
  await context.translate({ id: 'x:2', platform: 'x', resourceId: 'item-2', body: '' });
  assert.equal(context.restored, 'x:2');
  assert.equal(context.remembered, true);
  assert.notEqual(context.toast, '这条没有可翻译的正文');
});

test('a client translation replaces the english card excerpt, and an in-flight server translation says it is translating', () => {
  const source = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');
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
  vm.runInContext(`${extractFunctions(source, [
    'textNeedsZhView', 'chineseReaderText', 'postNeedsChineseTranslation', 'postIsTranslating', 'socialListPlaceholder',
    'translationFor', 'plainFeedText', 'clipFeedText', 'firstFeedSentence', 'textAfterLead',
    'postDisplayTitle', 'socialBodyText', 'listCardExcerpt', 'postListExcerpt', 'feedCardExcerpt', 'feedAsItem',
  ])}\nthis.feedAsItem=feedAsItem;this.card=feedCardExcerpt;`, context);
  const post = context.feedAsItem({
    id: 'x:3', title: 'CapCut for students',
    summary: 'Verified students get 50% off in selected markets.',
    excerpt: 'Verified students get 50% off in selected markets.',
    body: 'Verified students get 50% off in selected markets. Terms apply.',
  }, 'x');
  assert.match(post.excerpt, /Verified students/);
  context.state.translations['x:3'] = { text: '认证学生可享五折优惠。仅限部分市场，条款适用。', engine: 'test' };
  const shown = context.card(post);
  assert.match(shown, /仅限部分市场/);
  assert.equal(/[A-Za-z]/.test(shown), false);
  const waiting = context.feedAsItem({
    id: 'x:4', title: 'Market note', summary: 'Another English sentence about markets today.', body: '',
    translation: { status: 'pending', title: '' },
  }, 'x');
  assert.equal(waiting.excerpt, '正在翻译…');
  context.state.xTranslating = true;
  const batch = context.feedAsItem({
    id: 'x:5', title: 'Market note', summary: 'Another English sentence about markets today.', body: '',
  }, 'x');
  assert.equal(batch.excerpt, '正在翻译…');
});
