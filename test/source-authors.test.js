import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createStore } from '../packages/database/src/index.js';
import { latestSchemaVersion } from '../packages/database/src/migrations.js';
import { createAuthorService } from '../packages/domain/src/author-service.js';
import { authorCaptureFields } from '../packages/domain/src/authors.js';
import { syncOfficialReleases } from '../packages/domain/src/source-author-sync.js';
import {
  annotateOfficialReleases,
  authorSortAt,
  listSourceAuthors,
  officialAuthorByUrl,
  sourceAuthorProfile,
} from '../packages/domain/src/source-authors.js';
import { runSourceAuthorBackfill } from '../scripts/backfill-source-authors.mjs';

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function openStore() {
  return createStore(':memory:');
}

function saveSourceItem(feed, {
  sourceKey, externalId, title, publishedAt = null, capturedAt, createdAt, publishedAtRaw = '',
}) {
  const capture = feed.saveCapture({
    workspaceId: 'local',
    provider: 'media',
    externalId,
    sourceUrl: `https://example.com/${externalId}`,
    title,
    contentHash: hash(`${externalId}:${title}`),
    publishedAt,
    capturedAt,
    metadata: { sourceKey, publishedAtRaw },
  });
  return feed.saveContentItem({
    workspaceId: 'local',
    captureId: capture.id,
    originType: 'subscription',
    contentType: 'article',
    title,
    body: title,
    sourceUrl: `https://example.com/${externalId}`,
    authorName: sourceKey,
    publishedAt,
    createdAt,
  });
}

function saveSocial(feed, { externalId, nativeId, name, publishedAt, title, kind = '' }) {
  const fields = authorCaptureFields('xueqiu', {
    authorNativeId: nativeId,
    authorName: name,
    authorHandle: name,
    authorKind: kind,
  });
  const capture = feed.saveCapture({
    workspaceId: 'local',
    provider: 'xueqiu',
    externalId,
    sourceUrl: `https://xueqiu.com/${externalId}`,
    title,
    contentHash: hash(`${externalId}:${nativeId}:${title}`),
    publishedAt,
    authorNativeId: fields?.authorNativeId || null,
    metadata: fields ? { authorProfile: fields.authorProfile } : {},
  });
  return feed.saveContentItem({
    workspaceId: 'local',
    captureId: capture.id,
    originType: 'subscription',
    contentType: 'post',
    title,
    body: title,
    sourceUrl: `https://xueqiu.com/${externalId}`,
    authorName: name,
    publishedAt,
  });
}

test('official and media authors use a stable source key and keep columns separate', () => {
  const fed = sourceAuthorProfile('fed');
  const register = sourceAuthorProfile('federalregister');
  const govcn = sourceAuthorProfile('govcn');
  const govnews = sourceAuthorProfile('govnews');
  const next = sourceAuthorProfile('nextplatform');
  const eia = sourceAuthorProfile('eia');
  const live = sourceAuthorProfile('xueqiu7x24');
  assert.equal(fed.authorId, 'official:fed');
  assert.equal(fed.platform, 'official');
  assert.equal(fed.kind, 'source');
  assert.equal(fed.name, '美联储');
  assert.equal(register.authorId, 'official:federalregister');
  assert.equal(register.name, 'Federal Register');
  assert.equal(govcn.authorId, 'official:govcn');
  assert.equal(govcn.name, '国务院政策文件库');
  assert.equal(govnews.authorId, 'official:govnews');
  assert.notEqual(govcn.authorId, govnews.authorId);
  assert.equal(next.authorId, 'media:nextplatform');
  assert.equal(next.platform, 'media');
  assert.equal(next.name, 'The Next Platform');
  assert.equal(eia.platform, 'media');
  assert.equal(eia.name, 'EIA Today in Energy');
  assert.equal(live.authorId, 'media:xueqiu7x24');
  assert.equal(live.name, '雪球7x24');
  assert.equal(sourceAuthorProfile('bbc').name, 'BBC Business');
  assert.equal(sourceAuthorProfile('bbcworld').name, 'BBC World');
  assert.equal(sourceAuthorProfile('bbc').authorId, 'media:bbc');
  assert.notEqual(sourceAuthorProfile('bbc').authorId, sourceAuthorProfile('bbcworld').authorId);
  const lanes = new Map(listSourceAuthors().map((row) => [row.authorId, row.lane]));
  assert.equal(lanes.get('official:pboc'), 'official');
  assert.equal(lanes.get('official:whitehouse'), 'official');
  assert.equal(officialAuthorByUrl('https://www.federalreserve.gov/newsevents/pressreleases/monetary.htm')?.authorId, 'official:fed');
  assert.equal(officialAuthorByUrl('https://www.gov.cn/yaowen/202610/content.htm')?.authorId, 'official:govnews');
  assert.equal(officialAuthorByUrl('https://sousuo.www.gov.cn/zcwjk.htm')?.authorId, 'official:govcn');
  assert.equal(sourceAuthorProfile('not-a-source'), null);
  const published = authorSortAt({ publishedAt: 0, publishedAtRaw: '2026-01-02T00:00:00.000Z', capturedAt: 50 });
  assert.equal(published.basis, 'published');
  assert.equal(published.at, Date.parse('2026-01-02T00:00:00.000Z'));
  const captured = authorSortAt({ publishedAt: 0, publishedAtRaw: 'not-a-date', capturedAt: 50, createdAt: 10 });
  assert.deepEqual(captured, { at: 50, basis: 'captured' });
  assert.deepEqual(authorSortAt({}), { at: 0, basis: 'missing' });
});

