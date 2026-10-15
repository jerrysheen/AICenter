import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { createStore } from '../packages/database/src/index.js';
import { createMediaIngestionService } from '../packages/domain/src/media-ingestion-service.js';
import config from '../config/media.json' with { type: 'json' };

const bbc = config.sources.find((source) => source.sourceKey === 'bbc');
const TITLE = 'Anthropic quarterly revenue reaches two billion dollars';
const PUBLISHED = Date.parse('2026-10-15T11:34:00+08:00');
const NOISE_AT = Date.parse('2024-01-01T00:00:00+08:00');

test('dedupeHourlyCandidates of 300 candidates stays under a second on 50k rows', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'article-dedup-perf-'));
  const file = path.join(dir, 'test.db');
  const store = createStore(file);
  const database = new Database(file);
  try {
    const insertItem = database.prepare(`INSERT INTO content_items
      (id, workspace_id, origin_type, content_type, title, body, summary, source_url, author_name, published_at, created_at, updated_at, dedup_key)
      VALUES (?, 'local', 'subscription', 'article', ?, '', '', ?, '', ?, ?, ?, NULL)`);
    const insertMedia = database.prepare(`INSERT INTO media_index_entries
      (workspace_id, external_id, source_key, publisher_key, channel, canonical_url, title, summary,
       published_at_raw, content_level, content_hash, revision, status, origin_url, discovered_via_json,
       observed_at, body_hash, truncated, created_at, updated_at, published_at, dedup_key)
      VALUES ('local', ?, 'example', 'example', 'macro', ?, ?, '', '', 'summary_only', ?, 1, 'indexed', '', '', ?, '', 0, ?, ?, ?, NULL)`);
    database.transaction(() => {
      for (let index = 0; index < 50_000; index += 1) {
        const id = String(index).padStart(6, '0');
        insertItem.run(
          `noise-${id}`,
          `Noise ${id}`,
          `https://noise.example/p/${id}`,
          NOISE_AT + index * 60_000,
          NOISE_AT + index,
          NOISE_AT + index,
        );
      }
      insertItem.run(
        'bbc-feed',
        TITLE,
        'https://www.BBC.com/news/articles/anthropic-q3-revenue/?utm_source=rss',
        PUBLISHED,
        PUBLISHED,
        PUBLISHED,
      );
      for (let index = 0; index < 5_000; index += 1) {
        const id = String(index).padStart(6, '0');
        insertMedia.run(
          `noise:${id}`,
          `https://noise.example/m/${id}`,
          `Media ${id}`,
          `hash-${id}`,
          NOISE_AT,
          NOISE_AT,
          NOISE_AT,
          NOISE_AT,
        );
      }
      insertMedia.run(
        'bbc:anthropic',
        'https://www.BBC.com/news/articles/anthropic-q3-revenue?at_campaign=rss',
        TITLE,
        'hash-bbc',
        PUBLISHED,
        PUBLISHED,
        PUBLISHED,
        PUBLISHED,
      );
    })();

    const feedPlan = store.repositories.feed.explainFeedUrlPrefix().join('\n');
    const mediaPlan = store.repositories.media.explainMediaUrlPrefix().join('\n');
    assert.match(feedPlan, /SEARCH ci USING (?:COVERING )?INDEX idx_content_items_source_url_nocase/);
    assert.doesNotMatch(feedPlan, /SCAN ci/);
    assert.match(mediaPlan, /SEARCH media_index_entries USING (?:COVERING )?INDEX idx_media_canonical_url_nocase/);
    assert.equal(database.prepare(`SELECT dedup_key FROM content_items WHERE id = 'bbc-feed'`).get().dedup_key, null);

    const media = createMediaIngestionService({
      mediaRepository: store.repositories.media,
      feedRepository: store.repositories.feed,
      mediaPort: { sources: [bbc] },
      now: () => PUBLISHED,
    });
    const candidates = [{
      id: 'media:bbc:anthropic',
      sourceUrl: 'https://www.bbc.com/news/articles/anthropic-q3-revenue?at_campaign=rss',
      title: TITLE,
      publishedAt: PUBLISHED,
      eventAt: PUBLISHED,
      sourceKey: 'bbc',
      publisherKey: 'bbc',
    }, {
      id: 'feed:bbc-feed',
      sourceUrl: 'https://bbc.com/news/articles/anthropic-q3-revenue/',
      title: TITLE,
      publishedAt: PUBLISHED + 120_000,
      eventAt: PUBLISHED + 120_000,
      sourceExternalId: 'https://feeds.bbci.co.uk/news/business/rss.xml',
    }];
    for (let index = 0; index < 298; index += 1) {
      const id = String(index).padStart(6, '0');
      candidates.push({
        id: `feed:cand-${id}`,
        sourceUrl: `https://news.example/articles/${id}`,
        title: `Distinct hourly candidate ${id} with enough words`,
        publishedAt: PUBLISHED + index * 1_000,
        eventAt: PUBLISHED + index * 1_000,
      });
    }
    const started = performance.now();
    const kept = media.dedupeHourlyCandidates('local', candidates);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 1_000, `dedupeHourlyCandidates took ${elapsed.toFixed(1)}ms`);
    assert.equal(candidates.length, 300);
    assert.equal(kept.some((row) => row.id === 'media:bbc:anthropic'), true);
    assert.equal(kept.some((row) => row.id === 'feed:bbc-feed'), false);
    assert.equal(kept.length, 299);
    console.log(`dedupeHourlyCandidates 50k rows / 300 candidates: ${elapsed.toFixed(1)}ms`);
  } finally {
    database.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hidden external ids use the partial index and stay bounded', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'article-dedup-hidden-'));
  const file = path.join(dir, 'test.db');
  const store = createStore(file);
  const database = new Database(file);
  try {
    const plan = store.repositories.feed.explainHiddenExternalIds().join('\n');
    assert.match(plan, /SEARCH uis USING (?:COVERING )?INDEX idx_user_item_states_hidden/);
    assert.doesNotMatch(plan, /SCAN uis|SCAN ci|SCAN content_items/);
    database.prepare(`INSERT INTO captures
      (id, workspace_id, provider, external_id, source_url, title, content_hash, captured_at)
      VALUES ('cap-hidden', 'local', 'media', 'hidden-1', '', '', 'h', 1)`).run();
    database.prepare(`INSERT INTO captures
      (id, workspace_id, provider, external_id, source_url, title, content_hash, captured_at)
      VALUES ('cap-visible', 'local', 'media', 'visible-1', '', '', 'v', 1)`).run();
    database.prepare(`INSERT INTO content_items
      (id, workspace_id, capture_id, origin_type, content_type, created_at, updated_at)
      VALUES ('item-hidden', 'local', 'cap-hidden', 'subscription', 'article', 1, 1)`).run();
    database.prepare(`INSERT INTO content_items
      (id, workspace_id, capture_id, origin_type, content_type, created_at, updated_at)
      VALUES ('item-visible', 'local', 'cap-visible', 'subscription', 'article', 1, 1)`).run();
    database.prepare(`INSERT INTO user_item_states
      (workspace_id, content_item_id, is_hidden, updated_at) VALUES ('local', 'item-hidden', 1, 1)`).run();
    database.prepare(`INSERT INTO user_item_states
      (workspace_id, content_item_id, is_hidden, updated_at) VALUES ('local', 'item-visible', 0, 1)`).run();
    assert.deepEqual(store.repositories.feed.listHiddenExternalIds('local', 'media'), ['hidden-1']);
  } finally {
    database.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
