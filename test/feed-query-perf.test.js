import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createStore } from '../packages/database/src/index.js';
import { createFeedService } from '../packages/domain/src/feed-service.js';
import { createMediaIngestionService } from '../packages/domain/src/media-ingestion-service.js';
import { createAiCenterServer } from '../apps/web/src/server.js';

const BODY = `${'公开市场评论与经营数据。'.repeat(80)} TRENDFORCE_FULL_BODY_MARKER ${'正文'.repeat(200)}`;

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function feedService(store) {
  const feed = store.repositories.feed;
  const source = feed.upsertSourceAccount({
    workspaceId: 'local', provider: 'x', externalId: 'x:home', displayName: 'X',
  });
  for (let index = 0; index < 240; index += 1) {
    const externalId = `p${String(index).padStart(3, '0')}`;
    const capture = feed.saveCapture({
      workspaceId: 'local', provider: 'x', externalId, sourceAccountId: source.id,
      sourceUrl: `https://x.com/example/status/${index}`, contentHash: hash(externalId), capturedAt: 5_000 + index,
      metadata: index % 17 === 0 ? { filterMode: 'enforce', filterDecision: 'DROP', filterApplied: 1 } : {},
    });
    const item = feed.saveContentItem({
      workspaceId: 'local', captureId: capture.id, originType: 'subscription', contentType: 'post',
      title: `标题 ${externalId}`, body: `${BODY} ${externalId}`, summary: `摘要 ${externalId}`,
      sourceUrl: `https://x.com/example/status/${index}`, authorName: 'Example', publishedAt: 5_000 + index,
    });
    if (index === 239) feed.upsertUserItemState({ workspaceId: 'local', contentItemId: item.id, isRead: true });
    if (index === 1) feed.upsertUserItemState({ workspaceId: 'local', contentItemId: item.id, isHidden: true });
  }
  return createFeedService({
    legacyRepository: {},
    feedRepository: feed,
    taggingRepository: store.repositories.tagging,
    sourcePort: {
      findByProvider: () => ({ id: 'content.x' }),
      persistence: () => ({ providerId: 'x', sourceAccount: { externalId: 'x:home' }, emptyNote: '' }),
      read: async () => { throw new Error('perf test must not refresh'); },
    },
    normalizedArticlePort: { normalizedArticles: () => new Map() },
  });
}

test('provider feed page uses the sort index and stays under 300ms', async () => {
  const store = createStore(':memory:');
  try {
    const service = feedService(store);
    const plan = store.repositories.feed.explainProviderFeed('local', 'x', {
      sourceExternalId: 'x:home', includeLowValue: true, limit: 12,
    }).join('\n');
    assert.match(plan, /idx_captures_feed_sort/);
    assert.doesNotMatch(plan, /SCAN (?:c |ci |content_items|captures)/);
    const started = performance.now();
    const page = await service.getExternalFeed('x', { feed: 'for-you', limit: 12, fields: 'list' });
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 300, `feed page took ${elapsed.toFixed(1)}ms\n${plan}`);
    assert.equal(page.items.length, 12);
    assert.equal(page.items.some((item) => item.isRead), false);
    assert.equal(page.items.some((item) => item.externalId === 'p001'), false);
    assert.equal(page.items[0].externalId, 'p238');
    assert.equal(Object.hasOwn(page.items[0], 'body'), false);
    assert.equal(JSON.stringify(page).includes('TRENDFORCE_FULL_BODY_MARKER'), false);
    const wide = await service.getExternalFeed('x', { feed: 'for-you', limit: 50, fields: 'full' });
    assert.match(wide.items[0].body, /TRENDFORCE_FULL_BODY_MARKER/);
    assert.equal(wide.items.some((item) => item.isRead), false);
    assert.equal(page.total, 239);
  } finally {
    store.close();
  }
});

test('trendforce list omits article text and answers If-None-Match', async () => {
  const store = createStore(':memory:');
  const media = store.repositories.media;
  const now = Date.parse('2026-10-13T00:00:00Z');
  const externalId = 'trendforce:spot';
  const bodyHash = hash(externalId);
  media.upsertEntry({
    workspaceId: 'local', externalId, sourceKey: 'trendforce', publisherKey: 'trendforce', publisherName: 'TrendForce',
    channel: 'tech', canonicalUrl: 'https://www.trendforce.com/price/spot', title: '现货报价', summary: '列表摘要',
    publishedAt: now, publishedAtRaw: '', contentLevel: 'full', contentHash: bodyHash, revision: 1,
    status: 'indexed', observedAt: now, createdAt: now, updatedAt: now, bodyHash,
  });
  media.saveSnapshot({
    workspaceId: 'local', externalId, revision: 1, bodyHash, truncated: false, contentLevel: 'full', observedAt: now,
    bodyText: BODY,
    article: { paragraphs: [{ id: 'p0001', kind: 'paragraph', text: BODY }] },
  });
  const app = createAiCenterServer({ store, host: '127.0.0.1', port: 0 });
  const address = await app.listen();
  try {
    const first = await fetch(`${address.localUrl}/api/v1/feed/trendforce`);
    assert.equal(first.status, 200);
    const etag = first.headers.get('etag');
    assert.match(etag || '', /^W\/"/);
    const payload = await first.json();
    const listed = (payload.feed?.items || []).find((item) => item.externalId === externalId);
    assert.ok(listed);
    assert.equal(listed.body, '');
    assert.equal(listed.detail, 'list');
    assert.equal(listed.paragraphs, undefined);
    assert.equal(JSON.stringify(payload).includes('TRENDFORCE_FULL_BODY_MARKER'), false);
    const again = await fetch(`${address.localUrl}/api/v1/feed/trendforce`, { headers: { 'If-None-Match': etag } });
    assert.equal(again.status, 304);
    assert.equal(await again.text(), '');
    const article = await fetch(`${address.localUrl}/api/v1/feed/media/article?externalId=${encodeURIComponent(externalId)}`);
    assert.equal(article.status, 200);
    const detail = await article.json();
    assert.match(detail.item.body, /TRENDFORCE_FULL_BODY_MARKER/);
  } finally {
    await app.close();
    store.close();
  }
});
