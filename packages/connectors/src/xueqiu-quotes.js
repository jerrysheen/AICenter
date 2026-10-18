import { isCnYahooSymbol } from './cn-quotes.js';

const TOKEN_URL = 'https://xueqiu.com/hq';
const BATCH_QUOTE_PATH = '/v5/stock/batch/quote.json';
const KLINE_PATH = '/v5/stock/chart/kline.json';
const SPARKLINE_COUNT = 30;
const SPARKLINE_CONCURRENCY = 4;
const SPARKLINE_ROUND_LIMIT = 10;
const SPARKLINE_ROUND_MS = 8_000;
// 第 1、2 次失败后等 10 分钟、30 分钟；第 3 次失败当天不再试。最后一档是 1 小时。
export const SPARKLINE_FAIL_BACKOFF_MS = Object.freeze([10 * 60_000, 30 * 60_000, 60 * 60_000]);
const SPARKLINE_FAIL_LIMIT = 3;
const STOCK_API = 'https://stock.xueqiu.com';
const DEFAULT_TIMEOUT_MS = 8_000;
const BATCH_SIZE = 50;
const TOKEN_TTL_MS = 25 * 60_000;
const USER_AGENT = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
].join(' ');
const BASE_HEADERS = {
  'User-Agent': USER_AGENT,
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  Referer: 'https://xueqiu.com/',
  Origin: 'https://xueqiu.com',
};

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && value !== '-') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function chunk(items, size) {
  const groups = [];
  for (let index = 0; index < items.length; index += size) groups.push(items.slice(index, size + index));
  return groups;
}

export function isHkYahooSymbol(symbol) {
  return /^\d{1,5}\.HK$/i.test(String(symbol || '').trim());
}

export function isXueqiuYahooSymbol(symbol) {
  return isCnYahooSymbol(symbol) || isHkYahooSymbol(symbol);
}

export function yahooToXueqiuSymbol(symbol) {
  const raw = String(symbol || '').trim().toUpperCase();
  const cn = raw.match(/^(\d{6})\.(SS|SZ)$/);
  if (cn) return `${cn[2] === 'SS' ? 'SH' : 'SZ'}${cn[1]}`;
  const hk = raw.match(/^(\d{1,5})\.HK$/);
  if (hk) return hk[1].padStart(5, '0');
  return null;
}

export function parseCookieString(value) {
  const cookies = new Map();
  for (const part of String(value || '').split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const cookieValue = trimmed.slice(eq + 1).trim();
    if (name && cookieValue) cookies.set(name, cookieValue);
  }
  return cookies;
}

function cookieHeader(cookies) {
  return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

function setCookieHeaders(headers) {
  if (!headers) return [];
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie().filter(Boolean);
  if (typeof headers.get === 'function') {
    const joined = headers.get('set-cookie');
    return joined ? [joined] : [];
  }
  const raw = headers['set-cookie'] ?? headers['Set-Cookie'];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  return raw ? [raw] : [];
}

function applySetCookie(cookies, headers) {
  for (const header of setCookieHeaders(headers)) {
    const first = String(header).split(';')[0];
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (name) {
      if (value) cookies.set(name, value);
      else cookies.delete(name);
    }
  }
}

function quoteItems(payload) {
  if (!isRecord(payload)) return [];
  const data = isRecord(payload.data) ? payload.data : payload;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.item)) return data.item;
  if (isRecord(data.quote) || (isRecord(data) && data.current != null)) return [data];
  return [];
}

export function sessionFromXueqiuMarket(market, quote = {}) {
  const status = text(market?.status || quote.status);
  if (/交易中|盘中/.test(status)) return 'regular';
  if (/盘前|竞价/.test(status)) return 'pre';
  if (/盘后/.test(status)) return 'post';
  const statusId = num(market?.status_id);
  if (statusId === 5) return 'regular';
  return 'closed';
}

function barTimeMs(value) {
  const at = num(value);
  if (at == null || at <= 0) return null;
  return at < 1e12 ? Math.trunc(at * 1000) : Math.trunc(at);
}

