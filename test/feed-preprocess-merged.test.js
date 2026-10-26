import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createStore } from '../packages/database/src/index.js';
import { TAG_PROMPT_VERSION } from '../packages/domain/src/tag-prompt.js';
import { createFeedService } from '../packages/domain/src/feed-service.js';
import { createTaggingService } from '../packages/domain/src/tagging-service.js';
import { createTaggingJobHandlers } from '../packages/runtime/src/tagging-module.js';
import {
  feedPreprocessMergedEnabled,
  feedPreprocessShortLimit,
  createFeedAutomationJobHandlers,
} from '../packages/runtime/src/feed-automation-module.js';
import { fillUncoveredTranslations } from '../packages/runtime/src/feed-translation-module.js';

const CATALOG = {
  version: 'tags_v1',
  tags: [
    { id: 'ai', name: 'AI', keywords: ['LLM'] },
    { id: 'ai_compute', name: '算力', keywords: ['Nvidia'] },
  ],
};

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function sourcePort() {
  return { findByProvider() { return null; } };
}

function saveX(feed, sourceId, { externalId, body, title = 'Title', summary = '' }) {
  const capture = feed.saveCapture({
    workspaceId: 'local',
    provider: 'x',
    externalId,
    sourceAccountId: sourceId,
    sourceUrl: `https://example.com/${externalId}`,
    contentHash: hash(`${externalId}\n${body}`),
    capturedAt: Date.now(),
  });
  return feed.saveContentItem({
    workspaceId: 'local',
    captureId: capture.id,
    originType: 'subscription',
    contentType: 'post',
    title,
    body,
    summary,
    sourceUrl: `https://example.com/${externalId}`,
    authorName: 'Reporter',
    publishedAt: Date.now(),
  });
}

function openFeed(store) {
  const feed = store.repositories.feed;
  const source = feed.upsertSourceAccount({
    workspaceId: 'local', provider: 'x', externalId: 'x:home', displayName: 'X',
  });
  return { feed, source };
}

test('merged preprocess stays off unless the flag is 1 or true', () => {
  assert.equal(feedPreprocessMergedEnabled({}), false);
  assert.equal(feedPreprocessMergedEnabled({ AI_CENTER_FEED_PREPROCESS_MERGED: '0' }), false);
  assert.equal(feedPreprocessMergedEnabled({ AI_CENTER_FEED_PREPROCESS_MERGED: 'false' }), false);
  assert.equal(feedPreprocessMergedEnabled({ AI_CENTER_FEED_PREPROCESS_MERGED: '1' }), true);
  assert.equal(feedPreprocessMergedEnabled({ AI_CENTER_FEED_PREPROCESS_MERGED: 'true' }), true);
  assert.equal(feedPreprocessShortLimit({}), 1500);
  assert.equal(feedPreprocessShortLimit({ AI_CENTER_TRANSLATION_CHUNK_CHARS: '800' }), 800);
});

