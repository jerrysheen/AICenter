import { asiaTrackedItems, buildAsiaMarketBoard, buildCnMarketBoard, buildGlobalAssetBoard, buildOverviewBoard, buildUsMarketBoard, cnTrackedItems, globalTrackedItems, parseAsiaExtraSymbols, parseCnExtraSymbols, parseUsExtraSymbols, preferredOverviewFocus, usTrackedItems } from './boards.js';
import { createCnQuoteClient, isCnYahooSymbol } from '../../../connectors/src/cn-quotes.js';
import { createSinaFuturesClient, isSinaFutureSymbol } from '../../../connectors/src/sina-futures.js';
import { createXueqiuQuoteClient, isXueqiuYahooSymbol } from '../../../connectors/src/xueqiu-quotes.js';
import { createYahooClient } from '../../../connectors/src/yahoo.js';
import { resolveMarketCatalog } from './catalog.js';

export function createMarketService(options = {}) {
  const marketCatalog = options.marketCatalog || resolveMarketCatalog(options.marketCatalogPath);
  const yahoo = options.yahoo || createYahooClient(options);
  const cnQuotes = options.cnQuotes || createCnQuoteClient(options);
  const sinaFutures = options.sinaFutures === undefined ? createSinaFuturesClient(options) : options.sinaFutures;
  const xueqiuQuotes = options.xueqiuQuotes === undefined ? createXueqiuQuoteClient(options) : options.xueqiuQuotes;
  const ttlMs = options.ttlMs ?? 20_000;
  const xueqiuTtlMs = options.xueqiuTtlMs ?? 3_000;
  const now = options.now || (() => Date.now());
  const cache = new Map();
  const pending = new Map();

  async function cached(key, loader, { refresh = false, ttl = ttlMs } = {}) {
    const timestamp = now();
    if (!refresh) {
      const hit = cache.get(key);
      if (hit && timestamp - hit.at < ttl) return hit.payload;
      if (pending.has(key)) return pending.get(key);
    }
    const task = Promise.resolve().then(loader).then((payload) => {
      cache.set(key, { at: now(), payload });
      return payload;
    }).finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  }

  async function loadUs(extraSymbols) {
    return cached(`us:${extraSymbols.join(',')}`, async () => {
      const tracked = usTrackedItems(extraSymbols, marketCatalog);
      try {
        const { quotes, session } = await yahoo.fetchQuotes(tracked.map((item) => item.symbol));
        return buildUsMarketBoard({
          quotes,
          extraSymbols,
          session,
          fetchedAt: now(),
          errors: Math.max(tracked.length - quotes.length, 0),
          marketCatalog,
        });
      } catch {
        return buildUsMarketBoard({
          quotes: [],
          extraSymbols,
          session: 'closed',
          fetchedAt: now(),
          errors: tracked.length,
          marketCatalog,
        });
      }
    });
  }

  async function loadGlobal() {
    return cached('global', async () => {
      const tracked = globalTrackedItems(marketCatalog);
      const symbols = [...new Set(tracked.map((item) => item.yahoo))];
      try {
        const quotes = await fetchQuotes(symbols);
        const session = quotes.some((item) => item.session === 'regular') ? 'regular' : 'closed';
        return buildGlobalAssetBoard({
          quotes,
          session,
          fetchedAt: now(),
          errors: Math.max(symbols.length - quotes.length, 0),
          marketCatalog,
        });
      } catch {
        return buildGlobalAssetBoard({
          quotes: [],
          session: 'closed',
          fetchedAt: now(),
          errors: symbols.length,
          marketCatalog,
        });
      }
    });
  }

  async function loadCn(extraSymbols) {
    return cached(`cn-board:${extraSymbols.join(',')}`, async () => {
      const tracked = cnTrackedItems(extraSymbols, marketCatalog);
      const unique = [...new Set(tracked.map((item) => item.symbol))];
      try {
        const quotes = await fetchQuotes(unique);
        return buildCnMarketBoard({
          quotes,
          extraSymbols,
          fetchedAt: now(),
          errors: unique.filter((symbol) => !quotes.some((item) => item.symbol === symbol)).length,
          marketCatalog,
        });
      } catch {
        return buildCnMarketBoard({
          quotes: [],
          extraSymbols,
          fetchedAt: now(),
          errors: unique.length,
          marketCatalog,
        });
      }
    });
  }

  async function loadAsia(extraSymbols) {
    return cached(`asia:${extraSymbols.join(',')}`, async () => {
      const tracked = asiaTrackedItems(extraSymbols, marketCatalog);
      try {
        const { quotes } = await yahoo.fetchQuotes(tracked.map((item) => item.symbol));
        return buildAsiaMarketBoard({
          quotes,
          extraSymbols,
          fetchedAt: now(),
          errors: Math.max(tracked.length - quotes.length, 0),
          marketCatalog,
        });
      } catch {
        return buildAsiaMarketBoard({
          quotes: [],
          extraSymbols,
          fetchedAt: now(),
          errors: tracked.length,
          marketCatalog,
        });
      }
    });
  }

  async function fetchYahooQuotes(symbols, { refresh = false } = {}) {
    if (!symbols.length) return [];
    return cached(`yahoo:${symbols.slice().sort().join(',')}`, async () => {
      try {
        const { quotes } = await yahoo.fetchQuotes(symbols, { interval: refresh ? '1m' : '5m' });
        return quotes.map((item) => mapQuote({
          symbol: item.symbol,
          name: item.name,
          lastPrice: item.lastPrice,
          prevClose: item.prevClose,
          change: item.change,
          changePct: item.changePct,
          high: item.high,
          low: item.low,
          volume: item.volume,
          sparkline: item.sparkline,
          currency: item.currency,
          session: item.session,
        }));
      } catch {
        return [];
      }
    }, { refresh });
  }

  function mapQuote(item, sessionFallback = 'regular') {
    const lastPrice = item.lastPrice;
    const prevClose = item.prevClose;
    const change = item.change ?? (lastPrice != null && prevClose != null ? lastPrice - prevClose : null);
    const changePct = item.changePct ?? (lastPrice != null && prevClose ? ((lastPrice - prevClose) / prevClose) * 100 : null);
    return {
      symbol: String(item.symbol || '').toUpperCase(),
      ...(item.name ? { name: item.name } : {}),
      lastPrice,
      prevClose,
      change,
      changePct,
      high: item.high ?? null,
      low: item.low ?? null,
      volume: item.volume ?? null,
      sparkline: Array.isArray(item.sparkline) ? item.sparkline : [],
      session: item.session || sessionFallback,
      ...(item.currency ? { currency: item.currency } : {}),
    };
  }

  async function fetchCnQuotes(symbols, { refresh = false } = {}) {
    if (!symbols.length || !cnQuotes?.fetchQuotes) return [];
    return cached(`cn:${symbols.slice().sort().join(',')}`, async () => {
      try {
        return (await cnQuotes.fetchQuotes(symbols)).map((item) => mapQuote(item));
      } catch {
        return [];
      }
    }, { refresh });
  }

  async function fetchSinaFutures(symbols, { refresh = false } = {}) {
    if (!symbols.length || !sinaFutures?.fetchQuotes) return [];
    return cached(`sina-futures:${symbols.slice().sort().join(',')}`, async () => {
      try {
        return (await sinaFutures.fetchQuotes(symbols)).map((item) => mapQuote(item));
      } catch {
        return [];
      }
    }, { refresh });
  }

  async function fetchXueqiuQuotes(symbols, { refresh = false } = {}) {
    if (!symbols.length || !xueqiuQuotes?.fetchQuotes) return [];
    return cached(`xueqiu:${symbols.slice().sort().join(',')}`, async () => {
      try {
        return (await xueqiuQuotes.fetchQuotes(symbols)).map((item) => mapQuote(item));
      } catch {
        return [];
      }
    }, { refresh, ttl: xueqiuTtlMs });
  }

  async function fetchQuotes(symbols, { refresh = false } = {}) {
    const unique = [...new Set((symbols || []).map((item) => String(item || '').trim().toUpperCase()).filter(Boolean))];
    if (!unique.length) return [];
    const sinaSymbols = unique.filter(isSinaFutureSymbol);
    const xueqiuSymbols = unique.filter((symbol) => isXueqiuYahooSymbol(symbol) && !isSinaFutureSymbol(symbol));
    const otherSymbols = unique.filter((symbol) => !isXueqiuYahooSymbol(symbol) && !isSinaFutureSymbol(symbol));
    const [sinaList, xueqiuList, otherList] = await Promise.all([
      fetchSinaFutures(sinaSymbols, { refresh }),
      fetchXueqiuQuotes(xueqiuSymbols, { refresh }),
      fetchYahooQuotes(otherSymbols, { refresh }),
    ]);
    const missingXueqiu = xueqiuSymbols.filter((symbol) => !xueqiuList.some((item) => item.symbol === symbol));
    const missingCn = missingXueqiu.filter(isCnYahooSymbol);
    const thsList = missingCn.length ? await fetchCnQuotes(missingCn, { refresh }) : [];
    const stillMissing = missingXueqiu.filter((symbol) => !thsList.some((item) => item.symbol === symbol));
    const fallback = stillMissing.length ? await fetchYahooQuotes(stillMissing, { refresh }) : [];
    const bySymbol = new Map([...otherList, ...fallback, ...thsList, ...xueqiuList, ...sinaList].map((item) => [item.symbol, item]));
    return unique.map((symbol) => bySymbol.get(symbol)).filter(Boolean);
  }

  async function getBoard({ board = 'overview', extra = '', extraUs = extra, extraAsia = extra, extraCn = extra } = {}) {
    const usExtras = parseUsExtraSymbols(extraUs, marketCatalog);
    const asiaExtras = parseAsiaExtraSymbols(extraAsia, marketCatalog);
    const cnExtras = parseCnExtraSymbols(extraCn, marketCatalog);
    if (board === 'us') return loadUs(usExtras);
    if (board === 'asia') return loadAsia(asiaExtras);
    if (board === 'cn') return loadCn(cnExtras);
    if (board === 'global') return loadGlobal();
    const focus = preferredOverviewFocus(now());
    const [usBoard, asiaBoard, cnBoard] = await Promise.all([
      focus === 'us' ? loadUs(usExtras) : Promise.resolve(null),
      Promise.resolve(null),
      focus === 'cn' ? loadCn(cnExtras) : Promise.resolve(null),
    ]);
    return buildOverviewBoard(usBoard, asiaBoard, cnBoard, { focus, now: now() });
  }

  async function fetchHistory(symbols, options = {}) {
    const unique = [...new Set((symbols || []).map((item) => String(item || '').trim()).filter(Boolean))];
    if (!unique.length) return [];
    const range = options.range || '3mo';
    const interval = options.interval || '1d';
    return cached(`history:${range}:${interval}:${unique.slice().sort().join(',')}`, async () => {
      try {
        if (!yahoo.fetchHistory) return [];
        return await yahoo.fetchHistory(unique, { range, interval });
      } catch {
        return [];
      }
    }, { refresh: Boolean(options.refresh) });
  }

  async function search(query) {
    return yahoo.searchSymbols(String(query || '').trim());
  }

  return { getBoard, search, fetchQuotes, fetchHistory, parseUsExtraSymbols, parseAsiaExtraSymbols, parseCnExtraSymbols };
}