export function seriesFromXueqiuKline(payload) {
  const data = isRecord(payload?.data) ? payload.data : (isRecord(payload) ? payload : null);
  if (!data) return { points: [], lastAt: null };
  const columns = Array.isArray(data.column) ? data.column : [];
  const closeIndex = columns.indexOf('close');
  const timeIndex = columns.indexOf('timestamp');
  const items = Array.isArray(data.item) ? data.item : [];
  if (closeIndex < 0) return { points: [], lastAt: null };
  const points = [];
  let lastAt = null;
  for (const row of items) {
    const value = Array.isArray(row) ? num(row[closeIndex]) : null;
    if (value == null || value <= 0) continue;
    points.push(value);
    if (timeIndex >= 0 && Array.isArray(row)) {
      const at = barTimeMs(row[timeIndex]);
      if (at != null) lastAt = at;
    }
  }
  return { points, lastAt };
}

export function sparklineFromXueqiuKline(payload) {
  return seriesFromXueqiuKline(payload).points;
}

export function quoteFromXueqiuItem(item, yahooSymbol) {
  const quote = isRecord(item?.quote) ? item.quote : (isRecord(item) && item.current != null ? item : null);
  if (!quote) return null;
  const symbol = String(yahooSymbol || '').trim().toUpperCase();
  const lastPrice = num(quote.current);
  if (!symbol || lastPrice == null) return null;
  const currency = text(quote.currency);
  const timestamp = num(quote.timestamp);
  return {
    symbol,
    name: text(quote.name),
    lastPrice,
    prevClose: num(quote.last_close),
    change: num(quote.chg),
    changePct: num(quote.percent),
    high: num(quote.high),
    low: num(quote.low),
    volume: num(quote.volume),
    sparkline: sparklineFromXueqiuKline(item?.kline),
    asOf: timestamp != null && timestamp > 0 ? Math.trunc(timestamp) : null,
    session: sessionFromXueqiuMarket(item.market, quote),
    ...(currency ? { currency } : {}),
  };
}

export function shanghaiCalendarDay(at) {
  return new Date(Number(at) + 8 * 3_600_000).toISOString().slice(0, 10);
}

function sparklineRetryDelayMs(fails) {
  if (fails >= SPARKLINE_FAIL_LIMIT) return null;
  const index = Math.min(Math.max(fails, 1), SPARKLINE_FAIL_BACKOFF_MS.length) - 1;
  return SPARKLINE_FAIL_BACKOFF_MS[index];
}

function sparklineSlot(hit, day, at) {
  if (!hit || hit.day !== day) return 'unseen';
  const fails = Number(hit.fails) || 0;
  if (!fails) return hit.points?.length >= 2 ? 'fresh' : 'unseen';
  const delay = sparklineRetryDelayMs(fails);
  if (delay == null) return 'exhausted';
  if (at - Number(hit.failedAt) < delay) return 'wait';
  return 'due';
}