test('flag off keeps separate tagging and translation', async () => {
  const store = createStore(':memory:');
  try {
    const { feed, source } = openFeed(store);
    const body = 'Nvidia data center revenue grew on AI accelerators this quarter.';
    const item = saveX(feed, source.id, { externalId: 'off', body });
    const seen = { preprocess: 0, tag: 0, translate: 0 };
    const tagging = createTaggingService({
      catalog: CATALOG,
      taggingRepository: store.repositories.tagging,
      taggingPort: {
        async preprocessItem() { seen.preprocess += 1; throw new Error('must stay off'); },
        async tagBatch(input) {
          seen.tag += 1;
          const ids = input.userPayload.items.map((row) => row.item_id);
          return { reply_text: JSON.stringify({ items: ids.map((id) => ({ item_id: id, tags: ['ai_compute'] })) }), model: 'gemma-4-26b-a4b-it' };
        },
      },
    });
    const feedService = createFeedService({
      legacyRepository: store,
      feedRepository: feed,
      sourcePort: sourcePort(),
      translationPort: { async translate() { seen.translate += 1; throw new Error('enrich must enqueue'); } },
    });
    const prepared = [];
    const handlers = createFeedAutomationJobHandlers({
      feedService,
      feedRepository: feed,
      taggingService: tagging,
      articleNormalizePort: { async prepareInformation(payload) { prepared.push(payload.sourceIds); return { queued: 1 }; } },
      env: { AI_CENTER_FEED_PREPROCESS_MERGED: '0' },
    });
    const result = await handlers['feed.items.enrich']({ workspaceId: 'local', resourceIds: [item.id] }, { store });
    assert.equal(seen.preprocess, 0);
    assert.equal(seen.tag, 1);
    assert.equal(seen.translate, 0);
    assert.equal(result.tagged, 1);
    assert.deepEqual(prepared, [[`feed:${item.id}`]]);
    const jobs = store.listOpenJobs('feed.translation.run');
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].input.items[0].id, item.id);
    assert.equal(feed.listTranslations('local', [item.id], 'zh').length, 0);
  } finally {
    store.close();
  }
});

