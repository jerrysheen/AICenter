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
import { hideShortOfficialItems, officialArticleExternalId, officialBodyAction, officialReleaseExternalId, syncOfficialReleases } from '../packages/domain/src/source-author-sync.js';
import { stableArticleId } from '../packages/connectors/src/media/article-url.js';
import { createTreeMaterialPort } from '../packages/domain/src/information-tree-materials.js';
import {
  annotateOfficialReleases,
  authorSortAt,
  listSourceAuthors,
  officialAuthorByUrl,
  sourceAuthorProfile,
} from '../packages/domain/src/source-authors.js';
import { backfillSourceAuthorBatch, repairAuthorPublishBatch } from '../packages/database/src/repositories/author-repository.js';
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

test('source author write batches take the reserved lock before reading', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'source-authors-immediate-'));
  const file = path.join(dir, 'test.db');
  const store = createStore(file);
  store.close();
  const database = new Database(file);
  const modes = [];
  const original = database.transaction.bind(database);
  database.transaction = (fn) => {
    const transaction = original(fn);
    const run = (mode, body) => (...args) => {
      modes.push(mode);
      return body(...args);
    };
    const deferred = run('deferred', transaction);
    deferred.immediate = run('immediate', transaction.immediate.bind(transaction));
    deferred.deferred = run('deferred', transaction.deferred.bind(transaction));
    deferred.exclusive = run('exclusive', transaction.exclusive.bind(transaction));
    return deferred;
  };
  try {
    backfillSourceAuthorBatch(database, { limit: 1 });
    repairAuthorPublishBatch(database, { limit: 1 });
    assert.deepEqual(modes, ['immediate', 'immediate']);
  } finally {
    database.close();
  }
});

test('source author backfill resumes after the last committed batch and a finished run can start over', async () => {
  const store = openStore();
  try {
    const publishedAt = 1_710_000_000_000;
    saveSourceItem(store.repositories.feed, {
      sourceKey: 'nextplatform', externalId: 'np-1', title: '一', publishedAt, capturedAt: publishedAt,
    });
    saveSourceItem(store.repositories.feed, {
      sourceKey: 'nextplatform', externalId: 'np-2', title: '二', publishedAt, capturedAt: publishedAt,
    });
    const busy = {
      repositories: {
        authors: {
          ...store.repositories.authors,
          backfillSourceAuthorBatch() {
            throw Object.assign(new Error('SQLITE_BUSY'), { code: 'SQLITE_BUSY' });
          },
        },
        feed: store.repositories.feed,
      },
    };
    let savedDuringBusy = false;
    await assert.rejects(
      () => runSourceAuthorBackfill(busy, { sleepMs: 0, batchSize: 1, saveCheckpoint() { savedDuringBusy = true; } }),
      (error) => error.code === 'SQLITE_BUSY',
    );
    assert.equal(savedDuringBusy, false);

    let saved = null;
    await assert.rejects(
      () => runSourceAuthorBackfill(store, {
        sleepMs: 0,
        batchSize: 1,
        saveCheckpoint(state) {
          saved = state;
          if (state.phase === 'captures') throw Object.assign(new Error('SQLITE_BUSY'), { code: 'SQLITE_BUSY' });
        },
      }),
      (error) => error.code === 'SQLITE_BUSY',
    );
    assert.equal(saved.phase, 'captures');
    assert.equal(saved.counts.captures, 1);
    assert.ok(saved.afterRowid > 0);
    const stoppedAt = saved.afterRowid;
    const seen = [];
    const rest = await runSourceAuthorBackfill(store, {
      sleepMs: 0,
      batchSize: 1,
      checkpoint: saved,
      onBatch(batch) {
        if (batch.phase === 'captures') seen.push(batch.lastRowid);
      },
      saveCheckpoint(state) { saved = state; },
    });
    assert.deepEqual(seen, seen.filter((rowid) => rowid > stoppedAt));
    assert.ok(seen.length >= 1);
    assert.equal(rest.captures, 2);
    assert.equal(saved.phase, 'done');
    assert.equal(store.repositories.authors.getAuthor('local', 'media:nextplatform').totalCount, 2);
    const again = await runSourceAuthorBackfill(store, {
      sleepMs: 0,
      checkpoint: { ...saved, counts: { ...saved.counts, captures: 99 } },
    });
    assert.equal(again.captures, 2);
    assert.equal(store.repositories.authors.getAuthor('local', 'media:nextplatform').totalCount, 2);
    let drySaved = false;
    const preview = await runSourceAuthorBackfill(store, {
      sleepMs: 0,
      dryRun: true,
      checkpoint: {
        phase: 'publish',
        repairAfter: 'zzz',
        counts: { captures: 50, linked: 50, indexed: 50, official: 50, resorted: 50 },
      },
      saveCheckpoint() { drySaved = true; },
    });
    assert.equal(drySaved, false);
    assert.equal(preview.captures, 2);
  } finally {
    store.close();
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
    assert.deepEqual(service.items('local', 'official:federalregister').items.map((item) => item.title), []);
  } finally {
    store.close();
  }
});

