import { percentileRank } from './percentile.js';

const EXPECTED_SAMPLES = {
  '1y': 252,
  '3y': 756,
  '5y': 1260,
};

const COVERAGE_MIN = 0.8;
const AVAILABLE_MIN = 2;

function finiteMetric(value) {
  return Number.isFinite(value) ? value : null;
}

export function metricWindow(series, current, { window, asOf, positiveOnly = false }) {
  const expected = EXPECTED_SAMPLES[window] || null;
  const eligible = (series || []).filter((point) => (
    point.at <= asOf && Number.isFinite(point.value) && (!positiveOnly || point.value > 0)
  ));
  const sample = expected ? eligible.slice(-expected) : eligible;
  const enough = expected
    ? sample.length >= Math.ceil(expected * COVERAGE_MIN)
    : sample.length >= AVAILABLE_MIN;
  const currentUsable = finiteMetric(current) != null && (!positiveOnly || current > 0);
  return {
    percentile: enough && currentUsable ? percentileRank(sample.map((point) => point.value), current) : null,
    sampleCount: sample.length,
    window,
    requestedWindow: window,
    actualStartAt: sample[0]?.at ?? null,
    coverage: expected ? Math.min(1, sample.length / expected) : (sample.length ? 1 : 0),
  };
}

export function buildValuationMetric(series, asOf, { positiveOnly = false } = {}) {
  const history = (series || []).filter((point) => point.at <= asOf && Number.isFinite(point.value));
  const current = history.length ? history.at(-1).value : null;
  const usableCurrent = positiveOnly && !(current > 0) ? current : current;
  const percentileCurrent = positiveOnly && !(current > 0) ? null : current;
  return {
    value: finiteMetric(usableCurrent),
    percentile1y: metricWindow(series, percentileCurrent, { window: '1y', asOf, positiveOnly }),
    percentile3y: metricWindow(series, percentileCurrent, { window: '3y', asOf, positiveOnly }),
    percentile5y: metricWindow(series, percentileCurrent, { window: '5y', asOf, positiveOnly }),
    available: metricWindow(series, percentileCurrent, { window: 'available', asOf, positiveOnly }),
  };
}
