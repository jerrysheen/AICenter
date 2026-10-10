import { YI, roundDigits } from './calculate.js';
import { FIXED_HISTORY_SAMPLE } from './reference-samples.js';

const SHARE_YI_TOLERANCE = 0.00005;
const DELTA_YI_TOLERANCE = 0.00015;
const LARGE_FLOW_YI = 1;

export function referenceFlowYi(row) {
  const delta = numberOrNull(row?.qfq_delta_units_yi);
  const price = numberOrNull(row?.etf_qfq_avg_price_est) ?? numberOrNull(row?.etf_qfq_close);
  if (delta == null || price == null) return null;
  return delta * price;
}

export function compareEtfDay(ours, reference) {
  if (!reference) {
    return { status: 'MISSING_REFERENCE', shareStatus: 'MISSING_REFERENCE', flowStatus: 'MISSING_REFERENCE' };
  }
  const refSharesRaw = numberOrNull(reference.qfq_total_units_yi);
  if (refSharesRaw === 0) {
    return rowResult({
      status: 'NOT_COMPARABLE',
      shareStatus: 'NOT_COMPARABLE',
      flowStatus: 'NOT_COMPARABLE',
      reason: 'reference_zero_share',
      refShares: 0,
      refDelta: numberOrNull(reference.qfq_delta_units_yi),
      refClose: numberOrNull(reference.etf_qfq_close),
      refAvg: numberOrNull(reference.etf_qfq_avg_price_est),
      refTurnover: numberOrNull(reference.etf_qfq_turnover_est_yi),
      refFlow: null,
    });
  }
  const refShares = refSharesRaw;
  const refDelta = numberOrNull(reference.qfq_delta_units_yi);
  const refClose = numberOrNull(reference.etf_qfq_close);
  const refAvg = numberOrNull(reference.etf_qfq_avg_price_est);
  const refTurnover = numberOrNull(reference.etf_qfq_turnover_est_yi);
  const refFlow = referenceFlowYi(reference);
  if (!ours) {
    return rowResult({
      status: 'MISSING_OURS',
      shareStatus: 'MISSING_OURS',
      flowStatus: 'MISSING_OURS',
      refShares, refDelta, refClose, refAvg, refTurnover, refFlow,
    });
  }
  if (!ours.shareComparable && ours.reason !== 'ok' && ours.reason !== 'missing_quote') {
    return rowResult({
      status: 'NOT_COMPARABLE',
      shareStatus: 'NOT_COMPARABLE',
      flowStatus: 'NOT_COMPARABLE',
      reason: ours.reason,
      ours, refShares, refDelta, refClose, refAvg, refTurnover, refFlow,
    });
  }
  const shareDiff = diff(ours.sharesYi, refShares);
  const deltaDiff = diff(ours.deltaYi, refDelta);
  const closeDiff = diff(ours.closePrice, refClose);
  const avgDiff = diff(ours.typicalPrice, refAvg);
  const turnoverDiff = diff(ours.turnoverCny == null ? null : ours.turnoverCny / YI, refTurnover);
  const flowDiff = diff(ours.flowYi, refFlow);
  const shareStatus = refShares == null ? 'MISSING_REFERENCE' : (shareDiff != null && Math.abs(shareDiff) <= SHARE_YI_TOLERANCE ? 'PASS' : 'FAIL');
  const deltaStatus = refDelta == null ? 'MISSING_REFERENCE' : (!ours.shareComparable ? 'NOT_COMPARABLE' : (deltaDiff != null && Math.abs(deltaDiff) <= DELTA_YI_TOLERANCE ? 'PASS' : 'FAIL'));
  const priceStatus = refClose == null ? 'MISSING_REFERENCE' : (closeDiff != null && Math.abs(closeDiff) <= 0.0005 ? 'PASS' : 'FAIL');
  const avgStatus = refAvg == null ? 'MISSING_REFERENCE' : (avgDiff != null && Math.abs(avgDiff) <= 0.00005 ? 'PASS' : 'FAIL');
  let flowStatus = flowStatusFor(ours, refFlow, flowDiff);
  let reason = flowStatus === 'NOT_COMPARABLE' ? ours.reason : '';
  if (refAvg == null && refFlow != null && ours.flowComparable) {
    flowStatus = 'NOT_COMPARABLE';
    reason = 'reference_avg_price_missing';
  }
  const status = [shareStatus, deltaStatus, flowStatus].includes('FAIL')
    ? 'FAIL'
    : [shareStatus, deltaStatus, flowStatus].every((item) => item === 'PASS' || item === 'MISSING_REFERENCE')
      ? 'PASS'
      : 'NOT_COMPARABLE';
  return rowResult({
    status, shareStatus, deltaStatus, priceStatus, avgStatus, flowStatus,
    reason,
    ours, refShares, refDelta, refClose, refAvg, refTurnover, refFlow,
    shareDiff, deltaDiff, closeDiff, avgDiff, turnoverDiff, flowDiff,
  });
}

