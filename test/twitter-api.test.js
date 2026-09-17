import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAiCenterServer } from '../apps/web/src/server.js';

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
  const app = createAiCenterServer({ host: '127.0.0.1', port: 0, dataDirectory: directory, twitterService });
  const address = await app.listen();
  try {
    const cached = await fetch(`${address.localUrl}/api/v1/feed/x?feed=for-you&limit=50`).then((response) => response.json());
    assert.equal(cached.ok, true);
    assert.equal(calls, 0);
    assert.equal(cached.feed.mode, 'empty');
    const live = await fetch(`${address.localUrl}/api/v1/feed/x?feed=for-you&limit=50&refresh=1`).then((response) => response.json());
    assert.equal(live.ok, true);
    assert.equal(calls, 1);
    assert.equal(live.feed.items[0].externalId, '1');
    const again = await fetch(`${address.localUrl}/api/v1/feed/x?feed=for-you&limit=50`).then((response) => response.json());
    assert.equal(calls, 1);
    assert.equal(again.feed.mode, 'cached');
    assert.equal(again.feed.items[0].id, 'x:1');
    const alias = await fetch(`${address.localUrl}/api/v1/feed?platform=x&limit=50`).then((response) => response.json());
    assert.equal(alias.feed.items[0].sourceUrl, 'https://x.com/OpenAI/status/1');
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
