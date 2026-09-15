const SPARK_URL = 'https://query1.finance.yahoo.com/v7/finance/spark';
const SEARCH_URL = 'https://query1.finance.yahoo.com/v1/finance/search';
const DEFAULT_TIMEOUT_MS = 12_000;
const BATCH_SIZE = 20;
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

export function createYahooClient(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { headers: YAHOO_HEADERS, cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`Yahoo HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error('Yahoo 行情请求超时。');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchQuotes(symbols) {
    const unique = [...new Set(symbols.map((symbol) => String(symbol || '').trim().toUpperCase()).filter(Boolean))];
    const quotes = [];
    let sessionMeta;

    for (const group of chunk(unique, BATCH_SIZE)) {
      const url = `${SPARK_URL}?symbols=${group.map(encodeURIComponent).join(',')}&range=1d&interval=5m&includePrePost=true`;
      const payload = await request(url);
      const results = isRecord(payload) && isRecord(payload.spark) && Array.isArray(payload.spark.result)
        ? payload.spark.result
        : [];
      for (const result of results) {
        const quote = quoteFromSpark(result);
        if (!quote) continue;
        quotes.push(quote);
        sessionMeta ??= result.response?.[0]?.meta;
      }
    }

    const bySymbol = new Map(quotes.map((quote) => [quote.symbol, quote]));
    return {
      quotes: unique.map((symbol) => bySymbol.get(symbol)).filter(Boolean),
      session: parseMarketSession(sessionMeta),
    };
  }

  async function searchSymbols(query) {
    const q = query.trim();
    if (!q) return [];
    let payload;
    try {
      payload = await request(`${SEARCH_URL}?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`);
    } catch (error) {
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

  return { fetchQuotes, searchSymbols };
}
