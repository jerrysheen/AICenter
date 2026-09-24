import { sampleStd } from './percentile.js';

function trailing(points, count) {
  if (points.length < count) return null;
  return points.slice(-count);
}

export function trailingReturn(points, days) {
  if (points.length <= days) return null;
  const last = points.at(-1).close;
  const previous = points.at(-1 - days).close;
  if (!(previous > 0) || !Number.isFinite(last)) return null;
  return last / previous - 1;
}

export function distanceToMovingAverage(points, window) {
  const slice = trailing(points, window);
  if (!slice) return null;
  const average = slice.reduce((total, point) => total + point.close, 0) / window;
  const last = slice.at(-1).close;
  if (!(average > 0) || !Number.isFinite(last)) return null;
  return last / average - 1;
}

export function currentDrawdown(points, window) {
  const slice = trailing(points, window);
  if (!slice) return null;
  const peak = Math.max(...slice.map((point) => point.close));
  const last = slice.at(-1).close;
  if (!(peak > 0) || !Number.isFinite(last)) return null;
  return last / peak - 1;
}

export function maxDrawdown(points, window) {
  const slice = trailing(points, window);
  if (!slice) return null;
  let peak = slice[0].close;
  let worst = 0;
  for (const point of slice) {
    if (!(point.close > 0) || !(peak > 0)) return null;
    if (point.close > peak) peak = point.close;
    worst = Math.min(worst, point.close / peak - 1);
  }
  return worst;
}

export function pricePosition(points, window) {
  const slice = trailing(points, window);
  if (!slice) return null;
  const high = Math.max(...slice.map((point) => point.close));
  const low = Math.min(...slice.map((point) => point.close));
  if (!(high > low)) return null;
  return (slice.at(-1).close - low) / (high - low);
}

export function realizedVolatility(points, window) {
  if (points.length <= window) return null;
  const slice = points.slice(-(window + 1));
  const returns = [];
  for (let index = 1; index < slice.length; index += 1) {
    const previous = slice[index - 1].close;
    if (!(previous > 0)) return null;
    returns.push(slice[index].close / previous - 1);
  }
  if (returns.length < window) return null;
  const deviation = sampleStd(returns);
  if (deviation == null) return null;
  return deviation * Math.sqrt(252);
}
