import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../packages/database/src/index.js';
import { createAuthorService } from '../packages/domain/src/author-service.js';
import { createFeedService } from '../packages/domain/src/feed-service.js';
import { ensureXVideoFeedPost, repairXFollowingFeed } from '../packages/domain/src/x-video-feed.js';
import { repairFollowingFeed, rollbackFollowingFeed } from '../scripts/repair-x-following-feed.mjs';
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
  } finally {
    opened.close();
  }
});

function keepMeta(extra = {}) {
  return {
    filterMode: 'enforce',
    filterDecision: 'KEEP',
    filterApplied: true,
    filterRule: 'all-three-0.60',
    ...extra,
  };
}

const CRANMER_PROFILE = {
  authorId: 'x:382008009',
  platform: 'x',
  nativeId: '382008009',
  handle: 'MilesCranmer',
  name: 'Miles Cranmer',
  kind: 'person',
};

function saveXPost(feed, { externalId, sourceAccountId, title, body, publishedAt, metadata, authorName = '别人' }) {
  const capture = feed.saveCapture({
    workspaceId: 'local',
    provider: 'x',
    externalId,
    sourceAccountId,
    sourceUrl: `https://x.com/i/status/${externalId}`,
    title,
    contentHash: hash(externalId),
    publishedAt,
    authorNativeId: metadata.authorProfile?.nativeId || null,
    metadata,
  });
  feed.saveContentItem({
    workspaceId: 'local',
    captureId: capture.id,
    originType: 'subscription',
    contentType: 'post',
    title,
    body,
    sourceUrl: capture.sourceUrl,
    authorName,
    publishedAt,
  });
  return capture;
}