test('flag on writes translation and tags for a short item in one call', async () => {
  const store = createStore(':memory:');
  try {
    const { feed, source } = openFeed(store);
    const body = 'Nvidia data center revenue grew on AI accelerators this quarter.';
    const chinese = '宁德时代公布了新的产能计划，电池出货继续增长。';
    const long = `Nvidia capacity update. ${'capacity '.repeat(220)}`;
    assert.ok(long.length > 1500);
    const short = saveX(feed, source.id, { externalId: 'short', body });
    const cjk = saveX(feed, source.id, { externalId: 'cjk', body: chinese });
    const wide = saveX(feed, source.id, { externalId: 'long', body: long });
    const other = saveX(feed, source.id, { externalId: 'gap', body: 'Apple supply chain lead times remain elevated in Asia.' });
    const pre = [];
    const tagged = [];
    let translates = 0;
    const tagging = createTaggingService({
      catalog: CATALOG,
      taggingRepository: store.repositories.tagging,
      taggingPort: {
        async preprocessItem(input) {
          pre.push(input);
          return {
            reply_text: JSON.stringify({
              item_id: input.userPayload.item_id,
              translated_text: '英伟达数据中心收入本季增长。',
              tags: ['ai', 'ai_compute', 'nope'],
            }),
            model: 'gemma-4-26b-a4b-it',
          };
        },
        async tagBatch(input) {
          const ids = input.userPayload.items.map((row) => row.item_id);
          tagged.push(ids);
          return {
            reply_text: JSON.stringify({ items: ids.map((id) => ({ item_id: id, tags: ['ai_compute'] })) }),
            model: 'gemma-4-26b-a4b-it',
          };
        },
      },
    });
    const feedService = createFeedService({
      legacyRepository: store,
      feedRepository: feed,
      sourcePort: sourcePort(),
      translationPort: { async translate() { translates += 1; throw new Error('merged item must not translate again'); } },
    });
    const prepared = [];
    const handlers = createFeedAutomationJobHandlers({
      feedService,
      feedRepository: feed,
      taggingService: tagging,
      articleNormalizePort: {
        async prepareInformation(payload) { prepared.push(payload.sourceIds); return { queued: payload.sourceIds.length }; },
      },
      env: { AI_CENTER_FEED_PREPROCESS_MERGED: '1' },
    });
    const result = await handlers['feed.items.enrich']({
      workspaceId: 'local', resourceIds: [short.id, cjk.id, wide.id],
    }, { store });
    await handlers['feed.items.enrich']({
      workspaceId: 'local', resourceIds: [short.id],
    }, { store });
    assert.equal(pre.length, 1);
    assert.equal(pre[0].userPayload.original_text, body);
    assert.equal(JSON.stringify(pre[0].userPayload).includes('英伟达数据中心'), false);
    assert.match(pre[0].systemPrompt, /不要总结/);
    assert.match(pre[0].systemPrompt, /不要根据译文/);
    assert.match(pre[0].systemPrompt, /只能从 tag_catalog/);
    assert.equal(translates, 0);
    assert.equal(result.tagged, 3);
    assert.deepEqual(prepared[0].slice().sort(), [`feed:${short.id}`, `feed:${cjk.id}`, `feed:${wide.id}`].sort());
    const translation = feed.listTranslations('local', [short.id], 'zh')[0];
    assert.equal(translation.translatedText, '英伟达数据中心收入本季增长。');
    assert.equal(translation.sourceHash, hash(body));
    assert.equal(translation.engine, 'gemma-4-26b-a4b-it');
    assert.equal(translation.targetLang, 'zh');
    const tags = store.repositories.tagging.getTagging('local', 'content-item', short.id);
    assert.deepEqual(tags.tags, ['ai_compute']);
    assert.equal(tags.promptVersion, TAG_PROMPT_VERSION);
    assert.equal(tags.tagCatalogVersion, 'tags_v1');
    assert.equal(feed.listTranslations('local', [cjk.id], 'zh').length, 0);
    assert.deepEqual(store.repositories.tagging.getTagging('local', 'content-item', cjk.id).tags, ['ai_compute']);
    assert.equal(feed.listTranslations('local', [wide.id], 'zh').length, 0);
    const jobs = store.listOpenJobs('feed.translation.run');
    assert.deepEqual(jobs.flatMap((job) => job.input.items.map((item) => item.id)), [wide.id]);
    assert.equal(tagged.flat().includes(short.id), false);
    assert.equal(tagged.flat().includes(cjk.id), true);
    assert.equal(tagged.flat().includes(wide.id), true);

    const untagged = feed.listUntaggedContentIds('local', { since: 0, limit: 20 });
    assert.equal(untagged.includes(short.id), false);
    assert.equal(untagged.includes(other.id), true);
    const rescanned = [];
    const rescan = createTaggingJobHandlers({
      taggingService: createTaggingService({
        catalog: CATALOG,
        taggingRepository: store.repositories.tagging,
        taggingPort: {
          async tagBatch(input) {
            rescanned.push(...input.userPayload.items.map((row) => row.item_id));
            return { reply_text: JSON.stringify({ items: [] }), model: 'gemma-4-26b-a4b-it' };
          },
        },
      }),
      feedService,
      knowledgeService: {},
      env: {},
      now: () => Date.now(),
    });
    await rescan['tagging.rescan']();
    assert.equal(rescanned.includes(short.id), false);
    assert.equal(rescanned.includes(other.id), true);
    const gap = await fillUncoveredTranslations({ store, feedService, workspaceId: 'local', limit: 20, now: Date.now() });
    const queued = gap.jobs.flatMap((job) => job.input.items.map((item) => item.id));
    assert.equal(queued.includes(short.id), false);
    assert.equal(queued.includes(other.id), true);
  } finally {
    store.close();
  }
});