test('migration 90 only adds the publish-time index and the phone chips scroll without a list swipe', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'source-authors-schema-'));
  const file = path.join(dir, 'test.db');
  const store = createStore(file);
  store.close();
  const database = new Database(file);
  assert.equal(database.prepare(`SELECT name FROM schema_migrations WHERE version = 88`).get().name, 'northbound_flow');
  const version = database.prepare(`SELECT name FROM schema_migrations WHERE version = 90`).get();
  assert.equal(version.name, 'author_stats_published');
  assert.equal(database.prepare(`SELECT name FROM schema_migrations WHERE version = 89`).get().name, 'youtube_podcast_article');
  assert.ok(database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_author_stats_published'`).get());
  database.prepare('DELETE FROM schema_migrations WHERE version = 90').run();
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

test('official board mirrors stay out of the feed, hourly report, and classification queues', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'source-authors-mirrors-'));
  const file = path.join(dir, 'test.db');
  const store = createStore(file);
  const publishedAt = Date.now() - 1_000;
  const window = { startAt: publishedAt - 60_000, endAt: Date.now() + 60_000 };
  const release = {
    releaseId: 'fed-mirror',
    title: 'FOMC statement',
    authority: 'Federal Reserve',
    sourceUrl: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20261019a.htm',
    publishedAt,
  };
  try {
    const feed = store.repositories.feed;
    saveSocial(feed, {
      externalId: 'xq-social', nativeId: '1001', name: '社交作者', publishedAt, title: '社交一条',
    });
    saveSourceItem(feed, {
      sourceKey: 'nextplatform', externalId: 'nextplatform:body', title: '媒体正文', publishedAt,
    });
    saveSourceItem(feed, {
      sourceKey: 'fed', externalId: 'fed-prefix-only', title: '只有作者前缀', publishedAt,
    });
    syncOfficialReleases(store.repositories.feed, 'local', [release], {
      'fed-mirror': 'policy.us.fed',
    });
    store.repositories.runtimeSnapshots.saveSnapshot('local', 'static-signal-board', {
      generatedAt: publishedAt,
      releases: [release],
      releaseSourceIds: { 'fed-mirror': 'policy.us.fed' },
    }, publishedAt);

    const externalId = officialReleaseExternalId('fed', release);
    assert.equal(externalId.startsWith('official-board:fed:'), true);
    assert.notEqual(externalId, officialArticleExternalId('fed', release));
    const capture = feed.getCapture('local', 'media', externalId);
    assert.equal(capture.metadata.officialMirror, true);
    assert.equal(capture.metadata.filterDecision, 'REVIEW');
    assert.equal(capture.metadata.filterReason, 'body-too-short');
    assert.equal(capture.metadata.filterApplied, true);
    assert.equal(capture.status, 'captured');
    const prefixCapture = feed.getCapture('local', 'media', 'fed-prefix-only');
    assert.equal(prefixCapture.metadata.officialMirror || false, false);
    assert.equal(prefixCapture.metadata.filterDecision || '', '');

    const titles = (rows) => rows.map((row) => row.title);
    const stored = titles(feed.listContentItems('local', { limit: 20 }));
    assert.equal(stored.includes('FOMC statement'), false);
    assert.ok(stored.includes('只有作者前缀'));
    assert.ok(stored.includes('社交一条'));
    assert.ok(stored.includes('媒体正文'));

    const social = titles(feed.listContentItemsByProvider('local', 'xueqiu'));
    const allFeed = [...social, release.title];
    assert.deepEqual(allFeed.filter((title) => title === 'FOMC statement'), ['FOMC statement']);
    assert.equal(allFeed.includes('只有作者前缀'), false);
    store.repositories.media.upsertEntry({
      workspaceId: 'local', externalId: 'nextplatform:index-only', sourceKey: 'nextplatform', publisherKey: 'nextplatform',
      channel: 'tech', canonicalUrl: 'https://www.nextplatform.com/2026/10/19/index/', title: '媒体索引',
      summary: '摘要', publishedAt, publishedAtRaw: '', contentLevel: 'summary_only', contentHash: hash('index'),
      revision: 1, status: 'indexed', observedAt: publishedAt, createdAt: publishedAt, updatedAt: publishedAt,
    });
    const mediaTab = titles(store.repositories.media.listEntries('local', { limit: 20 }));
    assert.deepEqual(mediaTab, ['媒体索引']);
    assert.equal(feed.getCapture('local', 'media', 'nextplatform:index-only'), null);

    const hourly = await createTreeMaterialPort({
      feedService: {
        listContentItemsInWindow: (workspaceId, query) => feed.listContentItemsInWindow(workspaceId, query),
      },
      mediaService: { informationCandidates: () => [] },
    }).candidates('local', window);
    assert.equal(titles(hourly).includes('FOMC statement'), false);
    assert.ok(titles(hourly).includes('只有作者前缀'));
    assert.ok(titles(hourly).includes('社交一条'));
    assert.ok(titles(hourly).includes('媒体正文'));
    const officialAccount = feed.listWindowSources('local', window)
      .find((row) => row.sourceId === capture.sourceAccountId);
    assert.equal(officialAccount?.available || 0, 0);

    const refresh = feed.listQualityRefreshItems('local');
    assert.ok(refresh.some((row) => row.externalId === 'xq-social'));
    assert.equal(refresh.some((row) => row.externalId === externalId || row.externalId === 'fed-prefix-only'), false);
    const taggable = titles(feed.listContentItemsWithSource('local', { limit: 20 }));
    assert.equal(taggable.includes('FOMC statement'), false);
    assert.ok(taggable.includes('只有作者前缀'));
    const officialIds = [
      feed.getContentItemByCapture('local', capture.id).id,
      feed.getContentItemByCapture('local', prefixCapture.id).id,
    ];
    const mediaId = feed.getContentItemByCapture('local', feed.getCapture('local', 'media', 'nextplatform:body').id).id;
    assert.deepEqual(
      titles(feed.listContentItemsWithSource('local', { ids: [...officialIds, mediaId], limit: 10 })).sort(),
      ['只有作者前缀', '媒体正文'],
    );

    const authors = createAuthorService({
      authorRepository: store.repositories.authors,
      feedRepository: feed,
    });
    assert.deepEqual(authors.items('local', 'official:fed').items.map((item) => item.title).sort(), ['只有作者前缀']);

    const backed = await runSourceAuthorBackfill(store, { sleepMs: 0 });
    assert.equal(backed.official, 1);
    assert.equal(feed.getCapture('local', 'media', externalId).metadata.officialMirror, true);
    assert.equal(feed.getCapture('local', 'media', externalId).metadata.filterDecision, 'REVIEW');
    assert.equal(feed.getCapture('local', 'media', 'fed-prefix-only').metadata.officialMirror || false, false);
    const afterBackfill = titles(feed.listContentItems('local', { limit: 20 }));
    assert.equal(afterBackfill.includes('FOMC statement'), false);
    assert.ok(afterBackfill.includes('只有作者前缀'));
    assert.equal(store.listJobs(20).some((job) => /quality\.refresh|information\.prepare|tagging\.analyze|reading-class/.test(job.type)), false);
    const script = readFileSync(new URL('../scripts/backfill-source-authors.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(script, /feedFilter|listContentItems|listQualityRefresh|enqueueTree|reading-class|tagging\.analyze/);
  } finally {
    store.close();
  }
});

