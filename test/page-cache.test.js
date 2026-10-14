import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createIndexedDbPersist,
  createLocalStoragePersist,
  createPageCache,
  createSplitPersist,
  HOME_CACHE_MAX_AGE_MS,
  pageCacheFresh,
  pageCacheKey,
  pageStoreFor,
} from '../apps/web/public/page-cache.js';

function memoryStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    key(index) { return [...map.keys()][index] || null; },
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
    removeItem(key) { map.delete(key); },
  };
}

test('page cache keys include the user and evicts the oldest entry', async () => {
  const removed = [];
  const cache = createPageCache({
    maxBytes: 10,
    maxEntries: 2,
    persist: { async remove(key) { removed.push(key); }, async write() {}, async clear() {} },
  });
  const first = pageCacheKey('desktop:self', 'GET', '/api/v1/home/bootstrap');
  const second = pageCacheKey('phone:1', 'GET', '/api/v1/posts');
  await cache.write(first, { bodyText: '12345' });
  await cache.write(second, { bodyText: '67890' });
  await cache.write(pageCacheKey('desktop:self', 'GET', '/api/v1/markets'), { bodyText: 'abcde' });
  assert.equal(cache.peek(first), null);
  assert.ok(removed.includes(first));
  assert.equal(cache.peek(second).bodyText, '67890');
  await cache.clear();
  assert.equal(cache.peek(second), null);
});

test('small records stay in localStorage and large ones go to the other store', async () => {
  const storage = memoryStorage();
  const idbRows = new Map();
  const persist = createSplitPersist({
    maxLocalBytes: 8,
    local: createLocalStoragePersist(storage, { maxItemBytes: 8 }),
    idb: createIndexedDbPersist(async () => ({
      async read(key) { return idbRows.get(key) || null; },
      async write(key, record) { idbRows.set(key, record); },
      async remove(key) { idbRows.delete(key); },
      async clear() { idbRows.clear(); },
    })),
  });
  assert.equal(pageStoreFor(4, 8), 'local');
  assert.equal(pageStoreFor(20, 8), 'idb');
  await persist.write('small', { bodyText: '1234', bytes: 4, etag: 'W/"a"', savedAt: 1 });
  await persist.write('large', { bodyText: '123456789', bytes: 9, etag: '', savedAt: 2 });
  assert.equal(JSON.parse(storage.getItem('ai-center.page:small')).bodyText, '1234');
  assert.equal(storage.getItem('ai-center.page:large'), null);
  assert.equal((await persist.read('large')).bodyText, '123456789');
  await persist.clear();
  assert.equal(storage.getItem('ai-center.page:small'), null);
  assert.equal(await persist.read('large'), null);
});

test('a newer indexed record wins over an older localStorage body for the same key', async () => {
  const storage = memoryStorage();
  const idbRows = new Map();
  const persist = createSplitPersist({
    maxLocalBytes: 8,
    local: createLocalStoragePersist(storage, { maxItemBytes: 8 }),
    idb: createIndexedDbPersist(async () => ({
      async read(key) { return idbRows.get(key) || null; },
      async write(key, record) { idbRows.set(key, record); },
      async remove(key) { idbRows.delete(key); },
      async clear() { idbRows.clear(); },
    })),
  });
  const key = 'phone:1|GET|/api/v1/home/bootstrap?day=2026-10-14';
  storage.setItem(`ai-center.page:${key}`, JSON.stringify({ bodyText: 'yesterday', bytes: 9, savedAt: 1 }));
  idbRows.set(key, { bodyText: 'today', bytes: 5, savedAt: 2 });
  assert.equal((await persist.read(key)).bodyText, 'today');
  assert.equal(storage.getItem(`ai-center.page:${key}`), null);
});

test('homepage cache stays usable for two hours and then expires', () => {
  const now = Date.parse('2026-10-14T03:00:00.000Z');
  assert.equal(HOME_CACHE_MAX_AGE_MS, 2 * 60 * 60 * 1000);
  assert.equal(pageCacheFresh({ savedAt: now - HOME_CACHE_MAX_AGE_MS }, now), true);
  assert.equal(pageCacheFresh({ savedAt: now - HOME_CACHE_MAX_AGE_MS - 1 }, now), false);
  assert.equal(pageCacheFresh({ savedAt: now + 1 }, now), false);
  assert.equal(pageCacheFresh({}, now), false);
});
