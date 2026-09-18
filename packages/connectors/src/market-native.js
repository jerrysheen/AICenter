const URLS = Object.freeze({
  polymarket: 'https://gamma-api.polymarket.com/markets',
  polymarketOpenInterest: 'https://data-api.polymarket.com/oi',
  kalshi: 'https://external-api.kalshi.com/trade-api/v2',
  hyperliquid: 'https://api.hyperliquid.xyz/info',
  defillamaStablecoins: 'https://stablecoins.llama.fi/stablecoins?includePrices=true',
});

const DEFAULT_PREDICTION_FOCUS = Object.freeze([
  'fed', 'federal reserve', 'interest rate', 'cpi', 'inflation', 'gdp', 'tariff',
  'government shutdown', 'bitcoin', 'btc', 'ethereum', 'eth', 'oil', 'gold',
]);
const DEFAULT_KALSHI_SERIES = Object.freeze(['KXFEDDECISION', 'KXFED']);
const DEFAULT_DERIVATIVE_SYMBOLS = Object.freeze(['BTC', 'ETH']);
const DEFAULT_STABLECOINS = Object.freeze(['USDT', 'USDC']);
const DEFAULT_STABLECOIN_CHAINS = Object.freeze(['Ethereum', 'Solana', 'Tron', 'Base', 'Hyperliquid L1']);

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

function fixedDecimal(value, digits = 2) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : null;
}

function computedDecimal(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return number.toFixed(12).replace(/(?:\.0+|(?<=[0-9])0+)$/, '').replace(/\.$/, '');
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
  } catch { return []; }
}

function midpoint(bid, ask, fallback = null) {
  const left = Number(bid);
  const right = Number(ask);
  if (Number.isFinite(left) && Number.isFinite(right) && right > 0 && left >= 0) {
    return computedDecimal((left + right) / 2);
  }
  return decimal(fallback);
}

function spread(bid, ask, fallback = null) {
  const left = Number(bid);
  const right = Number(ask);
  if (Number.isFinite(left) && Number.isFinite(right) && right >= left && right > 0) {
    return computedDecimal(right - left);
  }
  return decimal(fallback);
}

function includesFocus(value, query = '') {
  const normalized = String(value || '').toLocaleLowerCase();
  if (query) return normalized.includes(String(query).trim().toLocaleLowerCase());
  return DEFAULT_PREDICTION_FOCUS.some((keyword) => normalized.includes(keyword));
}

function metric(key, label, current, previousDay, previousWeek, previousMonth) {
  const value = Number(current);
  const difference = (previous) => Number.isFinite(value) && Number.isFinite(Number(previous))
    ? fixedDecimal(value - Number(previous))
    : null;
  return {
    key, label, supplyUsd: fixedDecimal(value),
    change1dUsd: difference(previousDay),
    change7dUsd: difference(previousWeek),
    change30dUsd: difference(previousMonth),
  };
}

export function parsePolymarketMarkets(rows, openInterestRows = [], observedAt = Date.now(), input = {}) {
  const openInterest = new Map((openInterestRows || []).map((row) => [String(row?.market || ''), decimal(row?.value)]));
  const limit = Math.min(Math.max(Number(input.limit) || 12, 1), 50);
  return (Array.isArray(rows) ? rows : []).filter((row) => includesFocus(row?.question, input.query)).map((row) => {
    const outcomes = parseArray(row.outcomes);
    const outcomePrices = parseArray(row.outcomePrices);
    const yesIndex = Math.max(outcomes.findIndex((outcome) => String(outcome).toLocaleLowerCase() === 'yes'), 0);
    const outcome = String(outcomes[yesIndex] || outcomes[0] || 'YES');
    const fallbackPrice = outcomePrices[yesIndex] ?? outcomePrices[0] ?? row.lastTradePrice;
    const eventSlug = row?.events?.[0]?.slug || row.slug || row.id;
    return {
      quoteId: `polymarket:${row.id}:${outcome}`,
      venue: 'polymarket', marketId: String(row.conditionId || row.id),
      marketQuestion: String(row.question || row.groupItemTitle || row.id), outcome,
      midPrice: midpoint(row.bestBid, row.bestAsk, fallbackPrice),
      bestBid: decimal(row.bestBid), bestAsk: decimal(row.bestAsk),
      spread: spread(row.bestBid, row.bestAsk, row.spread), lastPrice: decimal(row.lastTradePrice),
      volume24h: decimal(row.volume24hr ?? row.volume24hrClob), totalVolume: decimal(row.volume),
      liquidity: decimal(row.liquidity), openInterest: openInterest.get(String(row.conditionId || '')) || null,
      endAt: timestamp(row.endDate || row.endDateIso),
      sourceUrl: `https://polymarket.com/event/${encodeURIComponent(eventSlug)}`,
      observedAt,
    };
  }).sort((left, right) => Number(right.volume24h || 0) - Number(left.volume24h || 0)).slice(0, limit);
}

