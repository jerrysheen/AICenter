import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { acceptTweetRestId, buildTweetExtractExpression } from '../packages/connectors/src/x/home-browser.js';
import { tweetToFeedItem } from '../packages/connectors/src/x/home-timeline.js';
import { createStore } from '../packages/database/src/index.js';
import { latestSchemaVersion } from '../packages/database/src/migrations.js';
import { createAuthorService } from '../packages/domain/src/author-service.js';
import { attributeXAuthor, authorCaptureFields, provisionalAuthorId } from '../packages/domain/src/authors.js';
import {
  dynamicFeedItem,
  ingestBilibiliDynamics,
  ingestBilibiliDynamicsFiltered,
  resolveDynamicsWorkspace,
} from '../packages/domain/src/bilibili-dynamics.js';
import {
  AUTHOR_STATS_BATCH,
  AUTHOR_STATS_JOB_TYPE,
  createAuthorStatsJobHandlers,
  ensureAuthorStatsSchedule,
  recomputeAuthorStatsJob,
} from '../packages/runtime/src/author-stats-job.js';
import { mapLivenewsItem, mapTimelineStatus, xueqiuToFeedItem } from '../packages/connectors/src/xueqiu/index.js';
import { backfillAuthorBatch, openBackfillDatabase } from '../scripts/backfill-authors.mjs';
import { importBilibiliDynamicsFile } from '../scripts/import-bilibili-dynamics.mjs';
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
    const readEvents = store.listEvents(0, 50, 'local')
      .filter((event) => event.name === 'feed.item-state.updated.v1' && event.payload?.isRead === true);
    assert.ok(readEvents.length >= 2);
    assert.equal(readEvents[0].aggregateType, 'user-item-state');
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
    assert.equal(counts.media, 1);
    assert.equal(authors.getAuthor('local', 'media:xueqiu7x24').name, '雪球7x24');
    assert.equal(counts.all, 4);
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
  const sized = mapTimelineStatus({
    id: 89,
    text: '相对头像',
    created_at: 1,
    user: {
      id: 7,
      screen_name: '甲',
      profile_image_url: 'community/2017x/a.jpg,community/2017x/a.jpg!180x180.jpg',
    },
  }, 'following');
  assert.equal(xueqiuToFeedItem(sized).authorAvatar, 'https://xavatar.imedao.com/community/2017x/a.jpg');
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
  assert.equal(tweet.authorName, 'Alice');
  assert.equal(tweet.authorHandle, '@alice');
  assert.equal(tweet.authorNativeId, '1');
  assert.match(tweet.sourceUrl, /\/alice\/status\/55/);
  assert.equal(tweet.attributionHandle, 'bob');
  assert.equal(tweet.attributionNativeId, '2');
  assert.equal(tweet.attributionName, 'Bob');
  const registered = authorCaptureFields('x', tweet);
  assert.equal(registered.authorProfile.authorId, 'x:2');
  assert.equal(registered.authorProfile.name, 'Bob');
  const provisional = tweetToFeedItem({ tweet_id: '56', author_handle: 'cara', text: '没有 rest id' });
  assert.equal(provisional.authorNativeId, '@cara');
  assert.equal(provisional.authorProvisional, true);
  assert.equal(acceptTweetRestId('Alice', 'alice', '4242'), '4242');
  assert.equal(acceptTweetRestId('bob', 'alice', '4242'), '');
  assert.equal(acceptTweetRestId('', 'alice', '4242'), '');
  const extract = buildTweetExtractExpression();
  assert.match(extract, /author_rest_id/);
  assert.match(extract, /socialContext/);
  assert.match(extract, /screen_name/);
  assert.match(extract, /toLowerCase\(\) === String\(authorHandle\)/);

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

test('provisional ids use the same name and handle order', () => {
  const xueqiu = authorCaptureFields('xueqiu', { authorName: '球友甲', authorHandle: 'qiu' });
  assert.equal(xueqiu.authorNativeId, '@球友甲');
  assert.equal(provisionalAuthorId('xueqiu', 'qiu', '球友甲'), 'xueqiu:@球友甲');
  const bilibili = authorCaptureFields('bilibili', { authorName: '小明', authorHandle: 'up' });
  assert.equal(bilibili.authorNativeId, '@小明');
  assert.equal(provisionalAuthorId('bilibili', 'up', '小明'), 'bilibili:@小明');
  const x = authorCaptureFields('x', { authorName: 'Alice', authorHandle: 'alice' });
  assert.equal(x.authorNativeId, '@alice');
  assert.equal(provisionalAuthorId('x', 'alice', 'Alice'), 'x:@alice');
});

