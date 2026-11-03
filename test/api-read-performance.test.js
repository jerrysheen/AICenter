import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createStore } from '../packages/database/src/index.js';
import { createFeedRepository } from '../packages/database/src/repositories/feed-repository.js';
import { createMediaIngestionService } from '../packages/domain/src/media-ingestion-service.js';
import { createMediaConnector } from '../packages/connectors/src/media/port.js';
import { fetchBargoGpuRates } from '../packages/connectors/src/gpu-price-sources.js';
import { startOffthreadJson } from '../apps/web/src/http/offthread-json.js';
import { assertTimeZone, zonedParts } from '../packages/domain/src/zoned-time.js';
import { describeYoutubeArticle, formatArticleWhen } from '../packages/domain/src/youtube-article-status.js';

function seed(store, externalId, approved) {
  const at = 1_700_000_000_000;
  store.repositories.media.upsertEntry({ workspaceId: 'local', externalId, sourceKey: 'fixture',
    publisherKey: 'fixture', channel: 'tech', canonicalUrl: `https://example.com/${externalId}`,
    title: externalId, summary: 'Preview', publishedAt: at, contentLevel: 'summary_only',
    contentHash: externalId, revision: 1, status: 'indexed', observedAt: at, createdAt: at, updatedAt: at });
  const capture = store.repositories.feed.saveCapture({ workspaceId: 'local', provider: 'media', externalId,
    contentHash: externalId, metadata: approved ? { filterRule: 'all-three-0.60', filterDecision: 'KEEP',
      filterScores: { reading_value: 0.8, specific_content: 0.8, sufficient_information: 0.8 } } : {} });
  return store.repositories.feed.saveContentItem({ workspaceId: 'local', captureId: capture.id,
    originType: 'subscription', contentType: 'article', title: externalId, body: 'Preview' });
}

test('strict media pagination passes approved identities without loading the entire index', () => {
  const store = createStore(':memory:');
  try {
    seed(store, 'approved', true);
    seed(store, 'unscored', false);
    const mediaRepository = { ...store.repositories.media,
      listEntries() { throw new Error('listing must not materialize every index entry'); } };
    const service = createMediaIngestionService({ mediaRepository, feedRepository: store.repositories.feed,
      mediaPort: createMediaConnector(), feedFilter: { config: { mode: 'enforce', rule: 'all-three-0.60' } } });
    const view = service.readFeed({ channel: 'tech', limit: 1 });
    assert.deepEqual(view.items.map(item => item.externalId), ['approved']);
    assert.equal(view.total, 1);
    assert.equal(store.repositories.media.listFeedPage('local', { approvedExternalIds: [] }).matched, 0);
    assert.equal(store.repositories.media.listFeedPage('local', { approvedExternalIds: ['approved', 'approved'] }).matched, 1);
    assert.equal(store.repositories.media.listFeedPage('local').matched, 2);
  } finally { store.close(); }
});

