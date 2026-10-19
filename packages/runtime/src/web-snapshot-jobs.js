import { localizeOfficialBoard } from '../../domain/src/official-source-zh.js';
import { readStaticSignalBoardSnapshot } from '../../source/src/static/board.js';
import { STATIC_SIGNAL_BOARD_SNAPSHOT_KEY } from '../../source/src/static/board-read.js';
import { readMarketNativeBoard } from '../../source/src/static/market-native-board.js';
import {
  MARKET_NATIVE_BOARD_CAPTURE_LIMIT,
  MARKET_NATIVE_BOARD_SNAPSHOT_KEY,
} from '../../source/src/static/market-native-read.js';
import { buildOverviewBoard, preferredOverviewFocus, usRegularSessionAt } from '../../source/src/market/boards.js';
import { marketBoardSnapshotKey, newestQuoteAsOf } from '../../source/src/market/board-read.js';
import { listHoldingsQuoteSymbols, retainPreciseQuotes } from '../../domain/src/trading-service.js';

export const STATIC_SIGNAL_BOARD_JOB_TYPE = 'source.static-signal-board.snapshot';
export const HOLDINGS_MARKET_JOB_TYPE = 'market.holdings.snapshot';
export const MARKET_BOARDS_JOB_TYPE = 'market.boards.snapshot';
export const MARKET_NATIVE_BOARD_JOB_TYPE = 'market.native-board.snapshot';
export const STATIC_SIGNAL_BOARD_SCHEDULE_KEY = 'source.static-signal-board.snapshot';
export const HOLDINGS_MARKET_SCHEDULE_KEY = 'market.holdings.snapshot';
export const MARKET_BOARDS_SCHEDULE_KEY = 'market.boards.snapshot';
export const MARKET_NATIVE_BOARD_SCHEDULE_KEY = 'market.native-board.snapshot';
export const FEED_LIST_JOB_TYPE = 'feed.lists.snapshot';
export const FEED_LIST_SCHEDULE_KEY = 'feed.lists.snapshot';
export const HARDWARE_PRICE_JOB_TYPE = 'hardware.prices.snapshot';
export const HARDWARE_PRICE_SCHEDULE_KEY = 'hardware.prices.snapshot';
export const HARDWARE_PRICE_SNAPSHOT_KEY = 'hardware-prices';
export const HOME_BOOTSTRAP_JOB_TYPE = 'home.bootstrap.snapshot';
export const HOME_BOOTSTRAP_SCHEDULE_KEY = 'home.bootstrap.snapshot';
export const HOME_BOOTSTRAP_SNAPSHOT_KEY = 'home-bootstrap';
export const HOLDINGS_MARKET_SNAPSHOT_KEY = 'holdings-market';
export const FEED_LIST_SNAPSHOT_TTL_MS = 10 * 60 * 1000;
export const HARDWARE_PRICE_SNAPSHOT_TTL_MS = 5 * 60 * 1000;
export const FEED_FLASH_SNAPSHOT_KEY = 'feed-list-flash';
export const FEED_FLASH_LIMIT = 80;
export const FEED_TRENDFORCE_SNAPSHOT_KEY = 'feed-list-trendforce';
export const HARDWARE_PRICE_CATEGORIES = Object.freeze(['dram', 'nand', 'ssd', 'other-storage']);
export const REPORT_VIEWS_JOB_TYPE = 'reports.views.snapshot';
export const REPORT_VIEWS_SCHEDULE_KEY = 'reports.views.snapshot';
export const REPORT_TREE_INDEX_KEY = 'report-tree-index';
export const REPORT_TREE_INDEX_INFO_KEY = 'report-tree-index-info';
export const REPORT_TREE_HOME_KEY = 'report-tree-home';
export const REPORT_READING_INDEX_KEY = 'report-reading-index';
export const REPORT_READING_HOME_KEY = 'report-reading-home';
export { MARKET_NATIVE_BOARD_SNAPSHOT_KEY, marketBoardSnapshotKey };

