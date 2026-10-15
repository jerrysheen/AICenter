import { createUsQuoteFallback } from './us-quote-fallback.js';

const SPARK_URL = 'https://query1.finance.yahoo.com/v7/finance/spark';
const CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
const SEARCH_URL = 'https://query1.finance.yahoo.com/v1/finance/search';
const COOKIE_URL = 'https://fc.yahoo.com';
const CRUMB_URL = 'https://query1.finance.yahoo.com/v1/test/getcrumb';
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_CACHE_MS = 30_000;
const US_INDEX_SYMBOLS = new Set(['^GSPC', '^DJI', '^IXIC', '^SOX', '^VIX']);
const DEFAULT_MIN_INTERVAL_MS = 800;
const BATCH_SIZE = 20;
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
  let pumping = false;
  let fetcher = async () => [];
  let backoffUntil = 0;
  let backoffMs = BACKOFF_BASE_MS;
  let nextSlot = 0;

  function fresh(symbol) {
    const hit = cache.get(symbol);
    if (!hit || now() - hit.at >= cacheTtlMs) return null;
    return hit.quote;
  }

  function remember(quote) {
    const symbol = String(quote?.symbol || '').toUpperCase();
    if (!symbol || quote.lastPrice == null) return;
    cache.set(symbol, { at: now(), quote: { ...quote, symbol } });
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

  function schedule(task, lane = 'bulk') {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    jobs.push({ lane, task, resolve, reject });
    pump();
    return promise;
  }

  function pump() {
    if (pumping) return;
    const index = jobs.findIndex((job) => job.lane === 'us');
    const job = jobs.splice(index >= 0 ? index : 0, 1)[0];
    if (!job) return;
    pumping = true;
    Promise.resolve().then(async () => {
      const wait = Math.max(0, nextSlot - Date.now());
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      nextSlot = Date.now() + minIntervalMs;
      return job.task();
    }).then((value) => {
      job.resolve(value);
    }, (error) => {
      job.reject(error);
    }).finally(() => {
      pumping = false;
      pump();
    });
  }

  function quoteMap(quotes) {
    return new Map((quotes || []).filter((quote) => quote?.symbol).map((quote) => [String(quote.symbol).toUpperCase(), quote]));
  }

  function finish(symbol, quote) {
    const slot = inflight.get(symbol);
    if (!slot) return;
    inflight.delete(symbol);
    if (quote) remember(quote);
    slot.resolve(quote || null);
  }

  function finishMany(symbols, map) {
    for (const symbol of symbols) finish(symbol, map.get(symbol) || null);
  }

  function dispatch(group, lane) {
    if (!group.length) return;
    for (const symbol of group) {
      const slot = inflight.get(symbol);
      if (slot) slot.started = true;
    }
    const loadNow = fetcher;
    schedule(() => (backingOff() ? { blocked: true } : loadNow(group)), lane).then((result) => {
      if (result?.blocked) {
        finishMany(group, new Map());
        return;
      }
      noteSuccess();
      finishMany(group, quoteMap(result));
    }).catch((error) => {
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
    const pending = [];
    for (const [symbol, slot] of inflight) {
      if (!slot.started) pending.push(symbol);
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

  function enqueue(symbols, load) {
    fetcher = load;
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
        slot = { resolve, promise, started: false };
        inflight.set(symbol, slot);
        added = true;
      }
      pending.push(slot.promise);
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

export function quoteFromSpark(result, nowSec = Math.floor(Date.now() / 1000)) {
  const chart = result.response?.[0];
  const meta = chart?.meta;
  const symbol = text(result.symbol || meta?.symbol);
  if (!symbol || !meta) return null;
  const session = parseMarketSession(meta, nowSec);
  const closes = (chart?.indicators?.quote?.[0]?.close || []).filter((value) => typeof value === 'number' && Number.isFinite(value));
  const lastPrint = closes.at(-1) ?? null;
  const extended = session === 'pre' || session === 'post';
  const lastPrice = extended
    ? (num(meta.fulldayPrice) ?? lastPrint ?? num(meta.regularMarketPrice))
    : (num(meta.regularMarketPrice) ?? num(meta.fulldayPrice) ?? lastPrint);
  const prevClose = num(meta.previousClose) ?? num(meta.chartPreviousClose);
  const changePct = extended
    ? (num(meta.fulldayChangePercent) ?? num(meta.regularMarketChangePercent))
    : (num(meta.regularMarketChangePercent) ?? num(meta.fulldayChangePercent));
  const change = lastPrice !== null && prevClose !== null ? lastPrice - prevClose : num(meta.fulldayChange);
  return {
    symbol,
    name: text(meta.shortName || meta.longName, symbol),
    lastPrice,
    changePct,
    change,
    open: closes[0] ?? null,
    high: num(meta.regularMarketDayHigh),
    low: num(meta.regularMarketDayLow),
    prevClose,
    volume: num(meta.regularMarketVolume),
    sparkline: closes,
    currency: text(meta.currency, 'USD'),
    exchange: text(meta.fullExchangeName || meta.exchangeName),
    marketTime: num(meta.regularMarketTime),
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

  async function request(url, { withCrumb = true, cookieHeader = cookie, accept = 'application/json' } = {}) {
    const target = url instanceof URL ? new URL(url.href) : new URL(String(url));
    if (withCrumb && crumb) target.searchParams.set('crumb', crumb);
    const headers = { ...YAHOO_HEADERS, Accept: accept };
    if (cookieHeader) headers.Cookie = cookieHeader;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
      if (error instanceof Error && error.name === 'AbortError') throw new Error('Yahoo 行情请求超时。');
      throw error;
    } finally {
      clearTimeout(timer);
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
    if (isRecord(payload?.spark?.error) && /unauthor|crumb|invalid/i.test(String(payload.spark.error.code || payload.spark.error.description || ''))) {
      const error = new Error('Yahoo HTTP 401');
      error.status = 401;
      throw error;
    }
    return isRecord(payload) && isRecord(payload.spark) && Array.isArray(payload.spark.result)
      ? payload.spark.result
      : [];
  }

  async function fetchSparkGroup(group, range, interval, includePrePost, attempt = 0) {
    const url = new URL(SPARK_URL);
    url.searchParams.set('symbols', group.join(','));
    url.searchParams.set('range', range);
    url.searchParams.set('interval', interval);
    url.searchParams.set('includePrePost', includePrePost ? 'true' : 'false');
    try {
      const results = sparkResults(await requestJson(url));
      if (!results.length && attempt < 1) {
        await refreshCrumb();
        return fetchSparkGroup(group, range, interval, includePrePost, attempt + 1);
      }
      return results;
    } catch (error) {
      if (error?.status === 401 && attempt < 1) {
        await refreshCrumb();
        return fetchSparkGroup(group, range, interval, includePrePost, attempt + 1);
      }
      throw error;
    }
  }

  async function loadSymbols(symbols, interval) {
    const quotes = [];
    for (const group of chunk(symbols, BATCH_SIZE)) {
      try {
        const results = await fetchSparkGroup(group, '1d', interval, true);
        for (const result of results) {
          const quote = quoteFromSpark(result);
          if (quote) quotes.push({ ...quote, provider: 'yahoo' });
        }
      } catch (error) {
        if (error?.status === 429) {
          error.partial = quotes;
          throw error;
        }
        if (error?.status === 404) throw error;
        log('error', `Yahoo 行情失败 ${error instanceof Error ? error.message : error}`);
      }
    }
    return quotes;
  }

  function pack(quotes, unique) {
    const bySymbol = new Map();
    for (const quote of quotes) {
      if (!quote?.symbol || quote.lastPrice == null || bySymbol.has(quote.symbol)) continue;
      bySymbol.set(quote.symbol, quote);
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

  async function fetchQuotes(symbols, { interval = '5m' } = {}) {
    const unique = [...new Set((symbols || []).map((symbol) => String(symbol || '').trim().toUpperCase()).filter(Boolean))];
    if (!unique.length) return { quotes: [], session: 'closed' };
    if (layer.backingOff()) {
      const cached = unique.map((symbol) => layer.fresh(symbol)).filter(Boolean);
      const have = new Set(cached.map((quote) => quote.symbol));
      const extra = await fillFallback(unique.filter((symbol) => !have.has(symbol)));
      return pack([...cached, ...extra], unique);
    }
    const rows = await layer.enqueue(unique, (batch) => loadSymbols(batch, interval));
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