test('source authors appear with one item, social authors still need two in 30 days, and both sort by publish time', () => {
  const store = openStore();
  try {
    const now = Date.now();
    const feed = store.repositories.feed;
    const authors = store.repositories.authors;
    saveSourceItem(feed, { sourceKey: 'govcn', externalId: 'govcn-new', title: '国务院新文件', publishedAt: now - 1_000, createdAt: now - 50_000 });
    saveSourceItem(feed, { sourceKey: 'fed', externalId: 'fed-old', title: '美联储旧稿', publishedAt: now - 9_000, createdAt: now });
    saveSourceItem(feed, { sourceKey: 'nextplatform', externalId: 'np-1', title: '平台报道', publishedAt: now - 4_000, createdAt: now - 4_000 });
    saveSourceItem(feed, { sourceKey: 'govnews', externalId: 'news-1', title: '会议发布', publishedAt: now - 7_000 });
    saveSourceItem(feed, { sourceKey: 'federalregister', externalId: 'fr-1', title: '登记公告', publishedAt: now - 2_000 });
    saveSocial(feed, { externalId: 'solo', nativeId: '77', name: '只发一条', publishedAt: now, title: '孤单' });
    saveSocial(feed, { externalId: 'live', nativeId: '7x24', name: '雪球7x24', kind: 'system', publishedAt: now - 3_000, title: '快讯' });
    authors.setFollow('local', 'official:federalregister', true);
    authors.setFollow('local', 'official:govnews', true);
    const page = authors.listAuthors({ workspaceId: 'local', limit: 20 });
    assert.deepEqual(page.followed.map((row) => row.authorId), ['official:federalregister', 'official:govnews']);
    assert.deepEqual(page.others.map((row) => row.authorId), ['official:govcn', 'media:xueqiu7x24', 'media:nextplatform', 'official:fed']);
    assert.ok(page.others.every((row) => row.authorId !== 'xueqiu:77'));
    const official = authors.listAuthors({ workspaceId: 'local', platform: 'official', limit: 20 });
    assert.deepEqual(official.followed.map((row) => row.authorId), ['official:federalregister', 'official:govnews']);
    assert.deepEqual(official.others.map((row) => row.authorId), ['official:govcn', 'official:fed']);
    assert.equal(authors.getAuthor('local', 'official:fed').name, '美联储');
    assert.equal(authors.getAuthor('local', 'media:xueqiu7x24').platform, 'media');
    const counts = authors.countAuthors('local');
    assert.equal(counts.official, 4);
    assert.equal(counts.media, 2);
    assert.equal(counts.xueqiu, 0);
  } finally {
    store.close();
  }
});