export function hardwarePriceCategoryKey(category) {
  return `hardware-prices-${category}`;
}

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
    FEED_LIST_JOB_TYPE,
    HARDWARE_PRICE_JOB_TYPE,
    HOME_BOOTSTRAP_JOB_TYPE,
    REPORT_VIEWS_JOB_TYPE,
  ],
  jobTypes: [
    STATIC_SIGNAL_BOARD_JOB_TYPE,
    HOLDINGS_MARKET_JOB_TYPE,
    MARKET_BOARDS_JOB_TYPE,
    MARKET_NATIVE_BOARD_JOB_TYPE,
    FEED_LIST_JOB_TYPE,
    HARDWARE_PRICE_JOB_TYPE,
    HOME_BOOTSTRAP_JOB_TYPE,
    REPORT_VIEWS_JOB_TYPE,
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
  const payload = localizeOfficialBoard(await readStaticSignalBoardSnapshot(sourcePort, staticSignalBoardCaptureInput(at), { now: () => at }));
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

function envInt(env, key, fallback, min, max) {
  const raw = env?.[key];
  if (raw == null || String(raw).trim() === '') return fallback;
  const value = Number(String(raw).trim());
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function marketUsFreshMs(env = process.env) {
  return envInt(env, 'AI_CENTER_MARKET_US_FRESH_MS', 10 * 60_000, 60_000, 60 * 60_000);
}

export function marketBoardTimeoutMs(env = process.env) {
  return envInt(env, 'AI_CENTER_MARKET_BOARD_TIMEOUT_MS', 20_000, 1_000, 60_000);
}

export function usBoardFreshnessError(board, nowMs, maxAgeMs) {
  if (usRegularSessionAt(nowMs) !== 'regular') return '';
  const quoteAt = newestQuoteAsOf(board);
  const fetchedAt = quoteAt ?? Number(board?.fetchedAt);
  if (!Number.isFinite(fetchedAt)) return '美股看板没有行情时间';
  const ageMs = nowMs - fetchedAt;
  if (ageMs <= maxAgeMs) return '';
  const minutes = Math.max(1, Math.round(ageMs / 60_000));
  return `美股看板行情已 ${minutes} 分钟未更新`;
}

function withTimeout(start, ms, label) {
  const controller = new AbortController();
  let timer;
  let settled = false;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      settled = true;
      controller.abort();
      reject(new Error(label));
    }, ms);
    timer.unref?.();
  });
  const guarded = Promise.resolve()
    .then(() => start(controller.signal))
    .then(
      (value) => (settled ? undefined : value),
      (error) => {
        if (settled) return undefined;
        throw error;
      },
    );
  return Promise.race([guarded, timeout]).finally(() => clearTimeout(timer));
}

async function readMarketBoard(sourcePort, board, signal) {
  const snapshot = await sourcePort.read(`market.${board}`, {}, { refresh: true, signal });
  const data = snapshot?.data;
  if (!data || data.board !== board) throw new Error(`行情看板 ${board} 没有可用快照`);
  return data;
}

