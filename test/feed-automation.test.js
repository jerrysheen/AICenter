import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../packages/database/src/index.js';
import { createFeedService } from '../packages/domain/src/feed-service.js';
import { createTaggingService } from '../packages/domain/src/tagging-service.js';
import { createScheduler } from '../packages/runtime/src/scheduler.js';
import { createJobRunner } from '../packages/runtime/src/job-runner.js';
import {
  createFeedAutomationJobHandlers,
  ensureDefaultContentSubscriptions,
  ensureFeedSubscriptionSyncSchedule,
  FEED_ITEMS_ENRICH_JOB_TYPE,
  FEED_SUBSCRIPTION_SYNC_SCHEDULE_KEY,
  FEED_SUBSCRIPTIONS_SYNC_JOB_TYPE,
  FEED_SYNC_MAX_RUNTIME_MS,
  prepareFeedSyncEnqueue,
} from '../packages/runtime/src/feed-automation-module.js';
import { ensureDailyReportSchedule } from '../packages/runtime/src/report-module.js';
import { ensureDividendStrategySchedule } from '../packages/runtime/src/strategy-module.js';
import {
  createBilibiliSourceDefinition,
  createTrendForceSourceDefinition,
  createXSourceDefinition,
  createXueqiuSourceDefinition,
} from '../packages/source/src/content/definitions.js';
import { createAiCenterWorker } from '../apps/worker/src/worker.js';

const CATALOG = {
  version: 'tags_v1',
  tags: [{ id: 'general', name: '综合', parent_id: null, keywords: ['综合'] }],
};