test('author detail sorts unread and read by original publish time, and missing time stays on capture time', () => {
  const store = openStore();
  try {
    const feed = store.repositories.feed;
    const capturedAt = 1_700_000_000_000;
    const early = saveSourceItem(feed, {
      sourceKey: 'fed', externalId: 'fed-early', title: '较早发布', publishedAt: capturedAt + 1_000, createdAt: capturedAt + 9_000,
    });
    saveSourceItem(feed, {
      sourceKey: 'fed', externalId: 'fed-late', title: '较晚发布', publishedAt: capturedAt + 5_000, createdAt: capturedAt + 2_000,
    });
    const undated = saveSourceItem(feed, {
      sourceKey: 'fed', externalId: 'fed-undated', title: '没有发布时间', capturedAt, createdAt: capturedAt + 8_000,
    });
    feed.upsertUserItemState({ workspaceId: 'local', contentItemId: early.id, isRead: true });
    const service = createAuthorService({
      authorRepository: store.repositories.authors,
      feedRepository: feed,
      qualityRule: 'all-three-0.60',
    });
    const unread = service.items('local', 'official:fed', { read: 'unread' });
    assert.deepEqual(unread.items.map((item) => item.title), ['较晚发布', '没有发布时间']);
    assert.equal(unread.items[1].publishedAt, capturedAt);
    const read = service.items('local', 'official:fed', { read: 'read' });
    assert.deepEqual(read.items.map((item) => item.title), ['较早发布']);
    const before = store.repositories.authors.getAuthor('local', 'official:fed').latestItemAt;
    saveSourceItem(feed, {
      sourceKey: 'fed', externalId: 'fed-undated', title: '没有发布时间', capturedAt, createdAt: capturedAt + 8_000,
    });
    assert.equal(store.repositories.authors.getAuthor('local', 'official:fed').latestItemAt, before);
    assert.equal(undated.title, '没有发布时间');
    assert.ok(before > capturedAt);
  } finally {
    store.close();
  }
});

test('source author backfill is idempotent and repairs publish time without using the clock', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'source-authors-'));
  const file = path.join(dir, 'test.db');
  const store = createStore(file);
  const publishedAt = 1_710_000_000_000;
  try {
    const feed = store.repositories.feed;
    saveSourceItem(feed, {
      sourceKey: 'custom', externalId: 'later-key', title: '稍后归类', publishedAt, capturedAt: publishedAt - 10_000,
    });
    store.repositories.media.upsertEntry({
      workspaceId: 'local', externalId: 'nextplatform:one', sourceKey: 'nextplatform', publisherKey: 'nextplatform',
      channel: 'tech', canonicalUrl: 'https://www.nextplatform.com/2026/10/01/one/', title: '平台索引',
      summary: '摘要', publishedAt, publishedAtRaw: '', contentLevel: 'summary_only', contentHash: hash('np'),
      revision: 1, status: 'indexed', observedAt: publishedAt, createdAt: publishedAt, updatedAt: publishedAt,
    });
    store.repositories.runtimeSnapshots.saveSnapshot('local', 'static-signal-board', {
      generatedAt: publishedAt,
      releases: [{
        releaseId: 'fed-1',
        title: 'FOMC statement',
        authority: 'Federal Reserve',
        sourceUrl: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20261001a.htm',
        publishedAt,
      }],
      releaseSourceIds: { 'fed-1': 'policy.us.fed' },
    }, publishedAt);
    assert.equal(store.repositories.authors.getAuthor('local', 'media:nextplatform'), null);
  } finally {
    store.close();
  }
  const database = new Database(file);
  database.prepare(`UPDATE captures SET metadata_json = ? WHERE external_id = ?`)
    .run(JSON.stringify({ sourceKey: 'nextplatform' }), 'later-key');
  database.close();
  const dry = createStore(file);
  try {
    const preview = await runSourceAuthorBackfill(dry, { sleepMs: 0, dryRun: true });
    assert.equal(preview.linked, 1);
    assert.equal(preview.indexed, 1);
    assert.equal(preview.official, 1);
    assert.equal(dry.repositories.authors.getAuthor('local', 'media:nextplatform'), null);
    assert.equal(dry.repositories.authors.getAuthor('local', 'official:fed'), null);
  } finally {
    dry.close();
  }
  const live = createStore(file);
  try {
    const first = await runSourceAuthorBackfill(live, { sleepMs: 0 });
    assert.equal(first.linked, 1);
    assert.equal(first.indexed, 1);
    assert.equal(first.official, 1);
    const author = live.repositories.authors.getAuthor('local', 'media:nextplatform');
    assert.equal(author.totalCount, 2);
    assert.equal(author.latestItemAt, publishedAt);
    assert.equal(live.repositories.authors.getAuthor('local', 'official:fed').name, '美联储');
    assert.equal(live.repositories.authors.getAuthor('local', 'official:fed').totalCount, 1);
    const again = await runSourceAuthorBackfill(live, { sleepMs: 0 });
    assert.equal(live.repositories.authors.getAuthor('local', 'media:nextplatform').totalCount, 2);
    assert.equal(live.repositories.authors.getAuthor('local', 'official:fed').totalCount, 1);
    assert.equal(again.official, 1);
  } finally {
    live.close();
  }
  const patched = new Database(file);
  patched.prepare(`UPDATE item_authors SET sort_at = 1 WHERE author_id = ?`).run('media:nextplatform');
  patched.close();
  const repaired = createStore(file);
  try {
    const preview = repaired.repositories.authors.repairAuthorPublishBatch({ limit: 500, dryRun: true });
    assert.ok(preview.updated >= 1);
    assert.equal(preview.dryRun, true);
    assert.equal(repaired.repositories.authors.getAuthor('local', 'media:nextplatform').latestItemAt, publishedAt);
    const fix = repaired.repositories.authors.repairAuthorPublishBatch({ limit: 500 });
    assert.ok(fix.updated >= 1);
    assert.equal(repaired.repositories.authors.getAuthor('local', 'media:nextplatform').latestItemAt, publishedAt);
    const second = repaired.repositories.authors.repairAuthorPublishBatch({ limit: 500 });
    assert.equal(second.updated, 0);
    const rerun = await runSourceAuthorBackfill(repaired, { sleepMs: 0 });
    assert.equal(rerun.resorted, 0);
    assert.equal(repaired.repositories.authors.getAuthor('local', 'media:nextplatform').totalCount, 2);
    assert.equal(repaired.getRuntimeStatus().schemaVersion, latestSchemaVersion());
  } finally {
    repaired.close();
  }
});

