import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../packages/database/src/index.js';
import { createAuthorService } from '../packages/domain/src/author-service.js';
import { createFeedService } from '../packages/domain/src/feed-service.js';
import { ensureXVideoFeedPost } from '../packages/domain/src/x-video-feed.js';
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
