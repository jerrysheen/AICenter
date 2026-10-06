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

test('bilibili feed API caches imported transcripts and only fetches on POST', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-bili-'));
  let calls = 0;
  const bilibiliService = {
    async getFeed(query) {
      if (!query.refresh) {
        return { platform: 'bilibili', feed: 'imports', mode: 'empty', note: 'empty', items: [] };
      }
      calls += 1;
      return {
        platform: 'bilibili',
        feed: 'imports',
        mode: 'live',
        fetchedAt: 1,
        note: 'live',
        source: 'browser_runtime_player',
        items: [{
          id: 'bilibili:BV1cwtN6sEDr',
          workspaceId: 'local',
          platform: 'bilibili',
          externalId: 'BV1cwtN6sEDr',
          authorName: '结构笔记',
          authorHandle: '',
          title: '研读专利',
          summary: 'AI 中文字幕正文',
          body: 'AI 中文字幕正文',
          sourceUrl: 'https://www.bilibili.com/video/BV1cwtN6sEDr',
          publishedAt: 1,
          processing: '',
          subscriptionId: '',
          captureId: '',
          originType: 'import',
          contentType: 'transcript',
        }],
      };
    },
  };
  const app = createAiCenterServer({ host: '127.0.0.1', port: 0, dataDirectory: directory, bilibiliService,feedFilter:null });
  const address = await app.listen();
  try {
    const cached = await fetch(`${address.localUrl}/api/v1/feed/bilibili`).then((response) => response.json());
    assert.equal(cached.ok, true);
    assert.equal(calls, 0);
    assert.equal(cached.feed.mode, 'empty');
    const live = await fetch(`${address.localUrl}/api/v1/feed/bilibili`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: '【研读1081份专利后，我终于搞懂了华为为什么要做阔直板-哔哩哔哩】 https://b23.tv/BV1cwtN6sEDr',
      }),
    }).then((response) => response.json());
    assert.equal(live.ok, true);
    assert.equal(calls, 1);
    assert.equal(live.feed.added, 1);
    assert.equal(live.feed.items.length, 1);
    assert.equal(live.feed.items[0].id, 'bilibili:BV1cwtN6sEDr');
    tagStoredItems(path.join(directory, 'ai-center.db'));
    const again = await fetch(`${address.localUrl}/api/v1/feed/bilibili`).then((response) => response.json());
    assert.equal(calls, 1);
    assert.equal(again.feed.mode, 'cached');
    assert.equal(again.feed.items[0].id, 'bilibili:BV1cwtN6sEDr');
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