export async function captureMarketBoards({
  sourcePort,
  repository,
  workspaceId = 'local',
  now = () => Date.now(),
  env = process.env,
  timeoutMs = marketBoardTimeoutMs(env),
  log = (level, message) => {
    const line = `[market] ${message}`;
    if (level === 'error') console.error(line);
    else console.warn(line);
  },
}) {
  if (!sourcePort?.read) throw new Error('行情看板快照需要 Source 端口');
  if (!repository?.saveSnapshot) throw new Error('行情看板快照需要存储');
  const at = now();
  const focus = preferredOverviewFocus(at);
  const timings = {};
  const failures = [];
  const saved = new Set();
  let overviewSaved = false;
  async function captureOne(name) {
    const started = Date.now();
    try {
      const board = await withTimeout(
        (signal) => readMarketBoard(sourcePort, name, signal),
        timeoutMs,
        `行情看板 ${name} 超时`,
      );
      repository.saveSnapshot(workspaceId, marketBoardSnapshotKey(name), board, at);
      saved.add(name);
      timings[name] = Date.now() - started;
      if (name === focus) {
        const overview = buildOverviewBoard(
          focus === 'us' ? board : null,
          null,
          focus === 'cn' ? board : null,
          { focus, now: at },
        );
        repository.saveSnapshot(workspaceId, marketBoardSnapshotKey('overview'), overview, at);
        overviewSaved = true;
      }
      return board;
    } catch (error) {
      timings[name] = Date.now() - started;
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ board: name, message });
      log('warn', `看板 ${name} 失败 ${message}`);
      return null;
    }
  }
  const boards = {};
  await Promise.all(['us', 'asia', 'cn', 'global'].map(async (name) => {
    boards[name] = await captureOne(name);
  }));
  const summary = ['us', 'asia', 'cn', 'global'].map((name) => `${name}=${timings[name] ?? 0}ms`).join(' ');
  console.log(`[market] boards ${summary} failed=${failures.map((item) => item.board).join(',') || '0'}`);
  const freshError = boards.us ? usBoardFreshnessError(boards.us, at, marketUsFreshMs(env)) : '';
  if (freshError) {
    log('warn', freshError);
    throw new Error(freshError);
  }
  const usFailure = failures.find((item) => item.board === 'us');
  if (usFailure && usRegularSessionAt(at) === 'regular') throw new Error(usFailure.message);
  if (!saved.size && failures.length) throw new Error(failures.map((item) => item.message).join('; '));
  return {
    generatedAt: at,
    focus,
    boards: saved.size + (overviewSaved ? 1 : 0),
    timings,
    failures,
  };
}

export async function captureMarketNativeBoard({
  sourcePort,
  repository,
  workspaceId = 'local',
  now = () => Date.now(),
  keepPolymarketOrder = false,
}) {
  if (!sourcePort?.read || !sourcePort?.list) throw new Error('市场原生看板快照需要 Source 端口');
  if (!repository?.saveSnapshot) throw new Error('市场原生看板快照需要存储');
  const at = now();
  const board = await readMarketNativeBoard(sourcePort, {
    predictionLimit: MARKET_NATIVE_BOARD_CAPTURE_LIMIT,
  }, { refresh: true, now: () => at, keepPredictionOrder: Boolean(keepPolymarketOrder) });
  repository.saveSnapshot(workspaceId, MARKET_NATIVE_BOARD_SNAPSHOT_KEY, board, board.generatedAt);
  return {
    generatedAt: board.generatedAt,
    predictions: board.predictionMarkets.length,
    derivatives: board.cryptoDerivatives.length,
  };
}

const READ_HEAD = { isRead: 1, at: Number.MAX_SAFE_INTEGER, id: '~' };
const HOUR_MS = 3_600_000;
const HOME_RECENT_HOURS = 48;
const FEED_LIST_PAGES = [
  ['feed-list-x', 'x', { feed: 'following', limit: 12, fields: 'list' }],
  ['feed-list-x-read', 'x', { feed: 'following', limit: 12, fields: 'list', before: READ_HEAD }],
  ['feed-list-x-for-you', 'x', { feed: 'for-you', limit: 12, fields: 'list' }],
  ['feed-list-x-for-you-read', 'x', { feed: 'for-you', limit: 12, fields: 'list', before: READ_HEAD }],
  ['feed-list-x-saved', 'x', { feed: 'following', limit: 50, fields: 'list', saved: true }],
  ['feed-list-x-for-you-saved', 'x', { feed: 'for-you', limit: 50, fields: 'list', saved: true }],
  ['feed-list-xueqiu', 'xueqiu', { feed: 'following', limit: 12, fields: 'list' }],
  ['feed-list-xueqiu-read', 'xueqiu', { feed: 'following', limit: 12, fields: 'list', before: READ_HEAD }],
  ['feed-list-xueqiu-featured', 'xueqiu', { feed: 'featured', limit: 12, fields: 'list' }],
  ['feed-list-xueqiu-featured-read', 'xueqiu', { feed: 'featured', limit: 12, fields: 'list', before: READ_HEAD }],
  ['feed-list-xueqiu-livenews', 'xueqiu', { feed: 'livenews', limit: 12, fields: 'list' }],
  ['feed-list-xueqiu-livenews-read', 'xueqiu', { feed: 'livenews', limit: 12, fields: 'list', before: READ_HEAD }],
];
const REPORT_SLOT_KEYS = [
  REPORT_TREE_INDEX_KEY,
  REPORT_TREE_INDEX_INFO_KEY,
  REPORT_TREE_HOME_KEY,
  REPORT_READING_INDEX_KEY,
  REPORT_READING_HOME_KEY,
];
const loggedFeedMisses = new Set();

