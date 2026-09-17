const DEFAULT_BASE_URL = 'https://fuyao.aicubes.cn';
const ASHARE_SNAPSHOT_PATH = '/api/a-share/prices/snapshot';
const FUND_SNAPSHOT_PATH = '/api/fund/market/snapshot';
const DEFAULT_TIMEOUT_MS = 8_000;
const BATCH_SIZE = 40;
const FUND_CONCURRENCY = 6;

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

function chunk(items, size) {
  const groups = [];
  for (let index = 0; index < items.length; index += size) groups.push(items.slice(index, index + size));
  return groups;
}

function resolveBaseUrl(value) {
  const raw = String(value || '').trim() || DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, '');
}

function snapshotItems(payload) {
  if (!isRecord(payload)) return [];
  const data = isRecord(payload.data) ? payload.data : payload;
  if (Array.isArray(data.item)) return data.item;
  if (Array.isArray(data.items)) return data.items;
  if (isRecord(data) && data.thscode) return [data];
  return [];
}

export function isCnYahooSymbol(symbol) {
  return /^\d{6}\.(SS|SZ)$/i.test(String(symbol || '').trim());
}

export function isCnFundYahooSymbol(symbol) {
  return /^(15|16|50|51|52|56|58)\d{4}\.(SS|SZ)$/i.test(String(symbol || '').trim());
}

export function isCnBShareYahooSymbol(symbol) {
  return /^(200|900)\d{3}\.(SS|SZ)$/i.test(String(symbol || '').trim());
}

export function yahooToThscode(symbol) {
  const match = String(symbol || '').trim().toUpperCase().match(/^(\d{6})\.(SS|SZ)$/);
  if (!match) return null;
  return `${match[1]}.${match[2] === 'SS' ? 'SH' : 'SZ'}`;
}

export function thscodeToYahoo(thscode) {
  const match = String(thscode || '').trim().toUpperCase().match(/^(\d{6})\.(SH|SZ)$/);
  if (!match) return null;
  return `${match[1]}.${match[2] === 'SH' ? 'SS' : 'SZ'}`;
}

export function quoteFromHithinkItem(item) {
  if (!isRecord(item)) return null;
  const symbol = thscodeToYahoo(item.thscode);
  const lastPrice = num(item.last_price);
  if (!symbol || lastPrice == null) return null;
  return {
    symbol,
    lastPrice,
    prevClose: num(item.prev_price),
    session: 'regular',
  };
}

export function createCnQuoteClient(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const apiKey = String(options.apiKey ?? process.env.HITHINK_FINANCE_API_KEY ?? process.env.AI_CENTER_FINANCE_API_KEY ?? '').trim();
  const baseUrl = resolveBaseUrl(
    options.baseUrl
    ?? process.env.AI_CENTER_FINANCE_BASE_URL
    ?? process.env.HITHINK_FINANCE_BASE_URL,
  );

  async function request(path, params) {
    const url = new URL(path, `${baseUrl}/`);
    for (const [key, value] of Object.entries(params)) {
      if (value != null && value !== '') url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        headers: { 'X-api-key': apiKey, Accept: 'application/json' },
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`同花顺行情 HTTP ${response.status}`);
      const payload = await response.json();
      if (isRecord(payload) && payload.code != null && Number(payload.code) !== 0) {
        throw new Error(`同花顺行情业务错误 ${payload.code}`);
      }
      return payload;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error('同花顺行情请求超时。');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function quotesFrom(payload) {
    return snapshotItems(payload).map(quoteFromHithinkItem).filter(Boolean);
  }

  async function fetchAshareQuotes(symbols) {
    const codes = symbols.map(yahooToThscode).filter(Boolean);
    if (!codes.length) return [];
    const settled = await Promise.allSettled(chunk(codes, BATCH_SIZE).map((group) => (
      request(ASHARE_SNAPSHOT_PATH, { thscodes: group.join(',') })
    )));
    const quotes = [];
    for (const item of settled) {
      if (item.status !== 'fulfilled') continue;
      quotes.push(...await quotesFrom(item.value));
    }
    return quotes;
  }

  async function fetchFundQuotes(symbols) {
    const codes = symbols.map(yahooToThscode).filter(Boolean);
    if (!codes.length) return [];
    const quotes = [];
    for (const group of chunk(codes, FUND_CONCURRENCY)) {
      const settled = await Promise.allSettled(group.map((thscode) => (
        request(FUND_SNAPSHOT_PATH, { thscode })
      )));
      for (const item of settled) {
        if (item.status !== 'fulfilled') continue;
        quotes.push(...await quotesFrom(item.value));
      }
    }
    return quotes;
  }

  async function fetchQuotes(symbols) {
    const unique = [...new Set((symbols || []).map((item) => String(item || '').trim().toUpperCase()).filter(isCnYahooSymbol))];
    if (!unique.length || !apiKey) return [];
    const funds = unique.filter(isCnFundYahooSymbol);
    const equities = unique.filter((symbol) => !isCnFundYahooSymbol(symbol) && !isCnBShareYahooSymbol(symbol));
    const [fundQuotes, equityQuotes] = await Promise.all([
      fetchFundQuotes(funds),
      fetchAshareQuotes(equities),
    ]);
    const bySymbol = new Map([...equityQuotes, ...fundQuotes].map((quote) => [quote.symbol, quote]));
    return unique.map((symbol) => bySymbol.get(symbol)).filter(Boolean);
  }

  return { fetchQuotes };
}