test('a real policy-source article stays in hourly, search, and taggable lists', async () => {
  const store = openStore();
  const publishedAt = Date.now() - 1_000;
  const window = { startAt: publishedAt - 60_000, endAt: Date.now() + 60_000 };
  const link = 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20261018a.htm';
  const articleId = stableArticleId('fed', { link });
  const release = {
    releaseId: 'fed-real',
    title: '看板标题',
    authority: 'Federal Reserve',
    sourceUrl: link,
    publishedAt,
  };
  try {
    const feed = store.repositories.feed;
    saveSourceItem(feed, {
      sourceKey: 'fed', externalId: articleId, title: '美联储原文', publishedAt,
    });
    syncOfficialReleases(feed, 'local', [release], { 'fed-real': 'policy.us.fed' });
    store.repositories.runtimeSnapshots.saveSnapshot('local', 'static-signal-board', {
      generatedAt: publishedAt,
      releases: [release],
      releaseSourceIds: { 'fed-real': 'policy.us.fed' },
    }, publishedAt);
    await runSourceAuthorBackfill(store, { sleepMs: 0 });

    assert.equal(feed.getCapture('local', 'media', officialReleaseExternalId('fed', release)), null);
    const capture = feed.getCapture('local', 'media', articleId);
    assert.equal(capture.metadata.officialMirror || false, false);
    assert.equal(capture.metadata.sourceKey, 'fed');
    const titles = (rows) => rows.map((row) => row.title);
    assert.ok(titles(feed.listContentItems('local', { limit: 20 })).includes('美联储原文'));
    assert.equal(titles(feed.listContentItems('local', { limit: 20 })).includes('看板标题'), false);
    assert.ok(titles(feed.listContentItemsInWindow('local', { ...window, timeBasis: 'ingested' })).includes('美联储原文'));
    assert.ok(titles(feed.listContentItemsWithSource('local', { limit: 20 })).includes('美联储原文'));
    const authors = createAuthorService({
      authorRepository: store.repositories.authors,
      feedRepository: feed,
    });
    assert.deepEqual(authors.items('local', 'official:fed').items.map((item) => item.title), ['美联储原文']);
  } finally {
    store.close();
  }
});