function isReadHead(before) {
  return before?.isRead === 1 && before?.id === '~' && before?.at === Number.MAX_SAFE_INTEGER;
}

function slotRef(slot) {
  return { workspace: 'local', snapshotKey: slot, slot };
}

export function prebuiltSnapshotSlots() {
  return [
    slotRef(HARDWARE_PRICE_SNAPSHOT_KEY),
    ...HARDWARE_PRICE_CATEGORIES.map((category) => slotRef(hardwarePriceCategoryKey(category))),
    ...FEED_LIST_PAGES.map(([slot]) => slotRef(slot)),
    slotRef(FEED_FLASH_SNAPSHOT_KEY),
    slotRef(FEED_TRENDFORCE_SNAPSHOT_KEY),
    slotRef(HOME_BOOTSTRAP_SNAPSHOT_KEY),
    ...REPORT_SLOT_KEYS.map((slot) => slotRef(slot)),
  ];
}

export function feedListSnapshotKey(providerId, query = {}) {
  if (query.refresh || query.saved || query.fields !== 'list' || Number(query.limit) !== 12) return '';
  const readHead = isReadHead(query.before);
  if (query.before && !readHead) return '';
  const suffix = readHead ? '-read' : '';
  if (providerId === 'x' && query.feed === 'following') return `feed-list-x${suffix}`;
  if (providerId === 'x' && query.feed === 'for-you') return `feed-list-x-for-you${suffix}`;
  if (providerId === 'xueqiu' && query.feed === 'following') return `feed-list-xueqiu${suffix}`;
  if (providerId === 'xueqiu' && query.feed === 'featured') return `feed-list-xueqiu-featured${suffix}`;
  if (providerId === 'xueqiu' && query.feed === 'livenews') return `feed-list-xueqiu-livenews${suffix}`;
  return '';
}

export function feedPrebuiltSlot(providerId, query = {}) {
  if (query.refresh) return '';
  if (query.fields && query.fields !== 'list') return '';
  const readHead = isReadHead(query.before);
  if (query.before && !readHead) return '';
  if (providerId === 'x' && (query.feed === 'following' || query.feed === 'for-you')) {
    if (query.saved) {
      if (query.before) return '';
      return query.feed === 'following' ? 'feed-list-x-saved' : 'feed-list-x-for-you-saved';
    }
    return feedListSnapshotKey(providerId, { ...query, limit: 12, fields: 'list' });
  }
  if (query.saved) return '';
  return feedListSnapshotKey(providerId, { ...query, limit: 12, fields: 'list' });
}

export function describeFeedSlotMiss(providerId, query = {}) {
  const before = !query.before ? '' : (isReadHead(query.before) ? 'read-head' : 'cursor');
  return `provider=${providerId} feed=${query.feed || ''} limit=${query.limit ?? ''} saved=${query.saved ? 1 : 0} refresh=${query.refresh ? 1 : 0} before=${before} fields=${query.fields || ''}`;
}

export function logFeedSlotMiss(providerId, query = {}) {
  const line = describeFeedSlotMiss(providerId, query);
  if (loggedFeedMisses.has(line)) return line;
  loggedFeedMisses.add(line);
  console.log(`[web] feed-slot-miss ${line}`);
  return line;
}

