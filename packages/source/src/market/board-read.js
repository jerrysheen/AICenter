import { createMemorySnapshotCache } from '../../../runtime/src/snapshot-cache.js';
import { parseAsiaExtraSymbols, parseCnExtraSymbols, parseUsExtraSymbols } from './boards.js';

export const MARKET_BOARD_CACHE_TTL_MS = 45_000;
export const MARKET_BOARD_NAMES = Object.freeze(['overview', 'us', 'asia', 'cn', 'global']);

const EXTRA_QUOTE_CACHE_LIMIT = 32;

export function marketBoardSnapshotKey(board) {
  return `market-board-${board}`;
}

export function emptyMarketBoard(board = 'overview', now = Date.now()) {
  const name = MARKET_BOARD_NAMES.includes(board) ? board : 'overview';
  const flat = { advancers: 0, decliners: 0, unchanged: 0 };
  const fetchedAt = Math.trunc(Number(now));
  return {
    board: name,
    mode: 'partial',
    fetchedAt: Number.isInteger(fetchedAt) && fetchedAt >= 0 ? fetchedAt : Date.now(),
    session: 'closed',
    ...(name === 'overview' ? { focus: 'us' } : {}),
    note: '行情快照尚未就绪。',
    groups: [],
    indices: [],
    watchlist: [],
    gainers: [],
    losers: [],
    breadth: name === 'overview'
      ? { us: { ...flat }, asia: { ...flat }, cn: { ...flat } }
      : flat,
    ...(name === 'overview' ? { sections: [] } : {}),
  };
}

function extraSymbolsFor(board, query, marketCatalog) {
  if (board === 'us') return parseUsExtraSymbols(query?.extraUs || query?.extra || '', marketCatalog);
  if (board === 'asia') return parseAsiaExtraSymbols(query?.extraAsia || query?.extra || '', marketCatalog);
  if (board === 'cn') return parseCnExtraSymbols(query?.extraCn || query?.extra || '', marketCatalog);
  return [];
}

function extraRow(symbol, quote, board) {
  const item = quote && String(quote.symbol || '').toUpperCase() === symbol ? quote : null;
  return {
    symbol,
    name: item?.name || symbol,
    market: board.board,
    assetClass: 'equity',
    group: '自选',
    summary: '',
    lastPrice: item?.lastPrice ?? null,
    changePct: item?.changePct ?? null,
    change: item?.change ?? null,
    high: item?.high ?? null,
    low: item?.low ?? null,
    prevClose: item?.prevClose ?? null,
    volume: item?.volume ?? null,
    sparkline: Array.isArray(item?.sparkline) ? item.sparkline : [],
    currency: item?.currency || '',
    exchange: item?.exchange || '',
    session: item?.session || board.session || 'closed',
    asOf: item?.asOf ?? null,
    provider: item?.provider || 'yahoo',
    expiry: '',
  };
}

export function withExtraWatchlist(board, rows) {
  if (!rows?.length || !board || board.board === 'overview' || board.board === 'global') return board;
  const watchlist = [...(board.watchlist || [])];
  const seen = new Set(watchlist.map((item) => String(item.symbol || '').toUpperCase()));
  for (const row of rows) {
    const symbol = String(row?.symbol || '').toUpperCase();
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    watchlist.push(row);
  }
  const indexSymbols = new Set((board.indices || []).map((item) => String(item.symbol || '').toUpperCase()));
  const ranked = watchlist.filter((item) => item.changePct != null && !indexSymbols.has(String(item.symbol || '').toUpperCase()));
  const advancers = ranked.filter((item) => (item.changePct ?? 0) > 0.005).length;
  const decliners = ranked.filter((item) => (item.changePct ?? 0) < -0.005).length;
  const unchanged = Math.max(ranked.length - advancers - decliners, 0);
  const byMove = [...ranked].sort((left, right) => (right.changePct ?? -Infinity) - (left.changePct ?? -Infinity));
  return {
    ...board,
    watchlist,
    mode: watchlist.some((item) => item.lastPrice == null) ? 'partial' : board.mode,
    gainers: byMove.filter((item) => (item.changePct ?? 0) > 0).slice(0, 5),
    losers: [...byMove].reverse().filter((item) => (item.changePct ?? 0) < 0).slice(0, 5),
    breadth: { advancers, decliners, unchanged },
  };
}

export function createMarketBoardReader({
  repository,
  workspaceId = 'local',
  ttlMs = MARKET_BOARD_CACHE_TTL_MS,
  now = () => Date.now(),
  marketCatalog = null,
  quotePort = null,
} = {}) {
  if (!repository?.readSnapshot) throw new TypeError('market board reader requires a snapshot repository');
  const caches = new Map();
  const extraQuotes = new Map();

  function cacheFor(board) {
    let cache = caches.get(board);
    if (!cache) {
      cache = createMemorySnapshotCache({
        ttlMs,
        now,
        read: () => repository.readSnapshot(workspaceId, marketBoardSnapshotKey(board)),
      });
      caches.set(board, cache);
    }
    return cache;
  }

  function rememberQuotes(key, quotes) {
    extraQuotes.set(key, { at: now(), quotes });
    while (extraQuotes.size > EXTRA_QUOTE_CACHE_LIMIT) {
      const oldest = extraQuotes.keys().next().value;
      extraQuotes.delete(oldest);
    }
  }

  async function loadExtraQuotes(symbols) {
    const key = symbols.join(',');
    const hit = extraQuotes.get(key);
    const fresh = hit && now() - hit.at < ttlMs;
    if (fresh) return hit.quotes;
    if (hit) {
      Promise.resolve()
        .then(() => quotePort?.fetchQuotes?.(symbols))
        .then((quotes) => {
          if (Array.isArray(quotes)) rememberQuotes(key, quotes);
        })
        .catch(() => {});
      return hit.quotes;
    }
    if (!quotePort?.fetchQuotes) return [];
    try {
      const quotes = await quotePort.fetchQuotes(symbols);
      const list = Array.isArray(quotes) ? quotes : [];
      rememberQuotes(key, list);
      return list;
    } catch {
      return [];
    }
  }

  return {
    async read(query = {}, { refresh = false } = {}) {
      const board = MARKET_BOARD_NAMES.includes(query.board) ? query.board : 'overview';
      const stored = await cacheFor(board).get({ refresh: Boolean(refresh) });
      const payload = stored?.payload;
      if (!payload || payload.board !== board || payload.fetchedAt == null) {
        return { market: emptyMarketBoard(board, now()), pending: true };
      }
      const symbols = extraSymbolsFor(board, query, marketCatalog);
      if (!symbols.length) return { market: payload, pending: false };
      const quotes = await loadExtraQuotes(symbols);
      const bySymbol = new Map((quotes || []).map((item) => [String(item?.symbol || '').toUpperCase(), item]));
      const rows = symbols.map((symbol) => extraRow(symbol, bySymbol.get(symbol), payload));
      return { market: withExtraWatchlist(payload, rows), pending: false };
    },
  };
}