function temporaryStore() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-feed-auto-'));
  const store = createStore(path.join(directory, 'test.db'));
  return {
    directory,
    store,
    remove() {
      try { store.close(); } catch { /* closed by worker */ }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function definitions() {
  const unused = { async getFeed() { return { items: [] }; } };
  return new Map([
    ['content.x.home', createXSourceDefinition(unused)],
    ['content.xueqiu.home', createXueqiuSourceDefinition(unused)],
    ['content.trendforce.public', createTrendForceSourceDefinition(unused)],
    ['content.bilibili.import', createBilibiliSourceDefinition(unused)],
  ]);
}

function seedAccount(feed, provider, projection, {
  due = true,
  interval = 30,
  priority = 'normal',
  externalId = projection.sourceAccount.externalId,
} = {}) {
  const account = feed.upsertSourceAccount({
    workspaceId: 'local',
    provider,
    externalId,
    displayName: projection.sourceAccount.displayName,
    profileUrl: projection.sourceAccount.profileUrl,
    authMode: projection.sourceAccount.authMode,
    metadata: projection.sourceAccount.metadata,
  });
  const subscription = feed.upsertSubscription({
    workspaceId: 'local',
    sourceAccountId: account.id,
    enabled: true,
    priority,
    refreshIntervalMinutes: interval,
    nextSyncAt: due ? Date.now() - 1_000 : Date.now() + 60 * 60_000,
  });
  return { account, subscription };
}

test('subscription claim leases due rows and advances success or retry on its own', () => {
  const temporary = temporaryStore();
  const feed = temporary.store.repositories.feed;
  const now = Date.now();
  const high = feed.upsertSourceAccount({
    workspaceId: 'local', provider: 'x', externalId: 'high', displayName: 'high',
  });
  const low = feed.upsertSourceAccount({
    workspaceId: 'local', provider: 'xueqiu', externalId: 'low', displayName: 'low',
  });
  const later = feed.upsertSourceAccount({
    workspaceId: 'local', provider: 'trendforce', externalId: 'later', displayName: 'later',
  });
  const disabled = feed.upsertSourceAccount({
    workspaceId: 'local', provider: 'rss', externalId: 'off', displayName: 'off',
  });
  feed.upsertSubscription({
    workspaceId: 'local', sourceAccountId: low.id, priority: 'low', refreshIntervalMinutes: 30, nextSyncAt: now - 5_000,
  });
  const highSub = feed.upsertSubscription({
    workspaceId: 'local', sourceAccountId: high.id, priority: 'high', refreshIntervalMinutes: 60, nextSyncAt: now - 1_000,
  });
  feed.upsertSubscription({
    workspaceId: 'local', sourceAccountId: later.id, refreshIntervalMinutes: 120, nextSyncAt: now + 60 * 60_000,
  });
  feed.upsertSubscription({
    workspaceId: 'local', sourceAccountId: disabled.id, enabled: false, nextSyncAt: now - 10_000,
  });

  const claimed = feed.claimDueSubscriptions(now, 10, 10 * 60_000);
  assert.deepEqual(claimed.map((row) => row.priority), ['high', 'low']);
  assert.equal(claimed[0].id, highSub.id);
  assert.equal(claimed[0].lastSyncAt, null);
  assert.equal(claimed[0].nextSyncAt, now + 10 * 60_000);
  assert.equal(feed.claimDueSubscriptions(now, 10, 10 * 60_000).length, 0);

  const syncedAt = now + 1_000;
  const done = feed.completeSubscriptionSync(highSub.id, syncedAt);
  assert.equal(done.lastSyncAt, syncedAt);
  assert.equal(done.nextSyncAt, syncedAt + 60 * 60_000);

  const failedAt = now + 2_000;
  const failed = feed.failSubscriptionSync(claimed[1].id, failedAt, 5 * 60_000);
  assert.equal(failed.lastSyncAt, null);
  assert.equal(failed.nextSyncAt, failedAt + 5 * 60_000);
  temporary.remove();
});

test('manual refresh keeps an existing subscription and stores replay metadata', async () => {
  const temporary = temporaryStore();
  const sources = definitions();
  const x = sources.get('content.x.home');
  const bili = sources.get('content.bilibili.import');
  assert.deepEqual(x.persistence({ feed: 'following', limit: 50 }).sourceAccount.metadata, {
    sourceId: 'content.x.home',
    sourceInput: { feed: 'following' },
    autoRefresh: true,
  });
  assert.equal(x.persistence({ feed: 'for-you', limit: 50 }).refreshIntervalMinutes, 30);
  assert.equal(x.persistence({ feed: 'following', limit: 50 }).refreshIntervalMinutes, 30);
  assert.deepEqual(sources.get('content.xueqiu.home').persistence({ feed: 'featured', limit: 20 }).sourceAccount.metadata, {
    sourceId: 'content.xueqiu.home',
    sourceInput: { feed: 'featured' },
    autoRefresh: true,
  });
  assert.equal(sources.get('content.xueqiu.home').persistence({ feed: 'livenews', limit: 20 }).refreshIntervalMinutes, 30);
  assert.deepEqual(sources.get('content.trendforce.public').persistence({ feed: 'public' }).sourceAccount.metadata, {
    sourceId: 'content.trendforce.public',
    sourceInput: { feed: 'public' },
    autoRefresh: true,
  });
  assert.equal(sources.get('content.trendforce.public').persistence({ feed: 'public' }).refreshIntervalMinutes, 120);
  assert.equal(bili.persistence({ feed: 'imports', url: '' }).sourceAccount.metadata.autoRefresh, false);

  const feed = temporary.store.repositories.feed;
  let reads = 0;
  const service = createFeedService({
    legacyRepository: temporary.store,
    feedRepository: feed,
    sourcePort: {
      findByProvider(providerId) {
        if (providerId === 'x') return { id: 'content.x.home' };
        if (providerId === 'bilibili') return { id: 'content.bilibili.import' };
        return null;
      },
      persistence(sourceId, input) {
        return sources.get(sourceId).persistence(input);
      },
      async read(_sourceId, input) {
        reads += 1;
        const feedName = input.feed || 'imports';
        return {
          data: {
            mode: 'live',
            note: 'live',
            fetchedAt: Date.now(),
            items: [{
              externalId: `manual-${feedName}`,
              title: 'manual',
              body: 'manual body',
              summary: 'manual body',
              sourceUrl: `https://example.com/${feedName}`,
              authorName: 'user',
              publishedAt: 10,
            }],
          },
        };
      },
    },
  });

  const first = await service.getExternalFeed('x', { feed: 'following', limit: 50, refresh: true });
  assert.equal(first.added, 1);
  const created = feed.listDueSubscriptions(Date.now(), 10)[0];
  assert.equal(created.refreshIntervalMinutes, 30);
  assert.deepEqual(feed.getSourceAccount(created.sourceAccountId).metadata, {
    sourceId: 'content.x.home',
    sourceInput: { feed: 'following' },
    autoRefresh: true,
  });
  feed.upsertSubscription({
    workspaceId: 'local',
    sourceAccountId: created.sourceAccountId,
    enabled: true,
    priority: 'high',
    refreshIntervalMinutes: 120,
    notificationPolicy: 'all',
    nextSyncAt: 9_000_000,
  });
  const again = await service.getExternalFeed('x', { feed: 'following', limit: 50, refresh: true });
  assert.match(again.note, /去重/);
  const kept = feed.listDueSubscriptions(Date.now(), 10).find((row) => row.id === created.id);
  assert.equal(kept.priority, 'high');
  assert.equal(kept.refreshIntervalMinutes, 120);
  assert.equal(kept.notificationPolicy, 'all');
  assert.equal(kept.nextSyncAt, 9_000_000);

  const beforeBili = feed.listDueSubscriptions(Date.now(), 10).length;
  await service.getExternalFeed('bilibili', { feed: 'imports', url: 'https://www.bilibili.com/video/BV1xx411c7mD', refresh: true });
  assert.equal(feed.listDueSubscriptions(Date.now(), 10).length, beforeBili);
  assert.equal(reads, 3);
  temporary.remove();
});

test('feed sync uses metadata replay, isolates source failures, and enriches only new items', async () => {
  const temporary = temporaryStore();
  const sources = definitions();
  const feed = temporary.store.repositories.feed;
  const reads = [];
  const translateCalls = [];
  const tagCalls = [];
  const service = createFeedService({
    legacyRepository: temporary.store,
    feedRepository: feed,
    translationPort: {
      async translateMany({ items }) {
        translateCalls.push(items.map((item) => item.id));
        return {
          translations: items.map((item) => ({
            id: item.id,
            sourceText: item.text,
            translatedText: `译:${item.text}`,
            targetLang: 'zh',
            engine: 'fixture',
          })),
        };
      },
    },
    sourcePort: {
      persistence(sourceId, input) {
        return sources.get(sourceId).persistence(input);
      },
      async read(sourceId, input) {
        reads.push({ sourceId, feed: input.feed });
        if (sourceId === 'content.trendforce.public') throw new Error('fixture outage');
        const name = input.feed || 'public';
        const english = name !== 'livenews';
        return {
          data: {
            mode: 'live',
            note: 'fixture',
            fetchedAt: Date.now(),
            items: [{
              externalId: `${sourceId}:${name}`,
              title: name,
              body: english
                ? `Fresh English fixture sentence about the ${name} market today.`
                : '这是一条雪球中文快讯',
              summary: '',
              sourceUrl: `https://example.com/${encodeURIComponent(sourceId)}/${name}`,
              authorName: 'fixture',
              publishedAt: 1_700_000_000_000,
            }],
          },
        };
      },
    },
  });
  const tagging = createTaggingService({
    catalog: CATALOG,
    taggingRepository: temporary.store.repositories.tagging,
    taggingPort: {
      async tagBatch(input) {
        const ids = input.userPayload.items.map((item) => item.item_id);
        tagCalls.push(ids);
        return {
          reply_text: JSON.stringify({
            items: ids.map((id) => ({ item_id: id, tags: ['general'] })),
          }),
          model: 'fixture',
        };
      },
    },
  });
  const handlers = createFeedAutomationJobHandlers({
    feedService: service,
    feedRepository: feed,
    taggingService: tagging,
  });

  const xFollowing = seedAccount(feed, 'x', sources.get('content.x.home').persistence({ feed: 'following', limit: 50 }), {
    interval: 60,
  });
  seedAccount(feed, 'x', sources.get('content.x.home').persistence({ feed: 'for-you', limit: 50 }), {
    due: false,
    interval: 60,
  });
  for (const name of ['following', 'featured', 'livenews']) {
    seedAccount(feed, 'xueqiu', sources.get('content.xueqiu.home').persistence({ feed: name, limit: 20 }), {
      interval: 30,
    });
  }
  seedAccount(feed, 'trendforce', sources.get('content.trendforce.public').persistence({ feed: 'public' }), {
    interval: 120,
  });
  const bili = seedAccount(feed, 'bilibili', sources.get('content.bilibili.import').persistence({ feed: 'imports', url: '' }), {
    interval: 30,
  });

  const runner = createJobRunner({
    store: temporary.store,
    handlers,
    workerId: 'feed-sync-test',
  });
  temporary.store.createJob({
    type: FEED_SUBSCRIPTIONS_SYNC_JOB_TYPE,
    input: {},
    maxAttempts: 1,
  });
  const completed = await runner.runOnce();
  assert.equal(completed.status, 'completed');
  assert.equal(completed.output.due, 6);
  assert.equal(completed.output.succeeded, 4);
  assert.equal(completed.output.failed, 1);
  assert.equal(completed.output.deferred, 1);
  assert.equal(completed.output.added, 4);
  assert.equal(completed.output.subscriptions.length, 6);
  assert.deepEqual(reads.map((row) => `${row.sourceId}:${row.feed}`).sort(), [
    'content.trendforce.public:public',
    'content.x.home:following',
    'content.xueqiu.home:featured',
    'content.xueqiu.home:following',
    'content.xueqiu.home:livenews',
  ].sort());
  assert.equal(reads.some((row) => row.feed === 'for-you'), false);
  assert.equal(reads.some((row) => row.sourceId === 'content.bilibili.import'), false);

  const visible = feed.listDueSubscriptions(Date.now() + 400 * 24 * 60 * 60_000, 20);
  const afterSuccess = visible.find((item) => item.id === xFollowing.subscription.id);
  assert.equal(afterSuccess.lastSyncAt > 0, true);
  assert.equal(afterSuccess.nextSyncAt, afterSuccess.lastSyncAt + 60 * 60_000);

  const biliRow = visible.find((item) => item.id === bili.subscription.id);
  assert.equal(biliRow.lastSyncAt > 0, true);
  assert.equal(biliRow.nextSyncAt, biliRow.lastSyncAt + 30 * 60_000);
  assert.equal(completed.output.subscriptions.find((item) => item.subscriptionId === bili.subscription.id).reason, 'bilibili-link-only');

  const trend = visible.find((item) => item.refreshIntervalMinutes === 120);
  assert.equal(trend.lastSyncAt, null);
  assert.ok(trend.nextSyncAt <= Date.now() + 5 * 60_000 + 5_000);
  assert.ok(trend.nextSyncAt >= Date.now());

  const enrichJobs = temporary.store.listJobs(20).filter((job) => job.type === FEED_ITEMS_ENRICH_JOB_TYPE);
  assert.equal(enrichJobs.length, 4);
  for (const job of enrichJobs) {
    assert.equal(job.input.resourceIds.length, 1);
    const result = await handlers[FEED_ITEMS_ENRICH_JOB_TYPE](job.input);
    assert.equal(result.tagged, 1);
  }
  assert.equal(translateCalls.length, 3);
  assert.equal(tagCalls.length, 4);
  const translated = temporary.store.repositories.feed.listTranslations('local', translateCalls.flat(), 'zh');
  assert.equal(translated.length, 3);
  assert.ok(translated.every((row) => row.engine === 'fixture'));

  for (const job of enrichJobs) {
    const again = await handlers[FEED_ITEMS_ENRICH_JOB_TYPE](job.input);
    assert.equal(again.tagged, 0);
    assert.equal(again.skippedTagging, 1);
  }
  assert.equal(translateCalls.length, 3);
  assert.equal(tagCalls.length, 4);

  for (const row of visible) {
    if (!row.lastSyncAt) continue;
    feed.failSubscriptionSync(row.id, Date.now() - 5_000, 1_000);
  }
  reads.length = 0;
  const second = await handlers[FEED_SUBSCRIPTIONS_SYNC_JOB_TYPE]({}, { store: temporary.store });
  assert.equal(second.added, 0);
  assert.equal(second.succeeded, 4);
  assert.equal(second.failed, 0);
  assert.equal(temporary.store.listJobs(20).filter((job) => job.type === FEED_ITEMS_ENRICH_JOB_TYPE).length, 4);
  assert.deepEqual(reads.map((row) => row.feed).sort(), ['featured', 'following', 'following', 'livenews']);
  temporary.remove();
});

test('sync calls the source with metadata instead of parsing externalId', async () => {
  const temporary = temporaryStore();
  const feed = temporary.store.repositories.feed;
  const calls = [];
  const account = feed.upsertSourceAccount({
    workspaceId: 'local',
    provider: 'x',
    externalId: 'x:home:for-you',
    displayName: 'X',
    metadata: {
      sourceId: 'content.x.home',
      sourceInput: { feed: 'following' },
      autoRefresh: true,
    },
  });
  feed.upsertSubscription({
    workspaceId: 'local',
    sourceAccountId: account.id,
    refreshIntervalMinutes: 60,
    nextSyncAt: Date.now() - 1_000,
  });
  const handlers = createFeedAutomationJobHandlers({
    feedRepository: feed,
    feedService: {
      async refreshPersistedSource(input) {
        calls.push(input);
        return { added: 0, skipped: 0, addedItemIds: [] };
      },
      async localizeContentItems() { return { pendingIds: [] }; },
      listTaggableItems() { return []; },
    },
    taggingService: {
      async analyzeItems() { return { saved: [], missingItemIds: [], skipped: 0 }; },
    },
  });
  const output = await handlers[FEED_SUBSCRIPTIONS_SYNC_JOB_TYPE]({}, { store: temporary.store });
  assert.equal(output.succeeded, 1);
  assert.deepEqual(calls, [{
    workspaceId: 'local',
    sourceId: 'content.x.home',
    sourceInput: { feed: 'following' },
  }]);
  temporary.remove();
});

test('blank source id is skipped instead of failing auto refresh', async () => {
  const temporary = temporaryStore();
  const feed = temporary.store.repositories.feed;
  const calls = [];
  for (const [externalId, sourceId] of [['x:blank:empty', ''], ['x:blank:space', '   ']]) {
    const account = feed.upsertSourceAccount({
      workspaceId: 'local',
      provider: 'x',
      externalId,
      displayName: 'blank',
      metadata: {
        sourceId,
        sourceInput: { feed: 'following' },
        autoRefresh: true,
      },
    });
    feed.upsertSubscription({
      workspaceId: 'local',
      sourceAccountId: account.id,
      refreshIntervalMinutes: 30,
      nextSyncAt: Date.now() - 1_000,
    });
  }
  const handlers = createFeedAutomationJobHandlers({
    feedRepository: feed,
    feedService: {
      async refreshPersistedSource(input) {
        calls.push(input);
        return { added: 0, skipped: 0, addedItemIds: [] };
      },
      async localizeContentItems() { return { pendingIds: [] }; },
      listTaggableItems() { return []; },
    },
    taggingService: {
      async analyzeItems() { return { saved: [], missingItemIds: [], skipped: 0 }; },
    },
  });
  const output = await handlers[FEED_SUBSCRIPTIONS_SYNC_JOB_TYPE]({}, { store: temporary.store });
  assert.equal(output.failed, 0);
  assert.equal(output.succeeded, 0);
  assert.equal(output.deferred, 2);
  assert.equal(calls.length, 0);
  assert.deepEqual(output.subscriptions.map((row) => row.reason), ['empty-source-id', 'empty-source-id']);
  assert.ok(output.subscriptions.every((row) => row.status === 'skipped' && row.sourceId === ''));
  temporary.remove();
});

test('x and xueqiu home feeds register at 30 minutes', () => {
  const temporary = temporaryStore();
  const feed = temporary.store.repositories.feed;
  const following = feed.upsertSourceAccount({
    workspaceId: 'local', provider: 'x', externalId: 'x:home:following', displayName: 'old', metadata: {},
  });
  feed.upsertSubscription({
    workspaceId: 'local', sourceAccountId: following.id, refreshIntervalMinutes: 60,
    priority: 'high', notificationPolicy: 'all', nextSyncAt: 9_000_000,
  });
  const recommended = feed.upsertSourceAccount({
    workspaceId: 'local', provider: 'x', externalId: 'x:home:for-you', displayName: 'old',
  });
  feed.upsertSubscription({
    workspaceId: 'local', sourceAccountId: recommended.id, refreshIntervalMinutes: 120,
    priority: 'low', notificationPolicy: 'important', nextSyncAt: 8_000_000,
  });

  const saved = ensureDefaultContentSubscriptions(feed);
  assert.deepEqual(saved.map((row) => {
    const account = feed.getSourceAccount(row.sourceAccountId);
    return {
      sourceId: account.metadata.sourceId,
      feed: account.metadata.sourceInput.feed,
      minutes: row.refreshIntervalMinutes,
    };
  }), [
    { sourceId: 'content.x.home', feed: 'following', minutes: 30 },
    { sourceId: 'content.x.home', feed: 'for-you', minutes: 120 },
    { sourceId: 'content.xueqiu.home', feed: 'following', minutes: 30 },
    { sourceId: 'content.xueqiu.home', feed: 'featured', minutes: 30 },
    { sourceId: 'content.xueqiu.home', feed: 'livenews', minutes: 30 },
  ]);
  assert.equal(saved[0].priority, 'high');
  assert.equal(saved[0].notificationPolicy, 'all');
  assert.equal(saved[0].nextSyncAt, 9_000_000);
  assert.equal(saved[1].priority, 'low');
  assert.equal(saved[1].nextSyncAt, 8_000_000);
  assert.equal(ensureDefaultContentSubscriptions(feed).length, 5);
  assert.equal(feed.listDueSubscriptions(Date.now() + 400 * 24 * 60 * 60_000, 20).length, 5);
  temporary.remove();
});

test('a few missed minutes still enqueue one subscription sync', async () => {
  const temporary = temporaryStore();
  const past = Date.now() - 3 * 60 * 60_000;
  const schedule = ensureFeedSubscriptionSyncSchedule(temporary.store, past);
  assert.equal(schedule.key, FEED_SUBSCRIPTION_SYNC_SCHEDULE_KEY);
  assert.equal(schedule.schedule.kind, 'interval');
  assert.equal(schedule.schedule.intervalMinutes, 1);
  assert.equal(schedule.jobType, FEED_SUBSCRIPTIONS_SYNC_JOB_TYPE);
  const scheduler = createScheduler({
    store: temporary.store,
    allowedJobTypes: [FEED_SUBSCRIPTIONS_SYNC_JOB_TYPE],
    now: () => Date.now(),
  });
  const first = await scheduler.tick();
  const second = await scheduler.tick();
  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
  assert.equal(temporary.store.listJobs(20).filter((job) => job.type === FEED_SUBSCRIPTIONS_SYNC_JOB_TYPE).length, 1);
  temporary.remove();
});

test('automatic translation is visible on the feed item id', async () => {
  const temporary = temporaryStore();
  const feed = temporary.store.repositories.feed;
  const account = feed.upsertSourceAccount({
    workspaceId: 'local', provider: 'x', externalId: 'x:home:following', displayName: 'X',
    metadata: { sourceId: 'content.x.home', sourceInput: { feed: 'following' }, autoRefresh: true },
  });
  const capture = feed.saveCapture({
    workspaceId: 'local', provider: 'x', externalId: 'english-post', sourceAccountId: account.id,
    sourceUrl: 'https://x.com/user/status/english-post', contentHash: 'hash-english-post',
  });
  const item = feed.saveContentItem({
    workspaceId: 'local', captureId: capture.id, originType: 'subscription', contentType: 'post',
    title: 'English', body: 'Fresh English fixture sentence about the market.', sourceUrl: capture.sourceUrl,
  });
  const service = createFeedService({
    legacyRepository: temporary.store,
    feedRepository: feed,
    translationPort: {
      async translateMany({ items }) {
        return {
          translations: items.map((unit) => ({
            id: unit.id,
            sourceText: unit.text,
            translatedText: '中文译文',
            targetLang: 'zh',
            engine: 'fixture',
          })),
        };
      },
    },
    sourcePort: {
      findByProvider() { return { id: 'content.x.home' }; },
      persistence() {
        return {
          providerId: 'x',
          sourceAccount: { externalId: 'x:home:following', displayName: 'X', profileUrl: 'https://x.com/home', authMode: 'browser-session' },
        };
      },
      async read() { return { data: { mode: 'live', items: [] } }; },
    },
  });
  const body = 'Fresh English fixture sentence about the market.';
  temporary.store.repositories.tagging.saveTaggings([{
    workspaceId: 'local', resourceType: 'content-item', resourceId: item.id,
    tags: ['macro'], tagCatalogVersion: 'tags_v1', promptVersion: 'tag_v1', model: 'test', analyzedAt: 1,
  }]);
  feed.saveTranslations([{
    workspaceId: 'local',
    itemId: item.id,
    targetLang: 'zh',
    sourceHash: createHash('sha256').update(body).digest('hex'),
    translatedText: '旧记录译文',
    engine: 'fixture',
  }]);
  const legacy = await service.getExternalFeed('x', { feed: 'following', refresh: false });
  assert.equal(legacy.items[0].translation.text, '旧记录译文');

  const localized = await service.localizeContentItems('local', [item.id]);
  assert.equal(localized.translated, 1);
  assert.equal(feed.listTranslations('local', ['x:english-post'], 'zh')[0].translatedText, '中文译文');
  const stored = await service.getExternalFeed('x', { feed: 'following', refresh: false });
  assert.equal(stored.items[0].translation.text, '中文译文');
  temporary.remove();
});

test('worker starts the subscription sync schedule and enriches new items without the web server', async () => {
  const temporary = temporaryStore();
  const translateCalls = [];
  const tagCalls = [];
  const worker = createAiCenterWorker({
    store: temporary.store,
    workerId: 'feed-auto-worker',
    env: {AI_CENTER_INFORMATION_PIPELINE:'legacy'},
    browserRuntime: { async health() { return { available: false }; } },
    agentQuality: null,
    auxiliarySearch: null,
    webSearchPort: null,
    feedFilter: null,
    translateService: {
      async translate({ text, targetLang = 'zh' }) {
        translateCalls.push(text);
        return { sourceText: text, translatedText: '中文译文', targetLang, engine: 'fixture' };
      },
      async translateMany({ items, targetLang = 'zh' }) {
        translateCalls.push(...items.map((item) => item.id));
        return {
          translations: items.map((item) => ({
            id: item.id,
            sourceText: item.text,
            translatedText: '中文译文',
            targetLang,
            engine: 'fixture',
          })),
        };
      },
    },
    taggingPort: {
      async tagBatch(input) {
        const ids = input.userPayload.items.map((item) => item.item_id);
        tagCalls.push(...ids);
        return {
          reply_text: JSON.stringify({
            items: ids.map((id) => ({ item_id: id, tags: ['general'] })),
          }),
          model: 'fixture',
        };
      },
    },
  });
  try {
    const sync = temporary.store.getJobSchedule('local', FEED_SUBSCRIPTION_SYNC_SCHEDULE_KEY);
    const report = temporary.store.getJobSchedule('local', 'report.daily.default');
    const strategy = temporary.store.getJobSchedule('local', 'strategy.cn-dividend.snapshot');
    assert.equal(sync.schedule.intervalMinutes, 1);
    assert.equal(sync.jobType, FEED_SUBSCRIPTIONS_SYNC_JOB_TYPE);
    assert.equal(report.jobType, 'report.daily.generate');
    assert.equal(strategy.jobType, 'strategy.cn-dividend.snapshot');

    const source = temporary.store.repositories.feed.upsertSourceAccount({
      workspaceId: 'local', provider: 'x', externalId: 'x:home:following', displayName: 'X',
    });
    const capture = temporary.store.repositories.feed.saveCapture({
      workspaceId: 'local', provider: 'x', externalId: 'english-1', sourceAccountId: source.id,
      sourceUrl: 'https://x.com/user/status/english-1', contentHash: 'hash-english-1',
    });
    const item = temporary.store.repositories.feed.saveContentItem({
      workspaceId: 'local', captureId: capture.id, originType: 'subscription', contentType: 'post',
      title: 'English', body: 'Fresh English fixture sentence about the market.', sourceUrl: capture.sourceUrl,
    });
    temporary.store.createJob({
      type: FEED_ITEMS_ENRICH_JOB_TYPE,
      workspaceId: 'local',
      maxAttempts: 1,
      input: { workspaceId: 'local', resourceIds: [item.id] },
    });
    const completed = await worker.runner.runOnce();
    assert.equal(completed.type, FEED_ITEMS_ENRICH_JOB_TYPE);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.output.translated, 1);
    assert.equal(completed.output.tagged, 1);
    assert.equal(translateCalls.length, 1);
    assert.equal(tagCalls.length, 1);

    temporary.store.createJob({
      type: FEED_ITEMS_ENRICH_JOB_TYPE,
      workspaceId: 'local',
      maxAttempts: 1,
      input: { workspaceId: 'local', resourceIds: [item.id] },
    });
    const repeated = await worker.runner.runOnce();
    assert.equal(repeated.status, 'completed');
    assert.equal(repeated.output.tagged, 0);
    assert.equal(translateCalls.length, 1);
    assert.equal(tagCalls.length, 1);
  } finally {
    await worker.close();
    temporary.remove();
  }
});

test('a new subscription sync replaces one that is still running past its budget', async () => {
  const temporary = temporaryStore();
  const store = temporary.store;
  const feed = store.repositories.feed;
  const account = feed.upsertSourceAccount({
    workspaceId: 'local',
    provider: 'x',
    externalId: 'x:home:for-you',
    displayName: 'X',
    profileUrl: 'https://x.com/home',
    authMode: 'browser-session',
    metadata: { autoRefresh: true, sourceId: 'content.x.home', sourceInput: { feed: 'for-you' } },
  });
  feed.upsertSubscription({
    workspaceId: 'local',
    sourceAccountId: account.id,
    enabled: true,
    refreshIntervalMinutes: 30,
    nextSyncAt: Date.now() - 1_000,
  });
  feed.claimDueSubscriptions(Date.now(), 10, FEED_SYNC_MAX_RUNTIME_MS);
  const stale = store.createJob({ type: FEED_SUBSCRIPTIONS_SYNC_JOB_TYPE, input: {}, maxAttempts: 2 });
  store.claimNextJob('old-worker', [FEED_SUBSCRIPTIONS_SYNC_JOB_TYPE]);
  const queued = store.createJob({ type: FEED_SUBSCRIPTIONS_SYNC_JOB_TYPE, input: {}, maxAttempts: 2 });
  assert.equal(prepareFeedSyncEnqueue(store, Date.now()), false);
  assert.equal(store.getJob(stale.id).status, 'running');

  store.discardQueuedJobs(FEED_SUBSCRIPTIONS_SYNC_JOB_TYPE, 'test collapse');
  assert.equal(store.getJob(queued.id).status, 'failed');
  const Database = (await import('better-sqlite3')).default;
  const database = new Database(path.join(temporary.directory, 'test.db'));
  database.prepare('UPDATE jobs SET started_at = ? WHERE id = ?').run(Date.now() - FEED_SYNC_MAX_RUNTIME_MS - 1_000, stale.id);
  database.close();

  assert.equal(prepareFeedSyncEnqueue(store, Date.now()), true);
  assert.equal(store.getJob(stale.id).status, 'failed');
  assert.match(store.getJob(stale.id).error.message, /上一轮仍未结束/);
  const subscription = feed.listDueSubscriptions(Date.now(), 10)[0];
  assert.ok(subscription);
  assert.ok(subscription.nextSyncAt <= Date.now());

  ensureFeedSubscriptionSyncSchedule(store, Date.now() - 1_000);
  const scheduler = createScheduler({
    store,
    allowedJobTypes: [FEED_SUBSCRIPTIONS_SYNC_JOB_TYPE],
    beforeEnqueue: (schedule, at) => prepareFeedSyncEnqueue(store, at),
  });
  const created = await scheduler.tick(Date.now());
  assert.equal(created.length, 1);
  assert.equal(store.listOpenJobs(FEED_SUBSCRIPTIONS_SYNC_JOB_TYPE).length, 1);
  const again = await scheduler.tick(Date.now());
  assert.equal(again.length, 0);
  temporary.remove();
});

test('default report and dividend schedules still install beside subscription sync', () => {
  const temporary = temporaryStore();
  ensureDailyReportSchedule(temporary.store, { timezone: 'Asia/Shanghai', cutoffHour: 8, cutoffMinute: 0 });
  ensureDividendStrategySchedule(temporary.store);
  ensureFeedSubscriptionSyncSchedule(temporary.store);
  assert.equal(temporary.store.getJobSchedule('local', 'report.daily.default').jobType, 'report.daily.generate');
  assert.equal(temporary.store.getJobSchedule('local', 'strategy.cn-dividend.snapshot').jobType, 'strategy.cn-dividend.snapshot');
  assert.equal(temporary.store.getJobSchedule('local', FEED_SUBSCRIPTION_SYNC_SCHEDULE_KEY).schedule.intervalMinutes, 1);
  temporary.remove();
});
