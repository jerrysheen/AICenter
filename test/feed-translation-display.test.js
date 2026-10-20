import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createStore } from '../packages/database/src/index.js';
import { createFeedService, listNeedsTranslation, pickReaderTranslation } from '../packages/domain/src/feed-service.js';
import { createRuntimeService } from '../packages/domain/src/runtime-service.js';
import { translationLooksTruncated } from '../packages/domain/src/localize-texts.js';
import { backfillUntranslatedFeedTranslations, createFeedTranslationJobHandlers, demoteQueuedHashTranslationJobs, enqueueOriginalTranslations, repairEllipsisLeadTexts, translationBackfillConcurrency, translationStartupBackfillLimit, TRANSLATION_BACKFILL_PRIORITY, TRANSLATION_INTERACTIVE_PRIORITY } from '../packages/runtime/src/feed-translation-module.js';
import { createJobRunner, translationClaimMinPriority } from '../packages/runtime/src/job-runner.js';

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
  vm.runInContext(`${extractFunctions(source, ['textNeedsZhView', 'chineseReaderText', 'readerTranslationCut', 'dropEllipsisLead', 'translationFor', 'postNeedsChineseTranslation', 'shouldQueueTranslation'])}\nthis.translationFor=translationFor;this.shouldQueue=shouldQueueTranslation;`, context);
  const api = context.translationFor({
    id: 'x:1', platform: 'x', body: 'English original about CXMT.',
    translation: { text: '接口返回的完整中文译文。', engine: 'gemma' },
    normalizedArticle: { body: 'English normalized article body that must not replace the translation.' },
  });
  assert.equal(api.text, '接口返回的完整中文译文。');
  const repeated = context.translationFor({
    id: 'x:repeat', platform: 'x', body: 'English original.',
    translation: { text: '第一句说明产品已经发布。\n\n第一句说明产品已经发布。后面还有内容。', engine: 'gemma' },
  });
  assert.equal(repeated.text, '第一句说明产品已经发布。\n\n后面还有内容。');
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
  const kept = context.translationFor({
    id: 'x:jeff', platform: 'x', body: 'English original about the round.',
    translation: { text: 'English only translation that must not hide the Chinese article.', engine: 'gemma' },
    normalizedArticle: { body: '杰夫的投资记录已经整理成中文，保留在中文整理里。' },
  });
  assert.equal(kept.kind, 'normalized');
  assert.match(kept.text, /杰夫/);
  const truncated = context.translationFor({
    id: 'x:2110120766247424458', platform: 'x',
    body: 'Jeff wrote two paragraphs about the round. The second paragraph is still in the original and explains the public record.',
    translation: { text: '杰夫谈到了这一轮。…缺乏公开信息（我...', engine: 'gemma' },
    normalizedArticle: { body: '杰夫的两段中文整理都在。第二段说明了公开信息的范围。' },
  });
  assert.equal(truncated.kind, 'normalized');
  assert.match(truncated.text, /第二段/);
  const lead = '来自世界各地的小鹏之友汇聚于此，共同开启';
  const sentence = `${lead}飞行器的公开亮相。`;
  const xpeng = context.translationFor({
    id: 'x:xpeng', platform: 'x', body: 'XPENG friends gathered and opened the flying vehicle program.',
    translation: { text: `${lead}……${sentence}后面还有第二段。`, engine: 'gemma' },
  });
  assert.equal(xpeng.text, `${sentence}后面还有第二段。`);
  const keptLead = context.translationFor({
    id: 'x:keep-ellipsis', platform: 'x', body: 'A different second sentence follows the ellipsis.',
    translation: { text: `${lead}……后续是另一句完全不同的话。`, engine: 'gemma' },
  });
  assert.equal(keptLead.text, `${lead}……后续是另一句完全不同的话。`);
  assert.equal(context.shouldQueue({
    platform: 'trendforce', body: 'English body that already has a stored translation.',
    translation: { text: '已经有全文译文，不要再次入队。' },
  }), false);
  assert.equal(context.shouldQueue({
    platform: 'x', body: 'This English post still needs a Chinese translation today.',
  }), true);
  assert.equal(context.shouldQueue({
    platform: 'youtube', body: 'This English transcript still needs a Chinese translation today.',
  }), false);
  assert.equal(context.shouldQueue({
    provider: 'youtube', body: 'This English transcript still needs a Chinese translation today.',
  }), false);
  assert.equal(context.shouldQueue({
    id: 'youtube:2Zj6uMv3kTA', platform: 'manual',
    body: 'This English transcript still needs a Chinese translation today.',
  }), false);
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
    'textNeedsZhView', 'chineseReaderText', 'readerTranslationCut', 'postNeedsChineseTranslation', 'shouldQueueTranslation', 'postIsTranslating', 'dropEllipsisLead', 'translationFor', 'readyZhTitle', 'postDisplayTitle', 'socialBodyText',
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
  const lead = '来自世界各地的小鹏之友汇聚于此，共同开启';
  const sentence = `${lead}飞行器的公开亮相。`;
  const xpeng = context.feedAsItem({
    id: 'x:xpeng', title: 'XPENG', body: 'English body about the flying vehicle.',
    translation: { status: 'ready', title: `${lead}……`, summary: sentence },
  }, 'x');
  assert.equal(context.feedListTitle(xpeng).title, sentence);
  context.state.xItems = [pending];
  const queued = context.pending();
  assert.equal(queued.length, 1);
  assert.match(queued[0].summary, /Capacity plans/);
  context.schedule();
  assert.equal(context.requested.items[0].id, 'x:en');
  assert.match(context.requested.items[0].text, /Capacity plans/);
  assert.equal(context.requested.items[0].text.includes('暂未翻译'), false);
  const chineseBody = context.feedAsItem({
    id: 'x:pix', title: 'PixVerse model update', summary: 'English title only',
    zhLead: '像素蛋糕发布了新的视频模型。', needsTranslation: false,
  }, 'x');
  assert.equal(context.feedListTitle(chineseBody).title, '像素蛋糕发布了新的视频模型。');
  assert.equal(context.feedListTitle(chineseBody).tag, '');
  const translatedCard = context.feedAsItem({
    id: 'x:asha', title: 'ASHA weekly', summary: 'English title',
    translation: { title: 'ASHA', summary: '这是已经译好的中文摘要，不应再标暂未翻译。' },
    needsTranslation: true,
  }, 'x');
  assert.equal(context.feedListTitle(translatedCard).tag, '');
  assert.match(context.feedListTitle(translatedCard).title, /已经译好/);
});

