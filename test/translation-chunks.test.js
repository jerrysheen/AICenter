import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createStore } from '../packages/database/src/index.js';
import { createFeedService } from '../packages/domain/src/feed-service.js';
import { createTranslateService, joinTranslationChunks, splitTranslationText, translationChunkChars } from '../packages/connectors/src/translate/index.js';
import { gemmaTranslationInput, gemmaTranslationTimeoutMs } from '../packages/connectors/src/translate/gemma.js';
import { createFeedTranslationChunkStore, createFeedTranslationJobHandlers, enqueueOriginalTranslations, formatTranslationBackfillLog, backfillUntranslatedFeedTranslations } from '../packages/runtime/src/feed-translation-module.js';
import { createJobRunner } from '../packages/runtime/src/job-runner.js';

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function sourcePort() {
  return { findByProvider: () => ({ id: 'content.x' }), persistence: () => ({ providerId: 'x', sourceAccount: { externalId: 'x:home' }, emptyNote: '' }), read: async () => { throw new Error('no refresh'); } };
}

function saveItem(feed, sourceId, { provider = 'x', externalId, title, body, publishedAt = 5_000 }) {
  const capture = feed.saveCapture({
    workspaceId: 'local', provider, externalId, sourceAccountId: sourceId,
    sourceUrl: `https://example.com/${externalId}`, contentHash: hash(externalId), capturedAt: publishedAt,
  });
  return feed.saveContentItem({
    workspaceId: 'local', captureId: capture.id, originType: 'subscription', contentType: 'post',
    title, body, summary: '', sourceUrl: `https://example.com/${externalId}`, authorName: 'Reporter', publishedAt,
  });
}

test('joined chunks drop a repeated opening sentence', () => {
  const lead = '第一句说明产品已经发布。';
  const joined = joinTranslationChunks([
    `${lead}后面还有细节。`,
    `${lead}后面是下一段。`,
  ]);
  assert.equal(joined, `${lead}后面还有细节。\n\n后面是下一段。`);
  const source = `${'Capacity plan remains uncertain. '.repeat(20)}tail`;
  assert.equal(splitTranslationText(source, 400).join(''), source);
});

test('a short chunk is retried before the translation is saved', async () => {
  const source = `${'Capacity plan remains uncertain. '.repeat(20)}`;
  assert.ok(source.length >= 400);
  const calls = [];
  const full = '这是一段足够长的中文译文，用来说明原文并没有在第一句就停住，后面继续把产品、时间和后续安排说完。'.repeat(8);
  const service = createTranslateService({
    chunkChars: 1500,
    sleep: async () => {},
    router: {
      batch: false,
      generate: async () => {
        calls.push(1);
        return { text: calls.length === 1 ? '短' : full, engine: 'gemma' };
      },
    },
  });
  const saved = await service.translate({ text: source, id: 'short-chunk' });
  assert.equal(calls.length, 2);
  assert.equal(saved.translatedText, full);
});

test('a cut ending is retried before the translation is saved', async () => {
  const source = 'Jeff wrote two paragraphs about the round. The second paragraph explains what is already public.';
  assert.ok(source.length < 400);
  const calls = [];
  const full = '杰夫写了两段，谈到这一轮。第二段说明哪些信息已经公开。';
  const service = createTranslateService({
    sleep: async () => {},
    router: {
      batch: false,
      generate: async () => {
        calls.push(1);
        return { text: calls.length === 1 ? '…缺乏公开信息（我...' : full, engine: 'gemma' };
      },
    },
  });
  const saved = await service.translate({ text: source, id: 'jeff-cut' });
  assert.equal(calls.length, 2);
  assert.equal(saved.translatedText, full);
});

test('chunk size defaults to 1500 and the timeout can be raised without passing 300s', () => {
  assert.equal(translationChunkChars(undefined), 1500);
  assert.equal(translationChunkChars('1500'), 1500);
  assert.equal(translationChunkChars('400'), 400);
  assert.equal(translationChunkChars('2400'), 2400);
  assert.equal(translationChunkChars('100'), 400);
  assert.equal(translationChunkChars('9000'), 2400);
  assert.equal(translationChunkChars('nope'), 1500);
  assert.equal(gemmaTranslationTimeoutMs(undefined), 180_000);
  assert.equal(gemmaTranslationTimeoutMs('180000'), 180_000);
  assert.equal(gemmaTranslationTimeoutMs('60000'), 120_000);
  assert.equal(gemmaTranslationTimeoutMs('900000'), 300_000);
});

