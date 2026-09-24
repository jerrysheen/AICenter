import { buildValuationMetric } from '../market-factors/valuation-factors.js';
import {
  currentDrawdown,
  distanceToMovingAverage,
  trailingReturn,
} from '../market-factors/price-factors.js';

function latestPoint(points, at) {
  let found = null;
  for (const point of points) {
    if (point.at <= at) found = point;
    else break;
  }
  return found;
}

function activeSnapshot(snapshots, at) {
  let found = null;
  for (const snapshot of snapshots) {
    if (snapshot.at <= at) found = snapshot;
    else break;
  }
  return found;
}

function aggregateValuation(members, series, at) {
  let dividendWeighted = 0;
  let dividendUsed = 0;
  let earnings = 0;
  let earningsUsed = 0;
  let book = 0;
  let bookUsed = 0;
  for (const member of members) {
    if (!(member.weight > 0)) continue;
    const point = latestPoint(series[member.symbol]?.points || [], at);
    if (!point) continue;
    if (Number.isFinite(point.dividendYieldTtm)) {
      dividendWeighted += member.weight * point.dividendYieldTtm;
      dividendUsed += member.weight;
    }
    if (point.peTtm > 0) {
      earnings += member.weight / point.peTtm;
      earningsUsed += member.weight;
    }
    if (point.pb > 0) {
      book += member.weight / point.pb;
      bookUsed += member.weight;
    }
  }
  return {
    dividendYield: dividendUsed > 0 ? dividendWeighted / dividendUsed : null,
    pe: earningsUsed > 0 ? earningsUsed / earnings : null,
    pb: bookUsed > 0 ? bookUsed / book : null,
  };
}

function breadth(members, series, at, window) {
  let used = 0;
  let above = 0;
  for (const member of members) {
    const points = (series[member.symbol]?.points || []).filter((point) => point.at <= at && point.close > 0);
    if (points.length < window) continue;
    const slice = points.slice(-window);
    const average = slice.reduce((total, point) => total + point.close, 0) / window;
    if (!(average > 0)) continue;
    used += member.weight;
    if (slice.at(-1).close > average) above += member.weight;
  }
  return used > 0 ? above / used : null;
}

function qualityAt(members, series, at) {
  let total = 0;
  let covered = 0;
  let earnings = 0;
  let negativePe = 0;
  let missing = 0;
  let priced = 0;
  let pricedAdjusted = 0;
  for (const member of members) {
    if (!(member.weight > 0)) continue;
    total += member.weight;
    const record = series[member.symbol];
    const point = record ? latestPoint(record.points || [], at) : null;
    const hasPrice = point?.close > 0;
    const hasMetric = point && (
      Number.isFinite(point.peTtm) || Number.isFinite(point.pb) || Number.isFinite(point.dividendYieldTtm)
    );
    if (hasPrice || hasMetric) covered += member.weight;
    else missing += member.weight;
    if (point?.peTtm > 0) earnings += member.weight;
    if (point && Number.isFinite(point.peTtm) && point.peTtm <= 0) negativePe += member.weight;
    if (hasPrice) {
      priced += member.weight;
      if (record.adjusted) pricedAdjusted += member.weight;
    }
  }
  return {
    constituentCount: members.length,
    coverage: total > 0 ? covered / total : 0,
    earningsCoverage: total > 0 ? earnings / total : 0,
    negativePeWeight: total > 0 ? negativePe / total : 0,
    missingWeight: total > 0 ? missing / total : 0,
    adjustedPrice: priced > 0 && pricedAdjusted === priced,
  };
}

function emptyPain() {
  return {
    return20d: null,
    return60d: null,
    return120d: null,
    return252d: null,
    drawdown252d: null,
    distanceToMA20: null,
    distanceToMA60: null,
    distanceToMA120: null,
    distanceToMA250: null,
    breadthAboveMA20: null,
    breadthAboveMA60: null,
  };
}