test('an English title over a Chinese body is replaced on the list card', async () => {
  const store = createStore(':memory:');
  try {
    const feed = store.repositories.feed;
    const source = feed.upsertSourceAccount({ workspaceId: 'local', provider: 'x', externalId: 'x:home', displayName: 'X' });
    saveXItem(feed, source.id, {
      externalId: 'pix',
      title: 'PixVerse model update',
      body: '像素蛋糕发布了新的视频模型。正文后半继续说明使用范围。',
      summary: 'English summary',
    });
    const service = createFeedService({ legacyRepository: {}, feedRepository: feed, sourcePort: sourcePort() });
    const listed = await service.getExternalFeed('x', { feed: 'for-you', limit: 12, fields: 'list' });
    const card = listed.items[0];
    assert.equal(card.needsTranslation, false);
    assert.equal(card.zhLead, '像素蛋糕发布了新的视频模型。');
    assert.equal(Object.hasOwn(card, 'body'), false);
  } finally {
    store.close();
  }
});

test('list flags follow the body, and a Chinese body still supplies a card title', () => {
  assert.equal(listNeedsTranslation({ title: 'PixVerse ships a new video model today', body: '', summary: '' }), true);
  assert.equal(listNeedsTranslation({
    title: 'CXMT product name',
    body: '这是中文来源的正文，标题碰巧是英文产品名 CXMT。后续仍是中文说明。',
  }), false);
  assert.equal(listNeedsTranslation({
    title: 'Arena.ai weekly note',
    body: 'English body about model releases and customers today.',
  }), true);
  const mismatched = pickReaderTranslation([
    { sourceHash: 'old', translatedText: '库里已经有中文译文，哈希暂时对不上也不要丢掉。', engine: 'gemma' },
  ], 'current');
  assert.match(mismatched.translatedText, /中文译文/);
});

