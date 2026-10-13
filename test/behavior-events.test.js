import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAiCenterServer } from '../apps/web/src/server.js';

test('behavior batch accepts the new events and keeps payloads small', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-behavior-'));
  const app = createAiCenterServer({ host: '127.0.0.1', port: 0, dataDirectory: directory });
  const address = await app.listen();
  try {
    const posted = await fetch(`${address.localUrl}/api/v1/behavior`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({
        events: [
          { name: 'nav.tab', metadata: { view: 'feed', page: 'media' } },
          { name: 'feed.loaded', metadata: { count: 12, platform: 'media' } },
          { name: 'article.open', metadata: { id: 'media:1' } },
          { name: 'view.slow', metadata: { view: 'sources', ms: 1400 } },
        ],
      }),
    });
    assert.equal(posted.status, 202);
    assert.equal((await posted.json()).accepted, 4);
    const metrics = await fetch(`${address.localUrl}/api/v1/metrics`);
    assert.equal(metrics.status, 200);
    const payload = await metrics.json();
    assert.equal(payload.metrics.feedsLoaded, 1);
    const rejected = await fetch(`${address.localUrl}/api/v1/behavior`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ name: 'click.everything', metadata: {} }),
    });
    assert.equal(rejected.status, 400);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('client records tab, article, share, hour, expand, original, ask and slow views', () => {
  const app = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');
  const tree = readFileSync(new URL('../apps/web/public/information-tree.js', import.meta.url), 'utf8');
  const brief = readFileSync(new URL('../apps/web/public/brief-page.js', import.meta.url), 'utf8');
  assert.match(app, /visibleFeedItems\(\)\.length/);
  assert.doesNotMatch(app, /logBehavior\('feed\.loaded', \{ count: state\.posts\.length \}\)/);
  for (const name of ['nav.tab', 'article.open', 'share.start', 'item.expand', 'source.original', 'ask.submit', 'view.slow']) {
    assert.match(app, new RegExp(name.replace('.', '\\.')));
  }
  assert.match(tree, /report\.hour/);
  assert.match(brief, /report\.hour/);
  assert.match(app, /text\/plain;charset=UTF-8/);
  assert.match(app, /If-None-Match/);
  assert.match(app, /notModified/);
  assert.match(brief, /information-tree\.js\?v=/);
});