export function aggregateBasket({
  index,
  name,
  range,
  asOf,
  snapshots = [],
  series = {},
  warnings = [],
}) {
  const ordered = [...snapshots].filter((snapshot) => snapshot.at <= asOf).sort((left, right) => left.at - right.at);
  const normalizedSeries = {};
  for (const [symbol, record] of Object.entries(series)) {
    normalizedSeries[symbol] = {
      adjusted: Boolean(record?.adjusted),
      points: [...(record?.points || [])].sort((left, right) => left.at - right.at),
    };
  }
  const dates = new Set(ordered.map((snapshot) => snapshot.at));
  for (const record of Object.values(normalizedSeries)) {
    for (const point of record.points || []) {
      if (point.at <= asOf) dates.add(point.at);
    }
  }
  const firstWeightAt = ordered[0]?.at ?? null;
  const timeline = [...dates].filter((at) => firstWeightAt == null || at >= firstWeightAt).sort((left, right) => left - right);
  const pePoints = [];
  const pbPoints = [];
  const dividendPoints = [];
  const pricePoints = [];
  let level = 1;
  let previousCloses = null;
  for (const at of timeline) {
    const members = activeSnapshot(ordered, at)?.members || [];
    const valuation = aggregateValuation(members, normalizedSeries, at);
    if (valuation.pe != null) pePoints.push({ at, value: valuation.pe });
    if (valuation.pb != null) pbPoints.push({ at, value: valuation.pb });
    if (valuation.dividendYield != null) dividendPoints.push({ at, value: valuation.dividendYield });
    const closes = new Map();
    for (const member of members) {
      const point = latestPoint(normalizedSeries[member.symbol]?.points || [], at);
      if (point?.close > 0) closes.set(member.symbol, point.close);
    }
    if (previousCloses) {
      let weighted = 0;
      let used = 0;
      for (const member of members) {
        const current = closes.get(member.symbol);
        const previous = previousCloses.get(member.symbol);
        if (!(current > 0) || !(previous > 0) || !(member.weight > 0)) continue;
        weighted += member.weight * (current / previous - 1);
        used += member.weight;
      }
      if (used > 0) level *= 1 + weighted / used;
    }
    pricePoints.push({ at, close: level, volume: null });
    previousCloses = closes;
  }
  const stamp = timeline.at(-1) ?? null;
  const latest = ordered.at(-1) || null;
  const members = latest?.members || [];
  const pe = stamp == null ? null : buildValuationMetric(pePoints, stamp, { positiveOnly: true });
  const pb = stamp == null ? null : buildValuationMetric(pbPoints, stamp, { positiveOnly: true });
  const dividend = stamp == null ? null : buildValuationMetric(dividendPoints, stamp);
  const quality = qualityAt(members, normalizedSeries, stamp ?? asOf);
  const resultWarnings = [...warnings];
  if (ordered.length < 2) resultWarnings.push('indexWeightHistoryShort');
  if (quality.constituentCount > 0 && !quality.adjustedPrice) resultWarnings.push('priceSeriesAdjusted=false');
  const pain = stamp == null ? emptyPain() : {
    return20d: trailingReturn(pricePoints, 20),
    return60d: trailingReturn(pricePoints, 60),
    return120d: trailingReturn(pricePoints, 120),
    return252d: trailingReturn(pricePoints, 252),
    drawdown252d: currentDrawdown(pricePoints, 252),
    distanceToMA20: distanceToMovingAverage(pricePoints, 20),
    distanceToMA60: distanceToMovingAverage(pricePoints, 60),
    distanceToMA120: distanceToMovingAverage(pricePoints, 120),
    distanceToMA250: distanceToMovingAverage(pricePoints, 250),
    breadthAboveMA20: breadth(members, normalizedSeries, stamp, 20),
    breadthAboveMA60: breadth(members, normalizedSeries, stamp, 60),
  };
  const status = !members.length || quality.coverage === 0
    ? 'unavailable'
    : (resultWarnings.length ? 'partial' : 'ready');
  return {
    index,
    name,
    range,
    asOf: stamp,
    tradeDate: latest?.tradeDate || null,
    status,
    constituentCount: members.length,
    value: {
      dividendYield: dividend?.value ?? null,
      dividendYieldPercentile5y: dividend?.percentile5y.percentile ?? null,
      peTtm: pe?.value ?? null,
      pePercentile5y: pe?.percentile5y.percentile ?? null,
      pb: pb?.value ?? null,
      pbPercentile5y: pb?.percentile5y.percentile ?? null,
    },
    pain,
    dataQuality: quality,
    warnings: [...new Set(resultWarnings)].slice(0, 30),
  };
}