test('direct content item keeps a stored translation and a usable clock', async () => {
  const store = createStore(':memory:');
  try {
    const feed = store.repositories.feed;
    const source = feed.upsertSourceAccount({ workspaceId: 'local', provider: 'x', externalId: 'x:home', displayName: 'X' });
    const body = 'TrendForce is only the old fallback. This English note already has a translation.';
    const capture = feed.saveCapture({
      workspaceId: 'local', provider: 'x', externalId: 'direct', sourceAccountId: source.id,
      sourceUrl: 'https://x.com/example/status/direct', contentHash: hash('direct'), capturedAt: 1_700_000_000_000,
    });
    const item = feed.saveContentItem({
      workspaceId: 'local', captureId: capture.id, originType: 'subscription', contentType: 'post',
      title: 'English headline', body, summary: 'English summary', sourceUrl: capture.sourceUrl,
      authorName: 'Chris Lee', publishedAt: 0,
    });
    feed.saveTranslations([{
      workspaceId: 'local', itemId: item.id, targetLang: 'zh', sourceHash: hash('different-body'),
      translatedText: '克里斯的全文译文已经在库里。', engine: 'gemma',
    }]);
    const service = createFeedService({
      legacyRepository: {}, feedRepository: feed, sourcePort: sourcePort(),
      normalizedArticlePort: {
        normalizedArticle() {
          return { nodeId: 'n', title: '中文整理标题', summary: '中文整理摘要', body: '中文整理正文仍可使用。', generatedAt: 1 };
        },
      },
    });
    const loaded = service.getLocalizedContentItem('local', item.id);
    assert.equal(loaded.authorName, 'Chris Lee');
    assert.equal(loaded.provider, 'x');
    assert.equal(loaded.publishedAt, 1_700_000_000_000);
    assert.match(loaded.translation.text, /克里斯/);
    assert.match(loaded.normalizedArticle.body, /中文整理正文/);
    const byExternal = service.getLocalizedContentItem('local', 'x:direct');
    assert.equal(byExternal.id, item.id);
    assert.match(byExternal.translation.text, /克里斯/);
  } finally {
    store.close();
  }
});

test('user translation keeps a slot when backfill jobs are queued', async () => {
  assert.equal(translationClaimMinPriority(0, 5), null);
  assert.equal(translationClaimMinPriority(4, 5), 0);
  assert.equal(translationClaimMinPriority(5, 5), null);
  assert.equal(translationClaimMinPriority(0, 1), null);
  assert.equal(translationBackfillConcurrency(undefined, 5), 2);
  assert.equal(translationBackfillConcurrency(9, 5), 2);
  assert.equal(translationBackfillConcurrency(2, 2), 1);
  assert.equal(translationClaimMinPriority(0, 5, 2, 2), 0);
  assert.equal(translationClaimMinPriority(1, 5, 1, 2), null);
  const store = createStore(':memory:');
  try {
    const backfill = store.createJob({
      type: 'feed.translation.run', workspaceId: 'local', priority: TRANSLATION_BACKFILL_PRIORITY,
      input: { workspaceId: 'local', items: [{ id: 'backfill', text: 'long' }] },
    });
    store.createJob({
      type: 'feed.translation.run', workspaceId: 'local', priority: 10,
      input: { workspaceId: 'local', items: [{ id: 'interactive', text: 'short' }] },
    });
    const first = store.claimNextJob('worker', ['feed.translation.run'], { minPriority: 0 });
    assert.equal(first.input.items[0].id, 'interactive');
    assert.equal(store.claimNextJob('worker', ['feed.translation.run'], { minPriority: 0 }), null);
    assert.equal(store.claimNextJob('worker', ['feed.translation.run']).id, backfill.id);
    const runtime = createRuntimeService({
      runtimeRepository: {
        listOpenJobs: () => [],
        createJob(input) { return { id: 'created', ...input }; },
      },
    });
    const job = runtime.requestTranslation({
      workspaceId: 'local', targetLang: 'zh', items: [{ id: 'mobile', text: 'Please translate this short post.' }],
    });
    assert.equal(job.priority, 10);
  } finally {
    store.close();
  }
});