test('long feed.translation.run sends one chunk per request and resumes after a 500', async () => {
  const store = createStore(':memory:');
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    const feed = store.repositories.feed;
    const source = Array.from({ length: 40 }, (_, index) => `Capacity plan ${index} remains uncertain.`).join(' ');
    const chunks = splitTranslationText(source, 400);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((chunk) => chunk.length <= 400));
    assert.equal(chunks.join(''), source);
    const calls = [];
    const delays = [];
    let failSecond = true;
    const chunkStore = createFeedTranslationChunkStore(feed);
    const failing = createTranslateService({
      chunkChars: 400,
      chunkAttempts: 2,
      sleep: async (ms) => { delays.push(ms); },
      chunkStore,
      router: {
        batch: false,
        generate: async ({ system, prompt }) => {
          calls.push(prompt);
          assert.ok(gemmaTranslationInput(system, prompt).length < 16_000);
          assert.ok(prompt.length <= 400);
          assert.ok(prompt.length < source.length);
          if (failSecond && prompt === chunks[1]) throw Object.assign(new Error('Gemma 翻译失败（500）'), { upstreamStatus: 500 });
          return { text: `译${prompt.length}${'。'.repeat(160)}`, engine: 'gemma-4-26b-a4b-it' };
        },
      },
    });
    await assert.rejects(() => failing.translate({ text: source, id: 'item-1', workspaceId: 'local' }), /500/);
    assert.deepEqual(delays, [12_000]);
    assert.equal(calls.filter((prompt) => prompt === chunks[0]).length, 1);
    assert.equal(calls.filter((prompt) => prompt === chunks[1]).length, 2);
    assert.equal(calls.some((prompt) => prompt === chunks[2]), false);
    assert.equal(feed.listTranslationChunks('local', 'item-1', 'zh', hash(source)).length, 1);
    assert.match(lines.find((line) => line.includes('status=ok')), /item=item-1 chunk=1\/\d+ chars=\d+ requestChars=\d+ latencyMs=\d+ status=ok/);
    const ok = lines.find((line) => line.includes('chunk=1/'));
    const sizes = ok.match(/chars=(\d+) requestChars=(\d+)/);
    assert.ok(Number(sizes[2]) > Number(sizes[1]));
    assert.match(lines.find((line) => line.includes('status=retry')), /status=retry/);
    assert.match(lines.at(-1), /status=error/);

    failSecond = false;
    const resumedCalls = [];
    const resumed = createTranslateService({
      chunkChars: 400,
      chunkStore,
      router: {
        batch: false,
        generate: async ({ prompt }) => {
          resumedCalls.push(prompt);
          return { text: `续${prompt.length}${'。'.repeat(160)}`, engine: 'gemma-4-26b-a4b-it' };
        },
      },
    });
    const result = await resumed.translate({ text: source, id: 'item-1', workspaceId: 'local' });
    assert.equal(resumedCalls.includes(chunks[0]), false);
    assert.equal(resumedCalls[0], chunks[1]);
    assert.match(result.translatedText, /^译/);
    assert.match(lines.find((line) => line.includes('status=cached')), /status=cached/);
    assert.ok(feed.listTranslationChunks('local', 'item-1', 'zh', hash(source)).length > 1);

    const service = createFeedService({
      legacyRepository: store, feedRepository: feed, sourcePort: sourcePort(), translationPort: resumed,
    });
    const jobs = await enqueueOriginalTranslations({
      store, feedService: service, workspaceId: 'local', units: [{ id: 'item-1', text: source }],
    });
    await createJobRunner({ store, handlers: createFeedTranslationJobHandlers({ feedService: service }) }).runOnce();
    assert.equal(store.getJob(jobs[0].id).status, 'completed');
    const saved = feed.listTranslations('local', ['item-1'])[0];
    assert.equal(saved.sourceHash, hash(source));
    assert.equal(feed.listTranslationChunks('local', 'item-1', 'zh', hash(source)).length, 0);
    const logged = formatTranslationBackfillLog({ scanned: 29, cjk: 3, stale: 2, ids: { cjk: ['a'], stale: ['b'] } }, { enqueued: 24, limit: 80 });
    assert.match(logged, /enqueued=24 limit=80 scanned=29 cjk=3/);
    assert.match(logged, /stale=2/);
    assert.match(logged, /cjk-ids=a/);
    assert.match(logged, /stale-ids=b/);
  } finally {
    console.log = original;
    store.close();
  }
});

