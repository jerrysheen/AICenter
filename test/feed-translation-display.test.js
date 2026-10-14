import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createStore } from '../packages/database/src/index.js';
import { createFeedService } from '../packages/domain/src/feed-service.js';
import { backfillUntranslatedFeedTranslations, createFeedTranslationJobHandlers, enqueueOriginalTranslations, translationStartupBackfillLimit } from '../packages/runtime/src/feed-translation-module.js';
import { createJobRunner } from '../packages/runtime/src/job-runner.js';

test('worker startup backfill stays within the daily translation budget', () => {
  assert.equal(translationStartupBackfillLimit(undefined), 80);
  assert.equal(translationStartupBackfillLimit(''), 80);
  assert.equal(translationStartupBackfillLimit('40'), 40);
  assert.equal(translationStartupBackfillLimit('0'), 0);
  assert.equal(translationStartupBackfillLimit('80'), 80);
  assert.equal(translationStartupBackfillLimit('81'), 80);
  assert.equal(translationStartupBackfillLimit('5000'), 80);
  assert.equal(translationStartupBackfillLimit('nope'), 80);
});

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function watchFeed(raw, calls) {
  const feed = {};
  for (const key of Object.getOwnPropertyNames(raw)) {
    const value = raw[key];
    if (typeof value !== 'function') continue;
    feed[key] = (...args) => {
      if (key === 'listContentItemsWithSource') calls.reads += 1;
      return value.apply(raw, args);
    };
  }
  return feed;
}

function sourcePort() {
  return {
    findByProvider: () => ({ id: 'content.x' }),
    persistence: () => ({ providerId: 'x', sourceAccount: { externalId: 'x:home' }, emptyNote: '' }),
    read: async () => { throw new Error('test must not refresh'); },
  };
}

function saveXItem(feed, sourceId, { externalId, title, body, summary = '', publishedAt = 5_000 }) {
  const capture = feed.saveCapture({
    workspaceId: 'local', provider: 'x', externalId, sourceAccountId: sourceId,
    sourceUrl: `https://x.com/example/status/${externalId}`, contentHash: hash(externalId), capturedAt: publishedAt,
  });
  return feed.saveContentItem({
    workspaceId: 'local', captureId: capture.id, originType: 'subscription', contentType: 'post',
    title, body, summary, sourceUrl: `https://x.com/example/status/${externalId}`,
    authorName: 'Jukan', publishedAt,
  });
}

test('list cards carry Chinese title and summary, and Chinese sources are not marked for translation', async () => {
  const store = createStore(':memory:');
  try {
    const calls = { reads: 0 };
    const feed = watchFeed(store.repositories.feed, calls);
    const source = feed.upsertSourceAccount({ workspaceId: 'local', provider: 'x', externalId: 'x:home', displayName: 'X' });
    const english = 'CXMT 4F2 DRAM capacity is the subject of this long English note. '.repeat(8);
    const chinese = '这是中文来源的正文，标题碰巧是英文产品名 CXMT。后续仍是中文说明。';
    const translated = '长鑫 4F² 产能说明。正文后半解释了扩产节奏和客户验证进度，供列表摘要使用。';
    const englishItem = saveXItem(feed, source.id, { externalId: 'en', title: 'CXMT 4F2', body: english, summary: 'English summary about capacity.', publishedAt: 3_000 });
    saveXItem(feed, source.id, { externalId: 'zh', title: 'CXMT product name', body: chinese, summary: '中文摘要', publishedAt: 2_000 });
    feed.saveTranslations([{
      workspaceId: 'local', itemId: englishItem.id, targetLang: 'zh', sourceHash: hash(english),
      translatedText: translated, engine: 'test',
    }]);
    const service = createFeedService({
      legacyRepository: {}, feedRepository: feed, sourcePort: sourcePort(),
    });
    const listed = await service.getExternalFeed('x', { feed: 'for-you', limit: 12, fields: 'list' });
    const en = listed.items.find((item) => item.externalId === 'en');
    const zh = listed.items.find((item) => item.externalId === 'zh');
    assert.equal(Object.hasOwn(en, 'body'), false);
    assert.equal(en.translation.text, undefined);
    assert.equal(en.translation.title, '长鑫 4F² 产能说明。');
    assert.match(en.translation.summary, /扩产节奏/);
    assert.equal(en.needsTranslation, true);
    assert.equal(zh.needsTranslation, false);
    assert.equal(zh.translation, null);
    assert.equal(calls.reads, 0);
    const full = await service.getExternalFeed('x', { feed: 'for-you', limit: 12, fields: 'full' });
    assert.match(full.items.find((item) => item.externalId === 'en').translation.text, /客户验证进度/);
  } finally {
    store.close();
  }
});

