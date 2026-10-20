import { createUsQuoteFallback } from './us-quote-fallback.js';

const SPARK_URL = 'https://query1.finance.yahoo.com/v7/finance/spark';
const CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
const SEARCH_URL = 'https://query1.finance.yahoo.com/v1/finance/search';
const COOKIE_URL = 'https://fc.yahoo.com';
const CRUMB_URL = 'https://query1.finance.yahoo.com/v1/test/getcrumb';
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_CACHE_MS = 30_000;
const CACHE_SPAN_MS = 45_000;
const US_INDEX_SYMBOLS = new Set(['^GSPC', '^DJI', '^IXIC', '^SOX', '^VIX']);
const DEFAULT_MIN_INTERVAL_MS = 800;
// The US board deadline defaults to 20s and this pump is shared with Asia and global.
// Two in-flight calls use the existing undici pool (connections: 2). Batches of
// 10 stay near a direct spark (~2.6s) instead of four serial 20-symbol calls.
// Queued tasks carry the board AbortSignal and are dropped once they have waited
// longer than that deadline, so a slow round cannot pile up behind the next one.
const BATCH_SIZE = 10;
const QUOTE_CONCURRENCY = 2;
const BACKOFF_BASE_MS = 15_000;
const BACKOFF_CAP_MS = 5 * 60_000;
const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: 'application/json',
};

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function chunk(items, size) {
  const groups = [];
  for (let index = 0; index < items.length; index += size) groups.push(items.slice(index, index + size));
  return groups;
}