function shanghaiHourStart(nowMs) {
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(nowMs));
  const clock = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(nowMs));
  const read = (parts, type) => Number(parts.find((part) => part.type === type)?.value);
  let hour = read(clock, 'hour');
  if (hour === 24) hour = 0;
  const midnight = Date.UTC(read(date, 'year'), read(date, 'month') - 1, read(date, 'day')) - 8 * HOUR_MS;
  return midnight + hour * HOUR_MS;
}

function hourBucket(value) {
  return Math.floor(Number(value) / HOUR_MS);
}

function sameHourSpan(query, window) {
  return hourBucket(query?.startAt) === hourBucket(window.startAt)
    && hourBucket(query?.endAt) === hourBucket(window.endAt);
}

export function reportPreparedWindows(now = Date.now()) {
  const weekEnd = now + 1;
  const homeEnd = shanghaiHourStart(now) + HOUR_MS;
  return {
    week: { startAt: weekEnd - 7 * DAY_MS, endAt: weekEnd },
    home: { startAt: homeEnd - HOME_RECENT_HOURS * HOUR_MS, endAt: homeEnd },
  };
}

export function reportTreeSlot(query = {}, now = Date.now()) {
  if (query.view !== 'index') return '';
  const windows = reportPreparedWindows(now);
  if (query.information === '1') return sameHourSpan(query, windows.week) ? REPORT_TREE_INDEX_INFO_KEY : '';
  if (query.information) return '';
  if (sameHourSpan(query, windows.week)) return REPORT_TREE_INDEX_KEY;
  if (sameHourSpan(query, windows.home)) return REPORT_TREE_HOME_KEY;
  return '';
}

export function reportReadingIndexSlot(query = {}, now = Date.now()) {
  if (query.scope && query.scope !== 'hour') return '';
  const windows = reportPreparedWindows(now);
  if (sameHourSpan(query, windows.week)) return REPORT_READING_INDEX_KEY;
  if (sameHourSpan(query, windows.home)) return REPORT_READING_HOME_KEY;
  return '';
}

