import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createStore } from '../packages/database/src/index.js';
import { addArticleDedupColumns, addArticleDedupLookupIndexes } from '../packages/database/src/migrations.js';
import { createMediaConnector } from '../packages/connectors/src/media/port.js';
import { createMediaIngestionService } from '../packages/domain/src/media-ingestion-service.js';
import { createFeedService } from '../packages/domain/src/feed-service.js';
import { createTreeMaterialPort } from '../packages/domain/src/information-tree-materials.js';
import {
  ARTICLE_DEDUP_WINDOW_MS,
  articleIdentity,
  canonicalArticleSource,
  createArticleDedup,
  createPublisherIndex,
  normalizeDedupUrl,
  titleSimilarity,
} from '../packages/domain/src/article-dedup.js';
import config from '../config/media.json' with { type: 'json' };

const bbc = config.sources.find((source) => source.sourceKey === 'bbc');
const at1134 = Date.parse('2026-10-15T11:34:00+08:00');
const at1136 = Date.parse('2026-10-15T11:36:00+08:00');
const at1140 = Date.parse('2026-10-15T11:40:00+08:00');
const at1202 = Date.parse('2026-10-15T12:02:00+08:00');
const TITLE = 'Anthropic quarterly revenue reaches two billion dollars';
const SIMILAR = 'Anthropic quarterly revenue reaches two billion dollars this quarter';
const MEDIA_URL = 'https://www.BBC.com/news/articles/anthropic-q3-revenue?at_campaign=rss#story';
const FEED_URL = 'https://bbc.com/news/articles/anthropic-q3-revenue/?utm_source=rss';
const BODY = `${'Anthropic told the BBC that third-quarter revenue passed two billion dollars, with enterprise customers making up most of the new business. '.repeat(2)}`;

function rss(item) {
  return `<rss><channel><item><title>${item.title}</title><guid>${item.guid}</guid><link>${item.url}</link><pubDate>${new Date(item.publishedAt).toUTCString()}</pubDate><description>${item.summary || ''}</description></item></channel></rss>`;
}

function open(fetchImpl, now) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'article-dedup-'));
  const store = createStore(path.join(dir, 'test.db'));
  const port = createMediaConnector({
    sources: [bbc],
    fetchImpl,
    lookupImpl: async () => [{ address: '93.184.216.34' }],
  });
  const media = createMediaIngestionService({
    mediaRepository: store.repositories.media,
    feedRepository: store.repositories.feed,
    mediaPort: port,
    now,
  });
  store.repositories.media.saveState({
    workspaceId: 'local', sourceKey: 'bbc', enabled: true, hostDirectVerified: true,
    bodyUseAcknowledged: true, health: 'ready', updatedAt: now(),
  });
  return {
    dir, store, media,
    close() { store.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

function feedPort(item) {
  return {
    persistence() {
      return {
        providerId: 'rss',
        sourceAccount: {
          externalId: 'https://feeds.bbci.co.uk/news/business/rss.xml',
          displayName: 'BBC',
          profileUrl: 'https://feeds.bbci.co.uk/news/business/rss.xml',
          authMode: 'public',
          metadata: {},
        },
      };
    },
    async read() {
      return { data: { fetchedAt: item.publishedAt, items: [item] } };
    },
  };
}

test('normalized url and publisher source treat media:bbc and a BBC feed as one article', () => {
  const index = createPublisherIndex([bbc, config.sources.find((source) => source.sourceKey === 'bbcworld')]);
  assert.equal(normalizeDedupUrl(MEDIA_URL), 'bbc.com/news/articles/anthropic-q3-revenue');
  assert.equal(normalizeDedupUrl(FEED_URL), normalizeDedupUrl(MEDIA_URL));
  assert.equal(normalizeDedupUrl('https://www.bbc.co.uk/news/articles/anthropic-q3-revenue/'), 'bbc.co.uk/news/articles/anthropic-q3-revenue');
  const mediaSource = canonicalArticleSource({ sourceKey: 'bbc', publisherKey: 'bbc', sourceExternalId: 'media:bbc' }, index);
  const feedSource = canonicalArticleSource({
    url: FEED_URL,
    siteUrl: 'https://feeds.bbci.co.uk/news/business/rss.xml',
    sourceExternalId: 'https://feeds.bbci.co.uk/news/business/rss.xml',
  }, index);
  const ukSource = canonicalArticleSource({ url: 'https://www.bbc.co.uk/news/articles/anthropic-q3-revenue/' }, index);
  assert.equal(mediaSource.id, 'bbc');
  assert.equal(feedSource.id, 'bbc');
  assert.equal(ukSource.id, 'bbc');
  assert.equal(mediaSource.registered, true);
  const dedup = createArticleDedup({ sources: [bbc] });
  assert.equal(dedup.keyFor({ sourceKey: 'bbc', url: MEDIA_URL }), dedup.keyFor({ url: FEED_URL, siteUrl: 'https://feeds.bbci.co.uk/news/business/rss.xml' }));
  assert.ok(titleSimilarity(TITLE, SIMILAR) >= dedup.threshold);
  assert.ok(titleSimilarity(TITLE, 'Markets close higher after a quiet session in London') < dedup.threshold);
  assert.equal(ARTICLE_DEDUP_WINDOW_MS, 5 * 60 * 1000);
  assert.equal(articleIdentity({ url: 'https://www.reuters.com/technology/anthropic', title: TITLE }, index).sourceId, 'host:reuters.com');
});

test('migration 68 adds dedup columns and indexes without rewriting existing rows', () => {
  assert.equal(addArticleDedupColumns.toString().includes('UPDATE'), false);
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE media_index_entries (
      workspace_id TEXT, external_id TEXT, title TEXT, canonical_url TEXT, published_at INTEGER
    );
    CREATE TABLE content_items (
      workspace_id TEXT, id TEXT, title TEXT, body TEXT, source_url TEXT, published_at INTEGER
    );
    INSERT INTO media_index_entries VALUES ('local', 'bbc:old', 'Anthropic Q3', 'https://www.bbc.com/news/articles/anthropic-q3-revenue', ${at1134});
    INSERT INTO content_items VALUES ('local', '8c74e34e', 'keep', 'body', 'https://bbc.com/news/articles/anthropic-q3-revenue/', ${at1136});
  `);
  addArticleDedupColumns(db);
  const media = db.prepare('SELECT title, canonical_url, dedup_key FROM media_index_entries').get();
  const feed = db.prepare('SELECT title, body, dedup_key FROM content_items').get();
  assert.equal(media.title, 'Anthropic Q3');
  assert.equal(media.canonical_url, 'https://www.bbc.com/news/articles/anthropic-q3-revenue');
  assert.equal(media.dedup_key, null);
  assert.equal(feed.title, 'keep');
  assert.equal(feed.body, 'body');
  assert.equal(feed.dedup_key, null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM media_index_entries').get().n, 1);
  assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_media_article_dedup_key'`).get());
  db.close();
});

