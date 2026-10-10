import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaFeedCache, createMediaFeedLoader } from '../apps/web/public/media-feed.js';

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function page(prefix, count = 12, nextOffset = null) {
  return { items: Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}`, body: 'Stored article', tags: ['ai'] })), nextOffset };
}
function fixture(cache = createMediaFeedCache({ storage: storage() })) {
  const context = { scope: 'device:a', selection: { channel: 'tech', view: 'full' }, calls: [], shown: [], loading: [] };
  const loader = createMediaFeedLoader({ cache, getScope: () => context.scope, getSelection: () => context.selection,
    readFeed: query => { const wait = deferred(); context.calls.push({ query, ...wait }); return wait.promise; },
    onFeed: (feed, meta) => context.shown.push({ feed, meta }), onLoading: value => context.loading.push(value) });
  return { ...context, context, cache, loader };
}

test('authorized device renders cached articles before a slow network read and does not wait for tags', async () => {
  const cache = createMediaFeedCache({ storage: storage() });
  cache.set('device:a', 'tech:full', page('old'));
  const f = fixture(cache);
  const pending = f.loader.load();
  assert.equal(f.shown.at(-1).feed.items[0].id, 'old-0');
  assert.equal(f.shown.at(-1).meta.cached, true);
  await Promise.resolve();
  assert.equal(f.calls[0].query.limit, 12);
  f.calls[0].resolve({ feed: page('new') });
  await pending;
  assert.equal(f.shown.at(-1).feed.items[0].id, 'new-0');
  assert.deepEqual(f.shown.at(-1).feed.items[0].tags, ['ai']);
  assert.deepEqual(f.loading, [true, false]);
  assert.equal(cache.get('device:a', 'tech:full').items[0].id, 'new-0');
});

test('unpaired devices never read or display the device cache', async () => {
  const f = fixture(); f.context.scope = '';
  assert.equal(await f.loader.load(), null);
  assert.equal(f.calls.length, 0); assert.equal(f.shown.length, 0);
});

test('duplicate requests share a network read and old channels cannot overwrite the current channel', async () => {
  const f = fixture();
  const first = f.loader.load(); assert.equal(f.loader.load(), first);
  await Promise.resolve();
  f.context.selection = { channel: 'macro', view: 'full' };
  const second = f.loader.load(); await Promise.resolve();
  f.calls[1].resolve({ feed: page('macro') }); await second;
  f.calls[0].resolve({ feed: page('tech') }); await first;
  assert.equal(f.calls.length, 2);
  assert.equal(f.shown.at(-1).feed.items[0].id, 'macro-0');
  assert.deepEqual(f.loading, [true, true, false]);
});

test('pagination appends, deduplicates, keeps the server offset and refreshes the loaded range', async () => {
  const f = fixture();
  const first = f.loader.load(); await Promise.resolve();
  f.calls[0].resolve({ feed: page('first', 12, 12) }); await first;
  const next = f.loader.load({ append: true }); await Promise.resolve();
  assert.equal(f.calls[1].query.offset, 12); assert.equal(f.calls[1].query.limit, 12);
  const incoming = page('second', 12, 24); incoming.items[0] = page('first').items[0];
  f.calls[1].resolve({ feed: incoming }); await next;
  assert.equal(f.shown.at(-1).feed.items.length, 23);
  assert.equal(f.shown.at(-1).feed.nextOffset, 24);
  assert.equal(f.shown.at(-1).meta.append, true);
  const cached = f.cache.get('device:a', 'tech:full');
  assert.equal(cached.items.length, 12); assert.equal(cached.nextOffset, 12);
  const refresh = f.loader.load({ refresh: true }); await Promise.resolve();
  assert.equal(f.calls[2].query.limit, 23);
  f.calls[2].resolve({ feed: page('updated', 23, 23) }); await refresh;
});

test('a head merge reloads only the first page and keeps later pages and opened text', async () => {
  const f = fixture();
  const first = f.loader.load(); await Promise.resolve();
  f.calls[0].resolve({ feed: page('first', 12, 12) }); await first;
  const next = f.loader.load({ append: true }); await Promise.resolve();
  f.calls[1].resolve({ feed: page('second', 12, 24) }); await next;
  const opened = f.shown.at(-1).feed.items[0];
  opened.body = '已展开的全文';
  opened.detail = 'full';
  const merge = f.loader.load({ merge: true }); await Promise.resolve();
  assert.equal(f.calls[2].query.offset, 0);
  assert.equal(f.calls[2].query.limit, 12);
  const head = page('first', 12, 12);
  head.items[0] = { id: 'first-0', body: '', detail: 'list' };
  f.calls[2].resolve({ feed: head }); await merge;
  const items = f.shown.at(-1).feed.items;
  assert.equal(items.length, 24);
  assert.equal(items[0].body, '已展开的全文');
  assert.equal(items[0].detail, 'full');
  assert.equal(items[12].id, 'second-0');
  assert.equal(f.shown.at(-1).feed.nextOffset, 24);
});

test('failed background updates keep cached content and release the loading state', async () => {
  const f = fixture(); f.cache.set('device:a', 'tech:full', page('old'));
  const pending = f.loader.load(); await Promise.resolve();
  f.calls[0].reject(new Error('network timeout'));
  await assert.rejects(pending, /network timeout/);
  assert.equal(f.shown.at(-1).feed.items[0].id, 'old-0');
  assert.equal(f.loading.at(-1), false);
});

test('logout and revoked authorization clear cache and discard late network responses', async () => {
  const f = fixture(); f.cache.set('device:a', 'tech:full', page('old'));
  const pending = f.loader.load(); await Promise.resolve();
  f.loader.reset(); f.context.scope = '';
  f.calls[0].resolve({ feed: page('late') }); await pending;
  assert.equal(f.cache.get('device:a', 'tech:full'), null);
  assert.equal(f.shown.at(-1).feed.items[0].id, 'old-0');
  f.context.scope = 'device:a';
  const revoked = f.loader.load(); await Promise.resolve();
  f.calls[1].reject(Object.assign(new Error('revoked'), { status: 401 }));
  await assert.rejects(revoked, /revoked/);
  assert.equal(f.cache.get('device:a', 'tech:full'), null);
});

test('cache expires, separates devices and tolerates malformed data or quota failures', () => {
  let clock = 1_000; const disk = storage();
  const cache = createMediaFeedCache({ storage: disk, now: () => clock });
  cache.set('device:a', 'tech:full', page('first'));
  assert.equal(cache.get('device:a', 'macro:full'), null);
  clock += 24 * 60 * 60 * 1000;
  assert.equal(cache.get('device:a', 'tech:full'), null);
  cache.set('device:a', 'tech:full', page('new'));
  assert.equal(cache.get('device:b', 'tech:full'), null);
  assert.equal(cache.get('device:a', 'tech:full'), null);
  disk.setItem('ai-center.media-feed.v2-admitted', '{');
  assert.equal(cache.get('device:a', 'tech:full'), null);
  const blocked = createMediaFeedCache({ storage: { getItem() { throw Error('blocked'); }, setItem() { throw Error('quota'); } } });
  assert.doesNotThrow(() => blocked.set('a', 'tech:full', page('data')));
  assert.equal(blocked.get('a', 'tech:full'), null);
  cache.set('device:a', 'tech:full', { items: [{ id: 'huge', body: 'x'.repeat(1_000_000) }] });
  assert.equal(cache.get('device:a', 'tech:full'), null);
});

test('reading an article updates every cached view without dropping articles or extending cache age', () => {
  let clock = 1000;
  const cache = createMediaFeedCache({ storage: storage(), now: () => clock });
  cache.set('device:a', 'tech:full', page('article'));
  cache.set('device:a', 'tech:all', page('article'));
  clock += 1000;
  cache.markRead('device:a', 'article-0');
  for (const view of ['full', 'all']) {
    assert.equal(cache.get('device:a', `tech:${view}`).items[0].isRead, true);
    assert.equal(cache.get('device:a', `tech:${view}`).items.length, 12);
  }
  clock = 1000 + 24 * 60 * 60 * 1000;
  assert.equal(cache.get('device:a', 'tech:full'), null);
});
