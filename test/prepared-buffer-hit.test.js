import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../packages/database/src/index.js';
import { createRouter } from '../apps/web/src/http/router.js';
import { createFeedRoutes } from '../apps/web/src/routes/feed-routes.js';
import { createHardwarePriceRoutes } from '../apps/web/src/routes/hardware-price-routes.js';
import { createPreparedSlotStore, packPreparedJson } from '../apps/web/src/http/prepared-slots.js';
import { startSnapshotBufferLoader } from '../apps/web/src/http/snapshot-buffer-loader.js';
import {
  feedListSnapshotKey,
  feedPrebuiltSlot,
  prebuiltSnapshotSlots,
} from '../packages/runtime/src/web-snapshot-jobs.js';
import { parseXFeedQuery, parseXueqiuFeedQuery } from '../packages/contracts/src/index.js';

function mockResponse() {
  return {
    status: 0,
    headers: null,
    body: '',
    ended: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.ended = true;
      this.body = body ? Buffer.from(body).toString('utf8') : '';
    },
  };
}

test('home and 7x24 resolve to a snapshot slot even when the limit is not 12', () => {
  const home = parseXueqiuFeedQuery({ feed: 'following', limit: '12' });
  const wide = parseXueqiuFeedQuery({ feed: 'following', limit: '50' });
  const live = parseXueqiuFeedQuery({ feed: '7x24', limit: '12' });
  const featured = parseXueqiuFeedQuery({ feed: 'jingxuan', limit: '50' });
  const readHead = parseXueqiuFeedQuery({ feed: 'livenews', limit: '12', before: `1,${Number.MAX_SAFE_INTEGER},~` });
  const page = parseXueqiuFeedQuery({ feed: 'following', limit: '12', before: '0,10,abc' });
  assert.equal(feedPrebuiltSlot('xueqiu', home), 'feed-list-xueqiu');
  assert.equal(feedPrebuiltSlot('xueqiu', wide), 'feed-list-xueqiu');
  assert.equal(feedPrebuiltSlot('xueqiu', live), 'feed-list-xueqiu-livenews');
  assert.equal(feedPrebuiltSlot('xueqiu', featured), 'feed-list-xueqiu-featured');
  assert.equal(feedListSnapshotKey('xueqiu', { ...readHead, limit: 12 }), 'feed-list-xueqiu-livenews-read');
  assert.equal(feedPrebuiltSlot('xueqiu', readHead), 'feed-list-xueqiu-livenews-read');
  assert.equal(feedPrebuiltSlot('xueqiu', page), '');
  assert.equal(feedPrebuiltSlot('xueqiu', { ...home, refresh: true }), '');
  assert.equal(feedPrebuiltSlot('x', parseXFeedQuery({ feed: 'following', limit: '50' })), 'feed-list-x');
  assert.equal(prebuiltSnapshotSlots().some((item) => item.slot === 'feed-list-xueqiu-livenews'), true);
});

test('xueqiu home and hardware list respond from the slot without calling the service', async () => {
  let feedCalls = 0;
  let priceCalls = 0;
  const slots = createPreparedSlotStore();
  const feedBody = '{"ok":true,"feed":{"items":[{"id":"xq-1"}]}}';
  const priceBody = '{"ok":true,"items":[{"id":"dram","rawCells":[]}]}';
  slots.publish('feed-list-xueqiu', packPreparedJson(feedBody, { generatedAt: 10 }));
  slots.publish('hardware-prices', packPreparedJson(priceBody, { generatedAt: 11 }));
  const router = createRouter([
    ...createFeedRoutes({ slots }),
    ...createHardwarePriceRoutes({ slots }),
  ]);
  const services = {
    feed: { async getExternalFeed() { feedCalls += 1; return { items: [] }; } },
    hardwarePrices: { list() { priceCalls += 1; return { items: [{ id: 'live' }] }; } },
  };
  const parsers = new Map([['xueqiu', parseXueqiuFeedQuery]]);
  const feedResponse = mockResponse();
  const started = performance.now();
  await router.dispatch({
    request: { method: 'GET', headers: {} },
    response: feedResponse,
    services,
    identity: { kind: 'desktop', device: null },
    url: new URL('http://local/api/v1/feed/xueqiu?feed=livenews&limit=12'),
    params: { values: ['xueqiu'] },
    feedQueryParsers: parsers,
  });
  const feedMs = performance.now() - started;
  assert.equal(feedResponse.status, 200);
  assert.equal(JSON.parse(feedResponse.body).pending, true);
  assert.equal(feedCalls, 0);
  const homeResponse = mockResponse();
  await router.dispatch({
    request: { method: 'GET', headers: {} },
    response: homeResponse,
    services,
    identity: { kind: 'desktop', device: null },
    url: new URL('http://local/api/v1/feed/xueqiu?feed=following&limit=50'),
    params: { values: ['xueqiu'] },
    feedQueryParsers: parsers,
  });
  assert.equal(homeResponse.body, feedBody);
  assert.equal(feedCalls, 0);
  const priceResponse = mockResponse();
  const priceStarted = performance.now();
  await router.dispatch({
    request: { method: 'GET', headers: {} },
    response: priceResponse,
    services,
    identity: { kind: 'desktop', device: null },
    url: new URL('http://local/api/v1/hardware-prices?limit=500'),
    params: { values: [] },
  });
  const priceMs = performance.now() - priceStarted;
  assert.equal(priceResponse.body, priceBody);
  assert.equal(priceCalls, 0);
  assert.equal(slots.stats().hit, 2);
  assert.ok(slots.stats().pending >= 1);
  console.log(JSON.stringify({
    feedSlotMs: Number(feedMs.toFixed(2)),
    hardwareSlotMs: Number(priceMs.toFixed(2)),
    hit: slots.stats().hit,
    pending: slots.stats().pending,
  }));
});

test('snapshot buffer thread packs a stored payload off the caller', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'prepared-slot-'));
  const file = path.join(directory, 'test.db');
  const store = createStore(file);
  try {
    const payload = { ok: true, items: [{ name: 'n'.repeat(80_000) }] };
    store.repositories.runtimeSnapshots.saveSnapshot('local', 'hardware-prices', payload, 42);
    store.close();
    const slots = createPreparedSlotStore();
    const loader = startSnapshotBufferLoader({
      databasePath: file,
      slots,
      keys: [{ workspace: 'local', snapshotKey: 'hardware-prices', slot: 'hardware-prices' }],
    });
    try {
      const started = performance.now();
      assert.equal(await loader.refresh(), true);
      const loadedMs = performance.now() - started;
      const slot = slots.get('hardware-prices');
      assert.equal(slot.generatedAt, 42);
      assert.match(slot.json.toString('utf8'), /"ok":true/);
      assert.ok(slot.gzipped?.length > 0);
      const response = mockResponse();
      const sendStarted = performance.now();
      slots.send({ headers: { 'accept-encoding': 'gzip' } }, response, 'hardware-prices');
      const sendMs = performance.now() - sendStarted;
      assert.equal(response.status, 200);
      assert.equal(response.headers['Content-Encoding'], 'gzip');
      console.log(JSON.stringify({
        snapshotBytes: slot.bytes,
        gzipBytes: slot.gzipped.length,
        threadLoadMs: Number(loadedMs.toFixed(2)),
        sendMs: Number(sendMs.toFixed(2)),
      }));
    } finally {
      await loader.stop();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
