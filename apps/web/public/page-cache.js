export const PAGE_CACHE_MAX_BYTES = 4 * 1024 * 1024;
export const PAGE_CACHE_MAX_ENTRIES = 80;
export const PAGE_CACHE_LOCAL_MAX_BYTES = 48 * 1024;
export const HOME_CACHE_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export function pageCacheFresh(record, now = Date.now(), maxAge = HOME_CACHE_MAX_AGE_MS) {
  const savedAt = Number(record?.savedAt);
  if (!Number.isFinite(savedAt)) return false;
  const age = now - savedAt;
  return age >= 0 && age <= maxAge;
}
const LOCAL_PREFIX = 'ai-center.page:';

export function pageCacheKey(user, method, path) {
  const clean = String(path || '').split('#')[0];
  return `${String(user || 'anon')}|${String(method || 'GET').toUpperCase()}|${clean}`;
}

export function pageStoreFor(bytes, maxLocal = PAGE_CACHE_LOCAL_MAX_BYTES) {
  return Number(bytes) <= maxLocal ? 'local' : 'idb';
}

export function createPageCache({
  memory = new Map(),
  persist,
  maxBytes = PAGE_CACHE_MAX_BYTES,
  maxEntries = PAGE_CACHE_MAX_ENTRIES,
  now = () => Date.now(),
} = {}) {
  const order = [];

  function totalBytes() {
    let sum = 0;
    for (const key of order) sum += Number(memory.get(key)?.bytes) || 0;
    return sum;
  }

  function evict() {
    const removed = [];
    while (order.length && (order.length > maxEntries || totalBytes() > maxBytes)) {
      const key = order.shift();
      memory.delete(key);
      removed.push(key);
    }
    return removed;
  }

  return {
    peek(key) {
      return memory.get(key) || null;
    },
    async read(key) {
      if (memory.has(key)) {
        const index = order.indexOf(key);
        if (index >= 0) {
          order.splice(index, 1);
          order.push(key);
        }
        return memory.get(key);
      }
      const stored = await persist?.read?.(key);
      if (!stored) return null;
      memory.set(key, stored);
      order.push(key);
      return stored;
    },
    async write(key, record) {
      const bodyText = typeof record?.bodyText === 'string' ? record.bodyText : JSON.stringify(record?.body ?? null);
      const next = {
        bodyText,
        etag: String(record?.etag || ''),
        savedAt: Number(record?.savedAt) || now(),
        bytes: bodyText.length,
      };
      const index = order.indexOf(key);
      if (index >= 0) order.splice(index, 1);
      memory.set(key, next);
      order.push(key);
      const removed = evict();
      if (!memory.has(key)) {
        await persist?.remove?.(key);
        return null;
      }
      await Promise.all(removed.filter((item) => item !== key).map((item) => persist?.remove?.(item)));
      await persist?.write?.(key, next);
      return next;
    },
    async clear() {
      memory.clear();
      order.length = 0;
      await persist?.clear?.();
    },
  };
}

export function createLocalStoragePersist(storage, { maxItemBytes = PAGE_CACHE_LOCAL_MAX_BYTES } = {}) {
  return {
    async read(key) {
      try {
        const raw = storage.getItem(`${LOCAL_PREFIX}${key}`);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    },
    async write(key, record) {
      if (pageStoreFor(record?.bytes, maxItemBytes) !== 'local') {
        try { storage.removeItem(`${LOCAL_PREFIX}${key}`); } catch { /* 大对象不进 localStorage */ }
        return;
      }
      try {
        storage.setItem(`${LOCAL_PREFIX}${key}`, JSON.stringify(record));
      } catch {
        /* 配额满了就只留内存。 */
      }
    },
    async remove(key) {
      try { storage.removeItem(`${LOCAL_PREFIX}${key}`); } catch { /* 清不掉不影响内存 */ }
    },
    async clear() {
      const names = [];
      for (let index = 0; index < storage.length; index += 1) names.push(storage.key(index));
      for (const name of names) {
        if (String(name || '').startsWith(LOCAL_PREFIX)) {
          try { storage.removeItem(name); } catch { /* 继续清下一把 */ }
        }
      }
    },
  };
}

export function createIndexedDbPersist(factory) {
  let opened = null;
  function open() {
    if (!opened) opened = Promise.resolve().then(() => factory?.()).catch(() => null);
    return opened;
  }
  return {
    async read(key) {
      const store = await open();
      return store?.read?.(key) || null;
    },
    async write(key, record) {
      const store = await open();
      await store?.write?.(key, record);
    },
    async remove(key) {
      const store = await open();
      await store?.remove?.(key);
    },
    async clear() {
      const store = await open();
      await store?.clear?.();
    },
  };
}

export function createSplitPersist({ local, idb, maxLocalBytes = PAGE_CACHE_LOCAL_MAX_BYTES } = {}) {
  return {
    async read(key) {
      const localRecord = await local?.read?.(key);
      const idbRecord = await idb?.read?.(key);
      if (localRecord && idbRecord) {
        const localAt = Number(localRecord.savedAt) || 0;
        const idbAt = Number(idbRecord.savedAt) || 0;
        if (idbAt >= localAt) {
          await local?.remove?.(key);
          return idbRecord;
        }
        await idb?.remove?.(key);
        return localRecord;
      }
      return localRecord || idbRecord || null;
    },
    async write(key, record) {
      if (pageStoreFor(record?.bytes, maxLocalBytes) === 'local') {
        await local?.write?.(key, record);
        await idb?.remove?.(key);
        return;
      }
      await local?.remove?.(key);
      await idb?.write?.(key, record);
    },
    async remove(key) {
      await local?.remove?.(key);
      await idb?.remove?.(key);
    },
    async clear() {
      await local?.clear?.();
      await idb?.clear?.();
    },
  };
}

function openIndexedDb() {
  const indexedDB = globalThis.indexedDB;
  if (!indexedDB) return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open('ai-center-page-cache', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages');
    };
    request.onerror = () => resolve(null);
    request.onsuccess = () => {
      const db = request.result;
      resolve({
        read(key) {
          return new Promise((done) => {
            const tx = db.transaction('pages', 'readonly');
            const get = tx.objectStore('pages').get(key);
            get.onsuccess = () => done(get.result || null);
            get.onerror = () => done(null);
          });
        },
        write(key, record) {
          return new Promise((done) => {
            const tx = db.transaction('pages', 'readwrite');
            tx.objectStore('pages').put(record, key);
            tx.oncomplete = () => done();
            tx.onerror = () => done();
          });
        },
        remove(key) {
          return new Promise((done) => {
            const tx = db.transaction('pages', 'readwrite');
            tx.objectStore('pages').delete(key);
            tx.oncomplete = () => done();
            tx.onerror = () => done();
          });
        },
        clear() {
          return new Promise((done) => {
            const tx = db.transaction('pages', 'readwrite');
            tx.objectStore('pages').clear();
            tx.oncomplete = () => done();
            tx.onerror = () => done();
          });
        },
      });
    };
  });
}

export function browserPagePersist() {
  const storage = globalThis.localStorage;
  const local = storage ? createLocalStoragePersist(storage) : null;
  const idb = createIndexedDbPersist(openIndexedDb);
  return createSplitPersist({ local, idb });
}
