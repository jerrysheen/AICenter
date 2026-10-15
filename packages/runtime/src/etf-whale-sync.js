import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fetchSseEtfShares, fetchSzseEtfShareJsonPage, fetchSzseEtfShares } from '../../connectors/src/etf-exchange-shares.js';
import { fetchTencentQfqDaily } from '../../connectors/src/etf-tencent-kline.js';
import {
  ALGORITHM,
  addDays,
  buildCodeSeries,
  dateChunks,
  lotToShares,
  typicalPrice,
  turnoverFromTypical,
  weekdays,
} from '../../domain/src/etf-whale/calculate.js';
import {
  emptyShareStatus,
  expectedShareDate,
  shanghaiToday,
  shareSlotCanSkip,
  shouldRefetchSzseChunk,
} from '../../domain/src/etf-whale/fetch-policy.js';
import { ETF_WHALE_UNIVERSE } from '../../domain/src/etf-whale/universe.js';
import { ETF_WHALE_MARKET_PARTS, syncEtfWhaleFutures, syncEtfWhaleMarket } from './etf-whale-market.js';
import { refreshEtfWhaleSignals } from './etf-whale-score.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function syncEtfWhale(options) {
  const repository = options.repository;
  const dataDirectory = options.dataDirectory;
  const startDate = options.startDate;
  const endDate = options.endDate;
  const instruments = options.instruments || ETF_WHALE_UNIVERSE;
  const pauseMs = options.pauseMs ?? 250;
  const probes = [];
  const today = options.today || shanghaiToday(options.now || new Date());
  const pendingLimit = pendingDayLimit(options.pendingLimit ?? options.env?.AI_CENTER_ETF_WHALE_PENDING_DAYS);
  repository.replaceInstruments(instruments);
  repository.supersedeStackOverflowFetches?.();
  if (options.quotes !== false && options.task !== 'shares') {
    for (const item of instruments) {
      const result = await fetchTencentQfqDaily(item.code, item.exchange, startDate, endDate, options);
      probes.push(...result.probes);
      if (!result.ok) continue;
      const relativePath = `blobs/etf-whale/tencent/${item.code}.json`;
      const saved = await writeBlob(dataDirectory, relativePath, result.body);
      const capturedAt = Date.now();
      repository.saveQuotes(result.bars.map((bar) => ({
        source: 'tencent-qfq',
        code: item.code,
        tradeDate: bar.tradeDate,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volumeLots: bar.volumeLots,
        volumeShares: lotToShares(bar.volumeLots),
        typicalPrice: typicalPrice(bar.open, bar.high, bar.low, bar.close),
        turnoverCny: turnoverFromTypical(typicalPrice(bar.open, bar.high, bar.low, bar.close), bar.volumeLots),
        adjust: 'qfq',
      })), { capturedAt });
      repository.saveFetch({
        source: `tencent-qfq:${item.code}`,
        dateStart: startDate,
        dateEnd: endDate,
        status: 'ok',
        rowCount: result.bars.length,
        blobPath: saved.relativePath,
        contentHash: saved.hash,
        capturedAt,
      });
      options.onProgress?.(`行情 ${item.code} ${result.bars.length} 日`);
      await sleep(pauseMs);
    }
  }
  if (options.shares !== false && options.task !== 'quotes') {
    const quoteDates = new Set(repository.listQuoteDates?.('510300') || []);
    for (const [chunkStart, chunkEnd] of dateChunks(startDate, endDate, 31)) {
      const existing = repository.getFetch('szse-xlsx', chunkStart, chunkEnd);
      const maxShareDate = repository.maxShareDate?.('szse-xlsx', chunkStart, chunkEnd) || null;
      if (options.skipExisting !== false && !shouldRefetchSzseChunk({
        status: existing?.status,
        chunkEnd,
        maxShareDate,
        quoteDates,
      })) {
        probes.push({ source: 'szse-xlsx', startDate: chunkStart, endDate: chunkEnd, status: 'skipped', rowCount: existing.row_count });
        continue;
      }
      const result = await fetchSzseEtfShares(chunkStart, chunkEnd, options);
      probes.push(...result.probes);
      if (!result.ok) {
        repository.saveFetch({ source: 'szse-xlsx', dateStart: chunkStart, dateEnd: chunkEnd, status: 'error', rowCount: 0, error: result.error, capturedAt: Date.now() });
        continue;
      }
      const relativePath = `blobs/etf-whale/szse/${chunkStart}_${chunkEnd}.xlsx`;
      const saved = await writeBlob(dataDirectory, relativePath, result.body);
      repository.saveShares(result.rows, {
        source: 'szse-xlsx',
        dateStart: chunkStart,
        dateEnd: chunkEnd,
        status: result.rows.length ? 'ok' : 'empty',
        blobPath: saved.relativePath,
        contentHash: saved.hash,
        capturedAt: Date.now(),
        error: '',
      });
      options.onProgress?.(`深交所 ${chunkStart}..${chunkEnd} ${result.rows.length} 行`);
      await sleep(pauseMs);
    }
    const refreshFrom = options.refreshFrom || '2026-10-08';
    let consecutiveErrors = 0;
    const pendingDates = repository.listFetchDates?.('sse', 'pending') || [];
    const shareDates = [...new Set([...weekdays(startDate, endDate), ...pendingDates])].sort();
    for (const tradeDate of shareDates) {
      const existing = repository.getFetch('sse', tradeDate, tradeDate);
      if (options.skipExisting !== false && existing?.status === 'ok' && tradeDate < refreshFrom) continue;
      if (options.skipExisting !== false && (existing?.status === 'holiday' || existing?.status === 'stale')) continue;
      if (existing?.status === 'pending' && emptyShareStatus(tradeDate, today, { quoteDates, pendingLimit }) === 'stale') {
        repository.saveFetch({
          source: 'sse',
          dateStart: tradeDate,
          dateEnd: tradeDate,
          status: 'stale',
          rowCount: existing.row_count || 0,
          error: '空结果已超过 5 个交易日',
          blobPath: existing.blob_path || '',
          contentHash: existing.content_hash || '',
          capturedAt: Date.now(),
        });
        warnStale(tradeDate, options);
        continue;
      }
      const result = await fetchSseEtfShares(tradeDate, options);
      probes.push(...result.probes);
      if (!result.ok) {
        consecutiveErrors += 1;
        repository.saveFetch({ source: 'sse', dateStart: tradeDate, dateEnd: tradeDate, status: 'error', rowCount: 0, error: result.error, capturedAt: Date.now() });
        options.onProgress?.(`上交所 ${tradeDate} 失败 ${result.error}`);
        if (consecutiveErrors >= 8) break;
        await sleep(pauseMs * 2);
        continue;
      }
      consecutiveErrors = 0;
      const relativePath = `blobs/etf-whale/sse/${tradeDate}.json`;
      const saved = await writeBlob(dataDirectory, relativePath, result.body);
      const status = result.rows.length ? 'ok' : emptyShareStatus(tradeDate, today, { quoteDates, pendingLimit });
      if (status === 'stale' && existing?.status !== 'stale') warnStale(tradeDate, options);
      repository.saveShares(result.rows, {
        source: 'sse',
        dateStart: tradeDate,
        dateEnd: tradeDate,
        status,
        blobPath: saved.relativePath,
        contentHash: saved.hash,
        capturedAt: Date.now(),
        error: status === 'stale' ? '空结果已超过 5 个交易日' : '',
      });
      if (result.rows.length) options.onProgress?.(`上交所 ${tradeDate} ${result.rows.length} 只`);
      await sleep(pauseMs);
    }
  }
  return { probes, algorithm: ALGORITHM };
}

