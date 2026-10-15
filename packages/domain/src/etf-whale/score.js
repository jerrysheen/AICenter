import { percentileInclusive } from './calculate.js';
import { indexShapeHit } from './session-shape.js';

export const SCORE_ALGORITHM = 'gjd-score-v1';
export const ETF_WHALE_DISCLAIMER = '不构成投资建议';

export function clip(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export function priorPercentile(history, value) {
  const sample = history.filter(Number.isFinite).slice(-250);
  if (!sample.length || !Number.isFinite(value)) return null;
  return percentileInclusive([...sample].sort((left, right) => left - right), value);
}

export function turnoverComponent(todaySum, historySums) {
  const prior = historySums.filter(Number.isFinite).slice(-250);
  const base = median(prior.slice(-20));
  const ratio = base > 0 && Number.isFinite(todaySum) ? todaySum / base : null;
  const percentile = priorPercentile(prior, todaySum);
  const score = 12.5 * clip(ratio == null ? Number.NaN : (ratio - 1) / 2)
    + 12.5 * clip(percentile == null ? Number.NaN : (percentile - 80) / 20);
  return { score, ratio, percentile };
}

export function flowComponent(todayFlow, historyFlows) {
  const percentile = priorPercentile(historyFlows, todayFlow);
  if (!Number.isFinite(todayFlow) || todayFlow <= 0) return { score: 0, percentile };
  return { score: 25 * clip(percentile == null ? Number.NaN : (percentile - 80) / 19), percentile };
}

export function breadthComponent(items, { confirmed = false } = {}) {
  const flagged = items.map((item) => {
    const multiple = Number(item.multiple);
    const red = Number.isFinite(multiple) && multiple >= 8;
    const yellow = Number.isFinite(multiple) && multiple >= 3;
    const shareAnomaly = confirmed && Number(item.sharePercentile) >= 95;
    return { code: item.code, multiple: Number.isFinite(multiple) ? multiple : null, red, abnormal: yellow || red || shareAnomaly };
  });
  const count = flagged.filter((item) => item.abnormal).length;
  const hasRed = flagged.some((item) => item.red);
  const fromCount = count >= 3 ? Math.min(25, 15 + (count - 3) * 2.5) : 0;
  const fromSingle = hasRed ? 15 : 0;
  let score = Math.max(fromCount, fromSingle);
  if (hasRed) score = Math.min(25, score + 5);
  return { score, count, hasRed, items: flagged };
}

export function indexComponent(indices) {
  const hits = (indices || []).map((item) => ({ symbol: item.symbol, hit: indexShapeHit(item) }));
  const count = hits.filter((item) => item.hit).length;
  const hs300 = hits.some((item) => item.symbol === '000300' && item.hit);
  let score = 0;
  if (count >= 2 || hs300) score = 25;
  else if (count === 1) score = 15;
  return { score, hits, count, hs300 };
}

export function scoreLevel(score100) {
  if (!Number.isFinite(score100)) return 'none';
  if (score100 >= 70) return 'strong';
  if (score100 >= 50) return 'suspected';
  if (score100 >= 30) return 'watch';
  return 'none';
}

export function nameFlag(multiple, sharePercentile, confirmed) {
  if (Number.isFinite(multiple) && multiple >= 8) return 'red';
  if (Number.isFinite(multiple) && multiple >= 3) return 'yellow';
  if (confirmed && Number(sharePercentile) >= 95) return 'yellow';
  return null;
}

export function scoreGjdV1({ stage = 'initial', poolSumToday = null, poolHistory = [], names = [], indices = [], flowToday = null, flowHistory = [] } = {}) {
  const confirmed = stage === 'confirmed';
  const turnover = turnoverComponent(poolSumToday, poolHistory);
  const breadth = breadthComponent(names, { confirmed });
  const index = indexComponent(indices);
  const flow = confirmed ? flowComponent(flowToday, flowHistory) : null;
  const maxScore = confirmed ? 100 : 75;
  const score = turnover.score + breadth.score + index.score + (flow ? flow.score : 0);
  const scaled = (score / maxScore) * 100;
  return {
    algorithm: SCORE_ALGORITHM,
    stage: confirmed ? 'confirmed' : 'initial',
    score,
    maxScore,
    scaled,
    sTurnover: turnover.score,
    sFlow: flow ? flow.score : null,
    sBreadth: breadth.score,
    sIndex: index.score,
    level: scoreLevel(confirmed ? score : scaled),
    turnover,
    breadth,
    index,
    flow,
  };
}
