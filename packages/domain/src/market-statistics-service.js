import { parseContract, BasketStatisticsSchema, StockStatisticsSchema, ValidationError } from '../../contracts/src/index.js';
import { buildFactorSnapshot, buildAdjustedSeries } from './market-factors/factor-engine.js';
import { aggregateBasket } from './trading-strategies/basket-aggregate.js';

const RANGES = new Set(['1mo', '3mo', '6mo', '1y', '2y', '5y', 'max']);
const BASKET_RANGES = new Set(['1y', '2y', '5y', 'max']);
const INDEX_NAMES = { '000922': '中证红利' };
const BASKET_MEMBER_CAP = 150;

function canonicalIndex(value) {
  const match = String(value || '').trim().toUpperCase().match(/^(\d{6})(?:\.(?:SH|SZ|SS))?$/);
  return match ? match[1] : '';
}

function seriesFromMetrics(metrics, asOf) {
  const points = (metrics?.points || [])
    .filter((point) => point.at <= asOf)
    .map((point) => ({
      at: point.at,
      close: Number.isFinite(point.close) ? point.close : null,
      peTtm: Number.isFinite(point.peTtm) ? point.peTtm : null,
      pb: Number.isFinite(point.pb) ? point.pb : null,
      dividendYieldTtm: Number.isFinite(point.dividendYieldTtm) ? point.dividendYieldTtm : null,
    }))
    .sort((left, right) => left.at - right.at);
  const adjusted = buildAdjustedSeries(
    points.filter((point) => point.close > 0).map((point) => ({ at: point.at, close: point.close, volume: null })),
    metrics?.factors || [],
    asOf,
  );
  const closeByAt = new Map(adjusted.points.map((point) => [point.at, point.close]));
  return {
    adjusted: adjusted.adjusted,
    points: points.map((point) => ({
      ...point,
      close: closeByAt.get(point.at) ?? point.close,
    })),
  };
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function blankPercentile(window) {
  return {
    percentile: null,
    sampleCount: 0,
    window,
    requestedWindow: window,
    actualStartAt: null,
    coverage: 0,
  };
}

function emptyMetric(value = null) {
  return {
    value,
    percentile1y: blankPercentile('1y'),
    percentile3y: blankPercentile('3y'),
    percentile5y: blankPercentile('5y'),
    available: blankPercentile('available'),
  };
}

export function createMarketStatisticsService({ sourcePort, now = () => Date.now() }) {
  if (!sourcePort?.read) throw new Error('market statistics require a source port');

  async function read(sourceId, input) {
    const snapshot = await sourcePort.read(sourceId, input);
    return snapshot?.data;
  }

  return Object.freeze({
    async getStockStatistics(query = {}) {
      const symbol = String(query.symbol || '').trim().toUpperCase();
      if (!symbol) throw new ValidationError('标的代码不能为空', ['symbol']);
      const range = String(query.range || '5y');
      if (!RANGES.has(range)) throw new ValidationError('不支持的统计区间', ['range']);
      const warnings = [];
      let quote = null;
      let series = null;
      let metrics = null;
      try {
        const quotes = await read('market.quotes', { symbols: [symbol] });
        quote = Array.isArray(quotes) ? quotes.find((item) => String(item.symbol || '').toUpperCase() === symbol) || quotes[0] : null;
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : '报价读取失败');
      }
      try {
        const history = await read('market.history', { symbols: [symbol], range, interval: '1d', ohlc: true });
        series = Array.isArray(history) ? history[0] : null;
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : '价格历史读取失败');
      }
      try {
        metrics = await read('market.metrics.history', { symbol, range });
        if (Array.isArray(metrics?.warnings)) warnings.push(...metrics.warnings);
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : '指标历史读取失败');
      }
      const bars = Array.isArray(series?.bars) && series.bars.length
        ? series.bars
        : (series?.points || []).map((point) => ({
          at: point.at,
          close: point.close,
          volume: null,
        }));
      const asOf = bars.length ? bars.at(-1).at : (Number.isInteger(quote?.asOf) ? quote.asOf : now());
      const factors = metrics?.status === 'unavailable' ? [] : (metrics?.factors || []);
      const metricPoints = metrics?.status === 'unavailable' ? [] : (metrics?.points || []);
      const factor = bars.length || metricPoints.length
        ? buildFactorSnapshot({
          symbol,
          asOf,
          bars,
          metrics: metricPoints,
          factors,
        })
        : null;
      if (factor) warnings.push(...factor.warnings.filter((warning) => !warnings.includes(warning)));
      if (!bars.length) warnings.push('价格历史为空');
      const valuation = factor?.valuation || {
        peTtm: emptyMetric(),
        pb: emptyMetric(),
        dividendYieldTtm: emptyMetric(),
      };
      const statistics = {
        instrument: {
          symbol,
          name: String(quote?.name || ''),
        },
        range,
        asOf,
        quote: {
          lastPrice: finiteOrNull(quote?.lastPrice),
          changePct: finiteOrNull(quote?.changePct),
        },
        price: {
          return5d: factor?.price.return5d ?? null,
          return20d: factor?.price.return20d ?? null,
          return60d: factor?.price.return60d ?? null,
          return252d: factor?.price.return252d ?? null,
        },
        trend: {
          distanceMA20: factor?.price.distanceToMA20 ?? null,
          distanceMA60: factor?.price.distanceToMA60 ?? null,
          distanceMA250: factor?.price.distanceToMA250 ?? null,
        },
        risk: {
          realizedVol20: factor?.risk.realizedVol20 ?? null,
          realizedVol60: factor?.risk.realizedVol60 ?? null,
          drawdown252: factor?.risk.drawdown252d ?? null,
          maxDrawdown252: factor?.risk.maxDrawdown252d ?? null,
        },
        valuation,
        liquidity: {
          turnoverRate: factor?.liquidity.turnoverRate.value ?? null,
          turnoverPercentile252: factor?.liquidity.turnoverRate.percentile252d ?? blankPercentile('252d'),
          volumeRatio: factor?.liquidity.volumeRatio ?? null,
        },
        coverage: factor?.coverage || { priceSamples: 0, metricSamples: 0, adjustedPrice: false },
        warnings: warnings.map((warning) => String(warning || '').trim().slice(0, 500)).filter(Boolean).slice(0, 20),
      };
      return parseContract(StockStatisticsSchema, statistics);
    },

    async getBasketStatistics(query = {}) {
      const index = canonicalIndex(query.index);
      if (!index) throw new ValidationError('指数代码不正确', ['index']);
      const range = String(query.range || '5y');
      if (!BASKET_RANGES.has(range)) throw new ValidationError('不支持的篮子区间', ['range']);
      const asOf = Number.isInteger(query.asOf) ? query.asOf : now();
      const warnings = [];
      let weights = null;
      try {
        weights = await read('market.index.weights', { index, range });
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : '指数权重读取失败');
      }
      if (Array.isArray(weights?.warnings)) warnings.push(...weights.warnings);
      const snapshots = (weights?.snapshots || []).map((snapshot) => ({
        ...snapshot,
        members: [...(snapshot.members || [])].sort((left, right) => right.weight - left.weight || left.symbol.localeCompare(right.symbol)),
      }));
      const latest = [...snapshots].filter((snapshot) => snapshot.at <= asOf).at(-1);
      const symbols = [...new Set((latest?.members || []).map((member) => member.symbol))].slice(0, BASKET_MEMBER_CAP);
      if ((latest?.members || []).length > symbols.length) warnings.push('成分股数量超过本次读取上限');
      const series = {};
      for (const symbol of symbols) {
        try {
          const metrics = await read('market.metrics.history', { symbol, range });
          series[symbol] = seriesFromMetrics(metrics, asOf);
        } catch (error) {
          warnings.push(`${symbol} ${error instanceof Error ? error.message : '指标读取失败'}`.slice(0, 180));
        }
      }
      return parseContract(BasketStatisticsSchema, aggregateBasket({
        index,
        name: INDEX_NAMES[index] || index,
        range,
        asOf,
        snapshots,
        series,
        warnings: warnings.map((warning) => String(warning).trim()).filter(Boolean).slice(0, 20),
      }));
    },
  });
}
