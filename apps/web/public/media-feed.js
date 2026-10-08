const CACHE_KEY = 'ai-center.media-feed.v2-admitted';
const MAX_AGE = 24 * 60 * 60 * 1000;
const MAX_CACHE_CHARS = 1_000_000;

// This is a bounded device display cache. SQLite remains the source of truth.
export function createMediaFeedCache({ storage, now = Date.now, pageSize = 12 } = {}) {
  function clear() {
    try { storage?.removeItem(CACHE_KEY); } catch { /* Storage may be unavailable. */ }
  }
  function read(scope) {
    try {
      const value = JSON.parse(storage?.getItem(CACHE_KEY) || 'null');
      if (value?.scope !== scope) { clear(); return []; }
      if (!Array.isArray(value.entries)) return [];
      return value.entries.filter(entry => entry.at <= now() && now() - entry.at < MAX_AGE
        && Array.isArray(entry.feed?.items));
    } catch { return []; }
  }
  return {
    clear,
    markRead(scope, id) {
      if (!scope) return;
      const entries = read(scope);
      for (const entry of entries) {
        entry.feed.items = entry.feed.items.map(item => item.id === id || item.resourceId === id
          ? { ...item, isRead: true } : item);
      }
      try { storage?.setItem(CACHE_KEY, JSON.stringify({ scope, entries })); } catch { /* Best effort. */ }
    },
    get(scope, key) {
      if (!scope) return null;
      return read(scope).find(entry => entry.key === key)?.feed || null;
    },
    set(scope, key, feed) {
      if (!scope) return;
      const snapshot = { ...feed, items: feed.items.slice(0, pageSize),
        nextOffset: feed.items.length > pageSize ? pageSize : feed.nextOffset };
      const entries = [{ key, at: now(), feed: snapshot }, ...read(scope).filter(entry => entry.key !== key)].slice(0, 6);
      try {
        while (entries.length && JSON.stringify({ scope, entries }).length > MAX_CACHE_CHARS) entries.pop();
        storage?.setItem(CACHE_KEY, JSON.stringify({ scope, entries }));
      } catch { /* Quota failures must not stop network reads or rendering. */ }
    },
  };
}

export function createMediaFeedLoader({ cache, getScope, getSelection, readFeed, onFeed, onLoading, pageSize = 12 }) {
  let version = 0;
  let selectionKey = '';
  let feed = null;
  let active = null;
  const pending = new Map();

  function reset() {
    version += 1;
    selectionKey = '';
    feed = null;
    active = null;
    pending.clear();
    cache.clear();
  }

  function load({ refresh = false, append = false } = {}) {
    const scope = getScope();
    if (!scope) return Promise.resolve(null);
    const selection = { ...getSelection() };
    const viewKey = `${selection.channel}:${selection.view}${selection.sourceKey ? ':'+selection.sourceKey : ''}`;
    const key = `${scope}:${viewKey}`;
    if (selectionKey !== key) {
      selectionKey = key;
      feed = cache.get(scope, viewKey);
      onFeed(feed || { items: [], counts: {}, sources: [], nextOffset: null }, { cached: Boolean(feed) });
    }
    if (append && feed?.nextOffset == null) return Promise.resolve(feed);
    const query = { ...selection, refresh, offset: append ? feed.nextOffset : 0,
      limit: append ? pageSize : Math.min(100, Math.max(pageSize, feed?.items.length || 0)) };
    const requestKey = `${key}:${query.offset}:${query.limit}:${refresh}`;
    if (active?.key === requestKey) return active.promise;
    const requestVersion = ++version;
    onLoading(true, { refresh, cached: Boolean(feed?.items.length) });
    const isCurrent = () => requestVersion === version && getScope() === scope
      && getSelection().channel === selection.channel && getSelection().view === selection.view && (getSelection().sourceKey || '') === (selection.sourceKey || '');
    if (!pending.has(requestKey)) {
      const request = Promise.resolve().then(() => readFeed(query));
      pending.set(requestKey, request);
      const forget = () => { if (pending.get(requestKey) === request) pending.delete(requestKey); };
      request.then(forget, forget);
    }
    const promise = pending.get(requestKey).then(payload => {
      if (!isCurrent()) return null;
      const incoming = payload.feed || { items: [] };
      const items = append ? [...new Map([...(feed?.items || []), ...incoming.items]
        .map(item => [item.id || item.externalId, item])).values()] : incoming.items;
      feed = { ...incoming, items };
      cache.set(scope, viewKey, feed);
      onFeed(feed, { cached: false, jobId: payload.jobId, append });
      return feed;
    }).catch(error => {
      if (!isCurrent()) return null;
      if (error.status === 401 || error.status === 403) reset();
      throw error;
    }).finally(() => {
      if (requestVersion === version) {
        active = null;
        onLoading(false, { refresh: false, cached: Boolean(feed?.items.length) });
      }
    });
    active = { key: requestKey, promise };
    return promise;
  }

  return { load, reset };
}

function translated(post) {
  const article = post?.articleTranslation;
  return article?.status === 'ready' && Boolean(article.bodyHash) && article.bodyHash === post.bodyHash;
}

function revision(post) {
  return `${post?.bodyHash || ''}:${post?.snapshotRevision || ''}:${post?.title || ''}`;
}

// Keep one authorized reading session in memory. A feed refresh must not replace
// the Chinese being read with English or mix translations from different bodies.
export function createMediaReaderSession() {
  let key = '', current = null, latest = null;
  return {
    clear() { key = ''; current = latest = null; },
    resolve(post, { scope, id } = {}) {
      if (!scope) { this.clear(); return { post:null, notice:'' }; }
      const nextKey = `${scope}:${id}`;
      if (nextKey !== key) { key = nextKey; current = latest = null; }
      if (post) latest = post;
      if (!current || !translated(current)) current = latest;
      if (!current) return { post:null, notice:'' };
      if (latest && translated(current)) {
        if (revision(latest) !== revision(current)) return { post:current, notice:'正文有更新，当前保留正在阅读的版本。', canUpdate:translated(latest) };
        if (!translated(latest)) return { post:current, notice:'后台正在更新，当前保留已载入的中文全文。' };
        current = latest;
      }
      return { post:current, notice:'' };
    },
    acceptUpdate() { if (translated(latest)) current = latest; },
  };
}

// A card, recent item, or focus snapshot can carry the saved text without paragraphs.
// That text is the body. It must not be replaced by a translation notice that has no switch.
export function mediaIndexBody(post, language, translated = '') {
  const original = String(post?.body || '');
  if (language === 'original' || !translated) return original;
  return translated;
}

export function mediaReaderParagraphs(post, language) {
  if (language === 'original') return post.paragraphs || [];
  const article = post.articleTranslation;
  const valid = Boolean(article?.bodyHash) && article.bodyHash === post.bodyHash;
  const byId = new Map((valid ? article.paragraphs || [] : []).map(paragraph => [paragraph.id,paragraph]));
  return (post.paragraphs || []).map(paragraph => byId.get(paragraph.id) || {
    id:paragraph.id, kind:'paragraph', text:'此段正在翻译…',
  });
}