test('migration 72 adds lookup indexes without rewriting rows', () => {
  assert.equal(addArticleDedupLookupIndexes.toString().includes('UPDATE'), false);
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE content_items (workspace_id TEXT, id TEXT, source_url TEXT, title TEXT);
    CREATE TABLE media_index_entries (workspace_id TEXT, external_id TEXT, canonical_url TEXT, title TEXT);
    CREATE TABLE user_item_states (workspace_id TEXT, content_item_id TEXT, is_hidden INTEGER);
    INSERT INTO content_items VALUES ('local', 'keep', 'https://www.BBC.com/news/articles/anthropic-q3-revenue', 'keep');
    INSERT INTO media_index_entries VALUES ('local', 'bbc:old', 'https://www.bbc.com/news/articles/anthropic-q3-revenue', 'Anthropic Q3');
  `);
  addArticleDedupLookupIndexes(db);
  assert.equal(db.prepare('SELECT title, source_url FROM content_items').get().title, 'keep');
  assert.equal(db.prepare('SELECT title FROM media_index_entries').get().title, 'Anthropic Q3');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM content_items').get().n, 1);
  for (const name of ['idx_content_items_source_url_nocase', 'idx_media_canonical_url_nocase', 'idx_user_item_states_hidden']) {
    assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`).get(name), name);
  }
  db.close();
});

test('BBC media article ingested at 11:34 absorbs the 11:36 subscription copy', async () => {
  const clock = at1136 + 60_000;
  const fx = open(async () => new Response(rss({
    title: TITLE, guid: 'anthropic-q3', url: MEDIA_URL, publishedAt: at1134, summary: 'Short index line',
  })), () => clock);
  try {
    await fx.media.syncEnabled({ workspaceId: 'local', channel: 'macro', force: true });
    const before = fx.store.repositories.media.listEntries('local');
    assert.equal(before.length, 1);
    const feed = createFeedService({
      legacyRepository: fx.store,
      feedRepository: fx.store.repositories.feed,
      mediaPort: fx.media,
      sourcePort: feedPort({
        externalId: '8c74e34e-feed',
        title: TITLE,
        summary: '',
        body: BODY,
        sourceUrl: FEED_URL,
        authorName: 'BBC',
        publishedAt: at1136,
        originType: 'subscription',
        contentType: 'article',
      }),
    });
    const stats = await feed.refreshPersistedSource({ workspaceId: 'local', sourceId: 'content.rss', sourceInput: { feed: 'bbc' } });
    assert.equal(stats.added, 0);
    assert.equal(stats.skipped, 1);
    assert.equal(fx.store.repositories.media.listEntries('local').length, 1);
    assert.equal(fx.store.repositories.feed.listContentItems('local').length, 0);
    const snaps = fx.store.repositories.media.listSnapshots('local', before[0].externalId);
    assert.match(snaps.at(-1).bodyText, /two billion dollars/);
    assert.equal(fx.store.repositories.media.getEntries('local', [before[0].externalId])[0].title, TITLE);
  } finally { fx.close(); }
});