export function recomputeEtfWhale(repository, instruments = ETF_WHALE_UNIVERSE) {
  const codes = instruments.map((item) => item.code);
  const shareRows = [
    ...repository.listShares(codes.filter((code) => instruments.find((item) => item.code === code)?.exchange === 'SH'), 'sse'),
    ...repository.listShares(codes.filter((code) => instruments.find((item) => item.code === code)?.exchange === 'SZ'), 'szse-xlsx'),
  ];
  const quoteRows = repository.listQuotes(codes);
  const tradingDates = [...new Set(quoteRows.filter((row) => row.code === '510300').map((row) => row.trade_date))].sort();
  const adjustments = [];
  const daily = [];
  for (const item of instruments) {
    const sharesByDate = new Map(shareRows.filter((row) => row.code === item.code).map((row) => [row.trade_date, row.shares]));
    const quotesByDate = new Map(quoteRows.filter((row) => row.code === item.code).map((row) => [row.trade_date, {
      open: row.open, high: row.high, low: row.low, close: row.close, volumeLots: row.volume_lots,
    }]));
    const series = buildCodeSeries({ code: item.code, tradingDates, sharesByDate, quotesByDate });
    for (const row of series) {
      if (row.adjustment?.kind === 'share_unit') {
        adjustments.push({
          code: item.code,
          tradeDate: row.tradeDate,
          eventType: 'share_unit',
          shareRatio: row.adjustment.ratio,
          priceRatio: null,
          comparable: true,
          note: '总份额相对上一交易日接近整数倍，已按该倍数把更早份额换到当前份额单位，差额仍计为申赎',
        });
      }
    }
    daily.push(...series);
  }
  if (adjustments.length) repository.saveAdjustments(adjustments);
  repository.saveDaily(daily);
  return { tradingDates, rowCount: daily.length, rows: daily };
}