test('reassigning an item recomputes both authors and keeps the new one listable', () => {
  const store = openStore();
  try {
    const now = Date.now();
    const item = saveAuthorItem(store.repositories.feed, {
      externalId: 'move', nativeId: '1', name: '甲', publishedAt: now, title: '要改挂',
    });
    store.repositories.feed.noteCaptureAuthor({
      workspaceId: 'local',
      provider: 'xueqiu',
      externalId: 'move',
      authorNativeId: '2',
      authorProfile: authorCaptureFields('xueqiu', { authorNativeId: '2', authorName: '乙', authorHandle: 'yi' }).authorProfile,
      title: '要改挂',
      publishedAt: now,
    });
    const previous = store.repositories.authors.getAuthor('local', 'xueqiu:1');
    const next = store.repositories.authors.getAuthor('local', 'xueqiu:2');
    assert.equal(previous.totalCount, 0);
    assert.equal(previous.unreadCount, 0);
    assert.equal(next.totalCount, 1);
    assert.equal(next.unreadCount, 1);
    assert.equal(next.latestItemId, item.id);
    store.repositories.authors.setFollow('local', 'xueqiu:2', true);
    const page = store.repositories.authors.listAuthors({ workspaceId: 'local' });
    assert.ok(page.followed.some((row) => row.authorId === 'xueqiu:2' && row.unreadCount === 1));
  } finally {
    store.close();
  }
});

test('translation updates only the author found by the item primary key', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'authors-title-'));
  const file = path.join(dir, 'test.db');
  const store = createStore(file);
  const now = Date.now();
  const latest = saveAuthorItem(store.repositories.feed, {
    provider: 'x', externalId: 'title-new', nativeId: '8', name: '甲', handle: 'jia', publishedAt: now, title: '最新',
  });
  saveAuthorItem(store.repositories.feed, {
    provider: 'x', externalId: 'other', nativeId: '9', name: '乙', handle: 'yi', publishedAt: now, title: '别人',
  });
  store.close();
  const database = new Database(file);
  database.prepare(`UPDATE author_stats SET latest_item_id = ?, latest_title_zh = ?
    WHERE author_id = ?`).run(latest.id, '不该被改', 'x:9');
  database.close();
  const again = createStore(file);
  try {
    again.repositories.feed.saveTranslations({
      workspaceId: 'local', itemId: latest.id, targetLang: 'zh', sourceHash: hash('最新'), translatedText: '甲的译文',
    });
    assert.equal(again.repositories.authors.getAuthor('local', 'x:8').latestTitleZh, '甲的译文');
    assert.equal(again.repositories.authors.getAuthor('local', 'x:9').latestTitleZh, '不该被改');
  } finally {
    again.close();
  }
});

test('repost capture keeps the original author handle', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'authors-repost-'));
  const file = path.join(dir, 'test.db');
  const store = createStore(file);
  try {
    const tweet = tweetToFeedItem({
      tweet_id: '55', author_handle: 'alice', author_rest_id: '1', author_name: 'Alice',
      reposter_handle: 'bob', reposter_rest_id: '2', reposter_name: 'Bob', text: '转发了',
    });
    const fields = authorCaptureFields('x', tweet);
    store.repositories.feed.saveCapture({
      workspaceId: 'local',
      provider: 'x',
      externalId: '55',
      sourceUrl: tweet.sourceUrl,
      title: tweet.title,
      contentHash: hash('repost-55'),
      authorNativeId: fields.authorNativeId,
      metadata: { authorHandle: tweet.authorHandle, authorProfile: fields.authorProfile },
    });
    store.repositories.feed.saveContentItem({
      workspaceId: 'local',
      captureId: store.repositories.feed.getCapture('local', 'x', '55').id,
      originType: 'subscription',
      contentType: 'post',
      title: tweet.title,
      body: tweet.body,
      summary: tweet.summary,
      sourceUrl: tweet.sourceUrl,
      authorName: tweet.authorName,
      publishedAt: Date.now(),
    });
  } finally {
    store.close();
  }
  const database = new Database(file);
  const row = database.prepare(`SELECT author_handle, author_native_id FROM captures WHERE external_id = ?`).get('55');
  assert.equal(row.author_handle, '@alice');
  assert.equal(row.author_native_id, '2');
  database.close();
  const reopened = createStore(file);
  try {
    assert.equal(reopened.repositories.authors.getAuthor('local', 'x:2').name, 'Bob');
    assert.equal(reopened.repositories.authors.getAuthor('local', 'x:1'), null);
  } finally {
    reopened.close();
  }
});

