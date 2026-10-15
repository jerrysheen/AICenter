const TENCENT_URL = 'https://qt.gtimg.cn/q=';
const SINA_URL = 'https://hq.sinajs.cn/list=';
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_QUOTE_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const TENCENT_INDEX = {
  '^GSPC': 'us.INX',
  '^DJI': 'us.DJI',
  '^IXIC': 'us.IXIC',
  '^VIX': 'us.VIX',
};

const SINA_INDEX = {
  '^GSPC': 'gb_inx',
  '^DJI': 'gb_dji',
  '^IXIC': 'gb_ixic',
  '^SOX': 'gb_sox',
  '^VIX': 'gb_vix',
};

function num(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function chunk(items, size) {
  const groups = [];
  for (let index = 0; index < items.length; index += size) groups.push(items.slice(index, index + size));
  return groups;
}

function timestampInZone(parts, timeZone) {
  const utcGuess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const asUtc = (ms) => {
    const map = {};
    for (const part of fmt.formatToParts(new Date(ms))) {
      if (part.type !== 'literal') map[part.type] = part.value;
    }
    return Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), Number(map.hour), Number(map.minute), Number(map.second));
  };
  let ms = utcGuess;
  for (let pass = 0; pass < 2; pass += 1) ms += utcGuess - asUtc(ms);
  return ms;
}

function parseClock(text, timeZone) {
  const match = String(text || '').match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!match) return null;
  return timestampInZone({
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6]),
  }, timeZone);
}

function freshEnough(asOf, nowMs) {
  if (asOf == null) return false;
  return nowMs - asOf <= MAX_QUOTE_AGE_MS && asOf - nowMs < 5 * 60_000;
}

function sessionFor(asOf, nowMs) {
  if (asOf == null) return 'closed';
  return nowMs - asOf < 30 * 60_000 ? 'regular' : 'closed';
}

export function yahooToTencentUs(symbol) {
  const upper = String(symbol || '').trim().toUpperCase();
  if (TENCENT_INDEX[upper]) return TENCENT_INDEX[upper];
  if (/^[A-Z][A-Z0-9-]{0,9}$/.test(upper)) return `us${upper}`;
  return null;
}

export function yahooToSinaUs(symbol) {
  const upper = String(symbol || '').trim().toUpperCase();
  if (SINA_INDEX[upper]) return SINA_INDEX[upper];
  if (/^[A-Z][A-Z0-9-]{0,9}$/.test(upper)) return `gb_${upper.toLowerCase()}`;
  return null;
}

export function quoteFromTencentUsBody(body, symbol, nowMs = Date.now()) {
  const fields = String(body || '').split('~');
  const lastPrice = num(fields[3]);
  if (lastPrice == null || lastPrice <= 0) return null;
  const asOf = parseClock(fields[30], 'America/New_York');
  if (!freshEnough(asOf, nowMs)) return null;
  const prevClose = num(fields[4]);
  const change = num(fields[31]);
  const changePct = num(fields[32]);
  return {
    symbol: String(symbol || '').toUpperCase(),
    name: String(fields[1] || symbol).trim() || String(symbol),
    lastPrice,
    prevClose,
    change: change ?? (prevClose != null ? lastPrice - prevClose : null),
    changePct: changePct ?? (prevClose ? ((lastPrice - prevClose) / prevClose) * 100 : null),
    high: num(fields[33]),
    low: num(fields[34]),
    volume: num(fields[6]),
    sparkline: [],
    currency: String(fields[35] || 'USD').trim() || 'USD',
    session: sessionFor(asOf, nowMs),
    marketTime: asOf == null ? null : Math.trunc(asOf / 1000),
    asOf,
    provider: 'tencent',
  };
}

