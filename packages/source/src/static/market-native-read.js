import { createMemorySnapshotCache } from '../../../runtime/src/snapshot-cache.js';
import { MarketNativeBoardInputSchema } from './market-native-board.js';
import { PredictionMarketQuoteSchema, parseContract } from '../../../contracts/src/index.js';

export const MARKET_NATIVE_BOARD_SNAPSHOT_KEY = 'market-native-board';
export const MARKET_NATIVE_BOARD_CACHE_TTL_MS = 45_000;
export const MARKET_NATIVE_BOARD_CAPTURE_LIMIT = 50;

export function emptyMarketNativeBoard(now = Date.now()) {
  const generatedAt = Math.trunc(Number(now));
  return {
    generatedAt: Number.isInteger(generatedAt) && generatedAt >= 0 ? generatedAt : Date.now(),
    predictionMarkets: [],
    cryptoDerivatives: [],
    stablecoinLiquidity: null,
    sourceHealth: [],
  };
}

export function projectMarketNativeBoard(board, predictionLimit = 12) {
  const limit = Math.min(MARKET_NATIVE_BOARD_CAPTURE_LIMIT, Math.max(1, Math.trunc(Number(predictionLimit) || 12)));
  return {
    ...board,
    predictionMarkets: (board.predictionMarkets || []).slice(0, limit * 2),
  };
}

function watchedPolymarketQuotes(quotes) {
  const kept = [];
  for (const quote of quotes || []) {
    const parsed = PredictionMarketQuoteSchema.safeParse(quote);
    if (parsed.success) kept.push(parsed.data);
  }
  return kept;
}

export function createMarketNativeBoardReader({
  repository,
  workspaceId = 'local',
  ttlMs = MARKET_NATIVE_BOARD_CACHE_TTL_MS,
  now = () => Date.now(),
  polymarketQuotes,
} = {}) {
  if (!repository?.readSnapshot) throw new TypeError('market-native board reader requires a snapshot repository');
  const cache = createMemorySnapshotCache({
    ttlMs,
    now,
    read: () => repository.readSnapshot(workspaceId, MARKET_NATIVE_BOARD_SNAPSHOT_KEY),
  });
  return {
    async read(rawInput = {}, { refresh = false } = {}) {
      const input = parseContract(MarketNativeBoardInputSchema, rawInput);
      const stored = await cache.get({ refresh: Boolean(refresh) });
      if (!stored?.payload || stored.payload.generatedAt == null) {
        return { board: emptyMarketNativeBoard(now()), pending: true };
      }
      const projected = projectMarketNativeBoard(stored.payload, input.predictionLimit);
      if (typeof polymarketQuotes !== 'function') return { board: projected, pending: false };
      try {
        const view = await polymarketQuotes();
        const quotes = watchedPolymarketQuotes(view?.quotes);
        if (!view?.available || !quotes.length) return { board: projected, pending: false };
        const others = (stored.payload.predictionMarkets || []).filter((quote) => quote?.venue !== 'polymarket');
        return {
          board: {
            ...projected,
            predictionMarkets: [...quotes, ...others].slice(0, 1_000),
          },
          pending: false,
        };
      } catch (error) {
        console.error('[market-native] 观察清单读取失败:', error instanceof Error ? error.message : error);
        return { board: projected, pending: false };
      }
    },
  };
}