test('a failed merged call falls back to tag plus translate and still prepares', async () => {
  const store = createStore(':memory:');
  const logs = [];
  try {
    const { feed, source } = openFeed(store);
    const body = 'Nvidia data center revenue grew on AI accelerators this quarter.';
    const item = saveX(feed, source.id, { externalId: 'fail', body });
    const seen = { tag: 0 };
    const tagging = createTaggingService({
      catalog: CATALOG,
      taggingRepository: store.repositories.tagging,
      taggingPort: {
        async preprocessItem() {
          throw Object.assign(new Error('Gemma 翻译失败（500）'), { upstreamStatus: 500 });
        },
        async tagBatch(input) {
          seen.tag += 1;
          const ids = input.userPayload.items.map((row) => row.item_id);
          return { reply_text: JSON.stringify({ items: ids.map((id) => ({ item_id: id, tags: ['ai_compute'] })) }), model: 'gemma-4-26b-a4b-it' };
        },
      },
    });
    const feedService = createFeedService({
      legacyRepository: store, feedRepository: feed, sourcePort: sourcePort(),
    });
    let prepared = 0;
    const handlers = createFeedAutomationJobHandlers({
      log: (line) => logs.push(line),
      feedService,
      feedRepository: feed,
      taggingService: tagging,
      articleNormalizePort: { async prepareInformation() { prepared += 1; return { queued: 1 }; } },
      env: { AI_CENTER_FEED_PREPROCESS_MERGED: '1' },
    });
    const result = await handlers['feed.items.enrich']({ workspaceId: 'local', resourceIds: [item.id] }, { store });
    assert.equal(seen.tag, 1);
    assert.equal(prepared, 1);
    assert.equal(result.tagged, 1);
    assert.equal(store.listOpenJobs('feed.translation.run').length, 1);
    assert.match(logs.join('\n'), /preprocess failed id=.* category=upstream/);
    assert.equal(logs.join('\n').includes(body), false);

    const blockedItem = saveX(feed, source.id, { externalId: 'blocked', body });
    const blocked = createTaggingService({
      catalog: CATALOG,
      taggingRepository: store.repositories.tagging,
      taggingPort: {
        async preprocessItem() { throw Object.assign(new Error('Gemma 翻译失败（500）'), { upstreamStatus: 500 }); },
        async tagBatch() { throw Object.assign(new Error('Gemma 翻译失败（500）'), { upstreamStatus: 500 }); },
      },
    });
    const again = createFeedAutomationJobHandlers({
      log() {},
      feedService,
      feedRepository: feed,
      taggingService: blocked,
      articleNormalizePort: { async prepareInformation() { prepared += 1; return { queued: 1 }; } },
      env: { AI_CENTER_FEED_PREPROCESS_MERGED: 'true' },
    });
    const failed = await again['feed.items.enrich']({ workspaceId: 'local', resourceIds: [blockedItem.id] }, { store });
    assert.equal(prepared, 2);
    assert.equal(failed.tagged, 0);
    assert.equal(failed.taggingError, 'tagging');
    assert.equal(failed.queued, 1);
  } finally {
    store.close();
  }
});

