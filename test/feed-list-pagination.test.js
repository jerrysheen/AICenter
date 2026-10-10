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
  const counted = new Set(['getContentItem', 'listTranslations', 'listContentItemsWithSource']);
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
    assert.equal(calls.listTranslations, 4);
    assert.equal(calls.listContentItemsWithSource, 4);
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
  });
  const loadX = source.match(/async function loadXFeed\([^]*?\n\}/)[0];
  vm.runInContext(`${loadX}\nthis.load=loadXFeed`, context);
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