test('media ingestion after an official mirror keeps the real article visible', () => {
  const store = openStore();
  const publishedAt = Date.now() - 1_000;
  const window = { startAt: publishedAt - 60_000, endAt: Date.now() + 60_000 };
  const release = {
    releaseId: 'fed-later',
    title: 'FOMC statement',
    authority: 'Federal Reserve',
    sourceUrl: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20261017a.htm',
    publishedAt,
  };
  try {
    const feed = store.repositories.feed;
    syncOfficialReleases(feed, 'local', [release], { 'fed-later': 'policy.us.fed' });
    const articleId = officialArticleExternalId('fed', release);
    const mirrorId = officialReleaseExternalId('fed', release);
    assert.equal(mirrorId.startsWith('official-board:fed:'), true);
    assert.notEqual(articleId, mirrorId);
    assert.equal(feed.getCapture('local', 'media', articleId), null);
    assert.equal(feed.getCapture('local', 'media', mirrorId).metadata.officialMirror, true);

    const account = feed.upsertSourceAccount({
      workspaceId: 'local',
      provider: 'media',
      externalId: 'media:fed',
      displayName: '美联储',
      profileUrl: release.sourceUrl,
      authMode: 'public',
      metadata: { sourceKey: 'fed', sourceId: 'policy.us.fed' },
    });
    feed.saveCapture({
      workspaceId: 'local',
      provider: 'media',
      externalId: articleId,
      sourceAccountId: account.id,
      sourceUrl: release.sourceUrl,
      title: '美联储全文',
      contentHash: hash('fed-body'),
      status: 'ready',
      publishedAt,
      metadata: {
        publisherKey: 'fed',
        sourceKey: 'fed',
        contentLevel: 'full',
        publishedAtRaw: '',
        channel: 'macro',
      },
    });
    const real = feed.getCapture('local', 'media', articleId);
    feed.saveContentItem({
      workspaceId: 'local',
      captureId: real.id,
      originType: 'subscription',
      contentType: 'article',
      title: '美联储全文',
      body: '这是媒体采集到的正文',
      summary: '摘要',
      sourceUrl: release.sourceUrl,
      authorName: '美联储',
      publishedAt,
    });

    assert.equal(real.metadata.officialMirror || false, false);
    assert.notEqual(real.id, feed.getCapture('local', 'media', mirrorId).id);
    const titles = (rows) => rows.map((row) => row.title);
    assert.ok(titles(feed.listContentItems('local', { limit: 20 })).includes('美联储全文'));
    assert.equal(titles(feed.listContentItems('local', { limit: 20 })).includes('FOMC statement'), false);
    assert.ok(titles(feed.listContentItemsInWindow('local', { ...window, timeBasis: 'ingested' })).includes('美联储全文'));
    assert.equal(titles(feed.listContentItemsInWindow('local', { ...window, timeBasis: 'ingested' })).includes('FOMC statement'), false);
    assert.ok(titles(feed.listContentItemsWithSource('local', { limit: 20 })).includes('美联储全文'));
    assert.equal(titles(feed.listContentItemsWithSource('local', { limit: 20 })).includes('FOMC statement'), false);
    const authors = createAuthorService({
      authorRepository: store.repositories.authors,
      feedRepository: feed,
    });
    assert.ok(authors.items('local', 'official:fed').items.some((item) => item.title === '美联储全文'));
  } finally {
    store.close();
  }
});