function flowStatusFor(ours, refFlow, flowDiff) {
  if (refFlow == null) return 'MISSING_REFERENCE';
  if (!ours.flowComparable || !Number.isFinite(ours.flowYi)) return 'NOT_COMPARABLE';
  const sameDirection = Math.sign(ours.flowYi) === Math.sign(refFlow) || (ours.flowYi === 0 && refFlow === 0);
  if (!sameDirection) return 'FAIL';
  if (Math.abs(refFlow) < 0.05) return Math.abs(flowDiff) <= 0.05 ? 'PASS' : 'FAIL';
  if (Math.abs(refFlow) >= LARGE_FLOW_YI) return Math.abs(flowDiff) / Math.abs(refFlow) <= 0.05 ? 'PASS' : 'FAIL';
  return Math.abs(flowDiff) <= 0.05 ? 'PASS' : 'FAIL';
}

function rowResult(value) {
  return {
    code: value.ours?.code || value.referenceCode || '',
    tradeDate: value.ours?.tradeDate || '',
    status: value.status,
    shareStatus: value.shareStatus,
    deltaStatus: value.deltaStatus || value.shareStatus,
    priceStatus: value.priceStatus || 'MISSING_REFERENCE',
    avgStatus: value.avgStatus || 'MISSING_REFERENCE',
    flowStatus: value.flowStatus,
    reason: value.reason || value.ours?.reason || '',
    oursSharesYi: value.ours?.sharesYi ?? null,
    refSharesYi: value.refShares ?? null,
    shareDiffYi: value.shareDiff ?? null,
    oursDeltaYi: value.ours?.deltaYi ?? null,
    refDeltaYi: value.refDelta ?? null,
    deltaDiffYi: value.deltaDiff ?? null,
    oursClose: value.ours?.closePrice ?? null,
    refClose: value.refClose ?? null,
    closeDiff: value.closeDiff ?? null,
    oursAvg: value.ours?.typicalPrice ?? null,
    refAvg: value.refAvg ?? null,
    avgDiff: value.avgDiff ?? null,
    oursTurnoverYi: value.ours?.turnoverCny == null ? null : value.ours.turnoverCny / YI,
    refTurnoverYi: value.refTurnover ?? null,
    turnoverDiffYi: value.turnoverDiff ?? null,
    oursFlowYi: value.ours?.flowYi ?? null,
    refFlowYi: value.refFlow ?? null,
    flowDiffYi: value.flowDiff ?? null,
    flowRelative: relative(value.flowDiff, value.refFlow),
    directionMatch: direction(value.ours?.flowYi, value.refFlow),
  };
}

