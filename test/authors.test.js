import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createStore } from '../packages/database/src/index.js';
import { latestSchemaVersion } from '../packages/database/src/migrations.js';
import { createAuthorService } from '../packages/domain/src/author-service.js';
import { attributeXAuthor, authorCaptureFields } from '../packages/domain/src/authors.js';
import { dynamicFeedItem, ingestBilibiliDynamics } from '../packages/domain/src/bilibili-dynamics.js';
import { buildTweetExtractExpression } from '../packages/connectors/src/x/home-browser.js';
import { tweetToFeedItem } from '../packages/connectors/src/x/home-timeline.js';
import { mapLivenewsItem, mapTimelineStatus, xueqiuToFeedItem } from '../packages/connectors/src/xueqiu/index.js';
import { backfillAuthorBatch } from '../scripts/backfill-authors.mjs';
import { recomputeAuthorStats } from '../scripts/recompute-author-stats.mjs';

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function openStore() {
  return createStore(':memory:');
}

function saveAuthorItem(feed, { provider = 'xueqiu', externalId, nativeId, name, handle, kind = '', publishedAt, title }) {
  const fields = authorCaptureFields(provider, {
    authorNativeId: nativeId,
    authorName: name,
    authorHandle: handle || name,
    authorKind: kind,
  });
  const capture = feed.saveCapture({
    workspaceId: 'local',
    provider,
    externalId,
    sourceUrl: `https://example.com/${externalId}`,
    title,
    contentHash: hash(`${externalId}:${nativeId}:${title}`),
    publishedAt,
    authorNativeId: fields?.authorNativeId || null,
    metadata: {
      authorHandle: handle || name || '',
      ...(fields ? { authorProfile: fields.authorProfile } : {}),
    },
  });
  return feed.saveContentItem({
    workspaceId: 'local',
    captureId: capture.id,
    originType: 'subscription',
    contentType: 'post',
    title,
    body: title,
    sourceUrl: `https://example.com/${externalId}`,
    authorName: name,
    publishedAt,
  });
}

test('migrations 77 and 78 apply again without rewriting the database', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'authors-'));
  const file = path.join(dir, 'test.db');
  const store = createStore(file);
  try {
    assert.equal(store.getRuntimeStatus().schemaVersion, latestSchemaVersion());
    assert.ok(latestSchemaVersion() >= 78);
  } finally {
    store.close();
  }
  const database = new Database(file);
  const names = new Map(database.prepare('SELECT version, name FROM schema_migrations').all()
    .map((row) => [row.version, row.name]));
  assert.equal(names.get(77), 'authors');
  assert.equal(names.get(78), 'author_stats');
  database.prepare('DELETE FROM schema_migrations WHERE version IN (77, 78)').run();
  database.close();
  const reopened = createStore(file);
  try {
    assert.equal(reopened.getRuntimeStatus().schemaVersion, latestSchemaVersion());
    const columns = reopened.repositories.feed.getCapture('local', 'x', 'missing');
    assert.equal(columns, null);
    const author = reopened.repositories.authors.getAuthor('local', 'x:1');
    assert.equal(author, null);
  } finally {
    reopened.close();
  }
});

test('capture, read and read-all keep author stats consistent', async () => {
  const store = openStore();
  try {
    const now = Date.now();
    const first = saveAuthorItem(store.repositories.feed, {
      externalId: 'a', nativeId: '42', name: '甲', publishedAt: now - 2_000, title: '第一条',
    });
    saveAuthorItem(store.repositories.feed, {
      externalId: 'b', nativeId: '42', name: '甲', publishedAt: now - 1_000, title: '第二条',
    });
    const authors = store.repositories.authors;
    const before = authors.getAuthor('local', 'xueqiu:42');
    assert.equal(before.unreadCount, 2);
    assert.equal(before.totalCount, 2);
    assert.equal(before.recent30dCount, 2);
    store.repositories.feed.upsertUserItemState({
      workspaceId: 'local', contentItemId: first.id, isRead: true,
    });
    const read = authors.getAuthor('local', 'xueqiu:42');
    assert.equal(read.unreadCount, 1);
    assert.equal(read.hasUnread, true);
    store.repositories.feed.upsertUserItemState({
      workspaceId: 'local', contentItemId: first.id, isRead: false,
    });
    assert.equal(authors.getAuthor('local', 'xueqiu:42').unreadCount, 2);
    const service = createAuthorService({
      authorRepository: authors,
      feedRepository: store.repositories.feed,
    });
    const unreadPage = service.items('local', 'xueqiu:42', { read: 'unread' });
    assert.equal(unreadPage.items.length, 2);
    assert.equal(unreadPage.nextCursor, '');
    let extra = false;
    const result = await service.readAll('local', 'xueqiu:42', {
      batchSize: 1,
      yield: async () => {
        if (extra) return;
        extra = true;
        saveAuthorItem(store.repositories.feed, {
          externalId: 'c', nativeId: '42', name: '甲', publishedAt: now + 60_000, title: '更晚的一条',
        });
      },
    });
    assert.ok(result.changed >= 2);
    const after = authors.getAuthor('local', 'xueqiu:42');
    assert.equal(after.unreadCount, 1);
    assert.equal(after.totalCount, 3);
    assert.ok(after.latestUnreadAt > result.capAt);
  } finally {
    store.close();
  }
});