export async function probeSzseJsonAgainstXlsx(tradeDate, xlsxRows, options = {}) {
  const json = await fetchSzseEtfShareJsonPage(tradeDate, tradeDate, 1, options);
  const compared = [];
  for (const row of json.rows || []) {
    const official = xlsxRows.find((item) => item.code === row.code && item.tradeDate === tradeDate);
    if (!official) continue;
    compared.push({ code: row.code, jsonShares: row.shares, xlsxShares: official.shares, diff: row.shares - official.shares });
  }
  return { probe: json.probes?.[0] || null, pageSize: json.pageSize, recordCount: json.recordCount, compared };
}

async function writeBlob(dataDirectory, relativePath, body) {
  const absolute = path.join(dataDirectory, ...relativePath.split('/'));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, body);
  return { relativePath, hash: createHash('sha256').update(body).digest('hex'), bytes: body.length };
}

function warnStale(tradeDate, options) {
  console.warn(`[worker] etf-whale sse stale ${tradeDate} 空结果已超过 5 个交易日`);
  options.onStale?.(tradeDate);
}

function pendingDayLimit(value) {
  const number = Number(value);
  if (!Number.isInteger(number)) return 5;
  return Math.min(20, Math.max(1, number));
}

export const ETF_WHALE_SYNC_JOB = 'etf.whale.sync';
export const ETF_WHALE_MARKET_JOB = 'etf.whale.market';
export const ETF_WHALE_FUTURES_JOB = 'etf.whale.futures';
const DEFAULT_LOOKBACK_DAYS = 12;

function lookbackDays(value) {
  const number = Number(value);
  if (!Number.isInteger(number)) return DEFAULT_LOOKBACK_DAYS;
  return Math.min(40, Math.max(1, number));
}

export function etfWhaleSyncWindow(input = {}, env = process.env, now = new Date()) {
  const endDate = /^\d{4}-\d{2}-\d{2}$/.test(String(input.endDate || ''))
    ? String(input.endDate)
    : new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now);
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(input.startDate || ''))) {
    return { startDate: String(input.startDate), endDate };
  }
  const days = lookbackDays(env.AI_CENTER_ETF_WHALE_LOOKBACK_DAYS);
  return { startDate: addDays(endDate, 1 - days), endDate };
}

export const etfWhaleManifest = Object.freeze({
  id: 'etf.whale',
  version: '1.1.0',
  capabilities: ['etf.whale.sync', 'etf.whale.market', 'etf.whale.futures'],
  jobTypes: [ETF_WHALE_SYNC_JOB, ETF_WHALE_MARKET_JOB, ETF_WHALE_FUTURES_JOB],
});

export function createEtfWhaleJobHandlers({ repository, dataDirectory, env = process.env, now = () => new Date() } = {}) {
  return {
    [ETF_WHALE_SYNC_JOB]: async (input = {}) => {
      repository.supersedeStackOverflowFetches?.();
      const today = shanghaiToday(now());
      if (!input.startDate && input.skipIfSettled !== false) {
        const expectedDate = expectedShareDate(today);
        const pendingDates = repository.listFetchDates?.('sse', 'pending') || [];
        if (shareSlotCanSkip({
          pendingDates,
          expectedDate,
          sseStatus: expectedDate ? repository.getFetch('sse', expectedDate, expectedDate)?.status : '',
          szseCovered: expectedDate ? repository.hasShareOn?.('szse-xlsx', expectedDate) : false,
        })) {
          return { skipped: true, reason: 'shares-complete', expectedShareDate: expectedDate };
        }
      }
      const { startDate, endDate } = etfWhaleSyncWindow(input, env, now());
      const fetched = await syncEtfWhale({
        repository,
        dataDirectory,
        startDate,
        endDate,
        skipExisting: input.skipExisting !== false,
        task: 'shares',
        today,
        env,
      });
      const computed = recomputeEtfWhale(repository);
      const confirmed = refreshEtfWhaleSignals(repository, { startDate, endDate, stage: 'confirmed' });
      return { startDate, endDate, probeCount: fetched.probes.length, dailyRows: computed.rowCount, algorithm: fetched.algorithm, confirmed };
    },
    [ETF_WHALE_MARKET_JOB]: async (input = {}) => {
      const { startDate, endDate } = etfWhaleSyncWindow(input, env, now());
      const market = await syncEtfWhaleMarket({
        repository,
        dataDirectory,
        startDate,
        endDate,
        env,
        fetchImpl: input.fetchImpl,
        parts: ETF_WHALE_MARKET_PARTS,
      });
      const initial = refreshEtfWhaleSignals(repository, { startDate, endDate, stage: 'initial' });
      return { ...market, initial };
    },
    [ETF_WHALE_FUTURES_JOB]: async (input = {}) => {
      const { startDate, endDate } = etfWhaleSyncWindow(input, env, now());
      return syncEtfWhaleFutures({ repository, startDate, endDate, env, skipExisting: input.skipExisting !== false });
    },
  };
}
