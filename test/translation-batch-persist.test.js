import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createStore } from '../packages/database/src/index.js';
import { translationTextIsTitle, translationTitleBatchLimit } from '../packages/domain/src/feed-ai-batch.js';
import { createFeedService } from '../packages/domain/src/feed-service.js';
import { localizationItemId } from '../packages/domain/src/localize-texts.js';
import { createRuntimeService } from '../packages/domain/src/runtime-service.js';
import { createTranslateService, splitTranslationText } from '../packages/connectors/src/translate/index.js';
import {
  TRANSLATION_BACKFILL_PRIORITY,
  backfillUntranslatedFeedTranslations,
  collectMediaTranslationGaps,
  createFeedTranslationChunkStore,
  createFeedTranslationJobHandlers,
  fillUncoveredTranslations,
  packTranslationJobBatches,
  translationGapFillIntervalMs,
  translationGapFillLimit,
} from '../packages/runtime/src/feed-translation-module.js';
import { createJobRunner } from '../packages/runtime/src/job-runner.js';

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function sourcePort() {
  return {
    findByProvider: () => ({ id: 'content.x' }),
    persistence: () => ({ providerId: 'x', sourceAccount: { externalId: 'x:home' }, emptyNote: '' }),
    read: async () => { throw new Error('no refresh'); },
  };
}

function feedService(store, translationPort) {
  return createFeedService({
    legacyRepository: store,
    feedRepository: store.repositories.feed,
    sourcePort: sourcePort(),
    translationPort,
  });
}

function saveItem(feed, sourceId, { externalId, title, body, publishedAt = 5_000 }) {
  const capture = feed.saveCapture({
    workspaceId: 'local', provider: 'x', externalId, sourceAccountId: sourceId,
    sourceUrl: `https://example.com/${externalId}`, contentHash: hash(externalId), capturedAt: publishedAt,
  });
  return feed.saveContentItem({
    workspaceId: 'local', captureId: capture.id, originType: 'subscription', contentType: 'post',
    title, body, summary: '', sourceUrl: `https://example.com/${externalId}`, authorName: 'Reporter', publishedAt,
  });
}

function mediaEntry(externalId, title, observedAt) {
  return {
    workspaceId: 'local', externalId, sourceKey: 'example', publisherKey: 'example', channel: 'tech',
    canonicalUrl: `https://example.com/${externalId}`, title, summary: '', publishedAt: observedAt,
    contentLevel: 'summary_only', contentHash: hash(externalId), revision: 1, status: 'indexed',
    observedAt, createdAt: observedAt, updatedAt: observedAt,
  };
}

test('a mixed batch stores each success and requeues only the failed title', async () => {
  const store = createStore(':memory:');
  try {
    const calls = [];
    const service = feedService(store, {
      async translateMany({ items }) {
        const item = items[0];
        calls.push(item.id);
        if (item.id === 'bad') throw Object.assign(new Error('Gemma 翻译失败（500）'), { upstreamStatus: 500 });
        return { translations: [{ id: item.id, translatedText: `中文${item.id}`, engine: 'gemma-4-26b-a4b-it' }] };
      },
    });
    const job = store.createJob({
      type: 'feed.translation.run', workspaceId: 'local', priority: 10, maxAttempts: 4,
      input: {
        workspaceId: 'local',
        items: [
          { id: 'ok-1', text: "Nvidia's Jensen Huang pledges $2 billion to open models" },
          { id: 'bad', text: 'AI guardrails designed to stop hackers from stealing weights' },
          { id: 'ok-2', text: 'A short English title that already came back' },
        ],
      },
    });
    await createJobRunner({ store, handlers: createFeedTranslationJobHandlers({ feedService: service }) }).runOnce();
    const current = store.getJob(job.id);
    assert.equal(current.status, 'queued');
    assert.deepEqual(current.input.items.map((item) => item.id), ['bad']);
    assert.deepEqual(calls, ['ok-1', 'bad', 'ok-2']);
    const saved = store.repositories.feed.listTranslations('local', ['ok-1', 'bad', 'ok-2']);
    assert.deepEqual(saved.map((row) => row.itemId).sort(), ['ok-1', 'ok-2']);
    const failures = store.repositories.feed.listTranslationFailures('local', ['ok-1', 'bad', 'ok-2']);
    assert.deepEqual(failures.map((row) => row.itemId), ['bad']);
  } finally {
    store.close();
  }
});