export async function captureFeedLists({
  feedService,
  feedRepository,
  repository,
  workspaceId = 'local',
  now = () => Date.now(),
}) {
  if (!feedService?.getExternalFeed) throw new Error('信息流快照需要 Feed');
  if (!repository?.saveSnapshot) throw new Error('信息流快照需要存储');
  if (feedRepository?.backfillFeedFilterColumns) {
    for (const providerId of ['x', 'xueqiu']) {
      for (let batch = 0; batch < 2; batch += 1) {
        const filled = feedRepository.backfillFeedFilterColumns(10, providerId);
        if (!filled) break;
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  }
  let pages = 0;
  let generatedAt = now();
  for (const [key, providerId, query] of FEED_LIST_PAGES) {
    try {
      const feed = await feedService.getExternalFeed(providerId, query, { workspaceId });
      generatedAt = now();
      repository.saveSnapshot(workspaceId, key, { ok: true, feed }, generatedAt);
      pages += 1;
    } catch {
      /* 未启用的来源不写快照，请求仍走原来的读取。 */
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  try {
    const items = feedService.listFlash?.(workspaceId, { limit: FEED_FLASH_LIMIT }) || [];
    generatedAt = now();
    repository.saveSnapshot(workspaceId, FEED_FLASH_SNAPSHOT_KEY, { ok: true, items }, generatedAt);
    pages += 1;
  } catch {
    /* 快讯名单未就绪时不写快照。 */
  }
  try {
    const feed = await feedService.getExternalFeed('trendforce', {
      platform: 'trendforce',
      feed: 'public',
      fields: 'list',
      refresh: false,
    }, { workspaceId });
    generatedAt = now();
    repository.saveSnapshot(workspaceId, FEED_TRENDFORCE_SNAPSHOT_KEY, { ok: true, feed }, generatedAt);
    pages += 1;
  } catch {
    /* TrendForce 未启用时不写快照。 */
  }
  return { generatedAt, pages };
}

export async function captureHomeBootstrap({
  compose,
  repository,
  workspaceId = 'local',
  now = () => Date.now(),
}) {
  if (!compose) throw new Error('总览快照需要组装');
  if (!repository?.saveSnapshot) throw new Error('总览快照需要存储');
  const at = now();
  const body = await compose({ workspace: workspaceId, now: at });
  const stored = body && typeof body === 'object' ? { ...body } : body;
  if (stored && typeof stored === 'object') delete stored.timings;
  repository.saveSnapshot(workspaceId, HOME_BOOTSTRAP_SNAPSHOT_KEY, stored, at);
  const timings = body?.timings && typeof body.timings === 'object' ? body.timings : {};
  const parts = Object.entries(timings).map(([name, value]) => `${name}=${value}ms`);
  console.log(`[worker] home-bootstrap ${parts.join(' ')}`);
  return { generatedAt: at, pages: 1, timings };
}

export function createHomeBootstrapCompose({
  store,
  report,
  env = process.env,
  timezone = 'Asia/Shanghai',
  pipeline = 'legacy',
} = {}) {
  let services = null;
  return async function compose(options = {}) {
    if (!services) {
      const { composeHomeBootstrap } = await import('../../../apps/web/src/http/home-bootstrap.js');
      const { createInformationTreeReader } = await import('../../domain/src/information-tree-service.js');
      const { createReadingHourService, readingHourSourceAccess } = await import('../../domain/src/reading-hour-service.js');
      const { createMarketBoardReader } = await import('../../source/src/market/board-read.js');
      const { createStaticSignalBoardReader } = await import('../../source/src/static/board-read.js');
      services = {
        composeHomeBootstrap,
        informationTree: createInformationTreeReader({
          repository: store.repositories.informationTree,
          timezone,
          pipeline,
          catalog: {},
        }),
        readingHour: createReadingHourService({
          repository: store.repositories.informationTree,
          reportRepository: store.repositories.report,
          enabled: env.AI_CENTER_READING_HOUR === '1',
          env,
          ...readingHourSourceAccess({ feed: store.repositories.feed, media: store.repositories.media }),
        }),
        report,
        marketBoard: createMarketBoardReader({ repository: store.repositories.runtimeSnapshots }),
        staticSignalBoard: createStaticSignalBoardReader({ repository: store.repositories.runtimeSnapshots }),
      };
    }
    return services.composeHomeBootstrap(services, options);
  };
}

export async function captureHardwarePrices({
  hardwarePriceService,
  repository,
  workspaceId = 'local',
  now = () => Date.now(),
}) {
  if (!hardwarePriceService?.list) throw new Error('硬件报价快照需要报价服务');
  if (!repository?.saveSnapshot) throw new Error('硬件报价快照需要存储');
  const at = now();
  const view = hardwarePriceService.list(workspaceId, { limit: 500 });
  repository.saveSnapshot(workspaceId, HARDWARE_PRICE_SNAPSHOT_KEY, { ok: true, ...view }, at);
  for (const category of HARDWARE_PRICE_CATEGORIES) {
    repository.saveSnapshot(workspaceId, hardwarePriceCategoryKey(category), {
      ok: true,
      items: view.items.filter((item) => item.category === category),
      snapshot: null,
      pages: view.pages,
    }, at);
  }
  return { generatedAt: at, items: view.items.length };
}

export async function captureReportViews({
  informationTree,
  readingHour,
  repository,
  workspaceId = 'local',
  now = () => Date.now(),
}) {
  if (!repository?.saveSnapshot) throw new Error('简报快照需要存储');
  const at = now();
  const windows = reportPreparedWindows(at);
  let pages = 0;
  const save = (key, body) => {
    repository.saveSnapshot(workspaceId, key, body, at);
    pages += 1;
  };
  if (informationTree?.list) {
    try {
      save(REPORT_TREE_INDEX_KEY, { ok: true, ...informationTree.list(workspaceId, { ...windows.week, view: 'index' }) });
    } catch { /* 目录未就绪时不写。 */ }
    try {
      save(REPORT_TREE_INDEX_INFO_KEY, { ok: true, ...informationTree.list(workspaceId, { ...windows.week, view: 'index', information: '1' }) });
    } catch { /* 材料目录未就绪时不写。 */ }
    try {
      save(REPORT_TREE_HOME_KEY, { ok: true, ...informationTree.list(workspaceId, { ...windows.home, view: 'index' }) });
    } catch { /* 首页目录未就绪时不写。 */ }
  }
  if (readingHour?.indexForRange) {
    try {
      save(REPORT_READING_INDEX_KEY, { ok: true, ...readingHour.indexForRange(workspaceId, windows.week, 'hour') });
    } catch { /* 七日阅读索引未就绪时不写。 */ }
    try {
      save(REPORT_READING_HOME_KEY, { ok: true, ...readingHour.indexForRange(workspaceId, windows.home, 'hour') });
    } catch { /* 首页阅读索引未就绪时不写。 */ }
  }
  return { generatedAt: at, pages };
}

export function createReportViewCapture({
  store,
  env = process.env,
  timezone = 'Asia/Shanghai',
  pipeline = 'legacy',
} = {}) {
  let readers = null;
  return async function capture(now = () => Date.now()) {
    if (!readers) {
      const { createInformationTreeReader } = await import('../../domain/src/information-tree-service.js');
      const { createReadingHourService, readingHourSourceAccess } = await import('../../domain/src/reading-hour-service.js');
      readers = {
        informationTree: createInformationTreeReader({
          repository: store.repositories.informationTree,
          timezone,
          pipeline,
          catalog: {},
        }),
        readingHour: createReadingHourService({
          repository: store.repositories.informationTree,
          reportRepository: store.repositories.report,
          enabled: env.AI_CENTER_READING_HOUR === '1',
          env,
          ...readingHourSourceAccess({ feed: store.repositories.feed, media: store.repositories.media }),
        }),
      };
    }
    return captureReportViews({
      informationTree: readers.informationTree,
      readingHour: readers.readingHour,
      repository: store.repositories.runtimeSnapshots,
      now,
    });
  };
}

export function createWebSnapshotJobHandlers(options) {
  return {
    [STATIC_SIGNAL_BOARD_JOB_TYPE]: async () => captureStaticSignalBoard(options),
    [HOLDINGS_MARKET_JOB_TYPE]: async () => captureHoldingsMarket(options),
    [MARKET_BOARDS_JOB_TYPE]: async () => captureMarketBoards(options),
    [MARKET_NATIVE_BOARD_JOB_TYPE]: async () => captureMarketNativeBoard(options),
    [FEED_LIST_JOB_TYPE]: async () => captureFeedLists(options),
    [HARDWARE_PRICE_JOB_TYPE]: async () => captureHardwarePrices(options),
    [REPORT_VIEWS_JOB_TYPE]: async () => (
      options.captureReportViews
        ? options.captureReportViews()
        : { generatedAt: Date.now(), pages: 0 }
    ),
    [HOME_BOOTSTRAP_JOB_TYPE]: async () => captureHomeBootstrap({
      compose: options.composeHomeBootstrap,
      repository: options.repository,
      workspaceId: options.workspaceId,
      now: options.now,
    }),
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

export function ensureFeedListSchedule(store, now = Date.now()) {
  return upsertInterval(store, FEED_LIST_SCHEDULE_KEY, FEED_LIST_JOB_TYPE, now);
}

export function ensureHardwarePriceSchedule(store, now = Date.now()) {
  return upsertInterval(store, HARDWARE_PRICE_SCHEDULE_KEY, HARDWARE_PRICE_JOB_TYPE, now);
}

export function ensureHomeBootstrapSchedule(store, now = Date.now()) {
  return upsertInterval(store, HOME_BOOTSTRAP_SCHEDULE_KEY, HOME_BOOTSTRAP_JOB_TYPE, now);
}

export function ensureReportViewSchedule(store, now = Date.now()) {
  return upsertInterval(store, REPORT_VIEWS_SCHEDULE_KEY, REPORT_VIEWS_JOB_TYPE, now);
}