test('official release sync links the source author and can run again', () => {
  const store = openStore();
  try {
    const release = {
      releaseId: 'fr-9',
      title: 'A rule',
      authority: 'Federal Register',
      sourceUrl: 'https://www.federalregister.gov/documents/2026/10/01/2026-1/a-rule',
      publishedAt: 1_730_000_000_000,
    };
    const older = { ...release, releaseId: 'fr-8', title: 'Older rule', publishedAt: 1_720_000_000_000, sourceUrl: 'https://www.federalregister.gov/documents/2026/09/01/2026-0/older' };
    const annotated = annotateOfficialReleases({ releases: [release] }, { 'fr-9': 'policy.us.federal-register' });
    assert.equal(annotated.releases[0].authorId, 'official:federalregister');
    assert.equal(annotated.releases[0].sourceAuthorName, 'Federal Register');
    const first = syncOfficialReleases(store.repositories.feed, 'local', [release, older], {
      'fr-9': 'policy.us.federal-register',
      'fr-8': 'policy.us.federal-register',
    });
    assert.equal(first.linked, 2);
    const second = syncOfficialReleases(store.repositories.feed, 'local', [release, older], {
      'fr-9': 'policy.us.federal-register',
      'fr-8': 'policy.us.federal-register',
    });
    assert.equal(second.linked, 2);
    const author = store.repositories.authors.getAuthor('local', 'official:federalregister');
    assert.equal(author.totalCount, 2);
    assert.equal(author.latestItemAt, release.publishedAt);
    const service = createAuthorService({
      authorRepository: store.repositories.authors,
      feedRepository: store.repositories.feed,
      qualityRule: 'all-three-0.60',
    });
    assert.deepEqual(service.items('local', 'official:federalregister').items.map((item) => item.title), ['A rule', 'Older rule']);
  } finally {
    store.close();
  }
});

test('migration 88 only adds the publish-time index and the phone chips scroll without a list swipe', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'source-authors-schema-'));
  const file = path.join(dir, 'test.db');
  const store = createStore(file);
  store.close();
  const database = new Database(file);
  const version = database.prepare(`SELECT name FROM schema_migrations WHERE version = 88`).get();
  assert.equal(version.name, 'author_stats_published');
  assert.ok(database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_author_stats_published'`).get());
  database.prepare('DELETE FROM schema_migrations WHERE version = 88').run();
  database.close();
  const reopened = createStore(file);
  try {
    assert.equal(reopened.getRuntimeStatus().schemaVersion, latestSchemaVersion());
  } finally {
    reopened.close();
  }
  const css = readFileSync(new URL('../apps/web/public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /@media \(max-width: 720px\) \{\s*\.author-switch \{[^}]*mask-image:/);
  assert.match(css, /\.author-switch \{[^}]*overflow-x: auto/);
  assert.match(css, /\.author-switch-item \{[^}]*flex: none/);
  const view = readFileSync(new URL('../apps/web/public/author-view.js', import.meta.url), 'utf8');
  assert.match(view, /youtube', 'official', 'media'/);
  assert.match(view, /scrollIntoView\(\{ inline: 'nearest'/);
  assert.match(view, /iOS 边缘返回/);
  assert.doesNotMatch(view, /touchstart|touchmove|pointerdown/);
});