function envInt(env, key, fallback, min, max) {
  const raw = env?.[key];
  if (raw == null || String(raw).trim() === '') return fallback;
  const value = Number(String(raw).trim());
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function yahooCacheMs(env = process.env) {
  return envInt(env, 'AI_CENTER_YAHOO_CACHE_MS', DEFAULT_CACHE_MS, 30_000, 60_000);
}

export function yahooMinIntervalMs(env = process.env) {
  return envInt(env, 'AI_CENTER_YAHOO_MIN_INTERVAL_MS', DEFAULT_MIN_INTERVAL_MS, 0, 10_000);
}

export function yahooTimeoutMs(env = process.env) {
  return envInt(env, 'AI_CENTER_YAHOO_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 1_000, 20_000);
}

export function yahooQueueMaxAgeMs(env = process.env) {
  return envInt(env, 'AI_CENTER_MARKET_BOARD_TIMEOUT_MS', 20_000, 1_000, 60_000);
}

// Leave the tail of the board deadline for the free backup (Tencent, then Sina).
// A 20s board timeout otherwise aborts Yahoo and the backup in the same instant.
export const YAHOO_FALLBACK_RESERVE_MS = 10_000;

export function quoteQueueBudget(limit) {
  const value = Number(limit) || 0;
  if (value >= YAHOO_FALLBACK_RESERVE_MS + 4_000) return value - YAHOO_FALLBACK_RESERVE_MS;
  return value;
}

function defaultLog(level, message) {
  const line = `[market] ${message}`;
  if (level === 'error') console.error(line);
  else console.warn(line);
}

function parseRetryAfter(value, nowMs) {
  if (value == null || String(value).trim() === '') return 0;
  const seconds = Number(String(value).trim());
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(String(value));
  if (Number.isFinite(date)) return Math.max(0, date - nowMs);
  return 0;
}

function cookieHeaderFrom(response) {
  const headers = response?.headers;
  if (!headers) return '';
  const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  const raw = list.length ? list : [headers.get('set-cookie')].filter(Boolean);
  return raw.map((item) => String(item).split(';')[0].trim()).filter((item) => item.includes('=')).join('; ');
}

export function quoteObservedAt(quote) {
  const asOf = Number(quote?.asOf);
  if (Number.isFinite(asOf) && asOf > 0) return asOf;
  const market = Number(quote?.marketTime);
  if (!Number.isFinite(market) || market <= 0) return null;
  return market > 10_000_000_000 ? market : market * 1000;
}

export function preferNewerQuote(current, incoming) {
  if (!incoming || incoming.lastPrice == null) return current || null;
  if (!current || current.lastPrice == null) return incoming;
  const prevAt = quoteObservedAt(current);
  const nextAt = quoteObservedAt(incoming);
  if (prevAt != null && (nextAt == null || nextAt < prevAt)) return current;
  return incoming;
}

export function isUsMarketSymbol(symbol) {
  const value = String(symbol || '').trim().toUpperCase();
  if (!value) return false;
  if (US_INDEX_SYMBOLS.has(value)) return true;
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(value);
}

export function createYahooQuoteLayer(options = {}) {
  const now = options.now || (() => Date.now());
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_MS;
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const log = options.log || defaultLog;
  const cache = new Map();
  const inflight = new Map();
  const jobs = [];
  let drainScheduled = false;
  let inFlight = 0;
  let fetcher = async () => [];
  let backoffUntil = 0;
  let backoffMs = BACKOFF_BASE_MS;
  let nextSlot = 0;

  function fresh(symbol) {
    const hit = cache.get(symbol);
    if (!hit) return null;
    const started = hit.since ?? hit.at;
    if (now() - hit.at >= cacheTtlMs || now() - started >= CACHE_SPAN_MS) return null;
    return hit.quote;
  }

  function remember(quote, since = now()) {
    const symbol = String(quote?.symbol || '').toUpperCase();
    if (!symbol || quote.lastPrice == null) return null;
    const next = { ...quote, symbol };
    const prev = cache.get(symbol)?.quote;
    const chosen = preferNewerQuote(prev, next);
    if (chosen !== next) return chosen;
    cache.set(symbol, { at: now(), since, quote: next });
    return next;
  }

  function backingOff() {
    return now() < backoffUntil;
  }

  function note429(retryAfterMs = 0) {
    const chosen = Math.min(BACKOFF_CAP_MS, Math.max(Number(retryAfterMs) || 0, backoffMs));
    backoffUntil = now() + chosen;
    log('warn', `Yahoo HTTP 429 backoffMs=${chosen} retryAfterMs=${Number(retryAfterMs) || 0}`);
    backoffMs = Math.min(BACKOFF_CAP_MS, Math.max(backoffMs, BACKOFF_BASE_MS) * 2);
  }

  function noteSuccess() {
    backoffMs = BACKOFF_BASE_MS;
  }

  function waiterExpired(waiter, at = Date.now()) {
    if (!waiter) return true;
    if (waiter.signal?.aborted) return true;
    return waiter.maxQueueMs > 0 && at - waiter.enqueuedAt >= waiter.maxQueueMs;
  }

  function slotLive(slot, at = Date.now()) {
    if (!slot?.waiters?.length) return false;
    return slot.waiters.some((waiter) => !waiterExpired(waiter, at));
  }

  function liveSymbols(symbols, at = Date.now()) {
    return (symbols || []).filter((symbol) => slotLive(inflight.get(symbol), at));
  }

  function skipQueued(job) {
    if (!job || job.started || !job.symbols?.length) return false;
    return liveSymbols(job.symbols).length === 0;
  }

  function discardQueued(job) {
    const index = jobs.indexOf(job);
    if (index < 0 || job.started) return;
    jobs.splice(index, 1);
    if (job.expiryTimer) clearTimeout(job.expiryTimer);
    job.resolve({ skipped: true });
  }

  function reap() {
    for (const job of [...jobs]) {
      if (skipQueued(job)) discardQueued(job);
    }
    for (const [symbol, slot] of [...inflight]) {
      if (slotLive(slot)) continue;
      slot.cancel?.();
      finish(symbol, null);
    }
  }

  function batchAbortSignal(waiters, lifetime) {
    const list = [...new Set((waiters || []).filter(Boolean))];
    const controller = new AbortController();
    const check = () => {
      if (lifetime?.aborted || (list.length > 0 && list.every((signal) => signal.aborted))) controller.abort();
    };
    if (lifetime) {
      if (lifetime.aborted) controller.abort();
      else lifetime.addEventListener('abort', check, { once: true });
    }
    for (const signal of list) {
      if (signal.aborted) check();
      else signal.addEventListener('abort', check, { once: true });
    }
    return controller.signal;
  }

  function schedule(task, lane = 'bulk', meta = {}) {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const symbols = Array.isArray(meta.symbols) ? meta.symbols : [];
    const job = {
      lane,
      task,
      resolve,
      reject,
      symbols,
      started: false,
      signals: [...new Set((meta.signals || []).filter(Boolean))],
    };
    if (symbols.length && liveSymbols(symbols).length === 0) {
      resolve({ skipped: true });
      return promise;
    }
    jobs.push(job);
    for (const signal of job.signals) {
      if (signal.aborted) reap();
      else signal.addEventListener('abort', reap, { once: true });
    }
    const expiryAt = symbols.reduce((soonest, symbol) => {
      for (const waiter of inflight.get(symbol)?.waiters || []) {
        if (!(waiter.maxQueueMs > 0) || waiter.signal?.aborted) continue;
        const at = waiter.enqueuedAt + waiter.maxQueueMs;
        if (soonest == null || at < soonest) soonest = at;
      }
      return soonest;
    }, null);
    if (expiryAt != null) {
      job.expiryTimer = setTimeout(reap, Math.max(0, expiryAt - Date.now()));
      job.expiryTimer.unref?.();
    }
    pump();
    return promise;
  }

  function pump() {
    reap();
    while (inFlight < QUOTE_CONCURRENCY) {
      const index = jobs.findIndex((job) => job.lane === 'us');
      const job = jobs[index >= 0 ? index : 0];
      if (!job) return;
      jobs.splice(index >= 0 ? index : 0, 1);
      if (job.expiryTimer) clearTimeout(job.expiryTimer);
      const wait = Math.max(0, nextSlot - Date.now());
      nextSlot = Date.now() + wait + minIntervalMs;
      inFlight += 1;
      job.started = true;
      Promise.resolve().then(async () => {
        if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
        if (job.symbols?.length && liveSymbols(job.symbols).length === 0) return { skipped: true };
        return job.task();
      }).then((value) => {
        job.resolve(value);
      }, (error) => {
        job.reject(error);
      }).finally(() => {
        inFlight -= 1;
        pump();
      });
    }
  }

  function quoteMap(quotes) {
    return new Map((quotes || []).filter((quote) => quote?.symbol).map((quote) => [String(quote.symbol).toUpperCase(), quote]));
  }

  function finish(symbol, quote) {
    const slot = inflight.get(symbol);
    if (!slot) return;
    inflight.delete(symbol);
    const cachedQuote = cache.get(symbol)?.quote;
    const chosen = quote && quote.lastPrice != null ? preferNewerQuote(cachedQuote, quote) : null;
    if (quote && chosen === quote) remember(quote, slot.since || now());
    slot.resolve(chosen || null);
  }

  function finishMany(symbols, map) {
    for (const symbol of symbols) finish(symbol, map.get(symbol) || null);
  }

  function dispatch(group, lane) {
    const chosen = [];
    for (const symbol of group) {
      const slot = inflight.get(symbol);
      if (!slot || slot.started) continue;
      if (!slotLive(slot)) {
        finish(symbol, null);
        continue;
      }
      chosen.push(symbol);
    }
    if (!chosen.length) return;
    const startedAt = now();
    const waiters = [];
    for (const symbol of chosen) {
      const slot = inflight.get(symbol);
      slot.started = true;
      if (!slot.since) slot.since = startedAt;
      waiters.push(...(slot.waiters || []));
    }
    const loadNow = fetcher;
    const signals = waiters.map((waiter) => waiter.signal).filter(Boolean);
    schedule(() => {
      const still = chosen.filter((symbol) => slotLive(inflight.get(symbol)));
      for (const symbol of chosen) {
        if (!still.includes(symbol) && inflight.has(symbol)) finish(symbol, null);
      }
      if (!still.length) return { skipped: true };
      if (backingOff()) return { blocked: true };
      const lifetime = new AbortController();
      for (const symbol of still) {
        const slot = inflight.get(symbol);
        if (slot) slot.cancel = () => lifetime.abort();
      }
      const batchSignal = batchAbortSignal(still.flatMap((symbol) => (
        (inflight.get(symbol)?.waiters || []).map((waiter) => waiter.signal).filter(Boolean)
      )), lifetime.signal);
      return loadNow(still, batchSignal);
    }, lane, { symbols: chosen, signals }).then((result) => {
      const open = chosen.filter((symbol) => inflight.has(symbol));
      if (result?.blocked || result?.skipped) {
        finishMany(open, new Map());
        return;
      }
      noteSuccess();
      finishMany(open, quoteMap(result));
    }).catch((error) => {
      if (error?.name === 'AbortError') {
        finishMany(chosen, new Map());
        return;
      }
      if (error?.status === 429) {
        note429(error.retryAfterMs || 0);
        const partial = quoteMap(error.partial);
        for (const quote of partial.values()) remember(quote);
        finishMany(group, partial);
        return;
      }
      if (error?.status === 404 && group.length > 1) {
        const mid = Math.ceil(group.length / 2);
        for (const symbol of group) {
          const slot = inflight.get(symbol);
          if (slot) slot.started = false;
        }
        dispatch(group.slice(0, mid), lane);
        dispatch(group.slice(mid), lane);
        return;
      }
      if (error?.status === 404) {
        log('warn', `Yahoo HTTP 404 symbol=${group[0]}`);
        finish(group[0], null);
        return;
      }
      log('error', `Yahoo 行情失败 ${error instanceof Error ? error.message : error}`);
      const partial = quoteMap(error?.partial);
      for (const quote of partial.values()) remember(quote);
      finishMany(group, partial);
    });
  }

  function drain() {
    reap();
    const pending = [];
    for (const [symbol, slot] of inflight) {
      if (!slot.started && slotLive(slot)) pending.push(symbol);
    }
    if (!pending.length) return;
    if (backingOff()) {
      for (const symbol of pending) finish(symbol, null);
      return;
    }
    const us = pending.filter((symbol) => isUsMarketSymbol(symbol));
    const bulk = pending.filter((symbol) => !isUsMarketSymbol(symbol));
    for (const group of chunk(us, BATCH_SIZE)) dispatch(group, 'us');
    for (const group of chunk(bulk, BATCH_SIZE)) dispatch(group, 'bulk');
  }

  function enqueue(symbols, load, meta = {}) {
    fetcher = load;
    const signal = meta.signal;
    const maxQueueMs = Number(meta.maxQueueMs) || 0;
    const enqueuedAt = Date.now();
    const pending = [];
    let added = false;
    for (const symbol of symbols) {
      const hit = fresh(symbol);
      if (hit) {
        pending.push(Promise.resolve(hit));
        continue;
      }
      let slot = inflight.get(symbol);
      if (!slot) {
        let resolve;
        const promise = new Promise((res) => { resolve = res; });
        slot = { resolve, promise, started: false, waiters: [] };
        inflight.set(symbol, slot);
        added = true;
      }
      if (!slot.waiters) slot.waiters = [];
      slot.waiters.push({ signal, maxQueueMs, enqueuedAt });
      pending.push(slot.promise);
    }
    if (signal) {
      if (signal.aborted) reap();
      else signal.addEventListener('abort', reap, { once: true });
    }
    if (added && !drainScheduled) {
      drainScheduled = true;
      queueMicrotask(() => {
        drainScheduled = false;
        drain();
      });
    }
    return Promise.all(pending);
  }

  return { fresh, remember, enqueue, backingOff, note429, noteSuccess, schedule };
}

let sharedLayer = null;

function sharedYahooQuoteLayer(options) {
  if (!sharedLayer) sharedLayer = createYahooQuoteLayer(options);
  return sharedLayer;
}

export function parseMarketSession(meta, nowSec = Math.floor(Date.now() / 1000)) {
  if (!meta || !isRecord(meta.currentTradingPeriod)) return 'closed';
  const period = meta.currentTradingPeriod;
  const regular = isRecord(period.regular) ? period.regular : null;
  const pre = isRecord(period.pre) ? period.pre : null;
  const post = isRecord(period.post) ? period.post : null;
  const inRange = (slot) => {
    const start = num(slot?.start);
    const end = num(slot?.end);
    return start !== null && end !== null && nowSec >= start && nowSec < end;
  };
  if (inRange(regular)) return 'regular';
  if (inRange(pre)) return 'pre';
  if (inRange(post)) return 'post';
  return 'closed';
}

function unixMs(value) {
  const at = num(value);
  if (at == null || at <= 0) return null;
  return at > 10_000_000_000 ? Math.trunc(at) : Math.trunc(at * 1000);
}

function periodBounds(meta, name) {
  const slot = isRecord(meta?.currentTradingPeriod) ? meta.currentTradingPeriod[name] : null;
  const start = unixMs(slot?.start);
  const end = unixMs(slot?.end);
  if (start == null || end == null || end <= start) return null;
  return { start, end };
}

function barsInPeriod(chart, bounds) {
  if (!bounds) return [];
  const timestamps = Array.isArray(chart?.timestamp) ? chart.timestamp : [];
  const quote = chart?.indicators?.quote?.[0] || {};
  const rows = [];
  for (let index = 0; index < timestamps.length; index += 1) {
    const at = unixMs(timestamps[index]);
    const close = num(quote.close?.[index]);
    if (at == null || close == null || at < bounds.start || at >= bounds.end) continue;
    rows.push({
      at,
      close,
      high: num(quote.high?.[index]),
      low: num(quote.low?.[index]),
      volume: num(quote.volume?.[index]),
    });
  }
  return rows;
}

function barRange(bars) {
  const highs = bars.map((bar) => bar.high).filter((value) => value != null);
  const lows = bars.map((bar) => bar.low).filter((value) => value != null);
  const volumes = bars.map((bar) => bar.volume).filter((value) => value != null);
  return {
    high: highs.length ? Math.max(...highs) : null,
    low: lows.length ? Math.min(...lows) : null,
    volume: volumes.length ? volumes.reduce((sum, value) => sum + value, 0) : null,
  };
}

export function quoteFromSpark(result, nowSec = Math.floor(Date.now() / 1000)) {
  const chart = result.response?.[0];
  const meta = chart?.meta;
  const symbol = text(result.symbol || meta?.symbol);
  if (!symbol || !meta) return null;
  const session = parseMarketSession(meta, nowSec);
  const closes = (chart?.indicators?.quote?.[0]?.close || []).filter((value) => typeof value === 'number' && Number.isFinite(value));
  const lastPrint = closes.at(-1) ?? null;
  const extended = session === 'pre' || session === 'post';
  const regularClose = num(meta.regularMarketPrice);
  const previous = num(meta.previousClose) ?? num(meta.chartPreviousClose);
  const bounds = extended ? periodBounds(meta, session) : null;
  const sessionBars = barsInPeriod(chart, bounds);
  const sessionStamp = extended
    ? (unixMs(session === 'pre' ? meta.preMarketTime : meta.postMarketTime) ?? (sessionBars.at(-1)?.at ?? null))
    : null;
  const fullday = num(meta.fulldayPrice);
  const extendedPrice = fullday ?? (sessionBars.at(-1)?.close ?? null);
  const distinctPrint = extendedPrice != null && (regularClose == null || Math.abs(extendedPrice - regularClose) > 1e-6);
  const hasExtendedPrint = extended && (sessionStamp != null || sessionBars.length > 0 || distinctPrint);
  const regularStamp = unixMs(meta.regularMarketTime);
  const regularBounds = periodBounds(meta, 'regular');
  const staleRegular = session === 'regular' && regularBounds != null && regularStamp != null && regularStamp < regularBounds.start;
  const lastPrice = hasExtendedPrint
    ? extendedPrice
    : (regularClose ?? fullday ?? lastPrint);
  const prevClose = hasExtendedPrint ? (regularClose ?? previous) : previous;
  let changePct = hasExtendedPrint
    ? (num(meta.fulldayChangePercent) ?? num(meta.regularMarketChangePercent))
    : (num(meta.regularMarketChangePercent) ?? num(meta.fulldayChangePercent));
  let change = lastPrice !== null && prevClose !== null ? lastPrice - prevClose : num(meta.fulldayChange);
  if (hasExtendedPrint && lastPrice !== null && prevClose !== null) {
    change = lastPrice - prevClose;
    changePct = prevClose ? (change / prevClose) * 100 : changePct;
  }
  const ranged = hasExtendedPrint ? barRange(sessionBars) : null;
  const asOf = hasExtendedPrint ? sessionStamp : (extended || staleRegular ? null : regularStamp);
  return {
    symbol,
    name: text(meta.shortName || meta.longName, symbol),
    lastPrice,
    changePct,
    change,
    open: closes[0] ?? null,
    high: ranged ? ranged.high : (extended || staleRegular ? null : num(meta.regularMarketDayHigh)),
    low: ranged ? ranged.low : (extended || staleRegular ? null : num(meta.regularMarketDayLow)),
    prevClose,
    volume: ranged ? ranged.volume : (extended || staleRegular ? null : num(meta.regularMarketVolume)),
    sparkline: closes,
    currency: text(meta.currency, 'USD'),
    exchange: text(meta.fullExchangeName || meta.exchangeName),
    marketTime: asOf == null ? null : Math.trunc(asOf / 1000),
    asOf,
    session,
  };
}

function mapOhlcSeries(symbol, timestamps, quote) {
  const opens = quote?.open || [];
  const highs = quote?.high || [];
  const lows = quote?.low || [];
  const closes = quote?.close || [];
  const volumes = quote?.volume || [];
  const points = [];
  const bars = [];
  for (let index = 0; index < timestamps.length; index += 1) {
    const at = num(timestamps[index]);
    const close = num(closes[index]);
    if (at == null || close == null) continue;
    const open = num(opens[index]) ?? close;
    const high = num(highs[index]) ?? Math.max(open, close);
    const low = num(lows[index]) ?? Math.min(open, close);
    const volume = num(volumes[index]);
    const ms = at > 10_000_000_000 ? at : at * 1000;
    points.push({ at: ms, close });
    bars.push({ at: ms, open, high, low, close, volume });
  }
  return points.length ? { symbol, points, bars } : null;
}

export function seriesFromSpark(result) {
  const chart = result.response?.[0];
  const meta = chart?.meta;
  const symbol = text(result.symbol || meta?.symbol).toUpperCase();
  if (!symbol) return null;
  const timestamps = Array.isArray(chart?.timestamp) ? chart.timestamp : [];
  return mapOhlcSeries(symbol, timestamps, chart?.indicators?.quote?.[0] || {});
}

export function barsFromChart(payload, symbolHint = '') {
  const result = payload?.chart?.result?.[0];
  if (!isRecord(result)) return null;
  const symbol = text(result.meta?.symbol || symbolHint).toUpperCase();
  if (!symbol) return null;
  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  return mapOhlcSeries(symbol, timestamps, result.indicators?.quote?.[0] || {});
}

export function createYahooClient(options = {}) {
  const env = options.env || process.env;
  const timeoutMs = options.timeoutMs ?? yahooTimeoutMs(env);
  const log = options.log || defaultLog;
  const injected = options.fetchImpl;
  const layer = options.layer || (injected
    ? createYahooQuoteLayer({ ...options, log, cacheTtlMs: options.cacheTtlMs, minIntervalMs: options.minIntervalMs ?? 0 })
    : sharedYahooQuoteLayer({
      cacheTtlMs: options.cacheTtlMs ?? yahooCacheMs(env),
      minIntervalMs: options.minIntervalMs ?? yahooMinIntervalMs(env),
      log,
    }));
  const fallback = options.fallback === undefined
    ? createUsQuoteFallback({ fetchImpl: injected, timeoutMs, now: options.now })
    : options.fallback;
  let transport = injected || null;
  let agent = null;
  let cookie = '';
  let crumb = '';
  let crumbFlight = null;

  async function loadTransport() {
    if (transport) return transport;
    const undici = await import('undici');
    agent = new undici.Agent({
      connections: 2,
      pipelining: 1,
      keepAliveTimeout: 4_000,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      connect: { timeout: Math.min(5_000, timeoutMs) },
    });
    transport = (url, init) => undici.fetch(url, { ...init, dispatcher: agent });
    return transport;
  }

  async function request(url, { withCrumb = true, cookieHeader = cookie, accept = 'application/json', signal } = {}) {
    const target = url instanceof URL ? new URL(url.href) : new URL(String(url));
    if (withCrumb && crumb) target.searchParams.set('crumb', crumb);
    const headers = { ...YAHOO_HEADERS, Accept: accept };
    if (cookieHeader) headers.Cookie = cookieHeader;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const fetchImpl = await loadTransport();
      const response = await fetchImpl(target, { headers, cache: 'no-store', signal: controller.signal });
      if (!response.ok) {
        await response.arrayBuffer().catch(() => {});
        const error = new Error(`Yahoo HTTP ${response.status}`);
        error.status = response.status;
        if (response.status === 429) error.retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), Date.now());
        throw error;
      }
      return response;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        if (signal?.aborted) {
          const aborted = new Error('Yahoo 行情已取消');
          aborted.name = 'AbortError';
          throw aborted;
        }
        throw new Error('Yahoo 行情请求超时。');
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (signal?.removeEventListener) signal.removeEventListener('abort', onAbort);
    }
  }

  async function requestJson(url, requestOptions) {
    const response = await request(url, requestOptions);
    return response.json();
  }

  function refreshCrumb() {
    if (!crumbFlight) {
      crumbFlight = loadCrumb().finally(() => { crumbFlight = null; });
    }
    return crumbFlight;
  }

  async function loadCrumb() {
    const fetchImpl = await loadTransport();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let cookieResponse;
    try {
      cookieResponse = await fetchImpl(COOKIE_URL, {
        headers: { ...YAHOO_HEADERS, Accept: '*/*' },
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error('Yahoo 行情请求超时。');
      throw error;
    } finally {
      clearTimeout(timer);
    }
    await cookieResponse.arrayBuffer().catch(() => {});
    const nextCookie = cookieHeaderFrom(cookieResponse);
    if (!nextCookie) throw new Error('Yahoo 没有返回 cookie');
    const crumbResponse = await request(CRUMB_URL, { withCrumb: false, cookieHeader: nextCookie, accept: 'text/plain' });
    const value = (await crumbResponse.text()).trim().replace(/^"|"$/g, '');
    if (!value || value.includes('<') || value.length > 128) throw new Error('Yahoo crumb 无效');
    cookie = nextCookie;
    crumb = value;
  }

  function sparkResults(payload) {
    if (isRecord(payload?.spark?.error)) {
      const code = String(payload.spark.error.code || payload.spark.error.description || '');
      if (/not found|404/i.test(code)) {
        const error = new Error('Yahoo HTTP 404');
        error.status = 404;
        throw error;
      }
      if (/unauthor|crumb|invalid/i.test(code)) {
        const error = new Error('Yahoo HTTP 401');
        error.status = 401;
        throw error;
      }
    }
    return isRecord(payload) && isRecord(payload.spark) && Array.isArray(payload.spark.result)
      ? payload.spark.result
      : [];
  }

  async function fetchSparkGroup(group, range, interval, includePrePost, attempt = 0, signal) {
    const url = new URL(SPARK_URL);
    url.searchParams.set('symbols', group.join(','));
    url.searchParams.set('range', range);
    url.searchParams.set('interval', interval);
    url.searchParams.set('includePrePost', includePrePost ? 'true' : 'false');
    try {
      const results = sparkResults(await requestJson(url, { signal }));
      if (!results.length && attempt < 1) {
        await refreshCrumb();
        return fetchSparkGroup(group, range, interval, includePrePost, attempt + 1, signal);
      }
      return results;
    } catch (error) {
      if (error?.status === 401 && attempt < 1 && !signal?.aborted) {
        await refreshCrumb();
        return fetchSparkGroup(group, range, interval, includePrePost, attempt + 1, signal);
      }
      throw error;
    }
  }

  function quotesFromSpark(results) {
    const quotes = [];
    for (const result of results) {
      const quote = quoteFromSpark(result);
      if (quote) quotes.push({ ...quote, provider: 'yahoo' });
    }
    return quotes;
  }

  async function loadSparkBatch(group, interval, signal) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (signal?.aborted) break;
      try {
        return quotesFromSpark(await fetchSparkGroup(group, '1d', interval, true, 0, signal));
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw error;
        if (error?.status === 429 || error?.status === 404) throw error;
        lastError = error;
        if (attempt === 0) {
          log('warn', `Yahoo 行情批失败，重试一次 ${group.length} 项 ${error instanceof Error ? error.message : error}`);
        }
      }
    }
    if (signal?.aborted) return [];
    log('error', `Yahoo 行情失败 ${lastError instanceof Error ? lastError.message : lastError}`);
    return fillFallback(group);
  }

  async function loadGroup(group, interval, signal) {
    if (!group.length || signal?.aborted) return [];
    try {
      return await loadSparkBatch(group, interval, signal);
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') return [];
      if (error?.status === 429) throw error;
      if (error?.status === 404) {
        if (group.length === 1) {
          log('warn', `Yahoo HTTP 404 symbol=${group[0]}`);
          return [];
        }
        const mid = Math.ceil(group.length / 2);
        const left = await loadGroup(group.slice(0, mid), interval, signal);
        const right = await loadGroup(group.slice(mid), interval, signal);
        return [...left, ...right];
      }
      log('error', `Yahoo 行情失败 ${error instanceof Error ? error.message : error}`);
      return fillFallback(group);
    }
  }

  async function loadSymbols(symbols, interval, signal) {
    const quotes = [];
    for (const group of chunk(symbols, BATCH_SIZE)) {
      if (signal?.aborted) break;
      try {
        quotes.push(...await loadGroup(group, interval, signal));
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') break;
        if (error?.status === 429) {
          error.partial = quotes;
          throw error;
        }
        log('error', `Yahoo 行情失败 ${error instanceof Error ? error.message : error}`);
        quotes.push(...await fillFallback(group));
      }
    }
    return quotes;
  }

  function pack(quotes, unique) {
    const bySymbol = new Map();
    for (const quote of quotes) {
      if (!quote?.symbol || quote.lastPrice == null) continue;
      const symbol = String(quote.symbol).toUpperCase();
      bySymbol.set(symbol, preferNewerQuote(bySymbol.get(symbol), { ...quote, symbol }) || quote);
    }
    const ordered = unique.map((symbol) => bySymbol.get(symbol)).filter(Boolean);
    const sessionQuote = ordered.find((quote) => quote.session === 'regular')
      || ordered.find((quote) => quote.session === 'pre')
      || ordered.find((quote) => quote.session === 'post')
      || ordered[0];
    return { quotes: ordered, session: sessionQuote?.session || 'closed' };
  }

  async function fillFallback(symbols) {
    if (!symbols.length || !fallback?.fetchQuotes) return [];
    try {
      const quotes = await fallback.fetchQuotes(symbols);
      const list = Array.isArray(quotes) ? quotes.filter((quote) => quote?.lastPrice != null) : [];
      for (const quote of list) layer.remember(quote);
      if (list.length) {
        const providers = [...new Set(list.map((quote) => quote.provider || 'fallback'))].join(',');
        log('warn', `Yahoo 不可用，改用备用行情 ${list.length} 项 source=${providers}`);
      }
      return list;
    } catch (error) {
      log('error', `备用行情失败 ${error instanceof Error ? error.message : error}`);
      return [];
    }
  }

  async function fetchQuotes(symbols, { interval = '5m', signal, maxQueueMs } = {}) {
    const unique = [...new Set((symbols || []).map((symbol) => String(symbol || '').trim().toUpperCase()).filter(Boolean))];
    if (!unique.length) return { quotes: [], session: 'closed' };
    if (signal?.aborted) return { quotes: [], session: 'closed' };
    if (layer.backingOff()) {
      const cached = unique.map((symbol) => layer.fresh(symbol)).filter(Boolean);
      const have = new Set(cached.map((quote) => quote.symbol));
      const extra = await fillFallback(unique.filter((symbol) => !have.has(symbol)));
      return pack([...cached, ...extra], unique);
    }
    const queueLimit = maxQueueMs == null ? yahooQueueMaxAgeMs(env) : maxQueueMs;
    const yahooBudget = quoteQueueBudget(queueLimit);
    const rows = await layer.enqueue(
      unique,
      (batch, batchSignal) => loadSymbols(batch, interval, batchSignal || signal),
      { signal, maxQueueMs: yahooBudget },
    );
    if (signal?.aborted) return pack((rows || []).filter(Boolean), unique);
    const have = new Set(rows.filter((quote) => quote?.lastPrice != null).map((quote) => quote.symbol));
    const extra = await fillFallback(unique.filter((symbol) => !have.has(symbol)));
    return pack([...rows.filter(Boolean), ...extra], unique);
  }

  async function fetchChart(symbol, range, interval) {
    const url = new URL(`${CHART_URL}/${encodeURIComponent(symbol)}`);
    url.searchParams.set('range', range);
    url.searchParams.set('interval', interval);
    url.searchParams.set('includePrePost', 'false');
    return barsFromChart(await requestJson(url), symbol);
  }

  async function fetchHistory(symbols, { range = '3mo', interval = '1d', ohlc = false } = {}) {
    const unique = [...new Set((symbols || []).map((symbol) => String(symbol || '').trim().toUpperCase()).filter(Boolean))];
    if (!unique.length || layer.backingOff()) return [];
    if (ohlc) {
      const series = [];
      for (const symbol of unique) {
        try {
          const value = await layer.schedule(() => fetchChart(symbol, range, interval), 'bulk');
          if (value) series.push(value);
        } catch (error) {
          if (error?.status === 429) {
            layer.note429(error.retryAfterMs || 0);
            break;
          }
          if (error?.status === 404) log('warn', `Yahoo HTTP 404 symbol=${symbol}`);
        }
      }
      const bySymbol = new Map(series.map((item) => [item.symbol, item]));
      return unique.map((symbol) => bySymbol.get(symbol)).filter(Boolean);
    }
    const series = [];
    const queue = chunk(unique, BATCH_SIZE);
    for (let index = 0; index < queue.length; index += 1) {
      const group = queue[index];
      try {
        const results = await layer.schedule(() => fetchSparkGroup(group, range, interval, false), 'bulk');
        for (const result of results) {
          const mapped = seriesFromSpark(result);
          if (mapped) series.push(mapped);
        }
      } catch (error) {
        if (error?.status === 429) {
          layer.note429(error.retryAfterMs || 0);
          break;
        }
        if (error?.status === 404 && group.length > 1) {
          const mid = Math.ceil(group.length / 2);
          queue.push(group.slice(0, mid), group.slice(mid));
          continue;
        }
        if (error?.status === 404) log('warn', `Yahoo HTTP 404 symbol=${group[0]}`);
      }
    }
    const bySymbol = new Map(series.map((item) => [item.symbol, item]));
    return unique.map((symbol) => bySymbol.get(symbol)).filter(Boolean);
  }

  async function searchSymbols(query) {
    const q = String(query || '').trim();
    if (!q || layer.backingOff()) return [];
    let payload;
    try {
      payload = await layer.schedule(() => requestJson(`${SEARCH_URL}?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`), 'bulk');
    } catch (error) {
      if (error?.status === 429) {
        layer.note429(error.retryAfterMs || 0);
        return [];
      }
      if (error instanceof Error && /Yahoo HTTP 400/.test(error.message)) return [];
      throw error;
    }
    const quotes = isRecord(payload) && Array.isArray(payload.quotes) ? payload.quotes : [];
    return quotes.flatMap((item) => {
      if (!isRecord(item)) return [];
      const symbol = text(item.symbol).toUpperCase();
      const type = text(item.quoteType);
      if (!symbol || !['EQUITY', 'ETF', 'INDEX'].includes(type)) return [];
      return [{
        symbol,
        name: text(item.shortname || item.longname || item.shortName, symbol),
        type,
        exchange: text(item.exchDisp || item.exchange),
      }];
    });
  }

  return { fetchQuotes, fetchHistory, searchSymbols, layer };
}
