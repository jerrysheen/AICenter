import { parseContract, StockFactorSnapshotSchema } from '../../../contracts/src/index.js';
import { turnoverFactor, volumeFactor } from './liquidity-factors.js';
import {
  currentDrawdown, distanceToMovingAverage, maxDrawdown, pricePosition, realizedVolatility, trailingReturn,
} from './price-factors.js';
import { buildValuationMetric } from './valuation-factors.js';

function finite(value) {
  return Number.isFinite(value) ? value : null;
}

export function buildAdjustedSeries(bars, factors, asOf) {
  const eligible = (bars || [])
    .filter((bar) => bar.at <= asOf && Number.isFinite(bar.close))
    .slice()
    .sort((left, right) => left.at - right.at);
  const factorRows = (factors || [])
    .filter((factor) => factor.at <= asOf && Number.isFinite(factor.adjFactor) && factor.adjFactor > 0)
    .slice()
    .sort((left, right) => left.at - right.at);
  let factorIndex = 0;
  let active = null;
  const points = [];
  for (const bar of eligible) {
    while (factorIndex < factorRows.length && factorRows[factorIndex].at <= bar.at) {
      active = factorRows[factorIndex].adjFactor;
      factorIndex += 1;
    }
    points.push({
      at: bar.at,
      close: active == null ? bar.close : bar.close * active,
      volume: finite(bar.volume),
    });
  }
  return { points, adjusted: factorRows.length > 0 && points.length > 0 };
}

function metricSeries(points, field) {
  return (points || [])
    .filter((point) => point.at != null)
    .map((point) => ({ at: point.at, value: point[field] }))
    .filter((point) => Number.isFinite(point.at));
}

export function buildFactorSnapshot({ symbol, asOf, bars = [], metrics = [], factors = [] } = {}) {
  const stamp = Number.isInteger(asOf) ? asOf : (bars.at(-1)?.at ?? 0);
  const price = buildAdjustedSeries(bars, factors, stamp);
  const metricRows = (metrics || []).filter((point) => point.at <= stamp);
  const warnings = [];
  if (!price.adjusted) warnings.push('priceSeriesAdjusted=false');
  const points = price.points;
  const snapshot = {
    symbol: String(symbol || '').toUpperCase(),
    asOf: stamp,
    price: {
      return5d: trailingReturn(points, 5),
      return20d: trailingReturn(points, 20),
      return60d: trailingReturn(points, 60),
      return120d: trailingReturn(points, 120),
      return252d: trailingReturn(points, 252),
      distanceToMA20: distanceToMovingAverage(points, 20),
      distanceToMA60: distanceToMovingAverage(points, 60),
      distanceToMA120: distanceToMovingAverage(points, 120),
      distanceToMA250: distanceToMovingAverage(points, 250),
      pricePosition252d: pricePosition(points, 252),
    },
    risk: {
      drawdown20d: currentDrawdown(points, 20),
      drawdown60d: currentDrawdown(points, 60),
      drawdown252d: currentDrawdown(points, 252),
      maxDrawdown252d: maxDrawdown(points, 252),
      realizedVol20: realizedVolatility(points, 20),
      realizedVol60: realizedVolatility(points, 60),
    },
    valuation: {
      peTtm: buildValuationMetric(metricSeries(metricRows, 'peTtm'), stamp, { positiveOnly: true }),
      pb: buildValuationMetric(metricSeries(metricRows, 'pb'), stamp),
      dividendYieldTtm: buildValuationMetric(metricSeries(metricRows, 'dividendYieldTtm'), stamp),
    },
    liquidity: {
      turnoverRate: turnoverFactor(metricSeries(metricRows, 'turnoverRate'), stamp),
      volumeRatio: metricRows.length ? finite(metricRows.at(-1).volumeRatio) : null,
      ...volumeFactor(points),
    },
    coverage: {
      priceSamples: points.length,
      metricSamples: metricRows.length,
      adjustedPrice: price.adjusted,
    },
    warnings,
  };
  return parseContract(StockFactorSnapshotSchema, snapshot);
}
