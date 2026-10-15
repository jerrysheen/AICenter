import { fetchCffexPosition } from '../../connectors/src/cffex-position.js';
import { fetchDailyBars, fetchIntradayBars } from '../../connectors/src/etf-sina-kline.js';
import { fetchTencentQfqDaily } from '../../connectors/src/etf-tencent-kline.js';
import { addDays, lotToShares, typicalPrice, turnoverFromTypical, weekdays } from '../../domain/src/etf-whale/calculate.js';
import { classifyCalendarDay, shanghaiToday } from '../../domain/src/etf-whale/fetch-policy.js';
import { CFFEX_PRODUCTS, ETF_WHALE_INDICES, TURNOVER_SOURCE, citicPartyId } from '../../domain/src/etf-whale/indices.js';
import { indexSessionShape } from '../../domain/src/etf-whale/session-shape.js';
import { ETF_WHALE_UNIVERSE } from '../../domain/src/etf-whale/universe.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const HISTORICAL_MISS_DAYS = 7;
export const ETF_WHALE_MARKET_PARTS = Object.freeze(['quotes', 'intraday', 'index', 'turnover']);

function emptySourceCounts() {
  return { tencent: 0, sina: 0, eastmoney: 0, error: 0, rows: 0 };
}

function noteRows(bucket, source, count) {
  if (Object.hasOwn(bucket, source)) bucket[source] += count;
  else bucket.eastmoney += count;
  bucket.rows += count;
}

function recordSeries(repository, options, source, startDate, endDate, status, rowCount, error) {
  const message = String(error || '').slice(0, 500);
  repository.saveFetch({
    source,
    dateStart: startDate,
    dateEnd: endDate,
    status,
    rowCount,
    error: message,
    capturedAt: Date.now(),
  });
  if (status === 'error') {
    const line = `[worker] etf-whale ${source} ${startDate}..${endDate} ${message || '抓取失败'}`;
    console.warn(line);
    options.onProgress?.(line);
  }
}

function symbols(instruments) {
  return [
    ...ETF_WHALE_INDICES.map((item) => ({ ...item, kind: 'index' })),
    ...instruments.map((item) => ({ symbol: item.code, exchange: item.exchange, name: item.name, kind: 'etf' })),
  ];
}

export async function syncEtfWhaleMarket(options) {
  const repository = options.repository;
  const instruments = options.instruments || ETF_WHALE_UNIVERSE;
  const parts = new Set(options.parts || ETF_WHALE_MARKET_PARTS);
  const pauseMs = options.pauseMs ?? 200;
  const probes = [];
  const counts = { index: emptySourceCounts(), turnover: emptySourceCounts() };
  const targets = symbols(instruments);
  const indices = options.indices || ETF_WHALE_INDICES;
  if (parts.has('quotes')) {
    for (const item of instruments) {
      const result = await fetchTencentQfqDaily(item.code, item.exchange, options.startDate, options.endDate, options);
      probes.push(...result.probes);
      if (!result.ok) continue;
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
      })), { capturedAt: Date.now() });
      await sleep(pauseMs);
    }
  }
  if (parts.has('intraday')) {
    for (const item of targets) {
      const result = await fetchIntradayBars({
        code: item.symbol,
        exchange: item.exchange,
        kind: item.kind,
        startDate: options.startDate,
        endDate: options.endDate,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
      });
      probes.push(...(result.probes || []));
      if (result.ok) {
        repository.saveIntradayBars(result.bars.map((bar) => ({
          source: result.source,
          symbol: item.symbol,
          kind: item.kind,
          intervalKey: '5m',
          barTime: bar.barTime,
          tradeDate: bar.tradeDate,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume,
          amountCny: bar.amountCny,
        })));
      }
      await sleep(pauseMs);
    }
  }
  if (parts.has('index')) {
    for (const item of indices) {
      const sourceKey = `index-daily:${item.symbol}`;
      try {
        const result = await fetchDailyBars({
          code: item.symbol,
          exchange: item.exchange,
          startDate: options.startDate,
          endDate: options.endDate,
          fetchImpl: options.fetchImpl,
          timeoutMs: options.timeoutMs,
          pageBars: options.pageBars,
          endpoints: options.endpoints,
        });
        probes.push(...(result.probes || []));
        if (!result.ok || !(result.bars || []).length) {
          counts.index.error += 1;
          recordSeries(repository, options, sourceKey, options.startDate, options.endDate, 'error', 0, result.error || '指数日线为空');
        } else {
          const rows = shapeIndexRows(repository, item.symbol, result.bars, result.source);
          repository.saveIndexDaily(rows);
          noteRows(counts.index, result.source, rows.length);
          recordSeries(repository, options, sourceKey, options.startDate, options.endDate, 'ok', rows.length, '');
          options.onProgress?.(`指数 ${item.symbol} ${result.source} ${rows.length} 行`);
        }
      } catch (error) {
        counts.index.error += 1;
        recordSeries(repository, options, sourceKey, options.startDate, options.endDate, 'error', 0, error.message || String(error));
      }
      await sleep(pauseMs);
    }
  }
  if (parts.has('turnover')) {
    for (const item of instruments) {
      const sourceKey = `turnover:${item.code}`;
      try {
        const result = await fetchDailyBars({
          code: item.code,
          exchange: item.exchange,
          startDate: options.startDate,
          endDate: options.endDate,
          fetchImpl: options.fetchImpl,
          timeoutMs: options.timeoutMs,
          adjusted: false,
          pageBars: options.pageBars,
          endpoints: options.endpoints,
        });
        probes.push(...(result.probes || []));
        const rows = (result.bars || []).filter((bar) => Number.isFinite(bar.amountCny));
        if (!rows.length) {
          counts.turnover.error += 1;
          recordSeries(repository, options, sourceKey, options.startDate, options.endDate, 'error', 0, result.error || '实际成交额为空');
        } else {
          repository.saveTurnover(rows.map((bar) => ({
            source: TURNOVER_SOURCE,
            code: item.code,
            tradeDate: bar.tradeDate,
            amountCny: bar.amountCny,
            volumeShares: bar.volume,
            close: bar.close,
          })));
          noteRows(counts.turnover, result.source, rows.length);
          recordSeries(repository, options, sourceKey, options.startDate, options.endDate, 'ok', rows.length, '');
          options.onProgress?.(`成交额 ${item.code} ${result.source} ${rows.length} 行`);
        }
      } catch (error) {
        counts.turnover.error += 1;
        recordSeries(repository, options, sourceKey, options.startDate, options.endDate, 'error', 0, error.message || String(error));
      }
      await sleep(pauseMs);
    }
  }
  return { probes, parts: [...parts], counts };
}