export function compareFixedSample(rows) {
  const sample = FIXED_HISTORY_SAMPLE;
  const etfs = sample.etfs.map((item) => {
    const ours = rows.find((row) => row.code === item.code && row.tradeDate === sample.tradeDate);
    const deltaDiff = diff(ours?.deltaYi, item.deltaSharesYi);
    const flowDiff = diff(ours?.flowYi == null ? null : roundDigits(ours.flowYi, 1), item.flowYi);
    return {
      code: item.code,
      tradeDate: sample.tradeDate,
      oursDeltaYi: ours?.deltaYi ?? null,
      refDeltaYi: item.deltaSharesYi,
      deltaDiffYi: deltaDiff,
      deltaStatus: !ours ? 'MISSING_OURS' : (deltaDiff != null && Math.abs(deltaDiff) <= 0.001 ? 'PASS' : 'FAIL'),
      oursFlowYi: ours?.flowYi ?? null,
      oursFlowRoundedYi: ours?.flowYi == null ? null : roundDigits(ours.flowYi, 1),
      refFlowYi: item.flowYi,
      flowDiffYi: flowDiff,
      flowStatus: !ours?.flowComparable ? 'NOT_COMPARABLE' : (flowDiff != null && Math.abs(flowDiff) <= 0.05 ? 'PASS' : 'FAIL'),
      directionMatch: direction(ours?.flowYi, item.flowYi),
    };
  });
  return { sampleId: sample.id, sourceUrl: sample.sourceUrl, note: sample.note, etfs };
}

export function summarizeComparisons(rows) {
  const comparable = rows.filter((row) => row.status !== 'MISSING_REFERENCE' && row.status !== 'MISSING_OURS');
  const shareRows = comparable.filter((row) => row.shareStatus === 'PASS' || row.shareStatus === 'FAIL');
  const flowRows = comparable.filter((row) => row.flowStatus === 'PASS' || row.flowStatus === 'FAIL');
  const largeFlow = flowRows.filter((row) => Math.abs(row.refFlowYi) >= LARGE_FLOW_YI);
  const relatives = largeFlow.map((row) => Math.abs(row.flowRelative)).filter(Number.isFinite).sort((a, b) => a - b);
  return {
    rowCount: rows.length,
    comparable: comparable.length,
    missingReference: rows.filter((row) => row.status === 'MISSING_REFERENCE').length,
    missingOurs: rows.filter((row) => row.status === 'MISSING_OURS').length,
    notComparable: rows.filter((row) => row.shareStatus === 'NOT_COMPARABLE' || row.flowStatus === 'NOT_COMPARABLE').length,
    sharePassRate: rate(shareRows.filter((row) => row.shareStatus === 'PASS').length, shareRows.length),
    shareSample: shareRows.length,
    deltaPassRate: rate(comparable.filter((row) => row.deltaStatus === 'PASS').length, comparable.filter((row) => row.deltaStatus === 'PASS' || row.deltaStatus === 'FAIL').length),
    directionRate: rate(flowRows.filter((row) => row.directionMatch).length, flowRows.length),
    flowSample: flowRows.length,
    largeFlowSample: largeFlow.length,
    largeFlowWithin5pct: rate(largeFlow.filter((row) => row.flowStatus === 'PASS').length, largeFlow.length),
    medianAbsFlowRelative: relatives.length ? relatives[Math.floor((relatives.length - 1) / 2)] : null,
    pass: rows.filter((row) => row.status === 'PASS').length,
    fail: rows.filter((row) => row.status === 'FAIL').length,
  };
}

export function largestDiscrepancies(rows, limit = 10) {
  return rows
    .filter((row) => row.flowStatus === 'FAIL' || row.shareStatus === 'FAIL' || row.deltaStatus === 'FAIL')
    .map((row) => ({ ...row, rank: Math.abs(row.flowDiffYi || 0) }))
    .sort((left, right) => right.rank - left.rank)
    .slice(0, limit);
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function diff(ours, reference) {
  if (!Number.isFinite(ours) || !Number.isFinite(reference)) return null;
  return ours - reference;
}

function relative(diffValue, reference) {
  if (!Number.isFinite(diffValue) || !Number.isFinite(reference) || Math.abs(reference) < 0.05) return null;
  return diffValue / reference;
}

function direction(ours, reference) {
  if (!Number.isFinite(ours) || !Number.isFinite(reference)) return null;
  if (ours === 0 && reference === 0) return true;
  return Math.sign(ours) === Math.sign(reference);
}

function rate(part, total) {
  if (!total) return null;
  return part / total;
}