test('offthread media preserves projection and reflects state changes on the next request', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'api-media-read-'));
  const databasePath = path.join(directory, 'test.db');
  const store = createStore(databasePath);
  const config = { sources: [], budget: {} };
  const reader = startOffthreadJson({ databasePath, mediaSettings: { config, strictAdmission: true } });
  try {
    const item = seed(store, 'approved', true);
    seed(store, 'unscored', false);
    const connection = new Database(databasePath, { readonly: true });
    try {
      const plans = [];
      const feed = createFeedRepository({ prepare(sql) {
        const statement = connection.prepare(sql);
        return { all(...args) {
          plans.push(...connection.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(row => row.detail));
          return statement.all(...args);
        } };
      } }, () => {});
      const ids = [item.id, ...Array.from({ length: 450 }, (_, index) => `missing-${index}`)];
      assert.deepEqual(feed.listContentItemBriefs('local', ids).map(row => row.id), [item.id]);
      assert.deepEqual(feed.listContentSourceNames('local', ids).map(row => row.id), [item.id]);
      assert.deepEqual(feed.listContentItemBriefs('other', ids), []);
      assert.ok(plans.filter(plan => /SEARCH ci /.test(plan)).every(plan => /\(id=\?\)/.test(plan)), plans.join('\n'));
    } finally { connection.close(); }
    const service = createMediaIngestionService({ mediaRepository: store.repositories.media,
      feedRepository: store.repositories.feed, taggingRepository: store.repositories.tagging,
      mediaPort: createMediaConnector(config), feedFilter: { config: { mode: 'enforce', rule: 'all-three-0.60' } } });
    assert.equal(await reader.ready(), true);
    const task = { kind: 'media-feed', workspace: 'local', query: { channel: 'tech', fields: 'list', limit: 12 }, jobId: 'fixture-job' };
    const first = JSON.parse((await reader.build(task)).prepared.json.toString());
    const expected = service.readFeed(task.query);
    assert.deepEqual({ ...first.feed, fetchedAt: 0 }, { ...expected, fetchedAt: 0 });
    assert.equal(first.jobId, 'fixture-job');
    store.repositories.feed.upsertUserItemState({ workspaceId: 'local', contentItemId: item.id, isRead: true });
    const read = JSON.parse((await reader.build(task)).prepared.json.toString());
    assert.equal(read.feed.items[0].isRead, true);
    store.repositories.feed.upsertUserItemState({ workspaceId: 'local', contentItemId: item.id, isHidden: true });
    const hidden = JSON.parse((await reader.build(task)).prepared.json.toString());
    assert.equal(hidden.feed.items.length, 0);
    assert.equal(hidden.feed.total, 0);
  } finally {
    await reader.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('explicit timezone formatters are reused while daylight-saving offsets remain correct', () => {
  const Original = Intl.DateTimeFormat;
  let calls = 0;
  Intl.DateTimeFormat = function (...args) { calls += 1; return new Original(...args); };
  try {
    for (let index = 0; index < 20; index += 1) {
      zonedParts(Date.UTC(2026, 0, 1), 'Pacific/Chatham');
      assertTimeZone('Pacific/Chatham');
    }
    assert.equal(calls, 1);
    assert.equal(zonedParts(Date.parse('2026-03-08T06:30:00Z'), 'America/New_York').hour, 1);
    assert.equal(zonedParts(Date.parse('2026-03-08T07:30:00Z'), 'America/New_York').hour, 3);
    assert.throws(() => assertTimeZone('invalid-zone'), /无法识别时区/);
  } finally { Intl.DateTimeFormat = Original; }
});

test('a failed read thread rejects subsequent requests instead of waiting on its dead channel', { timeout: 5000 }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'api-read-failed-'));
  const databasePath = path.join(directory, 'test.db');
  const store = createStore(databasePath);
  store.close();
  const reader = startOffthreadJson({ databasePath, mediaSettings: { config: { discoveryPublishers: null } } });
  try {
    assert.equal(await reader.ready(), false);
    await assert.rejects(reader.build({ kind: 'media-feed' }), /尚未就绪/);
    assert.equal(reader.canReadMedia(), false);
  } finally {
    await reader.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an unknown podcast schedule does not render an epoch date', () => {
  assert.equal(formatArticleWhen(null, Date.now()), '');
  const view = describeYoutubeArticle({ articleStatus: 'pending', nextAt: null });
  assert.doesNotMatch(view.message, /1月1日/);
});

test('GPU fetch deadlines cover transports and response bodies that ignore cancellation', async () => {
  let transportSignal;
  await assert.rejects(fetchBargoGpuRates({ timeoutMs: 20, fetch: (_url, options) => {
    transportSignal = options.signal;
    return new Promise(() => {});
  } }), { name: 'TimeoutError' });
  assert.equal(transportSignal.aborted, true);
  await assert.rejects(fetchBargoGpuRates({ timeoutMs: 20,
    fetch: async () => ({ ok: true, text: () => new Promise(() => {}) }),
  }), { name: 'TimeoutError' });
  const controller = new AbortController();
  controller.abort(new Error('snapshot cancelled'));
  await assert.rejects(fetchBargoGpuRates({ signal: controller.signal,
    fetch() { throw new Error('cancelled task must not start another HTTP request'); },
  }), /snapshot cancelled/);
});
