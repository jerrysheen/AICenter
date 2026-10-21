import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../packages/database/src/index.js';
import { createAuthorService } from '../packages/domain/src/author-service.js';
import { createFeedService } from '../packages/domain/src/feed-service.js';
import { ensureXVideoFeedPost, repairXFollowingFeed } from '../packages/domain/src/x-video-feed.js';
import { createYoutubePodcastService } from '../packages/domain/src/youtube-podcasts-service.js';

const TWEET = '2111105654211608847';

function openStore() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'feed-search-'));
  const store = createStore(path.join(directory, 'test.db'));
  return {
    store,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

test('handle url opens the numeric author and search finds an older post', async () => {
  const opened = openStore();
  try {
    const feed = opened.store.repositories.feed;
    const other = feed.upsertSourceAccount({
      workspaceId: 'local',
      provider: 'x',
      externalId: 'x:home:for-you',
      displayName: 'For you',
    });
    const publishedAt = Date.parse('2026-10-16T08:00:00Z');
    const capture = feed.saveCapture({
      workspaceId: 'local',
      provider: 'x',
      externalId: TWEET,
      sourceAccountId: other.id,
      sourceUrl: `https://x.com/MilesCranmer/status/${TWEET}`,
      title: '以下是演讲全文：',
      contentHash: hash(TWEET),
      publishedAt,
      authorNativeId: '382008009',
      metadata: {
        authorHandle: 'MilesCranmer',
        authorProfile: {
          authorId: 'x:382008009',
          platform: 'x',
          nativeId: '382008009',
          handle: 'MilesCranmer',
          name: 'Miles Cranmer',
          kind: 'person',
        },
        filterMode: 'enforce',
        filterDecision: 'KEEP',
        filterApplied: true,
        filterRule: 'all-three-0.60',
        filterReason: 'fallback-manual',
      },
    });
    feed.saveContentItem({
      workspaceId: 'local',
      captureId: capture.id,
      originType: 'subscription',
      contentType: 'post',
      title: '以下是演讲全文：',
      body: '以下是演讲全文：',
      summary: '以下是演讲全文：',
      sourceUrl: capture.sourceUrl,
      authorName: 'Miles Cranmer',
      publishedAt,
    });
    for (let index = 0; index < 205; index += 1) {
      const filler = feed.saveCapture({
        workspaceId: 'local',
        provider: 'x',
        externalId: `newer-${index}`,
        sourceAccountId: other.id,
        sourceUrl: `https://x.com/i/status/newer-${index}`,
        title: `新帖 ${index}`,
        contentHash: hash(`newer-${index}`),
        publishedAt: publishedAt + (index + 1) * 60_000,
        metadata: { authorHandle: 'other' },
      });
      feed.saveContentItem({
        workspaceId: 'local',
        captureId: filler.id,
        originType: 'subscription',
        contentType: 'post',
        title: `新帖 ${index}`,
        body: '没有这个名字',
        sourceUrl: filler.sourceUrl,
        authorName: '别人',
        publishedAt: publishedAt + (index + 1) * 60_000,
      });
    }
    const authors = opened.store.repositories.authors;
    assert.equal(authors.getAuthor('local', 'x:@MilesCranmer').authorId, 'x:382008009');
    assert.equal(authors.getAuthor('local', 'x:MilesCranmer').authorId, 'x:382008009');
    const authorService = createAuthorService({ authorRepository: authors, feedRepository: feed });
    assert.equal(authorService.get('local', 'x%3A%40MilesCranmer').authorId, 'x:382008009');
    const reader = createFeedService({
      legacyRepository: { listPosts() { return []; }, getPost() { return null; } },
      feedRepository: feed,
      sourcePort: { findByProvider() { return null; }, persistence() { return null; }, async read() { return { data: null }; } },
    });
    const recent = feed.listContentItems('local', { limit: 200 });
    assert.equal(recent.some((row) => row.title === '以下是演讲全文：'), false);
    const found = reader.searchContentItems('local', 'Cranmer', { limit: 8 });
    assert.equal(found.some((row) => row.authorName === 'Miles Cranmer' && row.title === '以下是演讲全文：'), true);
    const hits = reader.searchFeed('local', { query: 'Cranmer', platform: 'x' });
    assert.equal(hits.some((row) => row.id === `x:${TWEET}` && row.authorId === 'x:382008009'), true);
    assert.equal(hits.find((row) => row.id === `x:${TWEET}`).subscriptionId, '');
    assert.equal(reader.searchFeed('local', { query: 'Cr', platform: 'x' }).some((row) => row.id === `x:${TWEET}`), true);
    assert.equal(reader.searchFeed('local', { query: 'C' }).length, 0);
    const before = feed.listContentItemsByProvider('local', 'x', { sourceExternalId: 'x:home:following', limit: 20 });
    assert.equal(before.some((row) => row.externalId === TWEET), false);
    await ensureXVideoFeedPost({
      feedRepository: feed,
      workspaceId: 'local',
      tweetId: TWEET,
      recomputeAuthor: (authorId) => authors.recomputeAuthor('local', authorId),
    });
    const after = feed.listContentItemsByProvider('local', 'x', { sourceExternalId: 'x:home:following', limit: 20 });
    assert.equal(after.some((row) => row.externalId === TWEET && row.authorId === 'x:382008009'), true);
    assert.equal(after.find((row) => row.externalId === TWEET).title, '以下是演讲全文：');
    const account = feed.findSourceAccount('local', 'x', 'x:home:following');
    const subscription = feed.findSubscriptionBySource('local', account.id);
    assert.ok(subscription?.id);
    const repaired = reader.searchFeed('local', { query: 'Cranmer', platform: 'x' });
    assert.equal(repaired.find((row) => row.id === `x:${TWEET}`).subscriptionId, subscription.id);
    assert.equal(repaired.find((row) => row.id === `x:${TWEET}`).title, '以下是演讲全文：');
  } finally {
    opened.close();
  }
});

test('feed search uses the full-text index in batches and keeps short queries off the body', async () => {
  const opened = openStore();
  try {
    const feed = opened.store.repositories.feed;
    const empty = feed.feedSearchIndexStatus();
    assert.equal(empty.ready, true);
    assert.equal(empty.rows, 0);
    assert.equal(empty.done, false);
    assert.equal(empty.cursor, 0);
    const account = feed.upsertSourceAccount({
      workspaceId: 'local', provider: 'x', externalId: 'x:home:for-you', displayName: 'For you',
    });
    const publishedAt = Date.parse('2026-10-16T08:00:00Z');
    const save = (externalId, title, body, provider = 'x') => {
      const capture = feed.saveCapture({
        workspaceId: 'local',
        provider,
        externalId,
        sourceAccountId: account.id,
        sourceUrl: `https://example.com/${externalId}`,
        title,
        contentHash: hash(externalId),
        publishedAt,
        metadata: provider === 'x' ? { authorHandle: 'other' } : {},
      });
      feed.saveContentItem({
        workspaceId: 'local',
        captureId: capture.id,
        originType: 'subscription',
        contentType: 'post',
        title,
        body,
        summary: title,
        sourceUrl: capture.sourceUrl,
        authorName: '别人',
        publishedAt,
      });
    };
    save('body-hit', '普通标题', `${'甲'.repeat(80)} CranmerToken ${'乙'.repeat(80)}`);
    save('body-short', '另一个标题', `${'丙'.repeat(80)} zz ${'丁'.repeat(80)}`);
    save('title-short', '甲乙标题', '没有目标词');
    save('youtube-hit', '视频标题', 'CranmerToken 在视频里', 'youtube');
    for (let index = 0; index < 5; index += 1) save(`pad-${index}`, `填充 ${index}`, '没有这个词');
    const reader = createFeedService({
      legacyRepository: { listPosts() { return []; }, getPost() { return null; } },
      feedRepository: feed,
      sourcePort: { findByProvider() { return null; }, persistence() { return null; }, async read() { return { data: null }; } },
    });
    assert.equal(reader.searchContentItems('local', 'CranmerToken').some((row) => row.title === '普通标题'), true);
    assert.equal(reader.searchContentItems('local', 'zz').some((row) => row.title === '另一个标题'), false);
    assert.equal(reader.searchContentItems('local', '甲乙').some((row) => row.title === '甲乙标题'), true);
    assert.equal(reader.searchFeed('local', { query: 'CranmerToken' }).some((row) => row.externalId === 'youtube-hit'), false);
    const first = feed.indexFeedSearchBatch(2);
    assert.equal(first.done, false);
    assert.equal(first.indexed, 2);
    assert.equal(feed.feedSearchIndexStatus().done, false);
    let guard = 0;
    while (!feed.feedSearchIndexStatus().done && guard < 20) {
      feed.indexFeedSearchBatch(2);
      guard += 1;
    }
    assert.equal(feed.feedSearchIndexStatus().done, true);
    assert.equal(reader.searchContentItems('local', 'CranmerToken').some((row) => row.title === '普通标题'), true);
    const startedAt = performance.now();
    reader.searchFeed('local', { query: 'CranmerToken' });
    assert.ok(performance.now() - startedAt < 300);
    feed.startFeedSearchIndex();
    assert.equal(feed.feedSearchIndexStatus().done, true);
  } finally {
    opened.close();
  }
});

test('feed search backfill starts after the caller returns', async () => {
  const opened = openStore();
  try {
    const feed = opened.store.repositories.feed;
    feed.startFeedSearchIndex();
    assert.equal(feed.feedSearchIndexStatus().done, false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(feed.feedSearchIndexStatus().done, true);
    assert.equal(feed.feedSearchIndexStatus().rows, 0);
  } finally {
    opened.close();
  }
});

test('ready youtube body drops leftover english without rewriting the episode', () => {
  const body = "主持人：Kai's power tools really cool.\n主持人：the model fit by it. 是的。\n每个人都可以成为 a maker";
  const service = createYoutubePodcastService({
    repository: {
      getReady() {
        return {
          videoId: 'abc12345678',
          title: '原标题',
          displayTitle: '中文标题',
          articleStatus: 'ready',
          body,
        };
      },
    },
    store: { listOpenJobs() { return []; } },
    configPath: path.join(os.tmpdir(), 'missing-youtube-podcasts.json'),
  });
  const episode = service.get('local', 'abc12345678');
  assert.equal(episode.body.includes("Kai's power tools"), false);
  assert.equal(episode.body.includes('the model fit by it'), false);
  assert.match(episode.body, /主持人：是的。/);
  assert.match(episode.body, /每个人都可以成为 a maker/);
  assert.equal(service.get('local', 'abc12345678').body, episode.body);
});

test('searchable posts land on the following feed and search shows the saved translation', async () => {
  const opened = openStore();
  try {
    const feed = opened.store.repositories.feed;
    const forYou = feed.upsertSourceAccount({
      workspaceId: 'local', provider: 'x', externalId: 'x:home:for-you', displayName: 'For you',
    });
    const loose = feed.upsertSourceAccount({
      workspaceId: 'local', provider: 'x', externalId: 'x:misc', displayName: 'Loose',
    });
    feed.ensureSubscription({
      workspaceId: 'local', sourceAccountId: forYou.id, enabled: true, refreshIntervalMinutes: 30,
    });
    const publishedAt = Date.parse('2026-10-16T14:43:00Z');
    const save = (externalId, accountId, title, body, metadata) => {
      const capture = feed.saveCapture({
        workspaceId: 'local',
        provider: 'x',
        externalId,
        sourceAccountId: accountId,
        sourceUrl: `https://x.com/i/status/${externalId}`,
        title,
        contentHash: hash(externalId),
        publishedAt,
        authorNativeId: metadata.authorProfile?.nativeId || null,
        metadata,
      });
      return feed.saveContentItem({
        workspaceId: 'local',
        captureId: capture.id,
        originType: 'subscription',
        contentType: 'post',
        title,
        body,
        summary: title,
        sourceUrl: capture.sourceUrl,
        authorName: metadata.authorProfile?.name || '别人',
        publishedAt,
      });
    };
    const plain = save('9002', forYou.id, '普通帖', '推荐页里的普通帖', { authorHandle: 'other' });
    const video = save('9001', forYou.id, '视频帖', '这是一条视频', { authorHandle: 'other' });
    const talk = save(TWEET, loose.id, 'Here is the full talk', 'Here is the full talk', {
      authorHandle: 'MilesCranmer',
      filterReason: 'fallback-manual',
      authorProfile: {
        authorId: 'x:382008009',
        platform: 'x',
        nativeId: '382008009',
        handle: 'MilesCranmer',
        name: 'Miles Cranmer',
        kind: 'person',
      },
    });
    opened.store.repositories.xVideos.savePost({
      workspaceId: 'local',
      tweetId: '9001',
      videoId: 'vid-1',
      contentItemId: video.id,
      sourceUrl: 'https://x.com/i/status/9001',
    });
    feed.saveTranslations({
      workspaceId: 'local',
      itemId: talk.id,
      targetLang: 'zh',
      sourceHash: hash('Here is the full talk'),
      translatedText: '以下是演讲全文：',
      engine: 'test',
    });
    const reader = createFeedService({
      legacyRepository: { listPosts() { return []; }, getPost() { return null; } },
      feedRepository: feed,
      sourcePort: { findByProvider() { return null; }, persistence() { return null; }, async read() { return { data: null }; } },
    });
    const before = repairXFollowingFeed({ feedRepository: feed, workspaceId: 'local', dryRun: true });
    assert.equal(before.status, 'dry-run');
    assert.equal(before.moved, 0);
    assert.equal(before.examples.some((row) => row.externalId === TWEET), true);
    assert.equal(before.examples.some((row) => row.externalId === '9001'), true);
    assert.equal(before.examples.some((row) => row.externalId === '9002'), false);
    assert.equal(feed.findSourceAccount('local', 'x', 'x:home:following'), null);
    assert.equal(feed.getCapture('local', 'x', TWEET).sourceAccountId, loose.id);
    assert.equal(feed.getCapture('local', 'x', TWEET).title, 'Here is the full talk');
    const moved = repairXFollowingFeed({ feedRepository: feed, workspaceId: 'local' });
    assert.equal(moved.moved, 2);
    const following = feed.findSourceAccount('local', 'x', 'x:home:following');
    const subscription = feed.findSubscriptionBySource('local', following.id);
    assert.equal(feed.getCapture('local', 'x', TWEET).sourceAccountId, following.id);
    assert.equal(feed.getCapture('local', 'x', TWEET).title, 'Here is the full talk');
    assert.equal(feed.getCapture('local', 'x', '9001').sourceAccountId, following.id);
    assert.equal(feed.getCapture('local', 'x', '9001').title, '视频帖');
    assert.equal(feed.getCapture('local', 'x', '9002').sourceAccountId, forYou.id);
    assert.equal(plain.id.length > 0, true);
    const listed = feed.listContentItemsByProvider('local', 'x', { sourceExternalId: 'x:home:following', limit: 20 });
    assert.equal(listed.some((row) => row.externalId === TWEET && row.publishedAt === publishedAt), true);
    const hit = reader.searchFeed('local', { query: 'Cranmer', platform: 'x' }).find((row) => row.id === `x:${TWEET}`);
    assert.equal(hit.subscriptionId, subscription.id);
    assert.match(hit.translation.text, /以下是演讲全文：/);
    const authors = createAuthorService({
      authorRepository: opened.store.repositories.authors,
      feedRepository: feed,
    });
    const page = authors.items('local', 'x:382008009', { read: 'unread' });
    assert.match(page.items.find((row) => row.externalId === TWEET).preview, /以下是演讲全文：/);
    feed.saveCapture({
      workspaceId: 'local',
      provider: 'x',
      externalId: TWEET,
      sourceAccountId: forYou.id,
      sourceUrl: `https://x.com/MilesCranmer/status/${TWEET}`,
      title: 'Here is the full talk',
      contentHash: hash(`${TWEET}-again`),
      publishedAt,
      metadata: { authorHandle: 'MilesCranmer', filterReason: 'fallback-manual' },
    });
    assert.equal(feed.getCapture('local', 'x', TWEET).sourceAccountId, following.id);
    assert.equal(feed.getCapture('local', 'x', TWEET).title, 'Here is the full talk');
    feed.saveCapture({
      workspaceId: 'local',
      provider: 'x',
      externalId: TWEET,
      sourceAccountId: null,
      sourceUrl: `https://x.com/MilesCranmer/status/${TWEET}`,
      title: 'Here is the full talk',
      contentHash: hash(`${TWEET}-empty`),
      publishedAt,
      metadata: { authorHandle: 'MilesCranmer' },
    });
    assert.equal(feed.getCapture('local', 'x', TWEET).sourceAccountId, following.id);
    feed.saveCapture({
      workspaceId: 'local',
      provider: 'x',
      externalId: '9002',
      sourceAccountId: following.id,
      sourceUrl: 'https://x.com/i/status/9002',
      title: '普通帖',
      contentHash: hash('9002-follow'),
      publishedAt,
      metadata: { authorHandle: 'other' },
    });
    assert.equal(feed.getCapture('local', 'x', '9002').sourceAccountId, following.id);
    assert.equal(feed.getCapture('local', 'x', '9002').title, '普通帖');
  } finally {
    opened.close();
  }
});