test('a later quota deferral keeps earlier items and retries the rest together', async () => {
  const store = createStore(':memory:');
  try {
    const calls = [];
    const service = feedService(store, {
      async translateMany({ items }) {
        const item = items[0];
        calls.push(item.id);
        if (item.id === 'b') {
          throw Object.assign(new Error('Gemma 翻译等待配额窗口'), { code: 'budget-deferred', retryAt: Date.now() + 60_000 });
        }
        return { translations: [{ id: item.id, translatedText: `中文${item.id}`, engine: 'gemma-4-26b-a4b-it' }] };
      },
    });
    await assert.rejects(() => service.translateMany({
      items: [
        { id: 'a', text: 'First English title is already done' },
        { id: 'b', text: 'Second English title waits for quota' },
        { id: 'c', text: 'Third English title was not sent' },
      ],
    }, { workspaceId: 'local' }), (error) => {
      assert.equal(error.code, 'budget-deferred');
      assert.deepEqual(error.failedItemIds, ['b', 'c']);
      return true;
    });
    assert.deepEqual(calls, ['a', 'b']);
    assert.deepEqual(store.repositories.feed.listTranslations('local', ['a', 'b', 'c']).map((row) => row.itemId), ['a']);
  } finally {
    store.close();
  }
});

test('a long article keeps finished chunks and a later retry skips them', async () => {
  const store = createStore(':memory:');
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    const source = Array.from({ length: 40 }, (_, index) => `Capacity plan ${index} remains uncertain.`).join(' ');
    const chunks = splitTranslationText(source, 400);
    assert.ok(chunks.length > 1);
    const title = "Nvidia's Jensen Huang pledges $2 billion to open models";
    let failSecond = true;
    const prompts = [];
    const port = createTranslateService({
      chunkChars: 400,
      chunkAttempts: 1,
      sleep: async () => {},
      chunkStore: createFeedTranslationChunkStore(store.repositories.feed),
      router: {
        batch: false,
        generate: async ({ prompt }) => {
          prompts.push(prompt);
          if (failSecond && prompt === chunks[1]) throw Object.assign(new Error('Gemma 翻译失败（500）'), { upstreamStatus: 500 });
          return { text: `译${prompt.length}${'。'.repeat(200)}`, engine: 'gemma-4-26b-a4b-it' };
        },
      },
    });
    const service = feedService(store, port);
    const job = store.createJob({
      type: 'feed.translation.run', workspaceId: 'local', priority: 10, maxAttempts: 4,
      input: { workspaceId: 'local', items: [{ id: 'title-1', text: title }, { id: 'long-1', text: source }] },
    });
    const runner = createJobRunner({ store, handlers: createFeedTranslationJobHandlers({ feedService: service }) });
    await runner.runOnce();
    const paused = store.getJob(job.id);
    assert.equal(paused.status, 'queued');
    assert.deepEqual(paused.input.items.map((item) => item.id), ['long-1']);
    assert.equal(store.repositories.feed.listTranslations('local', ['title-1']).length, 1);
    assert.equal(store.repositories.feed.listTranslations('local', ['long-1']).length, 0);
    assert.equal(store.repositories.feed.listTranslationChunks('local', 'long-1', 'zh', hash(source)).length, 1);
    assert.equal(prompts.filter((prompt) => prompt === chunks[0]).length, 1);
    assert.match(lines.find((line) => line.includes('chunk=1/') && line.includes('long-1')), /status=ok/);

    failSecond = false;
    const before = prompts.length;
    store.rescheduleQueuedJobs('local', [{ id: paused.id, availableAt: 0, expectedAvailableAt: paused.availableAt }]);
    await runner.runOnce();
    const done = store.getJob(job.id);
    assert.equal(done.status, 'completed');
    assert.equal(prompts.slice(before).includes(chunks[0]), false);
    assert.equal(prompts.slice(before)[0], chunks[1]);
    assert.equal(store.repositories.feed.listTranslations('local', ['long-1']).length, 1);
    assert.equal(store.repositories.feed.listTranslationChunks('local', 'long-1', 'zh', hash(source)).length, 0);
    assert.match(lines.find((line) => line.includes('status=cached') && line.includes('long-1')), /chunk=1\//);
  } finally {
    console.log = original;
    store.close();
  }
});

