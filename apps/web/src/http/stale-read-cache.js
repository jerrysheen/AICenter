import { createMemorySnapshotCache } from '../../../../packages/runtime/src/snapshot-cache.js';

export const STORED_FEED_CACHE_TTL_MS = 20_000;
export const HARDWARE_PRICE_CACHE_TTL_MS = 45_000;
export const STORED_FEED_CACHE_PROVIDERS = new Set(['x', 'xueqiu']);

export function storedFeedCacheKey(workspaceId, providerId, query = {}) {
  const parts = Object.keys(query)
    .filter((key) => key !== 'refresh')
    .sort()
    .map((key) => `${key}=${query[key] ?? ''}`);
  return `${workspaceId}|${providerId}|${parts.join('&')}`;
}

export function createStaleReadCache({ ttlMs, now } = {}) {
  const caches = new Map();
  return {
    get(key, read, { refresh = false } = {}) {
      let cache = caches.get(key);
      if (!cache) {
        cache = createMemorySnapshotCache({ ttlMs, now, read });
        caches.set(key, cache);
      }
      return cache.get({ refresh });
    },
  };
}
