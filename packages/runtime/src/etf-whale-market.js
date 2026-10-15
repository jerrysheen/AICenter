import { fetchCffexPosition } from '../../connectors/src/cffex-position.js';
import { fetchDailyBars, fetchIntradayBars } from '../../connectors/src/etf-sina-kline.js';
import { fetchTencentQfqDaily } from '../../connectors/src/etf-tencent-kline.js';
import { lotToShares, typicalPrice, turnoverFromTypical, weekdays } from '../../domain/src/etf-whale/calculate.js';
import { classifyCalendarDay } from '../../domain/src/etf-whale/fetch-policy.js';
import { CFFEX_PRODUCTS, ETF_WHALE_INDICES, TURNOVER_SOURCE, citicPartyId } from '../../domain/src/etf-whale/indices.js';
import { indexSessionShape } from '../../domain/src/etf-whale/session-shape.js';
import { ETF_WHALE_UNIVERSE } from '../../domain/src/etf-whale/universe.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function symbols(instruments) {
  return [
    ...ETF_WHALE_INDICES.map((item) => ({ ...item, kind: 'index' })),
    ...instruments.map((item) => ({ symbol: item.code, exchange: item.exchange, name: item.name, kind: 'etf' })),
  ];
}

export async function syncEtfWhaleMarket(options) {
  const repository = options.repository;
  const instruments = options.instruments || ETF_WHALE_UNIVERSE;
  const parts = new Set(options.parts || ['quotes', 'intraday', 'index', 'turnover']);
  const pauseMs = options.pauseMs ?? 200;
  const probes = [];
  const targets = symbols(instruments);
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
    for (const item of ETF_WHALE_INDICES) {
      const result = await fetchDailyBars({
        code: item.symbol,
        exchange: item.exchange,
        startDate: options.startDate,
        endDate: options.endDate,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
      });
      probes.push(...(result.probes || []));
      if (result.ok) repository.saveIndexDaily(shapeIndexRows(repository, item.symbol, result.bars, result.source));
      await sleep(pauseMs);
    }
  }
  if (parts.has('turnover')) {
    for (const item of instruments) {
      const result = await fetchDailyBars({
        code: item.code,
        exchange: item.exchange,
        startDate: options.startDate,
        endDate: options.endDate,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
        adjusted: false,
      });
      probes.push(...(result.probes || []));
      const rows = (result.bars || []).filter((bar) => Number.isFinite(bar.amountCny));
      if (rows.length) {
        repository.saveTurnover(rows.map((bar) => ({
          source: TURNOVER_SOURCE,
          code: item.code,
          tradeDate: bar.tradeDate,
          amountCny: bar.amountCny,
          volumeShares: bar.volume,
          close: bar.close,
        })));
      }
      await sleep(pauseMs);
    }
  }
  return { probes, parts: [...parts] };
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

export async function syncEtfWhaleFutures(options) {
  const repository = options.repository;
  const probes = [];
  const party = citicPartyId(options.env);
  let saved = 0;
  for (const tradeDate of weekdays(options.startDate, options.endDate)) {
    if (classifyCalendarDay(tradeDate) !== 'trading') continue;
    for (const product of CFFEX_PRODUCTS) {
      if (options.skipExisting !== false && repository.hasFutures(tradeDate, product)) {
        probes.push({ source: 'cffex', product, tradeDate, status: 'skipped' });
        continue;
      }
      const result = await fetchCffexPosition(product, tradeDate, options);
      probes.push(...result.probes);
      if (result.ok) {
        saved += repository.saveFuturesRanks(result.rows);
        repository.saveFetch({
          source: `cffex:${product}`,
          dateStart: tradeDate,
          dateEnd: tradeDate,
          status: 'ok',
          rowCount: result.rows.length,
          error: '',
          capturedAt: Date.now(),
        });
      } else {
        repository.saveFetch({
          source: `cffex:${product}`,
          dateStart: tradeDate,
          dateEnd: tradeDate,
          status: 'error',
          rowCount: 0,
          error: result.error || '',
          capturedAt: Date.now(),
        });
      }
      options.onProgress?.(`中金所 ${product} ${tradeDate} ${result.rows.length} 行`);
      await sleep(options.pauseMs ?? 200);
    }
  }
  return { probes, saved, citicPartyId: party };
}