function shapeIndexRows(repository, symbol, bars, source) {
  const ordered = [...bars].sort((left, right) => left.tradeDate.localeCompare(right.tradeDate));
  let previous = ordered.length ? repository.indexCloseBefore(symbol, ordered[0].tradeDate) : null;
  return ordered.map((bar) => {
    const prevClose = previous;
    const intraday = repository.listIntradayBars(symbol, bar.tradeDate);
    const shape = indexSessionShape({
      prevClose,
      close: bar.close,
      bars: intraday.map((row) => ({ barTime: row.bar_time, low: row.low, close: row.close })),
    });
    previous = bar.close;
    return {
      symbol,
      tradeDate: bar.tradeDate,
      prevClose,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      amountCny: bar.amountCny,
      source: source || 'sina',
      ...shape,
    };
  });
}

function rememberFutures(repository, product, tradeDate, status, rowCount, error) {
  repository.saveFetch({
    source: `cffex:${product}`,
    dateStart: tradeDate,
    dateEnd: tradeDate,
    status,
    rowCount,
    error: String(error || '').slice(0, 500),
    capturedAt: Date.now(),
  });
}

export async function syncEtfWhaleFutures(options) {
  const repository = options.repository;
  const probes = [];
  const party = citicPartyId(options.env);
  const products = options.products || CFFEX_PRODUCTS;
  const today = options.today || shanghaiToday();
  const historicalBefore = addDays(today, -HISTORICAL_MISS_DAYS);
  const counts = { ok: 0, holiday: 0, error: 0, skipped: 0 };
  let saved = 0;
  let lastDate = '';
  for (const tradeDate of weekdays(options.startDate, options.endDate)) {
    lastDate = tradeDate;
    for (const product of products) {
      const source = `cffex:${product}`;
      let fetched = false;
      try {
        const existing = repository.getFetch?.(source, tradeDate, tradeDate);
        if (options.skipExisting !== false && (repository.hasFutures(tradeDate, product) || existing?.status === 'holiday' || existing?.status === 'ok')) {
          counts.skipped += 1;
          probes.push({ source: 'cffex', product, tradeDate, status: 'skipped' });
          continue;
        }
        if (classifyCalendarDay(tradeDate) === 'closed') {
          rememberFutures(repository, product, tradeDate, 'holiday', 0, '非交易日');
          counts.holiday += 1;
          options.onProgress?.(`中金所 ${product} ${tradeDate} holiday`);
          continue;
        }
        fetched = true;
        const result = await fetchCffexPosition(product, tradeDate, options);
        probes.push(...result.probes);
        if (result.ok) {
          saved += repository.saveFuturesRanks(result.rows);
          rememberFutures(repository, product, tradeDate, 'ok', result.rows.length, '');
          counts.ok += 1;
          options.onProgress?.(`中金所 ${product} ${tradeDate} ${result.rows.length} 行`);
        } else if (result.missing && tradeDate <= historicalBefore) {
          rememberFutures(repository, product, tradeDate, 'holiday', 0, result.error || '非交易日');
          counts.holiday += 1;
          options.onProgress?.(`中金所 ${product} ${tradeDate} holiday`);
        } else {
          rememberFutures(repository, product, tradeDate, 'error', 0, result.error || '');
          counts.error += 1;
          const line = `[worker] etf-whale futures ${product} ${tradeDate} ${result.error || '抓取失败'}`;
          console.warn(line);
          options.onProgress?.(line);
        }
      } catch (error) {
        counts.error += 1;
        const message = error.message || String(error);
        try {
          rememberFutures(repository, product, tradeDate, 'error', 0, message);
        } catch (saveError) {
          console.warn(`[worker] etf-whale futures ${product} ${tradeDate} 失败记录没有写入 ${saveError.message || saveError}`);
        }
        console.warn(`[worker] etf-whale futures ${product} ${tradeDate} ${message}`);
        options.onProgress?.(`中金所 ${product} ${tradeDate} 失败 ${message}`);
      }
      if (fetched) await sleep(options.pauseMs ?? 200);
    }
  }
  return { probes, saved, citicPartyId: party, counts, lastDate, endDate: options.endDate };
}
