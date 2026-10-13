import { createMemorySnapshotCache } from '../../../runtime/src/snapshot-cache.js';
import { MarketNativeBoardInputSchema } from './market-native-board.js';
import { parseContract } from '../../../contracts/src/index.js';

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

export function createMarketNativeBoardReader({
  repository,
  workspaceId = 'local',
  ttlMs = MARKET_NATIVE_BOARD_CACHE_TTL_MS,
  now = () => Date.now(),
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
      return {
        board: projectMarketNativeBoard(stored.payload, input.predictionLimit),
        pending: false,
      };
    },
  };
}