test('subscription ingested first stays the only row and keeps its title', async () => {
  const clock = at1136 + 60_000;
  const fx = open(async () => new Response(rss({
    title: `${TITLE} today`, guid: 'anthropic-q3', url: MEDIA_URL, publishedAt: at1134, summary: 'Enterprise demand lifted the quarter.',
  })), () => clock);
  try {
    const feed = createFeedService({
      legacyRepository: fx.store,
      feedRepository: fx.store.repositories.feed,
      mediaPort: fx.media,
      sourcePort: feedPort({
        externalId: '8c74e34e-feed',
        title: TITLE,
        summary: '',
        body: BODY,
        sourceUrl: FEED_URL,
        publishedAt: at1136,
        originType: 'subscription',
        contentType: 'article',
      }),
    });
    const stats = await feed.refreshPersistedSource({ workspaceId: 'local', sourceId: 'content.rss', sourceInput: { feed: 'bbc' } });
    assert.equal(stats.added, 1);
    await fx.media.syncEnabled({ workspaceId: 'local', channel: 'macro', force: true });
    assert.equal(fx.store.repositories.media.listEntries('local').length, 0);
    const items = fx.store.repositories.feed.listContentItems('local');
    assert.equal(items.length, 1);
    assert.equal(items[0].title, TITLE);
    assert.match(items[0].body, /two billion dollars/);
    assert.equal(items[0].summary, 'Enterprise demand lifted the quarter.');
  } finally { fx.close(); }
});

test('different BBC urls within five minutes merge, six minutes and other publishers do not', async () => {
  const near = open(async () => new Response(rss({
    title: SIMILAR, guid: 'near', url: 'https://www.bbc.com/news/articles/another-slug', publishedAt: at1134,
  })), () => at1136 + 60_000);
  try {
    const feed = createFeedService({
      legacyRepository: near.store, feedRepository: near.store.repositories.feed, mediaPort: near.media,
      sourcePort: feedPort({
        externalId: 'uk-feed', title: TITLE, body: BODY, summary: '',
        sourceUrl: 'https://www.bbc.co.uk/news/business/anthropic-record-quarter',
        publishedAt: at1136, originType: 'subscription', contentType: 'article',
      }),
    });
    await feed.refreshPersistedSource({ workspaceId: 'local', sourceId: 'content.rss', sourceInput: { feed: 'bbc' } });
    await near.media.syncEnabled({ workspaceId: 'local', channel: 'macro', force: true });
    assert.equal(near.store.repositories.media.listEntries('local').length, 0);
    assert.equal(near.store.repositories.feed.listContentItems('local').length, 1);
  } finally { near.close(); }

  const late = open(async () => new Response(rss({
    title: SIMILAR, guid: 'late', url: 'https://www.bbc.com/news/articles/late-slug', publishedAt: at1140,
  })), () => at1140 + 60_000);
  try {
    const feed = createFeedService({
      legacyRepository: late.store, feedRepository: late.store.repositories.feed, mediaPort: late.media,
      sourcePort: feedPort({
        externalId: 'late-feed', title: TITLE, body: BODY, summary: '',
        sourceUrl: 'https://www.bbc.co.uk/news/business/anthropic-late',
        publishedAt: at1134, originType: 'subscription', contentType: 'article',
      }),
    });
    await feed.refreshPersistedSource({ workspaceId: 'local', sourceId: 'content.rss', sourceInput: { feed: 'bbc' } });
    await late.media.syncEnabled({ workspaceId: 'local', channel: 'macro', force: true });
    assert.equal(late.store.repositories.media.listEntries('local').length, 1);
    assert.equal(late.store.repositories.feed.listContentItems('local').length, 1);
  } finally { late.close(); }

  const other = open(async () => new Response(rss({
    title: TITLE, guid: 'bbc-only', url: MEDIA_URL, publishedAt: at1134,
  })), () => at1136 + 60_000);
  try {
    await other.media.syncEnabled({ workspaceId: 'local', channel: 'macro', force: true });
    const feed = createFeedService({
      legacyRepository: other.store, feedRepository: other.store.repositories.feed, mediaPort: other.media,
      sourcePort: {
        persistence() {
          return {
            providerId: 'rss',
            sourceAccount: {
              externalId: 'https://www.reuters.com/technology',
              displayName: 'Reuters',
              profileUrl: 'https://www.reuters.com/technology',
              authMode: 'public',
              metadata: {},
            },
          };
        },
        async read() {
          return { data: { fetchedAt: at1136, items: [{
            externalId: 'reuters-1', title: TITLE, body: BODY, summary: '',
            sourceUrl: 'https://www.reuters.com/technology/anthropic-quarterly-revenue-2026-10-15/',
            publishedAt: at1136, originType: 'subscription', contentType: 'article',
          }] } };
        },
      },
    });
    const stats = await feed.refreshPersistedSource({ workspaceId: 'local', sourceId: 'content.rss', sourceInput: { feed: 'reuters' } });
    assert.equal(stats.added, 1);
    assert.equal(other.store.repositories.media.listEntries('local').length, 1);
    assert.equal(other.store.repositories.feed.listContentItems('local').length, 1);
  } finally { other.close(); }
});