test('nightly recompute drops aged recent counts in batches of 500', async () => {
  assert.equal(AUTHOR_STATS_BATCH, 500);
  const yielded = [];
  const ids = Array.from({ length: 501 }, (_, index) => `x:${String(index).padStart(4, '0')}`);
  const seen = [];
  const repository = {
    listAuthorIds(workspaceId, after, limit) {
      assert.equal(workspaceId, 'desk');
      assert.equal(limit, 500);
      const start = after ? ids.indexOf(after) + 1 : 0;
      return ids.slice(start, start + limit);
    },
    recomputeAuthor(workspaceId, authorId) {
      seen.push(`${workspaceId}:${authorId}`);
      return true;
    },
  };
  const progress = [];
  const result = await recomputeAuthorStatsJob({
    authorRepository: repository,
    workspaceId: 'desk',
    onProgress: (entry) => progress.push(entry),
    yieldBetween: async () => { yielded.push(seen.length); },
  });
  assert.equal(seen.length, 501);
  assert.deepEqual(yielded, [500]);
  assert.equal(result.batches, 2);
  assert.equal(progress[0].count, 500);
  assert.equal(progress[1].count, 1);
  assert.equal(progress[1].lastAuthorId, 'x:0500');

  const dir = mkdtempSync(path.join(tmpdir(), 'authors-recent-'));
  const file = path.join(dir, 'test.db');
  const store = createStore(file);
  const now = Date.now();
  saveAuthorItem(store.repositories.feed, {
    externalId: 'aging', nativeId: '7', name: '会变旧', publishedAt: now, title: '刚抓到',
  });
  assert.equal(store.repositories.authors.getAuthor('local', 'xueqiu:7').recent30dCount, 1);
  store.close();
  const database = new Database(file);
  database.prepare('UPDATE item_authors SET sort_at = ?').run(now - 40 * 24 * 60 * 60 * 1000);
  database.close();
  const again = createStore(file);
  try {
    const schedule = ensureAuthorStatsSchedule(again, {}, Date.parse('2026-10-16T00:00:00Z'));
    assert.equal(schedule.jobType, AUTHOR_STATS_JOB_TYPE);
    assert.equal(schedule.schedule.kind, 'daily');
    assert.equal(schedule.schedule.timezone, 'Asia/Shanghai');
    assert.equal(schedule.schedule.hour, 0);
    assert.equal(schedule.schedule.minute, 10);
    const handlers = createAuthorStatsJobHandlers({ authorRepository: again.repositories.authors });
    const output = await handlers[AUTHOR_STATS_JOB_TYPE]({}, { job: { workspaceId: 'local' } });
    assert.ok(output.total >= 1);
    assert.equal(output.progress[0].count >= 1, true);
    assert.equal(again.repositories.authors.getAuthor('local', 'xueqiu:7').recent30dCount, 0);
    const worker = readFileSync(new URL('../apps/worker/src/worker.js', import.meta.url), 'utf8');
    assert.match(worker, /ensureAuthorStatsSchedule/);
    assert.match(worker, /createAuthorStatsJobHandlers/);
  } finally {
    again.close();
  }
});

test('backfill dry-run counts writes and rolls them back', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'authors-dry-'));
  const file = path.join(dir, 'test.db');
  const store = createStore(file);
  saveAuthorItem(store.repositories.feed, {
    externalId: 'dry', nativeId: '3', name: '回滚', publishedAt: Date.now(), title: '一条',
  });
  store.close();
  const database = openBackfillDatabase(file);
  assert.equal(database.pragma('busy_timeout', { simple: true }), 5000);
  database.prepare('DELETE FROM item_authors').run();
  database.prepare('DELETE FROM author_stats').run();
  database.prepare('DELETE FROM authors').run();
  database.prepare('UPDATE captures SET author_native_id = NULL').run();
  const preview = backfillAuthorBatch(database, { dryRun: true });
  assert.ok(preview.written >= 1);
  assert.equal(preview.dryRun, true);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM authors').get().count, 0);
  assert.equal(database.prepare(`SELECT author_native_id FROM captures WHERE external_id = 'dry'`).get().author_native_id, null);
  const applied = backfillAuthorBatch(database, { dryRun: false });
  assert.ok(applied.written >= 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM authors').get().count, 1);
  database.close();
});