export function parseKalshiEvents(payloads, observedAt = Date.now(), input = {}) {
  const limit = Math.min(Math.max(Number(input.limit) || 12, 1), 50);
  const quotes = [];
  const seen = new Set();
  for (const payload of Array.isArray(payloads) ? payloads : []) {
    for (const event of payload?.events || []) {
      for (const market of event?.markets || []) {
        if (!market?.ticker || seen.has(market.ticker)) continue;
        const question = String(market.title || `${event.title || ''} ${market.yes_sub_title || ''}`).trim();
        if (input.query && !includesFocus(question, input.query)) continue;
        seen.add(market.ticker);
        const bid = decimal(market.yes_bid_dollars);
        const ask = decimal(market.yes_ask_dollars);
        quotes.push({
          quoteId: `kalshi:${market.ticker}:yes`, venue: 'kalshi', marketId: String(market.ticker),
          marketQuestion: question || String(event.title || market.ticker), outcome: String(market.yes_sub_title || 'YES'),
          midPrice: midpoint(bid, ask, market.last_price_dollars), bestBid: bid, bestAsk: ask,
          spread: spread(bid, ask), lastPrice: decimal(market.last_price_dollars),
          volume24h: decimal(market.volume_24h_fp), totalVolume: decimal(market.volume_fp),
          liquidity: decimal(market.liquidity_dollars), openInterest: decimal(market.open_interest_fp),
          endAt: timestamp(market.close_time || market.expiration_time),
          sourceUrl: `https://kalshi.com/markets/${String(event.series_ticker || market.event_ticker || '').toLocaleLowerCase()}`,
          observedAt,
        });
      }
    }
  }
  return quotes.sort((left, right) => Number(right.volume24h || 0) - Number(left.volume24h || 0)).slice(0, limit);
}

export function parseHyperliquidMetaAndAssetContexts(payload, observedAt = Date.now(), input = {}) {
  const [meta, contexts] = Array.isArray(payload) ? payload : [];
  const requested = new Set((input.symbols || DEFAULT_DERIVATIVE_SYMBOLS).map((value) => String(value).toLocaleUpperCase()));
  return (meta?.universe || []).flatMap((asset, index) => {
    const symbol = String(asset?.name || '').toLocaleUpperCase();
    if (!requested.has(symbol) || asset?.isDelisted) return [];
    const context = contexts?.[index] || {};
    return [{
      quoteId: `hyperliquid:${symbol}:perp`, venue: 'hyperliquid', symbol,
      markPrice: decimal(context.markPx), midPrice: decimal(context.midPx), oraclePrice: decimal(context.oraclePx),
      previousDayPrice: decimal(context.prevDayPx), fundingRate: decimal(context.funding),
      openInterest: decimal(context.openInterest), openInterestUnit: 'base-asset',
      volume24h: decimal(context.dayNtlVlm), sourceUrl: 'https://app.hyperliquid.xyz/trade', observedAt,
    }];
  });
}

