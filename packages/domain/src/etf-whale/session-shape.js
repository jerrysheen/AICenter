export const INTRADAY_METHOD = 'intraday';
export const DAILY_APPROX_METHOD = 'daily-approx';
export const MIXED_INDEX_METHOD = 'mixed';

const CLOSE_NEAR_HIGH = 0.7;
const LOWER_SHADOW_MIN = 0.4;
const DIP_WASH = -0.01;
const DIP_SURGE = -0.005;
const REBOUND_MIN = 0.01;
const VOLUME_SURGE = 1.5;
const AMOUNT_MIN_DAYS = 10;

export function metricOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finite(value) {
  return metricOrNull(value);
}

export function indexSessionShape({ prevClose, close, bars = [] } = {}) {
  const previous = finite(prevClose);
  const settled = finite(close);
  if (!bars.length || previous == null || previous === 0 || settled == null) {
    return { lowTime: null, lowDropPct: null, reboundPct: null, tailPct: null };
  }
  let lowBar = null;
  for (const bar of bars) {
    const low = finite(bar.low);
    if (low == null) continue;
    if (!lowBar || low < lowBar.low) lowBar = { ...bar, low };
  }
  if (!lowBar) return { lowTime: null, lowDropPct: null, reboundPct: null, tailPct: null };
  const tail = bars.find((bar) => String(bar.barTime || '').slice(11, 16) === '14:30') || null;
  const tailClose = finite(tail?.close);
  return {
    lowTime: lowBar.barTime || null,
    lowDropPct: lowBar.low / previous - 1,
    reboundPct: lowBar.low ? settled / lowBar.low - 1 : null,
    tailPct: tailClose == null || tailClose === 0 ? null : settled / tailClose - 1,
  };
}

export function indexShapeHit({ lowDropPct, reboundPct, tailPct } = {}) {
  const drop = finite(lowDropPct);
  const rebound = finite(reboundPct);
  const tail = finite(tailPct);
  const washed = drop != null && rebound != null && drop < -0.01 && rebound >= 0.01;
  const tailUp = tail != null && tail >= 0.01;
  return washed || tailUp;
}

export function storedIntradayMetrics(row) {
  if (!row) return null;
  const lowDropPct = metricOrNull(row.lowDropPct ?? row.low_drop_pct);
  const reboundPct = metricOrNull(row.reboundPct ?? row.rebound_pct);
  const tailPct = metricOrNull(row.tailPct ?? row.tail_pct);
  const lowTime = row.lowTime ?? row.low_time ?? null;
  const values = [lowDropPct, reboundPct, tailPct];
  if (values.every((value) => value == null)) return null;
  if (values.every((value) => value === 0) && !lowTime) return null;
  return { lowDropPct, reboundPct, tailPct, lowTime: lowTime || null };
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function dailyIndexApprox({ open, high, low, close, prevClose, amountCny, priorAmounts = [] } = {}) {
  const opened = finite(open);
  const top = finite(high);
  const bottom = finite(low);
  const settled = finite(close);
  const previous = finite(prevClose);
  const amount = finite(amountCny);
  const history = (priorAmounts || []).map(finite).filter((value) => value != null && value > 0).slice(-20);
  const coherent = opened != null && top != null && bottom != null && settled != null
    && bottom > 0
    && top >= Math.max(opened, settled)
    && bottom <= Math.min(opened, settled);
  if (!coherent) {
    return { usable: false, hit: false, dip: null, rebound: null, closePos: null, lowerShadow: null, amountRatio: null };
  }
  const range = top - bottom;
  const dip = previous > 0 ? bottom / previous - 1 : null;
  const rebound = settled / bottom - 1;
  const closePos = range > 0 ? (settled - bottom) / range : null;
  const lowerShadow = range > 0 ? (Math.min(opened, settled) - bottom) / range : null;
  const average = history.length >= AMOUNT_MIN_DAYS ? mean(history) : null;
  const amountRatio = average > 0 && amount != null ? amount / average : null;
  const closeNearHigh = closePos != null && closePos >= CLOSE_NEAR_HIGH;
  const washedNearHigh = dip != null && dip < DIP_WASH && rebound >= REBOUND_MIN && closeNearHigh;
  const shadowRebound = lowerShadow != null && lowerShadow >= LOWER_SHADOW_MIN && settled >= opened && rebound >= REBOUND_MIN;
  const volumeRebound = amountRatio != null && amountRatio >= VOLUME_SURGE && dip != null && dip < DIP_SURGE && closeNearHigh && rebound >= REBOUND_MIN;
  return {
    usable: true,
    hit: Boolean(washedNearHigh || shadowRebound || volumeRebound),
    dip,
    rebound,
    closePos,
    lowerShadow,
    amountRatio,
  };
}

export function describeIndexPoint(point = {}) {
  const stored = storedIntradayMetrics(point);
  if (point.barsPresent || stored) {
    const metrics = stored || point;
    return {
      method: INTRADAY_METHOD,
      hit: indexShapeHit(metrics),
      lowDropPct: metricOrNull(metrics.lowDropPct),
      reboundPct: metricOrNull(metrics.reboundPct),
      tailPct: metricOrNull(metrics.tailPct),
    };
  }
  const approx = dailyIndexApprox(point);
  if (!approx.usable) {
    return { method: null, hit: false, lowDropPct: null, reboundPct: null, tailPct: null };
  }
  return {
    method: DAILY_APPROX_METHOD,
    hit: approx.hit,
    lowDropPct: approx.dip,
    reboundPct: approx.rebound,
    tailPct: null,
  };
}

export function resolveIndexPoint(symbol, row, bars = [], priorAmounts = []) {
  const barList = bars || [];
  const barsPresent = barList.length > 0;
  const stored = storedIntradayMetrics(row);
  const measured = barsPresent && !stored
    ? indexSessionShape({
      prevClose: row?.prev_close ?? row?.prevClose,
      close: row?.close,
      bars: barList,
    })
    : stored;
  return {
    symbol,
    barsPresent,
    lowDropPct: measured?.lowDropPct ?? null,
    reboundPct: measured?.reboundPct ?? null,
    tailPct: measured?.tailPct ?? null,
    lowTime: measured?.lowTime ?? row?.low_time ?? row?.lowTime ?? null,
    open: row?.open ?? null,
    high: row?.high ?? null,
    low: row?.low ?? null,
    close: row?.close ?? null,
    prevClose: row?.prev_close ?? row?.prevClose ?? null,
    amountCny: row?.amount_cny ?? row?.amountCny ?? null,
    priorAmounts,
  };
}