test('backfill demotes an open priority-0 job and requeues a truncated translation', async () => {
  const store = createStore(':memory:');
  try {
    const feed = store.repositories.feed;
    const source = feed.upsertSourceAccount({ workspaceId: 'local', provider: 'x', externalId: 'x:home', displayName: 'X' });
    const openText = 'English note that still needs a Chinese translation for the queue today.';
    const openItem = saveXItem(feed, source.id, { externalId: 'open-job', title: 'Open', body: openText, publishedAt: 4_000 });
    const longText = `Capacity plan remains uncertain. ${'detail '.repeat(140)}`;
    assert.ok(longText.length >= 600);
    assert.equal(translationLooksTruncated(longText, 40), true);
    const shortItem = saveXItem(feed, source.id, { externalId: 'short-translation', title: 'Short', body: longText, publishedAt: 3_000 });
    feed.saveTranslations([{
      workspaceId: 'local', itemId: shortItem.id, targetLang: 'zh', sourceHash: hash(longText),
      translatedText: '只有一句（我', engine: 'gemma',
    }]);
    const firstCapture = feed.saveCapture({
      workspaceId: 'local', provider: 'x', externalId: 'clock', sourceAccountId: source.id,
      sourceUrl: 'https://x.com/example/status/clock', contentHash: hash('clock-a'),
      capturedAt: 1_700_000_000_000, publishedAt: 1_700_000_000_000,
    });
    feed.saveCapture({
      workspaceId: 'local', provider: 'x', externalId: 'clock', sourceAccountId: source.id,
      sourceUrl: 'https://x.com/example/status/clock', contentHash: hash('clock-b'),
      capturedAt: 1_700_000_000_000 + 86_400_000, publishedAt: 1_700_000_000_000 + 40 * 60 * 60 * 1000,
    });
    const kept = feed.getCapture('local', 'x', 'clock');
    assert.equal(kept.capturedAt, firstCapture.capturedAt);
    assert.equal(kept.publishedAt, 1_700_000_000_000 + 40 * 60 * 60 * 1000);
    assert.equal(feed.touchPublishedAt('local', 'x', 'clock', kept.publishedAt + 60 * 60 * 1000), false);
    const service = createFeedService({
      legacyRepository: store, feedRepository: feed, sourcePort: sourcePort(),
      translationPort: { translate: async () => { throw new Error('not in this test'); } },
    });
    const queued = await enqueueOriginalTranslations({
      store, feedService: service, workspaceId: 'local', units: [{ id: openItem.id, text: openText }], priority: 0,
    });
    assert.equal(queued[0].priority, 0);
    const demoted = await enqueueOriginalTranslations({
      store, feedService: service, workspaceId: 'local', units: [{ id: openItem.id, text: openText }], priority: TRANSLATION_BACKFILL_PRIORITY,
    });
    assert.equal(demoted[0].id, queued[0].id);
    assert.equal(store.listOpenJobs('feed.translation.run').find((job) => job.id === queued[0].id).priority, TRANSLATION_BACKFILL_PRIORITY);
    const again = await backfillUntranslatedFeedTranslations({ store, feedService: service, workspaceId: 'local', limit: 10 });
    assert.ok(again.jobs.some((job) => job.input.items[0].id === shortItem.id));
  } finally {
    store.close();
  }
});

