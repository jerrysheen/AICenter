import { createMemorySnapshotCache } from '../../../../packages/runtime/src/snapshot-cache.js';
import { HARDWARE_PRICE_SNAPSHOT_TTL_MS } from '../../../../packages/runtime/src/web-snapshot-jobs.js';

export const STORED_FEED_CACHE_TTL_MS = 20_000;
export const HARDWARE_PRICE_CACHE_TTL_MS = HARDWARE_PRICE_SNAPSHOT_TTL_MS;
export const STORED_FEED_CACHE_PROVIDERS = new Set(['x', 'xueqiu']);

export function storedFeedCacheKey(workspaceId, providerId, query = {}) {
  const parts = Object.keys(query)
    .filter((key) => key !== 'refresh')
    .sort()
    .map((key) => {
      const value = query[key];
      const text = value && typeof value === 'object' ? JSON.stringify(value) : (value ?? '');
      return `${key}=${text}`;
    });
  return `${workspaceId}|${providerId}|${parts.join('&')}`;
}

export function createStaleReadCache({ ttlMs, now, refreshLeadMs = 0 } = {}) {
  const caches = new Map();
  return {
    get(key, read, { refresh = false } = {}) {
      let cache = caches.get(key);
      if (!cache) {
        cache = createMemorySnapshotCache({ ttlMs, now, read, refreshLeadMs });
        caches.set(key, cache);
      }
      return cache.get({ refresh });
    },
  };
}