test('author list pages with a cursor and keeps followed authors above the activity threshold', () => {
  const store = openStore();
  try {
    const now = Date.now();
    const authors = store.repositories.authors;
    for (const [nativeId, shift] of [['1', 0], ['2', 1_000], ['3', 2_000]]) {
      saveAuthorItem(store.repositories.feed, {
        externalId: `${nativeId}-1`, nativeId, name: `作者${nativeId}`, publishedAt: now - shift, title: '一',
      });
      saveAuthorItem(store.repositories.feed, {
        externalId: `${nativeId}-2`, nativeId, name: `作者${nativeId}`, publishedAt: now - shift - 10, title: '二',
      });
    }
    saveAuthorItem(store.repositories.feed, {
      externalId: 'quiet', nativeId: '9', name: '冷门', publishedAt: now, title: '只有一条',
    });
    saveAuthorItem(store.repositories.feed, {
      provider: 'xueqiu', externalId: 'live', nativeId: '7x24', name: '雪球7x24', kind: 'system', publishedAt: now, title: '快讯',
    });
    saveAuthorItem(store.repositories.feed, {
      provider: 'xueqiu', externalId: 'live-2', nativeId: '7x24', name: '雪球7x24', kind: 'system', publishedAt: now, title: '快讯二',
    });
    const followed = authors.setFollow('local', 'xueqiu:3', true);
    assert.equal(followed.followed, true);
    const first = authors.listAuthors({ workspaceId: 'local', limit: 1 });
    assert.equal(first.followed.length, 1);
    assert.equal(first.followed[0].authorId, 'xueqiu:3');
    assert.equal(first.others.length, 1);
    assert.equal(first.hasMore, true);
    assert.ok(first.others.every((row) => row.authorId !== 'xueqiu:9'));
    assert.ok(first.followed.every((row) => row.kind !== 'system'));
    const cursor = {
      hasUnread: first.others[0].hasUnread ? 1 : 0,
      latestUnreadAt: first.others[0].latestUnreadAt,
      latestItemAt: first.others[0].latestItemAt,
      authorId: first.others[0].authorId,
    };
    const second = authors.listAuthors({ workspaceId: 'local', cursor, limit: 1 });
    assert.equal(second.followed.length, 0);
    assert.equal(second.others.length, 1);
    assert.notEqual(second.others[0].authorId, first.others[0].authorId);
    const counts = authors.countAuthors('local');
    assert.equal(counts.xueqiu, 3);
    assert.equal(counts.all, 3);
    authors.setFollow('local', 'xueqiu:3', false);
    assert.equal(authors.getAuthor('local', 'xueqiu:3').followed, false);
    const service = createAuthorService({
      authorRepository: authors,
      feedRepository: store.repositories.feed,
    });
    const page = service.list({ workspaceId: 'local' });
    assert.equal(page.followed.length, 0);
    assert.ok(page.others.length <= 50);
    const old = now - 40 * 24 * 60 * 60 * 1000;
    saveAuthorItem(store.repositories.feed, {
      externalId: 'old-1', nativeId: '8', name: '旧作者', publishedAt: old, title: '旧一',
    });
    saveAuthorItem(store.repositories.feed, {
      externalId: 'old-2', nativeId: '8', name: '旧作者', publishedAt: old + 1, title: '旧二',
    });
    const stale = authors.listAuthors({ workspaceId: 'local', limit: 50 });
    assert.ok(stale.others.every((row) => row.authorId !== 'xueqiu:8'));
    authors.setFollow('local', 'xueqiu:8', true);
    const kept = authors.listAuthors({ workspaceId: 'local', limit: 50 });
    assert.ok(kept.followed.some((row) => row.authorId === 'xueqiu:8'));
  } finally {
    store.close();
  }
});

