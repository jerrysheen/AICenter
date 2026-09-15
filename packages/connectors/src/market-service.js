import { asiaTrackedItems, buildAsiaMarketBoard, buildOverviewBoard, buildUsMarketBoard, parseAsiaExtraSymbols, parseUsExtraSymbols, usTrackedItems } from './market-boards.js';
import { createYahooClient } from './yahoo.js';

export function createMarketService(options = {}) {
  const yahoo = options.yahoo || createYahooClient(options);
  const ttlMs = options.ttlMs ?? 20_000;
  const now = options.now || (() => Date.now());
  const cache = new Map();

  async function cached(key, loader) {
    const hit = cache.get(key);
    const timestamp = now();
    if (hit && timestamp - hit.at < ttlMs) return hit.payload;
    const payload = await loader();
    cache.set(key, { at: timestamp, payload });
    return payload;
  }

  async function loadUs(extraSymbols) {
    return cached(`us:${extraSymbols.join(',')}`, async () => {
      const tracked = usTrackedItems(extraSymbols);
      const { quotes, session } = await yahoo.fetchQuotes(tracked.map((item) => item.symbol));
      return buildUsMarketBoard({
        quotes,
        extraSymbols,
        session,
        fetchedAt: now(),
        errors: Math.max(tracked.length - quotes.length, 0),
      });
    });
  }

  async function loadAsia(extraSymbols) {
    return cached(`asia:${extraSymbols.join(',')}`, async () => {
      const tracked = asiaTrackedItems(extraSymbols);
      const { quotes } = await yahoo.fetchQuotes(tracked.map((item) => item.symbol));
      return buildAsiaMarketBoard({
        quotes,
        extraSymbols,
        fetchedAt: now(),
        errors: Math.max(tracked.length - quotes.length, 0),
      });
    });
  }

  async function getBoard({ board = 'overview', extra = '', extraUs = extra, extraAsia = extra } = {}) {
    const usExtras = parseUsExtraSymbols(extraUs);
    const asiaExtras = parseAsiaExtraSymbols(extraAsia);
    if (board === 'us') return loadUs(usExtras);
    if (board === 'asia') return loadAsia(asiaExtras);
    const [usBoard, asiaBoard] = await Promise.all([loadUs(usExtras), loadAsia(asiaExtras)]);
    return buildOverviewBoard(usBoard, asiaBoard);
  }

  async function search(query) {
    return yahoo.searchSymbols(String(query || '').trim());
  }

  return { getBoard, search, parseUsExtraSymbols, parseAsiaExtraSymbols };
}