test('hourly candidates collapse the BBC pair across hours and keep the media row', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'article-dedup-hour-'));
  const store = createStore(path.join(dir, 'test.db'));
  const port = createMediaConnector({ sources: [bbc], fetchImpl: async () => new Response(''), lookupImpl: async () => [{ address: '93.184.216.34' }] });
  const media = createMediaIngestionService({
    mediaRepository: store.repositories.media,
    feedRepository: store.repositories.feed,
    mediaPort: port,
    now: () => at1202,
  });
  const feed = createFeedService({
    legacyRepository: store,
    feedRepository: store.repositories.feed,
    mediaPort: media,
    sourcePort: { persistence() { return null; }, async read() { return { data: {} }; } },
  });
  let clock = at1136;
  t.mock.method(Date, 'now', () => clock);
  try {
    store.repositories.media.upsertEntry({
      workspaceId: 'local', externalId: 'bbc:anthropic', sourceKey: 'bbc', publisherKey: 'bbc', channel: 'macro',
      canonicalUrl: 'https://www.bbc.com/news/articles/anthropic-q3-revenue?at_campaign=rss',
      title: TITLE, summary: '', publishedAt: at1134, contentLevel: 'summary_only', contentHash: 'old',
      revision: 1, status: 'indexed', observedAt: at1134, createdAt: at1134, updatedAt: at1134,
    });
    const source = store.repositories.feed.upsertSourceAccount({
      workspaceId: 'local', provider: 'rss', externalId: 'https://feeds.bbci.co.uk/news/business/rss.xml',
      displayName: 'BBC', profileUrl: 'https://feeds.bbci.co.uk/news/business/rss.xml', authMode: 'public', metadata: {},
    });
    const sameHour = store.repositories.feed.saveCapture({
      workspaceId: 'local', provider: 'rss', externalId: '8c74e34e', sourceAccountId: source.id,
      sourceUrl: FEED_URL, title: TITLE, contentHash: 'feed-same', publishedAt: at1136, capturedAt: at1136, metadata: {},
    });
    store.repositories.feed.saveContentItem({
      workspaceId: 'local', captureId: sameHour.id, originType: 'subscription', contentType: 'article',
      title: TITLE, body: BODY, summary: '', sourceUrl: FEED_URL, publishedAt: at1136,
    });
    clock = at1202;
    const nextHour = store.repositories.feed.saveCapture({
      workspaceId: 'local', provider: 'rss', externalId: 'cross-hour', sourceAccountId: source.id,
      sourceUrl: 'https://www.bbc.com/news/articles/anthropic-q3-revenue/', title: TITLE, contentHash: 'feed-next',
      publishedAt: at1134, capturedAt: at1202, metadata: {},
    });
    store.repositories.feed.saveContentItem({
      workspaceId: 'local', captureId: nextHour.id, originType: 'subscription', contentType: 'article',
      title: TITLE, body: BODY, summary: '', sourceUrl: 'https://www.bbc.com/news/articles/anthropic-q3-revenue/', publishedAt: at1134,
    });
    const tree = createTreeMaterialPort({ feedService: feed, mediaService: media });
    const hour = Math.floor(at1134 / 3_600_000) * 3_600_000;
    const next = Math.floor(at1202 / 3_600_000) * 3_600_000;
    const current = await tree.candidates('local', { startAt: hour, endAt: hour + 3_600_000 });
    const later = await tree.candidates('local', { startAt: next, endAt: next + 3_600_000 });
    assert.deepEqual(current.map((row) => row.id), ['media:bbc:anthropic']);
    assert.equal(later.length, 0);
    assert.equal(store.repositories.media.listEntries('local').length, 1);
    assert.equal(store.repositories.feed.listContentItems('local').length, 2);
  } finally {
    t.mock.restoreAll();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
