const GAMMA_ORIGIN = 'https://gamma-api.polymarket.com';
const USER_AGENT = 'AI-Center/0.2 (local market-native reader)';

export function createPolymarketGate(options = {}) {
  const now = options.now || (() => Date.now());
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const minIntervalMs = Math.max(0, Number(options.minIntervalMs) || 0);
  const log = options.log || (() => {});
  const inflight = new Map();
  let tail = Promise.resolve();
  let nextSlot = 0;
  let backoffUntil = 0;

  function note429(retryAfterMs = 0) {
    const chosen = Math.min(60_000, Math.max(Number(retryAfterMs) || 0, 1_000));
    backoffUntil = Math.max(backoffUntil, now() + chosen);
    log('warn', `Polymarket HTTP 429 backoffMs=${chosen} retryAfterMs=${Number(retryAfterMs) || 0}`);
    return chosen;
  }

  function request(key, task) {
    const existing = inflight.get(key);
    if (existing) return existing;
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    inflight.set(key, promise);
    tail = tail.catch(() => {}).then(async () => {
      const wait = Math.max(0, Math.max(nextSlot, backoffUntil) - now());
      if (wait) await sleep(wait);
      nextSlot = now() + minIntervalMs;
      try {
        resolve(await task());
      } catch (error) {
        reject(error);
      } finally {
        if (inflight.get(key) === promise) inflight.delete(key);
      }
    });
    return promise;
  }

  return { request, note429, inflightCount: () => inflight.size };
}

let sharedGate = null;

export function sharedPolymarketGate(options = {}) {
  if (!sharedGate) sharedGate = createPolymarketGate({ minIntervalMs: 800, ...options });
  return sharedGate;
}

export function resetSharedPolymarketGate() {
  sharedGate = null;
}

function decimal(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') {
    const normalized = value.trim();
    return /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized) ? normalized : null;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const plain = number.toLocaleString('en-US', { useGrouping: false, maximumSignificantDigits: 21 });
  return /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(plain) ? plain : null;
}

function probability(value) {
  const parsed = decimal(value);
  if (parsed == null) return null;
  const number = Number(parsed);
  if (!Number.isFinite(number) || number < 0 || number > 1) return null;
  return parsed;
}

function midpoint(bid, ask, fallback = null) {
  const left = Number(bid);
  const right = Number(ask);
  if (Number.isFinite(left) && Number.isFinite(right) && right > 0 && left >= 0 && left <= 1 && right <= 1) {
    return probability((left + right) / 2);
  }
  return probability(fallback);
}

function timestamp(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function outcomeKeyFromLabel(label) {
  const key = String(label || 'yes').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return (key || 'yes').slice(0, 80);
}

export function parsePolymarketEvent(event, observedAt = Date.now()) {
  if (!event || event.id == null) return [];
  const eventId = String(event.id);
  const eventSlug = String(event.slug || '');
  const title = String(event.title || eventSlug || eventId).trim();
  const sourceUrl = `https://polymarket.com/event/${encodeURIComponent(eventSlug || eventId)}`;
  const eventVolume = decimal(event.volume24hr);
  const eventTotal = decimal(event.volume);
  const tags = (Array.isArray(event.tags) ? event.tags : [])
    .map((tag) => String(tag?.slug || tag || '').trim().toLowerCase())
    .filter(Boolean);
  const rows = [];
  for (const market of Array.isArray(event.markets) ? event.markets : []) {
    if (market?.id == null) continue;
    const outcomes = parseArray(market.outcomes);
    const prices = parseArray(market.outcomePrices);
    const yesIndex = Math.max(outcomes.findIndex((outcome) => String(outcome).toLowerCase() === 'yes'), 0);
    const label = String(market.groupItemTitle || outcomes[yesIndex] || 'Yes').trim() || 'Yes';
    const closed = Boolean(event.closed || market.closed);
    rows.push({
      eventId,
      marketId: String(market.id),
      outcomeKey: outcomeKeyFromLabel(label),
      eventSlug,
      marketSlug: String(market.slug || ''),
      title,
      outcomeLabel: label,
      closed,
      endAt: timestamp(market.endDate || event.endDate),
      liquidity: decimal(market.liquidity),
      volume24h: eventVolume ?? decimal(market.volume24hr),
      totalVolume: eventTotal ?? decimal(market.volume),
      probability: midpoint(market.bestBid, market.bestAsk, prices[yesIndex] ?? market.lastTradePrice),
      sourceUrl,
      tags,
      observedAt,
    });
  }
  return rows;
}

function parseRetryAfter(value) {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(String(value || ''));
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return 0;
}

function chunks(values, size) {
  const groups = [];
  for (let index = 0; index < values.length; index += size) groups.push(values.slice(index, index + size));
  return groups;
}

export function createPolymarketGammaClient(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('polymarket gamma client requires fetch');
  const gate = options.gate || sharedPolymarketGate({
    minIntervalMs: options.minIntervalMs ?? 800,
    now: options.now,
    sleep: options.sleep,
    log: options.log,
  });
  const batchSize = Math.max(1, Math.min(Number(options.batchSize) || 10, 20));

  async function getJson(pathAndQuery) {
    const url = `${GAMMA_ORIGIN}${pathAndQuery}`;
    const load = async () => {
      const response = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT } });
      if (response?.status === 429) {
        const retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after'));
        gate.note429(retryAfterMs);
        const error = new Error('HTTP 429');
        error.status = 429;
        error.retryAfterMs = retryAfterMs;
        throw error;
      }
      if (!response?.ok) throw new Error(`HTTP ${response?.status || 'unavailable'}`);
      return response.json();
    };
    try {
      return await gate.request(url, load);
    } catch (error) {
      if (error?.status !== 429) throw error;
      return gate.request(url, load);
    }
  }

  async function fetchBy(name, values, { limit } = {}) {
    const unique = [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
    const events = [];
    for (const group of chunks(unique, batchSize)) {
      const params = new URLSearchParams({ limit: String(limit || group.length) });
      for (const value of group) params.append(name, value);
      const rows = await getJson(`/events?${params}`);
      if (Array.isArray(rows)) events.push(...rows);
    }
    return events;
  }

  return Object.freeze({
    origin: GAMMA_ORIGIN,
    fetchEventsBySlugs(slugs) {
      return fetchBy('slug', slugs);
    },
    fetchEventsByIds(ids) {
      return fetchBy('id', ids);
    },
    async fetchEventsByTag(tag, { limit = 100, closed = false } = {}) {
      const params = new URLSearchParams({
        closed: closed ? 'true' : 'false',
        tag_slug: String(tag),
        order: 'volume24hr',
        ascending: 'false',
        limit: String(limit),
      });
      const rows = await getJson(`/events?${params}`);
      return Array.isArray(rows) ? rows : [];
    },
    async fetchEventsBySeries(seriesSlug, { limit = 50, closed = false } = {}) {
      const params = new URLSearchParams({
        closed: closed ? 'true' : 'false',
        series_slug: String(seriesSlug),
        limit: String(limit),
      });
      const rows = await getJson(`/events?${params}`);
      return Array.isArray(rows) ? rows : [];
    },
  });
}
