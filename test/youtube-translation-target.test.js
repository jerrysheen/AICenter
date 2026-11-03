import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createFeedRepository } from '../packages/database/src/repositories/feed-repository.js';

test('YouTube translation identity checks use indexed lookups and preserve workspace scope', () => {
  const database = new Database(':memory:');
  try {
    database.exec(`
      CREATE TABLE captures(id TEXT PRIMARY KEY, workspace_id TEXT, provider TEXT, external_id TEXT,
        UNIQUE(workspace_id, provider, external_id));
      CREATE TABLE content_items(id TEXT PRIMARY KEY, workspace_id TEXT, capture_id TEXT UNIQUE);
      INSERT INTO captures VALUES ('yt-c', 'local', 'youtube', 'video-1'),
        ('x-c', 'local', 'x', 'post-1'), ('other-c', 'other', 'youtube', 'video-2');
      INSERT INTO content_items VALUES ('yt-item', 'local', 'yt-c'),
        ('x-item', 'local', 'x-c'), ('other-item', 'other', 'other-c');
    `);
    const plans = [];
    const feed = createFeedRepository({
      prepare(sql) {
        const statement = database.prepare(sql);
        return { get(...args) {
          plans.push(...database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(row => row.detail));
          return statement.get(...args);
        } };
      },
    }, () => {});
    assert.equal(feed.isYoutubeTranslationTarget('local', 'youtube:video-1'), true);
    assert.equal(feed.isYoutubeTranslationTarget('local', 'yt-item'), true);
    assert.equal(feed.isYoutubeTranslationTarget('local', 'video-1'), true);
    assert.equal(feed.isYoutubeTranslationTarget('local', 'x-item'), false);
    assert.equal(feed.isYoutubeTranslationTarget('local', 'h:missing'), false);
    assert.equal(feed.isYoutubeTranslationTarget('local', 'other-item'), false);
    assert.equal(feed.isYoutubeTranslationTarget('local', 'video-2'), false);
    assert.ok(plans.length > 0);
    assert.ok(plans.every(plan => !/\bSCAN (?:ci|c)\b/.test(plan)), plans.join('\n'));
    for (const plan of plans.filter(plan => /SEARCH c .*workspace_id=/.test(plan))) {
      assert.match(plan, /external_id=\?/, `provider lookup must include the external identity: ${plan}`);
    }
  } finally {
    database.close();
  }
});