test('title jobs split at five and body jobs stay on the thirty-item pack', () => {
  const titles = Array.from({ length: 6 }, (_, index) => ({ id: `t${index}`, text: `English title number ${index} about chips` }));
  assert.ok(titles.every((item) => translationTextIsTitle(item.text)));
  const store = createStore(':memory:');
  try {
    const runtime = createRuntimeService({ runtimeRepository: store });
    runtime.requestTranslation({ workspaceId: 'local', targetLang: 'zh', items: titles });
    const jobs = store.listOpenJobs('feed.translation.run');
    assert.deepEqual(jobs.map((job) => job.input.items.length).sort((a, b) => b - a), [5, 1]);
    assert.ok(jobs.every((job) => job.priority === 10));

    const paragraphs = Array.from({ length: 6 }, (_, index) => ({ id: `p${index}`, text: `Paragraph ${index}\nkeeps the following sentence in the same job.` }));
    runtime.requestTranslation({ workspaceId: 'local', targetLang: 'zh', items: paragraphs });
    const paragraphJobs = store.listOpenJobs('feed.translation.run').filter((job) => job.input.items[0].id.startsWith('p'));
    assert.equal(paragraphJobs.length, 1);
    assert.equal(paragraphJobs[0].input.items.length, 6);

    const packed = packTranslationJobBatches(Array.from({ length: 31 }, (_, index) => ({ id: `b${index}`, text: `block ${index}` })));
    assert.deepEqual(packed.map((batch) => batch.length), [30, 1]);
    const titled = packTranslationJobBatches(titles.map((item) => ({ id: item.id, text: item.text })), { unitLimit: 5 });
    assert.deepEqual(titled.map((batch) => batch.length), [5, 1]);
  } finally {
    store.close();
  }
});

test('title batch limit follows the environment variable', () => {
  assert.equal(translationTitleBatchLimit(undefined), 5);
  assert.equal(translationTitleBatchLimit(''), 5);
  assert.equal(translationTitleBatchLimit('2'), 2);
  assert.equal(translationTitleBatchLimit('0'), 5);
  assert.equal(translationTitleBatchLimit('99'), 30);
  assert.equal(translationTitleBatchLimit('nope'), 5);
  const previous = process.env.AI_CENTER_TRANSLATION_TITLE_BATCH_LIMIT;
  process.env.AI_CENTER_TRANSLATION_TITLE_BATCH_LIMIT = '2';
  const store = createStore(':memory:');
  try {
    const runtime = createRuntimeService({ runtimeRepository: store });
    runtime.requestTranslation({
      workspaceId: 'local', targetLang: 'zh',
      items: Array.from({ length: 5 }, (_, index) => ({ id: `e${index}`, text: `Configurable English title ${index}` })),
    });
    assert.deepEqual(store.listOpenJobs('feed.translation.run').map((job) => job.input.items.length).sort((a, b) => b - a), [2, 2, 1]);
  } finally {
    if (previous === undefined) delete process.env.AI_CENTER_TRANSLATION_TITLE_BATCH_LIMIT;
    else process.env.AI_CENTER_TRANSLATION_TITLE_BATCH_LIMIT = previous;
    store.close();
  }
});

test('gap-fill parsers clamp the interval and the scan cap', () => {
  assert.equal(translationGapFillIntervalMs(undefined), 300_000);
  assert.equal(translationGapFillIntervalMs('0'), 0);
  assert.equal(translationGapFillIntervalMs('1000'), 60_000);
  assert.equal(translationGapFillIntervalMs('nope'), 300_000);
  assert.equal(translationGapFillLimit(undefined), 20);
  assert.equal(translationGapFillLimit('0'), 0);
  assert.equal(translationGapFillLimit('500'), 80);
  assert.equal(translationGapFillLimit('-3'), 20);
});

test('media gaps keep uncovered English titles and a missing article title', () => {
  const nvidia = "Nvidia's Jensen Huang pledges $2 billion to open models";
  const guard = 'AI guardrails designed to stop hackers from stealing weights';
  const body = 'A public paragraph about the funding round.';
  const partialTitle = 'Partial article title still in English';
  const ready = 'Ready English headline about chips';
  const selected = collectMediaTranslationGaps({
    entries: [
      { externalId: 'nvidia:one', title: nvidia, contentLevel: 'summary_only' },
      { externalId: 'guard:one', title: guard, contentLevel: 'summary_only' },
      { externalId: 'zh:one', title: '英伟达宣布新的开放模型计划', contentLevel: 'summary_only' },
      { externalId: 'ready:one', title: ready, contentLevel: 'summary_only' },
    ],
    articleUnits: [
      { localizationId: 'body-1', text: body, kind: 'paragraph', paragraphId: 'p1' },
      { localizationId: 'title-1', text: partialTitle, kind: 'heading', paragraphId: 'title' },
    ],
    translations: [
      { itemId: 'body-1', sourceHash: hash(body), translatedText: '这是一段已经译完的正文。' },
      { itemId: localizationItemId('media:ready:one'), sourceHash: hash(ready), translatedText: '已经译好的标题。' },
    ],
    openIds: new Set([localizationItemId('media:nvidia:one')]),
    limit: 20,
  });
  assert.deepEqual(selected.map((unit) => unit.text), [guard, partialTitle]);
});