test('backfill requeues a cut translation under 600 characters and drops a prepended preview', async () => {
  const store = createStore(':memory:');
  try {
    const feed = store.repositories.feed;
    const source = feed.upsertSourceAccount({ workspaceId: 'local', provider: 'x', externalId: 'x:home', displayName: 'X' });
    const jeff = 'Jeff wrote two paragraphs about the round. The second paragraph explains what is already public and why the earlier note stopped.';
    assert.ok(jeff.length < 600);
    assert.equal(translationLooksTruncated(jeff, 24, '…缺乏公开信息（我...'), true);
    const jeffItem = saveXItem(feed, source.id, { externalId: '2110120766247424458', title: 'Jeff', body: jeff, publishedAt: 2_000 });
    feed.saveTranslations([{
      workspaceId: 'local', itemId: jeffItem.id, targetLang: 'zh', sourceHash: hash(jeff),
      translatedText: '…缺乏公开信息（我...', engine: 'gemma',
    }]);
    const preview = 'XPENG showed a flying vehicle…';
    const article = 'XPENG showed a flying vehicle at the event, and the note continues through the aircraft program.';
    const duplicated = `${preview}\n\n${article}`;
    const xpeng = saveXItem(feed, source.id, { externalId: 'xpeng', title: 'XPENG', body: duplicated, publishedAt: 1_000 });
    feed.saveTranslations([{
      workspaceId: 'local', itemId: xpeng.id, targetLang: 'zh', sourceHash: hash(duplicated),
      translatedText: '小鹏展示了飞行器', engine: 'gemma',
    }]);
    const service = createFeedService({
      legacyRepository: store, feedRepository: feed, sourcePort: sourcePort(),
      translationPort: { translate: async () => { throw new Error('not in this test'); } },
    });
    const again = await backfillUntranslatedFeedTranslations({ store, feedService: service, workspaceId: 'local', limit: 10 });
    const queuedItems = again.jobs.flatMap((job) => job.input.items);
    const queued = new Set(queuedItems.map((item) => item.id));
    assert.equal(queued.has(jeffItem.id), true);
    assert.equal(queued.has(xpeng.id), true);
    assert.equal(feed.getContentItem('local', xpeng.id).body, article);
    assert.equal(queuedItems.find((item) => item.id === xpeng.id).text, article);
  } finally {
    store.close();
  }
});