test('bilibili dynamics use the feed filter and the caller workspace', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'authors-filter-'));
  const file = path.join(dir, 'test.db');
  const prepared = createStore(file);
  prepared.close();
  const database = new Database(file);
  database.prepare(`INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('desk', 'desk', ?, ?)`)
    .run(Date.now(), Date.now());
  database.close();
  const store = createStore(file);
  try {
    const record = {
      id: '77', author: '动态作者', authorMid: '300', text: '一条动态', pubTs: Math.floor(Date.now() / 1000),
    };
    const dropped = await ingestBilibiliDynamicsFiltered(store.repositories.feed, 'desk', [record], {
      async evaluate() {
        return { action: 'ignore', createContentItem: false, status: 'ignored', metadata: { filterApplied: true } };
      },
    });
    assert.equal(dropped.added, 0);
    const capture = store.repositories.feed.getCapture('desk', 'bilibili', 'dyn:77');
    assert.equal(capture.status, 'ignored');
    assert.equal(store.repositories.feed.getContentItemByCaptureId('desk', capture.id), null);
    assert.equal(store.repositories.authors.getAuthor('desk', 'bilibili:300'), null);
    const kept = await ingestBilibiliDynamicsFiltered(store.repositories.feed, 'desk', [{
      ...record, id: '78',
    }], null);
    assert.equal(kept.added, 1);
    assert.equal(store.repositories.feed.getCapture('desk', 'bilibili', 'dyn:78').status, 'ready');
    assert.equal(store.repositories.authors.getAuthor('desk', 'bilibili:300').totalCount, 1);
    assert.equal(store.repositories.authors.getAuthor('local', 'bilibili:300'), null);
    assert.equal(resolveDynamicsWorkspace({ argv: ['node', 'script', '--workspace', 'desk'], fallback: 'local' }), 'desk');
    assert.equal(resolveDynamicsWorkspace({ env: { AI_CENTER_WORKSPACE_ID: 'room' }, fallback: 'local' }), 'room');
    assert.equal(resolveDynamicsWorkspace({ instanceId: 'primary', legacyLayout: false, fallback: 'local' }), 'primary');
    assert.equal(resolveDynamicsWorkspace({ instanceId: 'local', legacyLayout: true, fallback: 'local' }), 'local');
    const collector = readFileSync(new URL('../scripts/collect-bilibili-space-dynamics.mjs', import.meta.url), 'utf8');
    assert.match(collector, /ingestBilibiliDynamicsFiltered/);
    assert.match(collector, /resolveDynamicsWorkspace/);
    assert.doesNotMatch(collector, /ingestBilibiliDynamics\([^)]*'local'/);
  } finally {
    store.close();
  }
});

test('bilibili jsonl import streams lines and commits each batch', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'authors-import-'));
  const file = path.join(dir, 'dynamics.jsonl');
  const dbFile = path.join(dir, 'test.db');
  const lines = [1, 2, 3].map((id) => JSON.stringify({
    id: String(id), author: '动态作者', authorMid: '400', text: `动态${id}`, pubTs: Math.floor(Date.now() / 1000),
  }));
  writeFileSync(file, `${lines.join('\n')}\n`);
  const store = createStore(dbFile);
  const real = store.transaction.bind(store);
  let transactions = 0;
  store.transaction = (work) => {
    transactions += 1;
    return real(work);
  };
  try {
    const result = await importBilibiliDynamicsFile(store, 'local', file, { batchSize: 2 });
    assert.equal(transactions, 2);
    assert.equal(result.transactions, 2);
    assert.equal(result.added, 3);
    assert.equal(store.repositories.authors.getAuthor('local', 'bilibili:400').totalCount, 3);
  } finally {
    store.close();
  }

  const rollbackFile = path.join(dir, 'rollback.db');
  const badFile = path.join(dir, 'bad.jsonl');
  writeFileSync(badFile, `${[
    JSON.stringify({ id: '9', author: '动态作者', authorMid: '401', text: '动态9', pubTs: 1_700_000_000 }),
    JSON.stringify({ id: '10', author: '乙'.repeat(600), authorMid: '401', text: '动态10', pubTs: 1_700_000_000 }),
  ].join('\n')}\n`);
  const rollback = createStore(rollbackFile);
  await assert.rejects(() => importBilibiliDynamicsFile(rollback, 'local', badFile, { batchSize: 2 }));
  assert.equal(rollback.repositories.feed.getCapture('local', 'bilibili', 'dyn:9'), null);
  assert.equal(rollback.repositories.authors.getAuthor('local', 'bilibili:401'), null);
  rollback.close();
});