export function quoteFromSinaUsBody(body, symbol, nowMs = Date.now()) {
  const fields = String(body || '').split(',');
  const lastPrice = num(fields[1]);
  if (!String(fields[0] || '').trim() || lastPrice == null || lastPrice <= 0) return null;
  const asOf = parseClock(fields[3], 'Asia/Shanghai');
  if (!freshEnough(asOf, nowMs)) return null;
  const prevClose = num(fields[26]);
  const change = num(fields[4]);
  const changePct = num(fields[2]);
  return {
    symbol: String(symbol || '').toUpperCase(),
    name: String(fields[0] || symbol).trim() || String(symbol),
    lastPrice,
    prevClose,
    change: change ?? (prevClose != null ? lastPrice - prevClose : null),
    changePct: changePct ?? (prevClose ? ((lastPrice - prevClose) / prevClose) * 100 : null),
    high: num(fields[6]),
    low: num(fields[7]),
    volume: num(fields[10]),
    sparkline: [],
    currency: 'USD',
    session: sessionFor(asOf, nowMs),
    marketTime: asOf == null ? null : Math.trunc(asOf / 1000),
    asOf,
    provider: 'sina',
  };
}

async function readText(response) {
  const bytes = Buffer.from(await response.arrayBuffer());
  return new TextDecoder('gb18030').decode(bytes);
}

export function createUsQuoteFallback(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now || (() => Date.now());

  async function request(url, headers) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { headers, cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`备用行情 HTTP ${response.status}`);
      return await readText(response);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error('备用行情请求超时。');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchTencent(pairs) {
    const quotes = [];
    for (const group of chunk(pairs, 40)) {
      const text = await request(`${TENCENT_URL}${group.map((item) => item.code).join(',')}`, {
        'User-Agent': USER_AGENT,
        Accept: '*/*',
      });
      const byCode = new Map(group.map((item) => [item.code.toUpperCase(), item.symbol]));
      for (const match of text.matchAll(/v_([^=\s]+)="([^"]*)"/g)) {
        const symbol = byCode.get(match[1].toUpperCase());
        const quote = symbol ? quoteFromTencentUsBody(match[2], symbol, now()) : null;
        if (quote) quotes.push(quote);
      }
    }
    return quotes;
  }

  async function fetchSina(pairs) {
    const quotes = [];
    for (const group of chunk(pairs, 40)) {
      const text = await request(`${SINA_URL}${group.map((item) => item.code).join(',')}`, {
        'User-Agent': USER_AGENT,
        Referer: 'https://finance.sina.com.cn',
        Accept: '*/*',
      });
      const byCode = new Map(group.map((item) => [item.code.toLowerCase(), item.symbol]));
      for (const match of text.matchAll(/hq_str_([A-Za-z0-9_$.]+)="([^"]*)"/g)) {
        const symbol = byCode.get(match[1].toLowerCase());
        const quote = symbol ? quoteFromSinaUsBody(match[2], symbol, now()) : null;
        if (quote) quotes.push(quote);
      }
    }
    return quotes;
  }

  async function fetchQuotes(symbols) {
    const unique = [...new Set((symbols || []).map((item) => String(item || '').trim().toUpperCase()).filter(Boolean))];
    const quotes = [];
    const errors = [];
    const tencentPairs = unique
      .map((symbol) => ({ symbol, code: yahooToTencentUs(symbol) }))
      .filter((item) => item.code);
    if (tencentPairs.length) {
      try {
        quotes.push(...await fetchTencent(tencentPairs));
      } catch (error) {
        errors.push(error);
      }
    }
    const have = new Set(quotes.map((item) => item.symbol));
    const sinaPairs = unique
      .filter((symbol) => !have.has(symbol))
      .map((symbol) => ({ symbol, code: yahooToSinaUs(symbol) }))
      .filter((item) => item.code);
    if (sinaPairs.length) {
      try {
        quotes.push(...await fetchSina(sinaPairs));
      } catch (error) {
        errors.push(error);
      }
    }
    if (!quotes.length && errors.length) throw errors[0];
    return quotes;
  }

  return { fetchQuotes };
}
