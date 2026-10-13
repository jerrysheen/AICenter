import test from 'node:test';
import assert from 'node:assert/strict';
import { createStaleReadCache, storedFeedCacheKey } from '../apps/web/src/http/stale-read-cache.js';

test('x and xueqiu share one in-flight read and then serve stale while refreshing', async () => {
  let now = 1_000;
  let reads = 0;
  const cache = createStaleReadCache({ ttlMs: 1_000, now: () => now });
  const key = storedFeedCacheKey('local', 'x', { limit: '12', feed: 'for-you', refresh: '1' });
  assert.equal(key.includes('refresh'), false);
  const read = async () => {
    reads += 1;
    return { items: reads };
  };
  assert.deepEqual(await cache.get(key, read), { items: 1 });
  assert.deepEqual(await cache.get(key, read), { items: 1 });
  assert.equal(reads, 1);
  now += 1_000;
  assert.deepEqual(await cache.get(key, read), { items: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 2);
  assert.deepEqual(await cache.get(key, read), { items: 2 });
});