test('backfill records skip reasons and still queues a long post that only has a title translation', async () => {
  const store = createStore(':memory:');
  try {
    const feed = store.repositories.feed;
    const home = feed.upsertSourceAccount({ workspaceId: 'local', provider: 'x', externalId: 'x:home', displayName: 'X' });
    const flash = feed.upsertSourceAccount({ workspaceId: 'local', provider: 'xueqiu', externalId: 'xueqiu:home:livenews', displayName: '快讯' });
    const media = feed.upsertSourceAccount({ workspaceId: 'local', provider: 'media', externalId: 'media:desk', displayName: '媒体' });
    const longText = `${'Capacity plans remain uncertain this quarter. '}`.repeat(30).trim();
    const quoted = `${longText} 长鑫存储扩产计划已经公开说明`;
    const chinese = '这是一条不需要翻译的中文长帖，只是提到了 CXMT。'.repeat(12);
    const readyText = 'A short English post that already has a full translation.';
    const failedText = 'Another English post waiting out a translation failure.';
    const fresh = saveItem(feed, home.id, { externalId: 'fresh', title: 'Fresh', body: longText, publishedAt: 9_000 });
    const titled = saveItem(feed, home.id, { externalId: 'titled', title: 'Titled', body: longText, publishedAt: 8_500 });
    feed.saveTranslations([{
      workspaceId: 'local', itemId: titled.id, targetLang: 'zh', sourceHash: hash(longText),
      translatedText: '小时标题', engine: 'hourly-report',
    }]);
    const stale = saveItem(feed, home.id, { externalId: 'stale', title: 'Stale', body: quoted, publishedAt: 8_000 });
    const zh = saveItem(feed, home.id, { externalId: 'zh', title: '中文', body: chinese, publishedAt: 7_000 });
    const hidden = saveItem(feed, home.id, { externalId: 'hidden', title: 'Hidden', body: longText, publishedAt: 6_000 });
    const flashItem = saveItem(feed, flash.id, { provider: 'xueqiu', externalId: 'flash-long', title: 'Flash', body: longText, publishedAt: 5_000 });
    const ready = saveItem(feed, home.id, { externalId: 'ready', title: 'Ready', body: readyText, publishedAt: 4_000 });
    const failed = saveItem(feed, home.id, { externalId: 'failed', title: 'Failed', body: failedText, publishedAt: 3_000 });
    saveItem(feed, media.id, { provider: 'media', externalId: 'other', title: 'Other', body: `${'Capacity plans remain uncertain this quarter. '.repeat(500)}`, publishedAt: 2_000 });
    feed.saveTranslations([{
      workspaceId: 'local', itemId: 'x:stale', targetLang: 'zh', sourceHash: hash('title only'),
      translatedText: '只有标题译文', engine: 'test',
    }]);
    feed.saveTranslations([{
      workspaceId: 'local', itemId: ready.id, targetLang: 'zh', sourceHash: hash(readyText),
      translatedText: '全文已有译文', engine: 'test',
    }]);
    feed.upsertUserItemState({ workspaceId: 'local', contentItemId: hidden.id, isHidden: true });
    feed.noteTranslationFailure({
      workspaceId: 'local', items: [{ id: failed.id, text: failedText }],
      error: new Error('Gemma 翻译失败（500）'), attemptCount: 1, nextRetryAt: Date.now() + 60_000,
    });
    const service = createFeedService({
      legacyRepository: store, feedRepository: feed, sourcePort: sourcePort(),
      normalizedArticlePort: { hourlyTitles: () => new Map([[`feed:${fresh.id}`, '小时标题']]) },
      translationPort: { translateMany: async () => { throw new Error('backfill must not translate'); } },
    });
    const result = await backfillUntranslatedFeedTranslations({
      store, feedService: service, workspaceId: 'local', limit: 80,
      excludeSourceIds: ['xueqiu:home:livenews'],
    });
    const queued = new Set(result.jobs.map((job) => job.input.items[0].id));
    assert.equal(queued.has(fresh.id), true);
    assert.equal(queued.has(titled.id), true);
    assert.equal(queued.has(stale.id), true);
    assert.equal(queued.has(zh.id), false);
    assert.equal(queued.has(hidden.id), false);
    assert.equal(queued.has(flashItem.id), false);
    assert.equal(queued.has(ready.id), false);
    assert.equal(queued.has(failed.id), false);
    assert.equal(feed.listTranslations('local', [fresh.id]).some((row) => row.engine === 'hourly-report'), false);
    assert.ok(result.summary.cjk >= 1);
    assert.ok(result.summary.flash >= 1);
    assert.ok(result.summary.hidden >= 1);
    assert.ok(result.summary.translated >= 1);
    assert.ok(result.summary.failure >= 1);
    assert.ok(result.summary.stale >= 1);
    assert.ok(result.summary.hourlyTitle >= 1);
    assert.ok(result.summary.ids.hourlyTitle.includes(titled.id));
    assert.equal(result.summary.otherProvider, 1);
    assert.ok(result.summary.ids.stale.includes(stale.id));
    assert.ok(result.summary.ids.cjk.includes(zh.id));
    assert.match(formatTranslationBackfillLog(result.summary, { enqueued: result.jobs.length, limit: 80 }), /stale=/);
  } finally {
    store.close();
  }
});
