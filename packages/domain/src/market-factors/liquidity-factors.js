import { percentileRank, sampleStd } from './percentile.js';

function percentileWindow(values, current, { window, expected, actualStartAt }) {
  const enough = expected ? values.length >= Math.ceil(expected * 0.8) : values.length >= 2;
  return {
    percentile: enough && Number.isFinite(current) ? percentileRank(values, current) : null,
    sampleCount: values.length,
    window,
    requestedWindow: window,
    actualStartAt,
    coverage: expected ? Math.min(1, values.length / expected) : (values.length ? 1 : 0),
  };
}

export function turnoverFactor(series, asOf) {
  const eligible = (series || []).filter((point) => point.at <= asOf && Number.isFinite(point.value));
  const current = eligible.length ? eligible.at(-1).value : null;
  const recent = eligible.slice(-20);
  const year = eligible.slice(-252);
  return {
    value: current,
    percentile20d: percentileWindow(
      recent.map((point) => point.value),
      current,
      { window: '20d', expected: 20, actualStartAt: recent[0]?.at ?? null },
    ),
    percentile252d: percentileWindow(
      year.map((point) => point.value),
      current,
      { window: '252d', expected: 252, actualStartAt: year[0]?.at ?? null },
    ),
  };
}

export function volumeFactor(points) {
  const volumes = points.map((point) => point.volume).filter((value) => Number.isFinite(value));
  const recent = volumes.slice(-20);
  if (recent.length < 20) {
    return { volume20dMean: null, volume20dRatio: null, volume20dZScore: null };
  }
  const current = recent.at(-1);
  const mean = recent.reduce((total, value) => total + value, 0) / recent.length;
  const deviation = sampleStd(recent);
  return {
    volume20dMean: mean,
    volume20dRatio: mean > 0 ? current / mean : null,
    volume20dZScore: deviation > 0 ? (current - mean) / deviation : null,
  };
}
