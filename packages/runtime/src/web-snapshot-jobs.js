import { readStaticSignalBoardSnapshot } from '../../source/src/static/board.js';
import { STATIC_SIGNAL_BOARD_SNAPSHOT_KEY } from '../../source/src/static/board-read.js';
import { readMarketNativeBoard } from '../../source/src/static/market-native-board.js';
import {
  MARKET_NATIVE_BOARD_CAPTURE_LIMIT,
  MARKET_NATIVE_BOARD_SNAPSHOT_KEY,
} from '../../source/src/static/market-native-read.js';
import { buildOverviewBoard, preferredOverviewFocus } from '../../source/src/market/boards.js';
import { MARKET_BOARD_NAMES, marketBoardSnapshotKey } from '../../source/src/market/board-read.js';
import { listHoldingsQuoteSymbols, retainPreciseQuotes } from '../../domain/src/trading-service.js';

export const STATIC_SIGNAL_BOARD_JOB_TYPE = 'source.static-signal-board.snapshot';
export const HOLDINGS_MARKET_JOB_TYPE = 'market.holdings.snapshot';
export const MARKET_BOARDS_JOB_TYPE = 'market.boards.snapshot';
export const MARKET_NATIVE_BOARD_JOB_TYPE = 'market.native-board.snapshot';
export const STATIC_SIGNAL_BOARD_SCHEDULE_KEY = 'source.static-signal-board.snapshot';
export const HOLDINGS_MARKET_SCHEDULE_KEY = 'market.holdings.snapshot';
export const MARKET_BOARDS_SCHEDULE_KEY = 'market.boards.snapshot';
export const MARKET_NATIVE_BOARD_SCHEDULE_KEY = 'market.native-board.snapshot';
export const HOLDINGS_MARKET_SNAPSHOT_KEY = 'holdings-market';
export { MARKET_NATIVE_BOARD_SNAPSHOT_KEY, marketBoardSnapshotKey };

const DAY_MS = 86_400_000;
const HISTORY_REFRESH_MS = 15 * 60 * 1000;
const INTERVAL_MINUTES = 1;

export const webSnapshotManifest = Object.freeze({
  id: 'runtime.web-snapshots',
  version: '1.0.0',
  capabilities: [
    STATIC_SIGNAL_BOARD_JOB_TYPE,
    HOLDINGS_MARKET_JOB_TYPE,
    MARKET_BOARDS_JOB_TYPE,
    MARKET_NATIVE_BOARD_JOB_TYPE,
  ],
  jobTypes: [
    STATIC_SIGNAL_BOARD_JOB_TYPE,
    HOLDINGS_MARKET_JOB_TYPE,
    MARKET_BOARDS_JOB_TYPE,
    MARKET_NATIVE_BOARD_JOB_TYPE,
  ],
});

export function staticSignalBoardCaptureInput(now = Date.now()) {
  return {
    from: Math.max(0, now - 2 * DAY_MS),
    to: now + 400 * DAY_MS,
    focus: false,
    includeUndated: true,
    limit: 1_000,
    releaseLimit: 200,
  };
}

export async function captureStaticSignalBoard({
  sourcePort,
  repository,
  workspaceId = 'local',
  now = () => Date.now(),
}) {
  if (!repository?.saveSnapshot) throw new Error('官方看板快照需要存储');
  const at = now();
  const payload = await readStaticSignalBoardSnapshot(sourcePort, staticSignalBoardCaptureInput(at), { now: () => at });
  repository.saveSnapshot(workspaceId, STATIC_SIGNAL_BOARD_SNAPSHOT_KEY, payload, payload.generatedAt);
  return {
    generatedAt: payload.generatedAt,
    upcoming: payload.upcoming.length,
    releases: payload.releases.length,
    sources: payload.sourceHealth.length,
  };
}

function seriesCovers(series, symbols) {
  const have = new Set((series || []).map((item) => String(item?.symbol || '').toUpperCase()));
  return symbols.every((symbol) => have.has(String(symbol || '').toUpperCase()));
}

export async function captureHoldingsMarket({
  sourcePort,
  repository,
  tradingRepository,
  workspaceId = 'local',
  now = () => Date.now(),
  historyRefreshMs = HISTORY_REFRESH_MS,
}) {
  if (!sourcePort?.read) throw new Error('持仓行情快照需要 Source 端口');
  if (!repository?.saveSnapshot || !repository?.readSnapshot) throw new Error('持仓行情快照需要存储');
  if (!tradingRepository) throw new Error('持仓行情快照需要持仓账本');
  const at = now();
  const symbols = listHoldingsQuoteSymbols(tradingRepository, workspaceId);
  const existing = repository.readSnapshot(workspaceId, HOLDINGS_MARKET_SNAPSHOT_KEY);
  const previousSeries = Array.isArray(existing?.payload?.series) ? existing.payload.series : [];
  const historyGeneratedAt = Number(existing?.payload?.historyGeneratedAt) || 0;
  const refreshHistory = !seriesCovers(previousSeries, symbols) || at - historyGeneratedAt >= historyRefreshMs;
  const quotesSnapshot = await sourcePort.read('market.quotes', { symbols }, { refresh: true });
  let series = previousSeries;
  let historyAt = historyGeneratedAt;
  if (refreshHistory) {
    const historySnapshot = await sourcePort.read('market.history', {
      symbols,
      range: '3mo',
      interval: '1d',
    }, { refresh: true });
    series = Array.isArray(historySnapshot?.data) ? historySnapshot.data : [];
    historyAt = at;
  }
  const storedQuotes = new Map();
  for (const quote of Array.isArray(existing?.payload?.quotes) ? existing.payload.quotes : []) {
    const symbol = String(quote?.symbol || '').trim().toUpperCase();
    if (symbol) storedQuotes.set(symbol, quote);
  }
  const quotes = retainPreciseQuotes(storedQuotes, symbols, quotesSnapshot?.data);
  const payload = {
    generatedAt: at,
    quotes,
    series,
    historyGeneratedAt: historyAt,
  };
  repository.saveSnapshot(workspaceId, HOLDINGS_MARKET_SNAPSHOT_KEY, payload, at);
  return {
    generatedAt: at,
    quotes: quotes.length,
    series: series.length,
    historyRefreshed: refreshHistory,
  };
}