test('gap fill requeues a terminal failure and an uncovered title without duplicating open jobs', async () => {
  const store = createStore(':memory:');
  try {
    const feed = store.repositories.feed;
    const home = feed.upsertSourceAccount({ workspaceId: 'local', provider: 'x', externalId: 'x:home', displayName: 'X' });
    const waitingText = 'Waiting English post still needs a Chinese translation today.';
    const coveredText = 'Covered English post already has a queued translation job.';
    const waiting = saveItem(feed, home.id, { externalId: 'waiting', title: 'Waiting', body: waitingText, publishedAt: 9_000 });
    const covered = saveItem(feed, home.id, { externalId: 'covered', title: 'Covered', body: coveredText, publishedAt: 8_000 });
    feed.noteTranslationFailure({
      workspaceId: 'local',
      items: [{ id: waiting.id, text: waitingText }, { id: covered.id, text: coveredText }],
      error: new Error('Gemma 翻译失败（500）'),
      attemptCount: 4,
      terminal: true,
      nextRetryAt: null,
    });
    const nvidia = "Nvidia's Jensen Huang pledges $2 billion to open models";
    const guard = 'AI guardrails designed to stop hackers from stealing weights';
    const ready = 'Ready English headline about chips';
    store.repositories.media.upsertEntry(mediaEntry('nvidia:one', nvidia, 7_000));
    store.repositories.media.upsertEntry(mediaEntry('guard:one', guard, 6_000));
    store.repositories.media.upsertEntry(mediaEntry('zh:one', '英伟达宣布新的开放模型计划', 5_000));
    store.repositories.media.upsertEntry(mediaEntry('ready:one', ready, 4_000));
    feed.saveTranslations([{
      workspaceId: 'local', itemId: localizationItemId('media:ready:one'), targetLang: 'zh',
      sourceHash: hash(ready), translatedText: '已经译好的标题。', engine: 'gemma-4-26b-a4b-it',
    }]);
    store.createJob({
      type: 'feed.translation.run', workspaceId: 'local', priority: TRANSLATION_BACKFILL_PRIORITY,
      input: { workspaceId: 'local', items: [{ id: covered.id, text: coveredText }] },
    });
    store.createJob({
      type: 'feed.translation.run', workspaceId: 'local', priority: TRANSLATION_BACKFILL_PRIORITY,
      input: { workspaceId: 'local', items: [{ id: localizationItemId('media:nvidia:one'), text: nvidia }] },
    });
    const service = feedService(store, { translateMany: async () => { throw new Error('gap fill must not translate'); } });
    const skipped = await backfillUntranslatedFeedTranslations({ store, feedService: service, workspaceId: 'local', limit: 20 });
    assert.equal(skipped.jobs.length, 0);
    const filled = await fillUncoveredTranslations({
      store, feedService: service, workspaceId: 'local', limit: 20,
      mediaService: { flashExternalIds: () => [], listArticleTranslationUnits: () => [] },
    });
    assert.equal(filled.enqueued, 2);
    assert.equal(filled.media, 1);
    assert.equal(filled.feed, 1);
    const created = filled.jobs;
    assert.ok(created.every((job) => job.priority === TRANSLATION_BACKFILL_PRIORITY));
    const queued = new Set(created.flatMap((job) => job.input.items.map((item) => item.id)));
    assert.equal(queued.has(waiting.id), true);
    assert.equal(queued.has(localizationItemId('media:guard:one')), true);
    assert.equal(queued.has(covered.id), false);
    assert.equal(queued.has(localizationItemId('media:nvidia:one')), false);
    assert.equal(queued.has(localizationItemId('media:zh:one')), false);
    assert.equal(queued.has(localizationItemId('media:ready:one')), false);
    const again = await fillUncoveredTranslations({
      store, feedService: service, workspaceId: 'local', limit: 0,
      mediaService: { flashExternalIds: () => [] },
    });
    assert.equal(again.enqueued, 0);
  } finally {
    store.close();
  }
});