test('ellipsis lead is removed from stored bodies and translations and from the list', async () => {
  const store = createStore(':memory:');
  try {
    const feed = store.repositories.feed;
    const source = feed.upsertSourceAccount({ workspaceId: 'local', provider: 'x', externalId: 'x:home', displayName: 'X' });
    const lead = '来自世界各地的小鹏之友汇聚于此，共同开启';
    const sentence = `${lead}飞行器的公开亮相。`;
    const glued = `${lead}……${sentence}后面还有第二段。`;
    const body = 'XPENG friends gathered. The note continues through the aircraft program.';
    const item = saveXItem(feed, source.id, { externalId: 'xpeng-zh', title: 'XPENG', body, publishedAt: 4_000 });
    feed.saveTranslations([{
      workspaceId: 'local', itemId: item.id, targetLang: 'zh', sourceHash: hash(body),
      translatedText: glued, engine: 'gemma',
    }]);
    const preview = 'XPENG showed a flying vehicle…';
    const article = 'XPENG showed a flying vehicle at the event, and the note continues through the aircraft program.';
    const duplicated = `${preview}\n\n${article}`;
    const bodyItem = saveXItem(feed, source.id, { externalId: 'xpeng-body', title: 'XPENG body', body: duplicated, publishedAt: 3_000 });
    feed.saveTranslations([{
      workspaceId: 'local', itemId: bodyItem.id, targetLang: 'zh', sourceHash: hash(duplicated),
      translatedText: glued, engine: 'gemma',
    }]);
    assert.deepEqual(repairEllipsisLeadTexts({ store, workspaceId: 'local', limit: 0 }), { bodies: 0, translations: 0 });
    const repaired = repairEllipsisLeadTexts({ store, workspaceId: 'local', limit: 80 });
    assert.equal(repaired.bodies, 1);
    assert.equal(repaired.translations, 2);
    assert.equal(feed.getContentItem('local', item.id).body, body);
    const kept = feed.listTranslations('local', [item.id])[0];
    assert.equal(kept.translatedText, `${sentence}后面还有第二段。`);
    assert.equal(kept.sourceHash, hash(body));
    assert.equal(feed.getContentItem('local', bodyItem.id).body, article);
    const moved = feed.listTranslations('local', [bodyItem.id])[0];
    assert.equal(moved.translatedText, `${sentence}后面还有第二段。`);
    assert.equal(moved.sourceHash, hash(article));
    assert.deepEqual(repairEllipsisLeadTexts({ store, workspaceId: 'local', limit: 80 }), { bodies: 0, translations: 0 });
    const service = createFeedService({
      legacyRepository: store, feedRepository: feed, sourcePort: sourcePort(),
      translationPort: { translate: async () => { throw new Error('not in this test'); } },
    });
    const listed = await service.getExternalFeed('x', { feed: 'for-you', limit: 12, fields: 'list' });
    const card = listed.items.find((row) => row.externalId === 'xpeng-zh');
    assert.equal(card.translation.title, sentence);
    assert.equal(card.translation.summary, '后面还有第二段。');
    assert.equal(service.getLocalizedContentItem('local', item.id).translation.text, `${sentence}后面还有第二段。`);
    const backfill = await backfillUntranslatedFeedTranslations({ store, feedService: service, workspaceId: 'local', limit: 10 });
    assert.equal(backfill.jobs.some((job) => job.input.items[0].id === item.id), false);
    assert.equal(backfill.jobs.some((job) => job.input.items[0].id === bodyItem.id), false);
  } finally {
    store.close();
  }
});

test('media block translations share jobs, and a hashed one-unit job can be demoted then promoted', async () => {
  const store = createStore(':memory:');
  try {
    const service = createFeedService({
      legacyRepository: store, feedRepository: store.repositories.feed, sourcePort: sourcePort(),
      translationPort: { translate: async () => { throw new Error('not in this test'); } },
    });
    const units = Array.from({ length: 31 }, (_, index) => ({
      id: `media-block-${index}`,
      text: `Capacity plan ${index} remains open for review today.`,
    }));
    const jobs = await enqueueOriginalTranslations({
      store, feedService: service, workspaceId: 'local', units, priority: TRANSLATION_BACKFILL_PRIORITY,
    });
    assert.equal(jobs.length, 4);
    assert.equal(jobs[0].priority, TRANSLATION_BACKFILL_PRIORITY);
    assert.equal(jobs[0].input.items.length, 8);
    assert.equal(jobs[3].input.items.length, 7);
    const hashedId = `h:${'ab'.repeat(32)}`;
    const hashedText = 'A hashed media block stays in its own flood job until restart.';
    const hashed = await enqueueOriginalTranslations({
      store, feedService: service, workspaceId: 'local', priority: 0,
      units: [{ id: hashedId, text: hashedText }],
    });
    assert.equal(hashed.length, 1);
    assert.equal(hashed[0].input.items.length, 1);
    assert.equal(hashed[0].priority, 0);
    assert.equal(demoteQueuedHashTranslationJobs(store, 'local'), 1);
    assert.equal(store.listOpenJobs('feed.translation.run').find((job) => job.id === hashed[0].id).priority, TRANSLATION_BACKFILL_PRIORITY);
    const promoted = await enqueueOriginalTranslations({
      store, feedService: service, workspaceId: 'local', priority: TRANSLATION_INTERACTIVE_PRIORITY,
      units: [{ id: hashedId, text: hashedText }],
    });
    assert.equal(promoted[0].id, hashed[0].id);
    assert.equal(store.listOpenJobs('feed.translation.run').find((job) => job.id === hashed[0].id).priority, TRANSLATION_INTERACTIVE_PRIORITY);
  } finally {
    store.close();
  }
});
