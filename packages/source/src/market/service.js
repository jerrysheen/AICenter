import { asiaTrackedItems, buildAsiaMarketBoard, buildGlobalAssetBoard, buildOverviewBoard, buildUsMarketBoard, globalTrackedItems, parseAsiaExtraSymbols, parseUsExtraSymbols, usTrackedItems } from './boards.js';
import { createCnQuoteClient, isCnYahooSymbol } from '../../../connectors/src/cn-quotes.js';
import { createYahooClient } from '../../../connectors/src/yahoo.js';
import { resolveMarketCatalog } from './catalog.js';

export function createMarketService(options = {}) {
  const marketCatalog = options.marketCatalog || resolveMarketCatalog(options.marketCatalogPath);
  const yahoo = options.yahoo || createYahooClient(options);
  const cnQuotes = options.cnQuotes || createCnQuoteClient(options);
  const ttlMs = options.ttlMs ?? 20_000;
  const now = options.now || (() => Date.now());
  const cache = new Map();
  const pending = new Map();

  async function cached(key, loader, { refresh = false } = {}) {
    const timestamp = now();
    if (!refresh) {
      const hit = cache.get(key);
      if (hit && timestamp - hit.at < ttlMs) return hit.payload;
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
        const { quotes, session } = await yahoo.fetchQuotes(symbols);
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
        return quotes.map((item) => ({
          symbol: String(item.symbol || '').toUpperCase(),
          lastPrice: item.lastPrice,
          prevClose: item.prevClose,
          currency: item.currency,
          session: item.session,
        }));
      } catch {
        return [];
      }
    }, { refresh });
  }

  async function fetchCnQuotes(symbols, { refresh = false } = {}) {
    if (!symbols.length || !cnQuotes?.fetchQuotes) return [];
    return cached(`cn:${symbols.slice().sort().join(',')}`, async () => {
      try {
        return (await cnQuotes.fetchQuotes(symbols)).map((item) => ({
          symbol: String(item.symbol || '').toUpperCase(),
          lastPrice: item.lastPrice,
          prevClose: item.prevClose,
          session: item.session || 'regular',
        }));
      } catch {
        return [];
      }
    }, { refresh });
  }

  async function fetchQuotes(symbols, { refresh = false } = {}) {
    const unique = [...new Set((symbols || []).map((item) => String(item || '').trim().toUpperCase()).filter(Boolean))];
    if (!unique.length) return [];
    const cnSymbols = unique.filter(isCnYahooSymbol);
    const otherSymbols = unique.filter((symbol) => !isCnYahooSymbol(symbol));
    const [cnList, otherList] = await Promise.all([
      fetchCnQuotes(cnSymbols, { refresh }),
      fetchYahooQuotes(otherSymbols, { refresh }),
    ]);
    const missingCn = cnSymbols.filter((symbol) => !cnList.some((item) => item.symbol === symbol));
    const fallback = missingCn.length ? await fetchYahooQuotes(missingCn, { refresh }) : [];
    const bySymbol = new Map([...otherList, ...fallback, ...cnList].map((item) => [item.symbol, item]));
    return unique.map((symbol) => bySymbol.get(symbol)).filter(Boolean);
  }

  async function getBoard({ board = 'overview', extra = '', extraUs = extra, extraAsia = extra } = {}) {
    const usExtras = parseUsExtraSymbols(extraUs, marketCatalog);
    const asiaExtras = parseAsiaExtraSymbols(extraAsia, marketCatalog);
    if (board === 'us') return loadUs(usExtras);
    if (board === 'asia') return loadAsia(asiaExtras);
    if (board === 'global') return loadGlobal();
    const [usBoard, asiaBoard] = await Promise.all([loadUs(usExtras), loadAsia(asiaExtras)]);
    return buildOverviewBoard(usBoard, asiaBoard);
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

  return { getBoard, search, fetchQuotes, fetchHistory, parseUsExtraSymbols, parseAsiaExtraSymbols };
}