async function readMarketBoard(sourcePort, board) {
  const snapshot = await sourcePort.read(`market.${board}`, {}, { refresh: true });
  const data = snapshot?.data;
  if (!data || data.board !== board) throw new Error(`行情看板 ${board} 没有可用快照`);
  return data;
}

export async function captureMarketBoards({
  sourcePort,
  repository,
  workspaceId = 'local',
  now = () => Date.now(),
}) {
  if (!sourcePort?.read) throw new Error('行情看板快照需要 Source 端口');
  if (!repository?.saveSnapshot) throw new Error('行情看板快照需要存储');
  const at = now();
  const [us, asia, cn, global] = await Promise.all([
    readMarketBoard(sourcePort, 'us'),
    readMarketBoard(sourcePort, 'asia'),
    readMarketBoard(sourcePort, 'cn'),
    readMarketBoard(sourcePort, 'global'),
  ]);
  const focus = preferredOverviewFocus(at);
  const overview = buildOverviewBoard(
    focus === 'us' ? us : null,
    null,
    focus === 'cn' ? cn : null,
    { focus, now: at },
  );
  const boards = { overview, us, asia, cn, global };
  for (const name of MARKET_BOARD_NAMES) {
    repository.saveSnapshot(workspaceId, marketBoardSnapshotKey(name), boards[name], at);
  }
  return {
    generatedAt: at,
    focus,
    boards: MARKET_BOARD_NAMES.length,
  };
}

export async function captureMarketNativeBoard({
  sourcePort,
  repository,
  workspaceId = 'local',
  now = () => Date.now(),
}) {
  if (!sourcePort?.read || !sourcePort?.list) throw new Error('市场原生看板快照需要 Source 端口');
  if (!repository?.saveSnapshot) throw new Error('市场原生看板快照需要存储');
  const at = now();
  const board = await readMarketNativeBoard(sourcePort, {
    predictionLimit: MARKET_NATIVE_BOARD_CAPTURE_LIMIT,
  }, { refresh: true, now: () => at });
  repository.saveSnapshot(workspaceId, MARKET_NATIVE_BOARD_SNAPSHOT_KEY, board, board.generatedAt);
  return {
    generatedAt: board.generatedAt,
    predictions: board.predictionMarkets.length,
    derivatives: board.cryptoDerivatives.length,
  };
}

export function createWebSnapshotJobHandlers(options) {
  return {
    [STATIC_SIGNAL_BOARD_JOB_TYPE]: async () => captureStaticSignalBoard(options),
    [HOLDINGS_MARKET_JOB_TYPE]: async () => captureHoldingsMarket(options),
    [MARKET_BOARDS_JOB_TYPE]: async () => captureMarketBoards(options),
    [MARKET_NATIVE_BOARD_JOB_TYPE]: async () => captureMarketNativeBoard(options),
  };
}

function upsertInterval(store, key, jobType, now) {
  return store.upsertJobSchedule({
    workspaceId: 'local',
    key,
    jobType,
    enabled: true,
    schedule: { kind: 'interval', intervalMinutes: INTERVAL_MINUTES },
    input: {},
    priority: 0,
    maxAttempts: 2,
    nextRunAt: Math.trunc(Number(now)),
  });
}

export function ensureStaticSignalBoardSchedule(store, now = Date.now()) {
  return upsertInterval(store, STATIC_SIGNAL_BOARD_SCHEDULE_KEY, STATIC_SIGNAL_BOARD_JOB_TYPE, now);
}

export function ensureHoldingsMarketSchedule(store, now = Date.now()) {
  return upsertInterval(store, HOLDINGS_MARKET_SCHEDULE_KEY, HOLDINGS_MARKET_JOB_TYPE, now);
}

export function ensureMarketBoardsSchedule(store, now = Date.now()) {
  return upsertInterval(store, MARKET_BOARDS_SCHEDULE_KEY, MARKET_BOARDS_JOB_TYPE, now);
}

export function ensureMarketNativeBoardSchedule(store, now = Date.now()) {
  return upsertInterval(store, MARKET_NATIVE_BOARD_SCHEDULE_KEY, MARKET_NATIVE_BOARD_JOB_TYPE, now);
}
