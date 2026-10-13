// Shared browser request layer. Lower priority numbers run first.
export const API_REQUEST_LIMIT = 6;
export const TRANSLATION_POLL_DEADLINE_MS = 90_000;
export const TRANSLATION_QUEUED_GIVE_UP_MS = 25_000;

export function requestDedupeKey(method, path) {
  const verb = String(method || 'GET').toUpperCase();
  const raw = String(path || '');
  const queryIndex = raw.indexOf('?');
  const pathname = queryIndex < 0 ? raw : raw.slice(0, queryIndex);
  const query = queryIndex < 0 ? '' : raw.slice(queryIndex + 1);
  if (verb === 'GET' && pathname === '/api/v1/reports/reading-hour') {
    const params = new URLSearchParams(query);
    const startAt = params.get('startAt');
    if (startAt) return `GET reading-hour:${params.get('scope') || 'hour'}:${startAt}:${params.get('endAt') || ''}`;
  }
  if (verb === 'GET' && pathname === '/api/v1/reports/reading-hour/snapshot') {
    const id = new URLSearchParams(query).get('id');
    if (id) return `GET reading-hour-snapshot:${id}`;
  }
  return `${verb} ${pathname}${query ? `?${query}` : ''}`;
}

export function cacheTtlFor(method, path) {
  if (String(method || 'GET').toUpperCase() !== 'GET') return 0;
  const raw = String(path || '');
  if (/[?&]refresh=1(?:&|$)/.test(raw)) return 0;
  const pathname = raw.split('?')[0];
  if (pathname.startsWith('/api/v1/translate/jobs/')) return 0;
  if (pathname === '/api/v1/session' || pathname.startsWith('/api/v1/behavior')) return 0;
  if (pathname === '/api/v1/reports/reading-hour'
    || pathname === '/api/v1/reports/reading-hour/index'
    || pathname === '/api/v1/reports/reading-hour/snapshot') return 30_000;
  if (pathname === '/api/v1/reports/daily/latest/brief') return 30_000;
  if (pathname.startsWith('/api/v1/reports/daily/brief')) return 15_000;
  if (pathname.startsWith('/api/v1/reports/tree')) return 15_000;
  if (pathname === '/api/v1/static-signals/board') return 20_000;
  if (pathname === '/api/v1/markets') return 15_000;
  if (pathname.startsWith('/api/v1/feed/')) return 8_000;
  if (pathname === '/api/v1/posts') return 5_000;
  return 4_000;
}

export function createRequestLayer({ maxInflight = API_REQUEST_LIMIT, now = () => Date.now() } = {}) {
  let active = 0;
  let seq = 0;
  const queue = [];
  const inflight = new Map();
  const cache = new Map();

  function pump() {
    queue.sort((left, right) => left.priority - right.priority || left.seq - right.seq);
    while (active < maxInflight && queue.length) {
      const job = queue.shift();
      active += 1;
      Promise.resolve()
        .then(job.factory)
        .then(job.resolve, job.reject)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  }

  function run(key, factory, { ttl = 0, bypass = false, priority = 4, share = true } = {}) {
    if (!bypass && ttl > 0) {
      const hit = cache.get(key);
      if (hit && hit.expires > now()) return Promise.resolve(hit.value);
    }
    const flightKey = bypass ? `${key} fresh` : key;
    if (share && inflight.has(flightKey)) return inflight.get(flightKey);
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    }).then((value) => {
      if (!bypass && ttl > 0) cache.set(key, { value, expires: now() + ttl });
      return value;
    });
    if (share) {
      inflight.set(flightKey, promise);
      promise.finally(() => {
        if (inflight.get(flightKey) === promise) inflight.delete(flightKey);
      });
    }
    queue.push({ priority, seq: seq += 1, factory, resolve, reject });
    pump();
    return promise;
  }

  return {
    run,
    get active() { return active; },
    get queued() { return queue.length; },
    clear() {
      cache.clear();
      inflight.clear();
    },
  };
}

export function planTranslationPoll({
  status = '',
  availableAt = null,
  now = 0,
  startedAt = 0,
  deadline = 0,
  sawRunning = false,
  missing = false,
  attempt = 0,
} = {}) {
  const at = Number(now);
  const end = Number(deadline);
  if (missing) return { stop: true, reason: 'missing' };
  if (status === 'completed') return { stop: true, reason: 'completed' };
  if (status === 'failed' || status === 'cancelled') return { stop: true, reason: status };
  if (at >= end) return { stop: true, reason: 'timeout' };
  if (status === 'queued' && sawRunning) return { stop: true, reason: 'requeued' };
  const readyAt = Number(availableAt);
  const claimable = !Number.isFinite(readyAt) || readyAt <= at;
  if (status === 'queued' && Number.isFinite(readyAt) && readyAt > end) return { stop: true, reason: 'deferred' };
  const waited = at - Number(startedAt);
  if ((status === 'queued' || status === 'pending') && waited >= TRANSLATION_QUEUED_GIVE_UP_MS && claimable) {
    return { stop: true, reason: 'unclaimed' };
  }
  if (status !== 'running' && status !== 'queued' && status !== 'pending' && waited >= TRANSLATION_QUEUED_GIVE_UP_MS) {
    return { stop: true, reason: 'unclaimed' };
  }
  const backoff = Math.min(8_000, Math.round(1_000 * (1.5 ** Math.max(0, Number(attempt) || 0))));
  const delay = Number.isFinite(readyAt) && readyAt > at
    ? Math.min(Math.max(readyAt - at, 1_000), 8_000)
    : backoff;
  return { stop: false, delay };
}
