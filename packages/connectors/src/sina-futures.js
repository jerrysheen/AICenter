const DEFAULT_TIMEOUT_MS = 8_000;
const SINA_URL = 'https://hq.sinajs.cn/list=';
const USER_AGENT = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
].join(' ');

const SINA_FUTURE_MAP = {
  AG00Y: 'nf_AG0',
  AU00Y: 'nf_AU0',
  CU00Y: 'nf_CU0',
  RB00Y: 'nf_RB0',
  I00Y: 'nf_I0',
  M00Y: 'nf_M0',
  LC00Y: 'nf_LC0',
  SC00Y: 'nf_SC0',
  C00Y: 'nf_C0',
  Y00Y: 'nf_Y0',
  P00Y: 'nf_P0',
  TS00Y: 'CFF_RE_TS0',
  TF00Y: 'CFF_RE_TF0',
  T00Y: 'CFF_RE_T0',
  TL00Y: 'CFF_RE_TL0',
};

function num(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && value !== '-') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function isSinaFutureSymbol(symbol) {
  return Object.hasOwn(SINA_FUTURE_MAP, String(symbol || '').trim().toUpperCase());
}

export function yahooToSinaFutureSymbol(symbol) {
  return SINA_FUTURE_MAP[String(symbol || '').trim().toUpperCase()] || null;
}

export function quoteFromSinaLine(line, requestedSymbol) {
  const match = String(line || '').match(/hq_str_([A-Za-z0-9_]+)="([^"]*)"/);
  if (!match || !match[2]) return null;
  const fields = match[2].split(',');
  const numericFirst = num(fields[0]) != null && !/[^\d.]/.test(String(fields[0]).trim());
  const lastPrice = numericFirst ? num(fields[0]) : num(fields[8]);
  const prevClose = numericFirst ? num(fields[3]) : num(fields[10]);
  const high = numericFirst ? num(fields[1]) : num(fields[3]);
  const low = numericFirst ? num(fields[2]) : num(fields[4]);
  const name = numericFirst ? String(fields[fields.length - 1] || '').trim() : String(fields[0] || '').trim();
  if (lastPrice == null) return null;
  const change = prevClose != null ? lastPrice - prevClose : null;
  const changePct = prevClose ? (change / prevClose) * 100 : null;
  return {
    symbol: String(requestedSymbol || '').toUpperCase(),
    ...(name ? { name } : {}),
    lastPrice,
    prevClose,
    change,
    changePct,
    high,
    low,
    volume: null,
    sparkline: [],
    session: 'regular',
    currency: 'CNY',
  };
}

export function createSinaFuturesClient(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function fetchQuotes(symbols) {
    const pairs = [...new Set((symbols || []).map((item) => String(item || '').trim().toUpperCase()).filter(Boolean))]
      .map((yahoo) => ({ yahoo, sina: yahooToSinaFutureSymbol(yahoo) }))
      .filter((item) => item.sina);
    if (!pairs.length) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = `${SINA_URL}${pairs.map((item) => item.sina).join(',')}`;
      const response = await fetchImpl(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Referer: 'https://finance.sina.com.cn/',
          Accept: 'text/plain,*/*',
        },
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`新浪期货行情 HTTP ${response.status}`);
      const text = new TextDecoder('gb18030').decode(Buffer.from(await response.arrayBuffer()));
      const bySina = new Map(pairs.map((item) => [item.sina.toUpperCase(), item.yahoo]));
      const quotes = [];
      for (const line of text.split(';')) {
        const sinaCode = line.match(/hq_str_([A-Za-z0-9_]+)=/)?.[1];
        const yahoo = bySina.get(String(sinaCode || '').toUpperCase());
        const quote = yahoo ? quoteFromSinaLine(line, yahoo) : null;
        if (quote) quotes.push(quote);
      }
      return quotes;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error('新浪期货行情请求超时。');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return { fetchQuotes };
}