test('a searchable Cranmer post joins the following feed and search uses the saved translation', () => {
  const opened = openStore();
  try {
    const feed = opened.store.repositories.feed;
    const forYou = feed.upsertSourceAccount({
      workspaceId: 'local',
      provider: 'x',
      externalId: 'x:home:for-you',
      displayName: 'For you',
    });
    feed.ensureSubscription({ workspaceId: 'local', sourceAccountId: forYou.id, enabled: true });
    const loose = feed.upsertSourceAccount({
      workspaceId: 'local',
      provider: 'x',
      externalId: 'x:loose',
      displayName: 'Loose',
    });
    const authorPage = feed.upsertSourceAccount({
      workspaceId: 'local',
      provider: 'x',
      externalId: 'x:author:382008009',
      displayName: 'Author',
      metadata: { sourceInput: { feed: 'author' } },
    });
    const search = feed.upsertSourceAccount({
      workspaceId: 'local',
      provider: 'x',
      externalId: 'x:search:cranmer',
      displayName: 'Search',
      metadata: { sourceId: 'content.x.search', sourceInput: { feed: 'search' } },
    });
    const publishedAt = Date.parse('2026-10-16T14:43:00Z');
    saveXPost(feed, {
      externalId: '9002', sourceAccountId: forYou.id, title: '普通帖', body: '推荐页里的普通帖',
      publishedAt: publishedAt + 60_000, authorName: '别人',
      metadata: keepMeta({ authorHandle: 'other' }),
    });
    const capture = saveXPost(feed, {
      externalId: TWEET, sourceAccountId: loose.id, title: 'Here is the full talk', body: 'Here is the full talk',
      publishedAt, authorName: 'Miles Cranmer',
      metadata: keepMeta({
        authorHandle: 'MilesCranmer',
        authorProfile: CRANMER_PROFILE,
        filterReason: 'fallback-manual',
      }),
    });
    opened.store.repositories.authors.setFollow('local', 'x:382008009', true);
    saveXPost(feed, {
      externalId: '9003', sourceAccountId: authorPage.id, title: '作者页', body: '作者页里的帖',
      publishedAt: publishedAt + 120_000, authorName: 'Miles Cranmer',
      metadata: keepMeta({ authorHandle: 'MilesCranmer', authorProfile: CRANMER_PROFILE }),
    });
    saveXPost(feed, {
      externalId: '9004', sourceAccountId: search.id, title: '搜索', body: '搜索来的帖',
      publishedAt: publishedAt + 180_000, authorName: 'Miles Cranmer',
      metadata: keepMeta({ authorHandle: 'MilesCranmer', authorProfile: CRANMER_PROFILE, homeFeed: 'following' }),
    });
    const video = saveXPost(feed, {
      externalId: '9005', sourceAccountId: loose.id, title: '视频', body: '一条视频帖',
      publishedAt: publishedAt + 240_000, authorName: 'Miles Cranmer',
      metadata: keepMeta({ authorHandle: 'MilesCranmer', authorProfile: CRANMER_PROFILE, xVideo: { tweetId: '9005', own: true } }),
    });
    opened.store.repositories.xVideos.savePost({
      workspaceId: 'local', tweetId: '9005', videoId: '9005:1', contentItemId: '', sourceUrl: video.sourceUrl,
    });
    saveXPost(feed, {
      externalId: '9006', sourceAccountId: loose.id, title: '关注标记', body: '来自关注时间线',
      publishedAt: publishedAt + 300_000, authorName: '陌生人',
      metadata: keepMeta({ authorHandle: 'stranger', homeFeed: 'following' }),
    });
    const strangerOnFollowing = saveXPost(feed, {
      externalId: '9007', sourceAccountId: forYou.id, title: '误放', body: '不该锁在关注源',
      publishedAt: publishedAt + 360_000, authorName: '陌生人',
      metadata: keepMeta({ authorHandle: 'stranger' }),
    });
    feed.saveTranslations({
      workspaceId: 'local', itemId: `x:${TWEET}`, targetLang: 'zh', sourceHash: hash('Here is the full talk'),
      translatedText: '以下是演讲全文：', engine: 'test',
    });
    const reader = createFeedService({
      legacyRepository: { listPosts() { return []; }, getPost() { return null; } },
      feedRepository: feed,
      sourcePort: { findByProvider() { return null; }, persistence() { return null; }, async read() { return { data: null }; } },
    });
    const before = repairXFollowingFeed({ feedRepository: feed, workspaceId: 'local', dryRun: true, limit: 20 });
    assert.equal(before.status, 'dry-run');
    assert.equal(before.moved, 0);
    const picked = before.examples.map((row) => row.externalId);
    assert.equal(picked.includes(TWEET), true);
    assert.equal(picked.includes('9006'), true);
    assert.equal(picked.includes('9002'), false);
    assert.equal(picked.includes('9003'), false);
    assert.equal(picked.includes('9004'), false);
    assert.equal(picked.includes('9005'), false);
    const moved = repairXFollowingFeed({ feedRepository: feed, workspaceId: 'local', limit: 20 });
    assert.equal(moved.moved, 2);
    const following = feed.findSourceAccount('local', 'x', 'x:home:following');
    const subscription = feed.findSubscriptionBySource('local', following.id);
    assert.equal(feed.getCapture('local', 'x', TWEET).sourceAccountId, following.id);
    assert.equal(feed.getCapture('local', 'x', '9006').sourceAccountId, following.id);
    assert.equal(feed.getCapture('local', 'x', TWEET).title, 'Here is the full talk');
    assert.equal(feed.getCapture('local', 'x', '9002').sourceAccountId, forYou.id);
    assert.equal(feed.getCapture('local', 'x', '9003').sourceAccountId, authorPage.id);
    assert.equal(feed.getCapture('local', 'x', '9004').sourceAccountId, search.id);
    assert.equal(feed.getCapture('local', 'x', '9005').sourceAccountId, loose.id);
    feed.placeCaptureOnAccount('local', 'x', '9007', following.id);
    assert.equal(feed.getCapture('local', 'x', '9007').sourceAccountId, following.id);
    feed.saveCapture({
      workspaceId: 'local', provider: 'x', externalId: '9007', sourceAccountId: forYou.id,
      sourceUrl: strangerOnFollowing.sourceUrl, title: '误放', contentHash: hash('9007'),
      publishedAt: publishedAt + 360_000,
      metadata: keepMeta({ authorHandle: 'stranger' }),
    });
    assert.equal(feed.getCapture('local', 'x', '9007').sourceAccountId, forYou.id);
    feed.saveCapture({
      workspaceId: 'local', provider: 'x', externalId: TWEET, sourceAccountId: loose.id,
      sourceUrl: capture.sourceUrl, title: 'Here is the full talk', contentHash: hash(TWEET), publishedAt,
      metadata: { authorHandle: 'MilesCranmer' },
    });
    assert.equal(feed.getCapture('local', 'x', TWEET).sourceAccountId, following.id);
    feed.saveCapture({
      workspaceId: 'local', provider: 'x', externalId: '9006', sourceAccountId: null,
      sourceUrl: 'https://x.com/i/status/9006', title: '关注标记', contentHash: hash('9006'),
      publishedAt: publishedAt + 300_000,
      metadata: { authorHandle: 'stranger' },
    });
    const marked = feed.getCapture('local', 'x', '9006');
    assert.equal(marked.sourceAccountId, following.id);
    assert.equal(marked.metadata.homeFeed, 'following');
    const listed = feed.listContentItemsByProvider('local', 'x', { sourceExternalId: 'x:home:following', limit: 20 });
    assert.equal(listed.some((row) => row.externalId === TWEET && row.publishedAt === publishedAt), true);
    const hit = reader.searchFeed('local', { query: 'Cranmer', platform: 'x' }).find((row) => row.externalId === TWEET);
    assert.equal(hit.subscriptionId, subscription.id);
    assert.match(hit.zhLead || hit.translation?.title || '', /以下是演讲全文：/);
    const authors = createAuthorService({ authorRepository: opened.store.repositories.authors, feedRepository: feed });
    const page = authors.items('local', 'x:382008009', { read: 'all' });
    assert.match(page.items.find((row) => row.externalId === TWEET).preview, /以下是演讲全文：/);
  } finally {
    opened.close();
  }
});