export function parseDefillamaStablecoins(payload, observedAt = Date.now(), input = {}) {
  const assets = (payload?.peggedAssets || []).filter((row) => row?.pegType === 'peggedUSD');
  const wantedAssets = new Set(input.assets || DEFAULT_STABLECOINS);
  const wantedChains = input.chains || DEFAULT_STABLECOIN_CHAINS;
  const totals = { current: 0, day: 0, week: 0, month: 0 };
  for (const row of assets) {
    totals.current += Number(row?.circulating?.peggedUSD || 0);
    totals.day += Number(row?.circulatingPrevDay?.peggedUSD || 0);
    totals.week += Number(row?.circulatingPrevWeek?.peggedUSD || 0);
    totals.month += Number(row?.circulatingPrevMonth?.peggedUSD || 0);
  }
  const assetMetrics = assets.filter((row) => wantedAssets.has(row.symbol)).map((row) => metric(
    String(row.symbol), String(row.symbol), row?.circulating?.peggedUSD,
    row?.circulatingPrevDay?.peggedUSD, row?.circulatingPrevWeek?.peggedUSD, row?.circulatingPrevMonth?.peggedUSD,
  ));
  const chainMetrics = wantedChains.map((chain) => {
    const sums = { current: 0, day: 0, week: 0, month: 0 };
    let found = false;
    for (const row of assets) {
      const value = row?.chainCirculating?.[chain];
      if (!value) continue;
      found = true;
      sums.current += Number(value?.current?.peggedUSD || 0);
      sums.day += Number(value?.circulatingPrevDay?.peggedUSD || 0);
      sums.week += Number(value?.circulatingPrevWeek?.peggedUSD || 0);
      sums.month += Number(value?.circulatingPrevMonth?.peggedUSD || 0);
    }
    return found ? metric(`chain:${chain}`, chain, sums.current, sums.day, sums.week, sums.month) : null;
  }).filter(Boolean);
  return {
    total: metric('total', 'Total stablecoin supply', totals.current, totals.day, totals.week, totals.month),
    assets: assetMetrics, chains: chainMetrics, observedAt,
  };
}

async function responseJson(response) {
  if (!response?.ok) throw new Error(`HTTP ${response?.status || 'unavailable'}`);
  return response.json();
}

export function createMarketNativeClient(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const now = options.now || (() => Date.now());
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (typeof fetchImpl !== 'function') throw new TypeError('market-native sources require fetch');

  async function request(url, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, {
        ...init, signal: controller.signal,
        headers: { accept: 'application/json', 'user-agent': 'AI-Center/0.2 (local market-native reader)', ...(init.headers || {}) },
      });
    } finally { clearTimeout(timer); }
  }

  return Object.freeze({
    urls: URLS,
    async polymarket(input = {}) {
      const observedAt = now();
      const fetchLimit = Math.min(Math.max((Number(input.limit) || 12) * 8, 50), 250);
      const params = new URLSearchParams({ active: 'true', closed: 'false', limit: String(fetchLimit), order: 'volume24hr', ascending: 'false' });
      const rows = await responseJson(await request(`${URLS.polymarket}?${params}`));
      const selected = (rows || []).filter((row) => includesFocus(row?.question, input.query));
      const oiParams = new URLSearchParams();
      selected.slice(0, 50).forEach((row) => { if (row.conditionId) oiParams.append('market', row.conditionId); });
      let oiRows = [];
      if ([...oiParams.keys()].length) {
        try { oiRows = await responseJson(await request(`${URLS.polymarketOpenInterest}?${oiParams}`)); } catch { /* Quote remains usable without OI. */ }
      }
      return {
        available: true, observedAt, sourceUrl: URLS.polymarket,
        quotes: parsePolymarketMarkets(selected, oiRows, observedAt, input),
        note: oiRows.length ? '' : '报价可用；部分市场未返回 Open Interest。',
      };
    },
    async kalshi(input = {}) {
      const observedAt = now();
      const series = input.series?.length ? input.series : DEFAULT_KALSHI_SERIES;
      const payloads = await Promise.all(series.map(async (seriesTicker) => {
        const params = new URLSearchParams({ status: 'open', with_nested_markets: 'true', limit: '200', series_ticker: seriesTicker });
        return responseJson(await request(`${URLS.kalshi}/events?${params}`));
      }));
      return {
        available: true, observedAt, sourceUrl: `${URLS.kalshi}/events`,
        quotes: parseKalshiEvents(payloads, observedAt, input), note: '',
      };
    },
    async hyperliquid(input = {}) {
      const observedAt = now();
      const payload = await responseJson(await request(URLS.hyperliquid, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      }));
      return {
        available: true, observedAt, sourceUrl: 'https://app.hyperliquid.xyz/trade',
        quotes: parseHyperliquidMetaAndAssetContexts(payload, observedAt, input), note: '',
      };
    },
    async stablecoins(input = {}) {
      const observedAt = now();
      const payload = await responseJson(await request(URLS.defillamaStablecoins));
      const parsed = parseDefillamaStablecoins(payload, observedAt, input);
      return {
        available: true, observedAt, sourceUrl: 'https://defillama.com/stablecoins',
        total: parsed.total, assets: parsed.assets, chains: parsed.chains, note: '',
      };
    },
  });
}

export { URLS as MARKET_NATIVE_URLS };