test('list shape attaches normalized Chinese title and summary without rereading bodies', async () => {
  const store = createStore(':memory:');
  try {
    const calls = { reads: 0 };
    const feed = watchFeed(store.repositories.feed, calls);
    const source = feed.upsertSourceAccount({ workspaceId: 'local', provider: 'x', externalId: 'x:home', displayName: 'X' });
    const item = saveXItem(feed, source.id, { externalId: 'norm', title: 'English headline', body: 'English body that still needs a Chinese card.', summary: 'English summary' });
    const service = createFeedService({
      legacyRepository: {}, feedRepository: feed, sourcePort: sourcePort(),
      normalizedArticlePort: {
        normalizedArticles(_workspace, specs) {
          const out = new Map();
          for (const spec of specs) {
            if (spec.sourceId === `feed:${item.id}`) {
              out.set(spec.sourceId, { nodeId: 'n1', title: '中文标题', summary: '中文摘要', body: '中文正文', generatedAt: 1 });
            }
          }
          return out;
        },
      },
    });
    const listed = await service.getExternalFeed('x', { feed: 'for-you', limit: 12, fields: 'list' });
    assert.equal(listed.items[0].normalizedArticle.title, '中文标题');
    assert.equal(listed.items[0].normalizedArticle.summary, '中文摘要');
    assert.equal(listed.items[0].normalizedArticle.body, undefined);
    assert.equal(calls.reads, 0);
  } finally {
    store.close();
  }
});

test('long posts are queued in full and a backfill does not duplicate open jobs', async () => {
  const store = createStore(':memory:');
  try {
    const calls = { reads: 0 };
    const feed = watchFeed(store.repositories.feed, calls);
    const source = feed.upsertSourceAccount({ workspaceId: 'local', provider: 'x', externalId: 'x:home', displayName: 'X' });
    const longText = `English report sentence ${'capacity '.repeat(40)}`.repeat(80);
    assert.ok(longText.length > 20_000);
    assert.ok(longText.length < 200_000);
    const longItem = saveXItem(feed, source.id, { externalId: 'long', title: 'Long English', body: longText, publishedAt: 9_000 });
    const chinese = saveXItem(feed, source.id, { externalId: 'zh', title: '中文', body: '这是一条不需要翻译的中文长帖。'.repeat(20), publishedAt: 8_000 });
    const doneText = 'A short English post that already has a translation.';
    const done = saveXItem(feed, source.id, { externalId: 'done', title: 'Done', body: doneText, publishedAt: 7_000 });
    feed.saveTranslations([{
      workspaceId: 'local', itemId: done.id, targetLang: 'zh', sourceHash: hash(doneText),
      translatedText: '已经有译文。', engine: 'test',
    }]);
    const seen = [];
    const translated = `${'中文长译文。'.repeat(2000)}结束`;
    assert.ok(translated.length > 8_000);
    const service = createFeedService({
      legacyRepository: store, feedRepository: feed, sourcePort: sourcePort(),
      translationPort: { translate: async ({ text }) => { seen.push(text); return { translatedText: translated, engine: 'test', targetLang: 'zh' }; } },
    });
    const jobs = await enqueueOriginalTranslations({
      store, feedService: service, workspaceId: 'local', units: [{ id: longItem.id, text: longText }],
    });
    assert.equal(jobs.length, 1);
    const again = await enqueueOriginalTranslations({
      store, feedService: service, workspaceId: 'local', units: [{ id: longItem.id, text: longText }],
    });
    assert.equal(again[0].id, jobs[0].id);
    await createJobRunner({ store, handlers: createFeedTranslationJobHandlers({ feedService: service }) }).runOnce();
    assert.equal(seen.length, 1);
    assert.ok(seen[0].length > 20_000);
    assert.equal(seen[0], longText.trim());
    assert.ok(seen[0].endsWith('capacity'));
    const saved = feed.listTranslations('local', [longItem.id])[0];
    assert.equal(saved.translatedText, translated);
    assert.equal(saved.sourceHash, hash(seen[0]));
    const queued = await backfillUntranslatedFeedTranslations({ store, feedService: service, workspaceId: 'local', limit: 10 });
    assert.equal(queued.jobs.length, 0);
    feed.removeTranslationIfUnchanged({
      workspaceId: 'local', itemId: longItem.id, targetLang: 'zh', sourceHash: saved.sourceHash,
      translatedText: saved.translatedText, engine: saved.engine,
    }, saved.updatedAt);
    assert.equal((await backfillUntranslatedFeedTranslations({ store, feedService: service, workspaceId: 'local', limit: 0 })).jobs.length, 0);
    const backfill = await backfillUntranslatedFeedTranslations({ store, feedService: service, workspaceId: 'local', limit: 10 });
    assert.equal(backfill.jobs.length, 1);
    assert.equal(backfill.jobs[0].input.items[0].id, longItem.id);
    assert.equal(backfill.jobs[0].input.items[0].text, longText.trim());
    assert.ok(backfill.jobs[0].input.items[0].text.length > 20_000);
    const second = await backfillUntranslatedFeedTranslations({ store, feedService: service, workspaceId: 'local', limit: 10 });
    assert.equal(second.jobs[0].id, backfill.jobs[0].id);
    assert.equal(chinese.id.length > 0, true);
  } finally {
    store.close();
  }
});