test('incomplete merged output falls back and the legacy enrich path uses the same short call', async () => {
  const store = createStore(':memory:');
  try {
    const { feed, source } = openFeed(store);
    const sourceText = `Nvidia reported record revenue.\n${'The data center business grew again. '.repeat(12)}`;
    assert.ok(sourceText.length > 80 && sourceText.length <= 1500);
    const cut = saveX(feed, source.id, { externalId: 'cut', body: sourceText });
    let tags = 0;
    let pre = 0;
    const tagging = createTaggingService({
      catalog: CATALOG,
      taggingRepository: store.repositories.tagging,
      taggingPort: {
        async preprocessItem() {
          pre += 1;
          return { reply_text: JSON.stringify({ item_id: cut.id, translated_text: '收入', tags: ['ai_compute'] }), model: 'gemma-4-26b-a4b-it' };
        },
        async tagBatch() { tags += 1; return { reply_text: JSON.stringify({ items: [{ item_id: cut.id, tags: ['ai_compute'] }] }), model: 'test' }; },
      },
    });
    const feedService = createFeedService({
      legacyRepository: store, feedRepository: feed, sourcePort: sourcePort(),
    });
    const article = createFeedAutomationJobHandlers({
      log() {},
      feedService,
      feedRepository: feed,
      taggingService: tagging,
      articleNormalizePort: { async prepareInformation() { return { queued: 1 }; } },
      env: { AI_CENTER_FEED_PREPROCESS_MERGED: '1' },
    });
    await article['feed.items.enrich']({ workspaceId: 'local', resourceIds: [cut.id] }, { store });
    assert.equal(pre, 1);
    assert.equal(tags, 1);
    assert.equal(feed.listTranslations('local', [cut.id], 'zh').length, 0);
    assert.equal(store.listOpenJobs('feed.translation.run').some((job) => job.input.items.some((item) => item.id === cut.id)), true);

    const legacyItem = saveX(feed, source.id, { externalId: 'legacy', body: 'Nvidia data center revenue grew on AI accelerators this quarter.' });
    let legacyPre = 0;
    let legacyTags = 0;
    let translates = 0;
    const legacyTagsService = createTaggingService({
      catalog: CATALOG,
      taggingRepository: store.repositories.tagging,
      taggingPort: {
        async preprocessItem(input) {
          legacyPre += 1;
          assert.equal(input.userPayload.original_text, 'Nvidia data center revenue grew on AI accelerators this quarter.');
          return {
            reply_text: JSON.stringify({ item_id: input.userPayload.item_id, translated_text: '英伟达数据中心收入本季增长。', tags: ['ai_compute'] }),
            model: 'gemma-4-26b-a4b-it',
          };
        },
        async tagBatch() { legacyTags += 1; throw new Error('legacy short item must not tag again'); },
      },
    });
    const legacyFeed = createFeedService({
      legacyRepository: store,
      feedRepository: feed,
      sourcePort: sourcePort(),
      translationPort: { async translate() { translates += 1; throw new Error('legacy short item must not translate again'); } },
    });
    const legacy = createFeedAutomationJobHandlers({
      feedService: legacyFeed,
      feedRepository: feed,
      taggingService: legacyTagsService,
      env: { AI_CENTER_FEED_PREPROCESS_MERGED: '1' },
    });
    const result = await legacy['feed.items.enrich']({ workspaceId: 'local', resourceIds: [legacyItem.id] }, { store });
    assert.equal(legacyPre, 1);
    assert.equal(legacyTags, 0);
    assert.equal(translates, 0);
    assert.equal(result.translated, 1);
    assert.equal(result.tagged, 1);
    assert.equal(feed.listTranslations('local', [legacyItem.id], 'zh')[0].engine, 'gemma-4-26b-a4b-it');
    const extra = store.listOpenJobs('feed.translation.run').flatMap((job) => job.input.items.map((item) => item.id));
    assert.equal(extra.includes(legacyItem.id), false);
  } finally {
    store.close();
  }
});

test('an empty tag list is still a tagging row and is not scanned again', async () => {
  const store = createStore(':memory:');
  try {
    const { feed, source } = openFeed(store);
    const body = 'Nvidia data center revenue grew on AI accelerators this quarter.';
    const item = saveX(feed, source.id, { externalId: 'empty', body });
    const tagging = createTaggingService({
      catalog: CATALOG,
      taggingRepository: store.repositories.tagging,
      taggingPort: {
        async preprocessItem(input) {
          return { reply_text: JSON.stringify({ item_id: input.userPayload.item_id, translated_text: '英伟达数据中心收入本季增长。', tags: [] }), model: 'gemma-4-26b-a4b-it' };
        },
        async tagBatch() { throw new Error('empty tags must not be retried here'); },
      },
    });
    const feedService = createFeedService({
      legacyRepository: store, feedRepository: feed, sourcePort: sourcePort(),
    });
    const handlers = createFeedAutomationJobHandlers({
      feedService,
      feedRepository: feed,
      taggingService: tagging,
      articleNormalizePort: { async prepareInformation() { return { queued: 1 }; } },
      env: { AI_CENTER_FEED_PREPROCESS_MERGED: '1' },
    });
    await handlers['feed.items.enrich']({ workspaceId: 'local', resourceIds: [item.id] }, { store });
    assert.deepEqual(store.repositories.tagging.getTagging('local', 'content-item', item.id).tags, []);
    assert.equal(feed.listUntaggedContentIds('local', { since: 0, limit: 20 }).includes(item.id), false);
    const gap = await fillUncoveredTranslations({ store, feedService, workspaceId: 'local', limit: 20, now: Date.now() });
    assert.equal(gap.jobs.flatMap((job) => job.input.items.map((row) => row.id)).includes(item.id), false);
  } finally {
    store.close();
  }
});