test('short official imports stay hidden until the body is long enough', () => {
  const store = openStore();
  const publishedAt = Date.now() - 1_000;
  const release = {
    releaseId: 'short-fed',
    title: '短公告',
    authority: '只有标题',
    sourceUrl: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20261019b.htm',
    publishedAt,
  };
  try {
    const feed = store.repositories.feed;
    syncOfficialReleases(feed, 'local', [release], { 'short-fed': 'policy.us.fed' });
    const externalId = officialReleaseExternalId('fed', release);
    const capture = feed.getCapture('local', 'media', externalId);
    assert.equal(officialBodyAction({ body: '', metadata: capture.metadata }), 'unchanged');
    assert.equal(officialBodyAction({ body: '短', metadata: { filterDecision: 'KEEP', filterApplied: false } }), 'keep');
    feed.saveCapture({
      ...capture,
      status: 'ready',
      metadata: { ...capture.metadata, filterMode: '', filterDecision: '', filterReason: '', filterApplied: false, filterReviewKind: 'none' },
    });
    const preview = hideShortOfficialItems(store, { dryRun: true });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.hidden, 1);
    assert.equal(feed.getCapture('local', 'media', externalId).status, 'ready');
    const applied = hideShortOfficialItems(store);
    assert.equal(applied.hidden, 1);
    assert.equal(feed.getCapture('local', 'media', externalId).status, 'captured');
    assert.equal(feed.getCapture('local', 'media', externalId).metadata.filterReason, 'body-too-short');
    const item = feed.getContentItemByCapture('local', capture.id);
    feed.saveContentItem({
      workspaceId: 'local', captureId: capture.id, originType: 'subscription', contentType: 'article',
      title: item.title, body: '正'.repeat(80), summary: item.summary || '', sourceUrl: item.sourceUrl,
      authorName: item.authorName, publishedAt: item.publishedAt,
    });
    const cleared = hideShortOfficialItems(store);
    assert.equal(cleared.cleared, 1);
    const restored = feed.getCapture('local', 'media', externalId);
    assert.equal(restored.status, 'ready');
    assert.equal(restored.metadata.filterReason || '', '');
  } finally {
    store.close();
  }
});