function extractFunctions(source, names) {
  return names.map((name) => {
    const result = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
    assert.ok(result, name);
    return result[0];
  }).join('\n');
}

test('reader prefers API translation text over cache and English normalized body', () => {
  const source = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');
  const context = vm.createContext({
    state: { translations: { 'x:1': { text: '本地旧译文', engine: 'cache' } } },
    translationStoreKey: (post) => `${post.id}::body`,
    loadTranslationStore: () => ({ 'x:1::body': { text: '磁盘旧译文', engine: 'disk' } }),
  });
  vm.runInContext(`${extractFunctions(source, ['textNeedsZhView', 'translationFor'])}\nthis.translationFor=translationFor;`, context);
  const api = context.translationFor({
    id: 'x:1', platform: 'x', body: 'English original about CXMT.',
    translation: { text: '接口返回的完整中文译文。', engine: 'gemma' },
    normalizedArticle: { body: 'English normalized article body that must not replace the translation.' },
  });
  assert.equal(api.text, '接口返回的完整中文译文。');
  assert.equal(context.state.translations['x:1'].text, '接口返回的完整中文译文。');
  const chineseNormalized = context.translationFor({
    id: 'x:2', platform: 'x', body: 'English original.',
    normalizedArticle: { body: '学生认证后可享五折优惠。仅限部分市场。' },
  });
  assert.equal(chineseNormalized.kind, 'normalized');
  const englishNormalized = context.translationFor({
    id: 'x:3', platform: 'x', body: 'English original about capacity plans.',
    normalizedArticle: { body: 'English normalized article body stays out of the reader.' },
  });
  assert.equal(englishNormalized, null);
});

test('Chinese-source cards are not tagged untranslated, and the visible X list requests translation without a body', () => {
  const source = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');
  const posts = [];
  const context = vm.createContext({
    formatTime: () => '',
    postTagNames: () => [],
    FEED_TITLE_MAX: 72,
    FEED_EXCERPT_MAX: 96,
    FEED_PAGE_SIZE: 12,
    TRANSLATE_BATCH_SIZE: 30,
    splitFeedText: (value) => ({ body: String(value || ''), comments: [] }),
    translationStoreKey: () => 'missing',
    loadTranslationStore: () => ({}),
    state: { translations: {}, xItems: [], xTranslating: false, session: { role: 'mobile' }, channel: 'social', feedPlatform: 'x' },
    document: { body: { dataset: { view: 'feed' } } },
    window: { setTimeout(fn) { posts.push('timer'); fn(); return 1; } },
    visibleFeedItems: () => context.state.xItems,
    xAsItem: (item) => item,
    requestTranslation: async (_path, options) => {
      context.requested = JSON.parse(options.body);
      return { translations: context.requested.items.map((item) => ({ id: item.id, translatedText: `译:${item.text}`, engine: 'test' })) };
    },
    rememberTranslation(post, translation) { context.state.translations[post.id] = translation; },
    renderPosts() {},
    renderXToolbar() {},
    showToast() {},
    setView() {},
  });
  vm.runInContext(`${extractFunctions(source, [
    'textNeedsZhView', 'postNeedsChineseTranslation', 'postIsTranslating', 'translationFor', 'readyZhTitle', 'postDisplayTitle', 'socialBodyText',
    'plainFeedText', 'clipFeedText', 'firstFeedSentence', 'translationRequestText', 'xTextNeedsTranslation',
    'xFeedVisible', 'visibleXPosts', 'pendingXTranslations', 'feedListTitle', 'listCardExcerpt', 'feedAsItem',
    'socialListPlaceholder', 'scheduleVisibleXTranslations', 'translateXBatch',
  ])}\nthis.feedListTitle=feedListTitle;this.feedAsItem=feedAsItem;this.pending=pendingXTranslations;this.schedule=scheduleVisibleXTranslations;this.batch=translateXBatch;`, context);
  const chinese = context.feedAsItem({
    id: 'x:zh', title: 'CXMT product name', summary: 'English looking title only', body: '',
    needsTranslation: false,
  }, 'x');
  assert.equal(context.feedListTitle(chinese).tag, '');
  const pending = context.feedAsItem({
    id: 'x:en', title: 'CXMT 4F2 DRAM', summary: 'Capacity plans remain in English on the card.', body: '',
    needsTranslation: true,
  }, 'x');
  assert.equal(context.feedListTitle(pending).tag, '暂未翻译');
  context.state.xItems = [pending];
  const queued = context.pending();
  assert.equal(queued.length, 1);
  assert.match(queued[0].summary, /Capacity plans/);
  context.schedule();
  assert.equal(context.requested.items[0].id, 'x:en');
  assert.match(context.requested.items[0].text, /Capacity plans/);
  assert.equal(context.requested.items[0].text.includes('暂未翻译'), false);
});