export function createXueqiuQuoteClient(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now || (() => Date.now());
  const cookies = parseCookieString(options.cookie ?? process.env.XUEQIU_COOKIE);
  const hasUserCookie = cookies.has('xq_a_token');
  let tokenAt = hasUserCookie ? now() : 0;
  const sparklineCache = new Map();

  async function request(url, init = {}, signal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const headers = { ...BASE_HEADERS, ...init.headers };
    const cookie = cookieHeader(cookies);
    if (cookie) headers.Cookie = cookie;
    try {
      const response = await fetchImpl(url, {
        ...init,
        headers,
        cache: 'no-store',
        redirect: 'follow',
        signal: controller.signal,
      });
      applySetCookie(cookies, response.headers);
      return response;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error('雪球行情请求超时。');
      throw error;
    } finally {
      clearTimeout(timer);
      if (signal?.removeEventListener) signal.removeEventListener('abort', onAbort);
    }
  }

  async function readJson(response, label) {
    if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
    const raw = Buffer.from(await response.arrayBuffer());
    if (!raw.length) throw new Error(`${label} 返回空响应。`);
    if (raw.subarray(0, 32).toString('utf8').trimStart().startsWith('<')) {
      throw new Error(`${label} 被风控拦截。`);
    }
    let payload;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new Error(`${label} 返回了无法解析的内容。`);
    }
    if (isRecord(payload) && payload.error_code != null && Number(payload.error_code) !== 0) {
      throw new Error(`${label} 业务错误 ${payload.error_code}`);
    }
    return payload;
  }

  async function ensureToken({ force = false, signal } = {}) {
    if (hasUserCookie) return;
    if (!force && cookies.get('xq_a_token') && now() - tokenAt < TOKEN_TTL_MS) return;
    cookies.clear();
    const response = await request(TOKEN_URL, { headers: { Accept: 'text/html,*/*' } }, signal);
    if (!response.ok) throw new Error(`雪球匿名令牌 HTTP ${response.status}`);
    await response.arrayBuffer();
    if (!cookies.get('xq_a_token')) throw new Error('未能从雪球获取访问令牌。');
    tokenAt = now();
  }

  async function fetchBatch(xueqiuSymbols, signal) {
    const url = new URL(BATCH_QUOTE_PATH, `${STOCK_API}/`);
    url.searchParams.set('symbol', xueqiuSymbols.join(','));
    url.searchParams.set('extend', 'detail');
    const response = await request(url, {}, signal);
    return quoteItems(await readJson(response, '雪球行情'));
  }

  async function fetchQuotes(symbols, options = {}) {
    const signal = options?.signal;
    const unique = [...new Set((symbols || []).map((item) => String(item || '').trim().toUpperCase()).filter(isXueqiuYahooSymbol))];
    if (!unique.length) return [];
    const pairs = unique.map((yahoo) => ({ yahoo, xueqiu: yahooToXueqiuSymbol(yahoo) })).filter((item) => item.xueqiu);
    if (!pairs.length) return [];
    const byXueqiu = new Map();
    for (const pair of pairs) {
      if (!byXueqiu.has(pair.xueqiu)) byXueqiu.set(pair.xueqiu, pair.yahoo);
    }

    async function load(forceToken = false) {
      await ensureToken({ force: forceToken, signal });
      const quotes = [];
      const settled = await Promise.allSettled(
        chunk([...byXueqiu.keys()], BATCH_SIZE).map((group) => fetchBatch(group, signal)),
      );
      for (const item of settled) {
        if (item.status !== 'fulfilled') continue;
        for (const row of item.value) {
          const xueqiuSymbol = text(row?.quote?.symbol || row?.symbol).toUpperCase();
          const quote = quoteFromXueqiuItem(row, byXueqiu.get(xueqiuSymbol));
          if (quote) quotes.push(quote);
        }
      }
      return quotes;
    }

    let quotes = [];
    try {
      quotes = await load(false);
    } catch {
      quotes = [];
    }
    if (!quotes.length && !hasUserCookie) {
      try {
        quotes = await load(true);
      } catch {
        return [];
      }
    }
    const bySymbol = new Map(quotes.map((item) => [item.symbol, item]));
    return unique.map((symbol) => bySymbol.get(symbol)).filter(Boolean);
  }

  async function fetchSparkline(xueqiuSymbol, signal) {
    const url = new URL(KLINE_PATH, `${STOCK_API}/`);
    url.searchParams.set('symbol', xueqiuSymbol);
    url.searchParams.set('begin', String(now()));
    url.searchParams.set('period', 'day');
    url.searchParams.set('type', 'before');
    url.searchParams.set('count', String(-SPARKLINE_COUNT));
    url.searchParams.set('indicator', 'kline');
    const response = await request(url, {}, signal);
    return seriesFromXueqiuKline(await readJson(response, '雪球K线'));
  }

  function rememberedSeries(symbol) {
    const hit = sparklineCache.get(symbol);
    if (!hit?.points || hit.points.length < 2) return null;
    return { sparkline: hit.points.slice(), lastAt: hit.lastAt ?? null };
  }

  function rememberFailure(yahoo, day) {
    const previous = sparklineCache.get(yahoo);
    const sameDay = previous?.day === day;
    const points = Array.isArray(previous?.points) ? previous.points.slice() : [];
    sparklineCache.set(yahoo, {
      day,
      points,
      lastAt: previous?.lastAt ?? null,
      failedAt: now(),
      fails: (sameDay ? Number(previous?.fails) || 0 : 0) + 1,
    });
  }

  async function fetchSparklines(symbols, options = {}) {
    const signal = options?.signal;
    const at = now();
    const day = shanghaiCalendarDay(at);
    const unique = [...new Set((symbols || []).map((item) => String(item || '').trim().toUpperCase()).filter(isXueqiuYahooSymbol))];
    const pairs = unique.map((yahoo) => ({ yahoo, xueqiu: yahooToXueqiuSymbol(yahoo) })).filter((item) => item.xueqiu);
    if (!pairs.length) return [];
    const fresh = [];
    const unseen = [];
    const failedDue = [];
    for (const pair of pairs) {
      const hit = sparklineCache.get(pair.yahoo);
      const slot = sparklineSlot(hit, day, at);
      if (slot === 'fresh') {
        fresh.push({ symbol: pair.yahoo, sparkline: hit.points.slice(), lastAt: hit.lastAt ?? null });
      } else if (slot === 'unseen') unseen.push(pair);
      else if (slot === 'due') failedDue.push({ pair, failedAt: Number(hit.failedAt) || 0 });
    }
    failedDue.sort((left, right) => left.failedAt - right.failedAt);
    const pending = [...unseen, ...failedDue.map((item) => item.pair)];
    const batch = pending.slice(0, SPARKLINE_ROUND_LIMIT);
    const gained = [];
    const seen = new Set(fresh.map((item) => item.symbol));
    const addSeries = (symbol, sparkline, lastAt) => {
      if (seen.has(symbol) || !Array.isArray(sparkline) || sparkline.length < 2) return;
      seen.add(symbol);
      gained.push({ symbol, sparkline: sparkline.slice(), lastAt: lastAt ?? null });
    };
    const keepPrevious = (pair) => {
      const previous = rememberedSeries(pair.yahoo);
      if (previous) addSeries(pair.yahoo, previous.sparkline, previous.lastAt);
    };
    if (batch.length) {
      const round = new AbortController();
      const roundTimer = setTimeout(() => round.abort(), SPARKLINE_ROUND_MS);
      const onAbort = () => round.abort();
      if (signal) {
        if (signal.aborted) round.abort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      try {
        if (!round.signal.aborted) {
          try {
            await ensureToken({ signal: round.signal });
          } catch {
            /* 令牌失败时沿用上一份日 K。 */
          }
        }
        for (let offset = 0; offset < batch.length && !round.signal.aborted; offset += SPARKLINE_CONCURRENCY) {
          const group = batch.slice(offset, offset + SPARKLINE_CONCURRENCY);
          const settled = await Promise.allSettled(group.map(async (pair) => ({
            symbol: pair.yahoo,
            ...(await fetchSparkline(pair.xueqiu, round.signal)),
          })));
          for (let index = 0; index < settled.length; index += 1) {
            const pair = group[index];
            const item = settled[index];
            const aborted = round.signal.aborted || item.reason?.name === 'AbortError';
            if (item.status === 'fulfilled' && item.value.points.length >= 2) {
              sparklineCache.set(pair.yahoo, {
                day,
                points: item.value.points.slice(),
                lastAt: item.value.lastAt ?? null,
                failedAt: 0,
                fails: 0,
              });
              addSeries(pair.yahoo, item.value.points, item.value.lastAt);
            } else if (!aborted) {
              rememberFailure(pair.yahoo, day);
              keepPrevious(pair);
            }
          }
        }
      } finally {
        clearTimeout(roundTimer);
        if (signal?.removeEventListener) signal.removeEventListener('abort', onAbort);
      }
    }
    for (const pair of pairs) keepPrevious(pair);
    return [...fresh, ...gained];
  }

  return { fetchQuotes, fetchSparklines };
}
