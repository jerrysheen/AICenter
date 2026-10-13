import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { createStore } from '../packages/database/src/index.js';
import { latestSchemaVersion } from '../packages/database/src/migrations.js';
import { createFeedService } from '../packages/domain/src/feed-service.js';
import { captureFeedLists, feedListSnapshotKey, FEED_TRENDFORCE_SNAPSHOT_KEY } from '../packages/runtime/src/web-snapshot-jobs.js';
import { packPreparedJson } from '../apps/web/src/http/prepared-slots.js';
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
  const feed = await app.services.feed.getExternalFeed('trendforce', { platform: 'trendforce', feed: 'public', fields: 'list' });
  app.preparedSlots.publish(FEED_TRENDFORCE_SNAPSHOT_KEY, packPreparedJson(JSON.stringify({ ok: true, feed })));
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

const FEED_INDEXES = [
  'idx_captures_feed_sort',
  'idx_captures_provider_captured',
  'idx_captures_feed_filter',
  'idx_content_items_capture_cover',
  'idx_user_item_states_feed_flags',
];

test('a database stopped at schema 57 applies runtime snapshots then feed indexes', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-schema-57-'));
  const file = path.join(directory, 'ai-center.db');
  const seeded = createStore(file);
  seeded.close();
  const rewound = new Database(file);
  rewound.exec(`
    DROP TABLE IF EXISTS runtime_snapshots;
    DROP INDEX IF EXISTS idx_captures_feed_sort;
    DROP INDEX IF EXISTS idx_captures_provider_captured;
    DROP INDEX IF EXISTS idx_captures_feed_filter;
    DROP INDEX IF EXISTS idx_content_items_capture_cover;
    DROP INDEX IF EXISTS idx_user_item_states_feed_flags;
    DELETE FROM schema_migrations WHERE version > 57;
    PRAGMA user_version = 57;
  `);
  assert.equal(rewound.pragma('user_version', { simple: true }), 57);
  assert.equal(rewound.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtime_snapshots'`).get(), undefined);
  rewound.close();

  const upgraded = createStore(file);
  try {
    assert.equal(latestSchemaVersion(), 66);
    assert.equal(upgraded.getRuntimeStatus().schemaVersion, 66);
  } finally {
    upgraded.close();
  }

  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    assert.equal(database.pragma('user_version', { simple: true }), 66);
    const rows = database.prepare(`
      SELECT version, name, applied_at FROM schema_migrations WHERE version >= 57 ORDER BY version
    `).all();
    assert.deepEqual(rows.map((row) => [row.version, row.name]), [
      [57, 'api_access_tokens'],
      [58, 'runtime_snapshots'],
      [59, 'feed_provider_page_indexes'],
      [60, 'tree_index_columns'],
      [61, 'gemini_model_pool_cursor'],
      [62, 'model_usage_http_status'],
      [64, 'capture_feed_filter_columns'],
      [65, 'outbox_payload_bytes'],
      [66, 'outbox_sse_data'],
    ]);
    assert.ok(database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'gemini_model_cursors'`).get());
    assert.equal(database.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('model_usage_index') WHERE name = 'http_status'`).get().n, 1);
    assert.ok(rows[1].applied_at <= rows[2].applied_at);
    assert.ok(database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtime_snapshots'`).get());
    for (const name of FEED_INDEXES) {
      assert.ok(database.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`).get(name), name);
    }
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('list page skips capture blobs and a second read reuses the cached count', async () => {
  const store = createStore(':memory:');
  try {
    const feed = store.repositories.feed;
    const source = feed.upsertSourceAccount({
      workspaceId: 'local', provider: 'x', externalId: 'x:home', displayName: 'X',
    });
    const padding = 'M'.repeat(8_000);
    const startedInsert = performance.now();
    for (let index = 0; index < 400; index += 1) {
      const externalId = `fat${index}`;
      const capture = feed.saveCapture({
        workspaceId: 'local', provider: 'x', externalId, sourceAccountId: source.id,
        sourceUrl: `https://x.com/example/status/${index}`, contentHash: hash(externalId), capturedAt: 10_000 + index,
        metadata: { authorHandle: 'ada', padding },
      });
      feed.saveContentItem({
        workspaceId: 'local', captureId: capture.id, originType: 'subscription', contentType: 'post',
        title: `标题 ${externalId}`, body: padding, summary: `摘要 ${externalId}`,
        sourceUrl: `https://x.com/example/status/${index}`, authorName: 'Ada', publishedAt: 10_000 + index,
      });
    }
    const service = createFeedService({
      legacyRepository: {},
      feedRepository: feed,
      sourcePort: {
        findByProvider: () => ({ id: 'content.x' }),
        persistence: () => ({ providerId: 'x', sourceAccount: { externalId: 'x:home' }, emptyNote: '' }),
        read: async () => { throw new Error('must not refresh'); },
      },
      normalizedArticlePort: {
        normalizedArticles() { throw new Error('list must not load article nodes'); },
      },
    });
    const insertMs = performance.now() - startedInsert;
    const firstAt = performance.now();
    const page = await service.getExternalFeed('x', { feed: 'following', limit: 12, fields: 'list' });
    const firstMs = performance.now() - firstAt;
    const secondAt = performance.now();
    const again = await service.getExternalFeed('x', { feed: 'following', limit: 12, fields: 'list' });
    const secondMs = performance.now() - secondAt;
    assert.equal(page.items.length, 12);
    assert.equal(page.items[0].authorHandle, 'ada');
    assert.equal(JSON.stringify(page).includes(padding), false);
    assert.equal(again.total, page.total);
    assert.ok(secondMs <= firstMs + 30, `cached count page ${secondMs.toFixed(1)}ms slower than first ${firstMs.toFixed(1)}ms`);
    const captured = await captureFeedLists({
      feedService: service,
      repository: store.repositories.runtimeSnapshots,
    });
    const body = store.repositories.runtimeSnapshots.readSnapshotBody('local', 'feed-list-x');
    assert.equal(captured.pages >= 1, true);
    assert.equal(feedListSnapshotKey('x', { feed: 'following', limit: 12, fields: 'list' }), 'feed-list-x');
    assert.equal(feedListSnapshotKey('xueqiu', { feed: 'featured', limit: 12, fields: 'list' }), 'feed-list-xueqiu-featured');
    assert.equal(feed.backfillFeedFilterColumns(10), 0);
    assert.match(body.body, /^\{"ok":true,"feed":/);
    console.log(JSON.stringify({
      insertMs: Math.round(insertMs),
      rows: 400,
      metadataBytes: 8000,
      firstListMs: Number(firstMs.toFixed(1)),
      secondListMs: Number(secondMs.toFixed(1)),
      snapshotBytes: Buffer.byteLength(body.body),
    }));
  } finally {
    store.close();
  }
});