test('reposts count under the reposter and provisional authors merge', () => {
  const status = mapTimelineStatus({
    id: 88,
    text: '<p>先看仓位</p>',
    created_at: 1_700_000_000_000,
    user: { id: 123, screen_name: '转发者', followers_count: 9, profile_image_url: '//xqimg.imedao.com/a.png' },
    retweeted_status: { user: { id: 999, screen_name: '原作者' }, description: '原帖' },
  }, 'following');
  const item = xueqiuToFeedItem(status);
  assert.equal(item.authorNativeId, '123');
  assert.equal(item.authorAvatar, 'https://xqimg.imedao.com/a.png');
  assert.equal(mapLivenewsItem({ id: 1, text: '快讯' }).author_kind, 'system');
  const repost = attributeXAuthor({
    author_handle: 'alice', author_rest_id: '1', reposter_handle: 'bob', reposter_rest_id: '2',
  });
  assert.equal(repost.handle, 'bob');
  assert.equal(repost.restId, '2');
  const tweet = tweetToFeedItem({
    tweet_id: '55', author_handle: 'alice', author_rest_id: '1', author_name: 'Alice',
    reposter_handle: 'bob', reposter_rest_id: '2', reposter_name: 'Bob', text: '转发了',
  });
  assert.equal(tweet.authorNativeId, '2');
  assert.equal(tweet.authorName, 'Bob');
  const provisional = tweetToFeedItem({ tweet_id: '56', author_handle: 'cara', text: '没有 rest id' });
  assert.equal(provisional.authorNativeId, '@cara');
  assert.equal(provisional.authorProvisional, true);
  assert.match(buildTweetExtractExpression(), /author_rest_id/);
  assert.match(buildTweetExtractExpression(), /socialContext/);

  const store = openStore();
  try {
    const now = Date.now();
    saveAuthorItem(store.repositories.feed, {
      externalId: 'p1', nativeId: '@球友甲', name: '球友甲', publishedAt: now - 1_000, title: '临时',
    });
    saveAuthorItem(store.repositories.feed, {
      externalId: 'p2', nativeId: '123', name: '球友甲', publishedAt: now, title: '实名',
    });
    const merged = store.repositories.authors.getAuthor('local', 'xueqiu:@球友甲');
    assert.equal(merged.authorId, 'xueqiu:123');
    assert.equal(merged.totalCount, 2);
    assert.equal(merged.provisional, false);
    const xFirst = saveAuthorItem(store.repositories.feed, {
      provider: 'x', externalId: 't1', nativeId: '5', name: '旧名', handle: 'oldname', publishedAt: now, title: '帖',
    });
    store.repositories.feed.noteCaptureAuthor({
      workspaceId: 'local',
      provider: 'x',
      externalId: 't1',
      authorNativeId: '5',
      authorProfile: authorCaptureFields('x', { authorNativeId: '5', authorHandle: 'newname', authorName: '新名' }).authorProfile,
      title: '帖',
      publishedAt: now,
    });
    const renamed = store.repositories.authors.getAuthor('local', 'x:5');
    assert.equal(renamed.handle, 'newname');
    assert.ok(renamed.aliases.includes('oldname'));
    assert.equal(xFirst.id.length > 0, true);
    store.repositories.feed.saveTranslations({
      workspaceId: 'local', itemId: xFirst.id, targetLang: 'zh', sourceHash: hash('帖'), translatedText: '中文预览',
    });
    assert.equal(store.repositories.authors.getAuthor('local', 'x:5').latestTitleZh, '中文预览');
    const older = saveAuthorItem(store.repositories.feed, {
      provider: 'x', externalId: 't0', nativeId: '5', name: '新名', handle: 'newname', publishedAt: now - 5_000, title: '更早',
    });
    store.repositories.feed.saveTranslations({
      workspaceId: 'local', itemId: older.id, targetLang: 'zh', sourceHash: hash('更早'), translatedText: '不该替换最新预览',
    });
    assert.equal(store.repositories.authors.getAuthor('local', 'x:5').latestTitleZh, '中文预览');
  } finally {
    store.close();
  }
});

test('bilibili dynamics use the outer mid and backfill is idempotent', async () => {
  const item = dynamicFeedItem({
    id: '900',
    author: '转发人',
    authorMid: '100',
    text: '看这个',
    pubTs: 1_700_000_000,
    orig: { author: '原作者', authorMid: '200', text: '原动态' },
  });
  assert.equal(item.externalId, 'dyn:900');
  assert.equal(item.authorNativeId, '100');
  assert.match(item.body, /原作者/);
  const dir = mkdtempSync(path.join(tmpdir(), 'authors-backfill-'));
  const file = path.join(dir, 'test.db');
  const store = createStore(file);
  try {
    ingestBilibiliDynamics(store.repositories.feed, 'local', [{
      id: '900', author: '转发人', authorMid: '100', text: '看这个', pubTs: Math.floor(Date.now() / 1000),
    }, {
      id: '901', author: '转发人', authorMid: '100', text: '再看', pubTs: Math.floor(Date.now() / 1000),
    }]);
    assert.equal(store.repositories.authors.getAuthor('local', 'bilibili:100').totalCount, 2);
  } finally {
    store.close();
  }
  const database = new Database(file);
  const once = backfillAuthorBatch(database, { afterRowid: 0 });
  const twice = backfillAuthorBatch(database, { afterRowid: 0 });
  assert.ok(once.rows >= 2);
  assert.equal(twice.linked, once.linked);
  database.close();
  const reopened = createStore(file);
  try {
    assert.equal(reopened.repositories.authors.getAuthor('local', 'bilibili:100').totalCount, 2);
    const stats = await recomputeAuthorStats(reopened.repositories.authors, 'local', { sleepMs: 0 });
    assert.ok(stats.total >= 1);
    assert.equal(reopened.repositories.authors.getAuthor('local', 'bilibili:100').totalCount, 2);
  } finally {
    reopened.close();
  }
});
