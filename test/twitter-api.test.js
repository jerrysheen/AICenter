import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createAiCenterServer } from '../apps/web/src/server.js';

function tagStoredItems(databasePath) {
  const db = new Database(databasePath);
  const now = Date.now();
  const insert = db.prepare(`INSERT INTO resource_taggings
    (workspace_id, resource_type, resource_id, tags_json, tag_catalog_version, prompt_version,
     model, truncated_for_model, analyzed_at, created_at, updated_at)
    VALUES (?, 'content-item', ?, '["ai"]', 'tags_v1', 'tag_v1', 'test', 0, ?, ?, ?)
    ON CONFLICT(workspace_id, resource_type, resource_id) DO UPDATE SET
      tags_json = excluded.tags_json`);
  for (const item of db.prepare('SELECT id, workspace_id FROM content_items').all()) {
    insert.run(item.workspace_id, item.id, now, now, now);
  }
  db.close();
}

test('x feed API caches source items and only refreshes on demand', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-xfeed-'));
  let calls = 0;
  const twitterService = {
    async getFeed() {
      calls += 1;
      return {
        platform: 'x',
        feed: 'for-you',
        handle: '',
        mode: 'live',
        fetchedAt: 1,
        note: 'live',
        source: 'browser_runtime_home',
        items: [{
          id: 'x:1',
          workspaceId: 'local',
          platform: 'x',
          externalId: '1',
          authorName: 'OpenAI',
          authorHandle: '@OpenAI',
          title: 'hello',
          summary: 'hello',
          body: 'hello',
          sourceUrl: 'https://x.com/OpenAI/status/1',
          publishedAt: 1,
          processing: '',
          subscriptionId: '',
          captureId: '',
        }],
      };
    },
  };
  const app = createAiCenterServer({ host: '127.0.0.1', port: 0, dataDirectory: directory, twitterService,feedFilter:null });
  const address = await app.listen();
  try {
    const cached = await fetch(`${address.localUrl}/api/v1/feed/x?feed=for-you&limit=50`).then((response) => response.json());
    assert.equal(cached.ok, true);
    assert.equal(cached.pending, true);
    assert.equal(calls, 0);
    const live = await fetch(`${address.localUrl}/api/v1/feed/x?feed=for-you&limit=50&refresh=1`).then((response) => response.json());
    assert.equal(live.ok, true, JSON.stringify(live));
    assert.equal(calls, 1);
    assert.equal(live.feed.added, 1);
    assert.equal(live.feed.items.length, 1);
    assert.equal(live.feed.items[0].sourceUrl, 'https://x.com/OpenAI/status/1');
    tagStoredItems(path.join(directory, 'ai-center.db'));
    const again = await fetch(`${address.localUrl}/api/v1/feed/x?feed=for-you&limit=50`).then((response) => response.json());
    assert.equal(calls, 1);
    assert.equal(again.pending, true);
    const alias = await fetch(`${address.localUrl}/api/v1/feed?platform=x&limit=50&refresh=1`).then((response) => response.json());
    assert.equal(calls, 2);
    assert.equal(alias.feed.items[0].sourceUrl, 'https://x.com/OpenAI/status/1');
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