test('following repair writes a backup and rollback restores the old source', () => {
  const opened = openStore();
  const backupFile = path.join(os.tmpdir(), `following-backup-${process.pid}-${Date.now()}.json`);
  try {
    const feed = opened.store.repositories.feed;
    const loose = feed.upsertSourceAccount({
      workspaceId: 'local', provider: 'x', externalId: 'x:loose', displayName: 'Loose',
    });
    const publishedAt = Date.parse('2026-10-16T14:43:00Z');
    const capture = saveXPost(feed, {
      externalId: TWEET, sourceAccountId: loose.id, title: 'Here is the full talk', body: 'Here is the full talk',
      publishedAt, authorName: 'Miles Cranmer',
      metadata: keepMeta({ authorHandle: 'MilesCranmer', authorProfile: CRANMER_PROFILE }),
    });
    opened.store.repositories.authors.setFollow('local', 'x:382008009', true);
    const moved = repairFollowingFeed({
      store: opened.store, workspaceId: 'local', backupPath: backupFile,
    });
    assert.equal(moved.moved, 1);
    assert.equal(moved.backedUp, 1);
    const written = JSON.parse(readFileSync(backupFile, 'utf8'));
    assert.equal(written.posts[0].captureId, capture.id);
    assert.equal(written.posts[0].sourceAccountId, loose.id);
    const following = feed.findSourceAccount('local', 'x', 'x:home:following');
    assert.equal(feed.getCapture('local', 'x', TWEET).sourceAccountId, following.id);
    const restored = rollbackFollowingFeed({
      store: opened.store, workspaceId: 'local', backupPath: backupFile,
    });
    assert.equal(restored.restored, 1);
    assert.equal(feed.getCapture('local', 'x', TWEET).sourceAccountId, loose.id);
  } finally {
    rmSync(backupFile, { force: true });
    opened.close();
  }
});

test('a following sync stamps homeFeed and later syncs keep that source', async () => {
  const opened = openStore();
  try {
    const feed = opened.store.repositories.feed;
    const service = createFeedService({
      legacyRepository: { listPosts() { return []; }, getPost() { return null; } },
      feedRepository: feed,
      sourcePort: {
        persistence(_sourceId, sourceInput) {
          const following = sourceInput.feed === 'following';
          return {
            providerId: 'x',
            sourceAccount: {
              externalId: following ? 'x:home:following' : 'x:home:for-you',
              displayName: following ? '关注' : '推荐',
              profileUrl: 'https://x.com/home',
              authMode: 'browser-session',
              metadata: { sourceId: 'content.x.home', sourceInput: { feed: sourceInput.feed } },
            },
          };
        },
        async read() {
          return {
            data: {
              mode: 'ready',
              fetchedAt: Date.now(),
              items: [{
                externalId: '9100',
                sourceUrl: 'https://x.com/i/status/9100',
                title: '关注时间线',
                body: '这条来自关注时间线',
                summary: '这条来自关注时间线',
                publishedAt: Date.parse('2026-10-16T14:43:00Z'),
                authorHandle: '@someone',
                authorName: 'Someone',
              }],
            },
          };
        },
      },
    });
    const stats = await service.refreshPersistedSource({
      workspaceId: 'local', sourceId: 'content.x.home', sourceInput: { feed: 'following' },
    });
    assert.equal(stats.added, 1);
    const stamped = feed.getCapture('local', 'x', '9100');
    assert.equal(stamped.metadata.homeFeed, 'following');
    const forYou = feed.upsertSourceAccount({
      workspaceId: 'local', provider: 'x', externalId: 'x:home:for-you', displayName: '推荐',
    });
    feed.saveCapture({
      workspaceId: 'local', provider: 'x', externalId: '9100', sourceAccountId: forYou.id,
      sourceUrl: stamped.sourceUrl, title: '关注时间线', contentHash: stamped.contentHash,
      publishedAt: stamped.publishedAt, metadata: { authorHandle: '@someone' },
    });
    const kept = feed.getCapture('local', 'x', '9100');
    assert.equal(kept.sourceAccountId, stamped.sourceAccountId);
    assert.equal(kept.metadata.homeFeed, 'following');
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
