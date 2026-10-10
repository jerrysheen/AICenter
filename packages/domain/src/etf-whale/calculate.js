export const ALGORITHM = 'etf-whale-qfq-typical-v1';
export const PERCENTILE_START = '2024-01-01';
export const WAN_FEN = 10_000;
export const LOT_SHARES = 100;
export const YI = 100_000_000;
const SPLIT_RATIOS = [10, 5, 4, 3, 2, 0.5, 0.25, 0.2, 0.1];

export function wanFenToShares(value) {
  const number = Number(String(value ?? '').replaceAll(',', '').trim());
  if (!Number.isFinite(number)) return null;
  return number * WAN_FEN;
}

export function lotToShares(lots) {
  const number = Number(lots);
  if (!Number.isFinite(number)) return null;
  return number * LOT_SHARES;
}

export function yuanToYi(yuan) {
  if (!Number.isFinite(yuan)) return null;
  return yuan / YI;
}

export function sharesToYi(shares) {
  if (!Number.isFinite(shares)) return null;
  return shares / YI;
}

export function roundDigits(value, digits) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Math.sign(value) * 1e-12) * factor) / factor;
}

export function addDays(iso, days) {
  const [year, month, day] = iso.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, 10);
}

export function weekdays(start, end) {
  const dates = [];
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
    const [year, month, day] = cursor.split('-').map(Number);
    const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    if (dow !== 0 && dow !== 6) dates.push(cursor);
  }
  return dates;
}

export function dateChunks(start, end, maxDays) {
  const chunks = [];
  let cursor = start;
  while (cursor <= end) {
    const chunkEnd = minIso(addDays(cursor, maxDays - 1), end);
    chunks.push([cursor, chunkEnd]);
    cursor = addDays(chunkEnd, 1);
  }
  return chunks;
}

function minIso(left, right) {
  return left <= right ? left : right;
}

export function typicalPrice(open, high, low, close) {
  const sumMilli = [open, high, low, close].reduce((total, value) => total + Math.round(Number(value) * 1000), 0);
  if (!Number.isFinite(sumMilli)) return null;
  return Math.round(sumMilli * 10 / 4) / 10_000;
}

export function turnoverFromTypical(typical, volumeLots) {
  if (!Number.isFinite(typical) || !Number.isFinite(volumeLots)) return null;
  return typical * volumeLots * LOT_SHARES;
}

export function shareUnitFactor(previousShares, shares) {
  if (!Number.isFinite(previousShares) || !Number.isFinite(shares) || previousShares === 0) return null;
  const ratio = shares / previousShares;
  if (Math.abs(ratio - 1) < 0.35) return null;
  let best = null;
  for (const factor of SPLIT_RATIOS) {
    const distance = Math.abs(ratio - factor) / factor;
    if (distance <= 0.024 && (best == null || distance < best.distance)) best = { factor, distance };
  }
  return best?.factor ?? null;
}

export function classifyShareJump({ previousShares, shares, previousClose, close }) {
  if (!Number.isFinite(previousShares) || !Number.isFinite(shares) || previousShares === 0) {
    return { kind: 'missing', comparable: false, ratio: null };
  }
  const shareRatio = shares / previousShares;
  const priceRatio = Number.isFinite(previousClose) && Number.isFinite(close) && previousClose !== 0
    ? close / previousClose
    : null;
  for (const ratio of SPLIT_RATIOS) {
    const shareClose = Math.abs(shareRatio - ratio) / ratio <= 0.02;
    const priceClose = priceRatio != null && Math.abs(priceRatio - (1 / ratio)) / (1 / ratio) <= 0.03;
    if (shareClose && priceClose) return { kind: 'split', comparable: false, ratio };
  }
  return { kind: 'flow', comparable: true, ratio: shareRatio };
}

export function percentileInclusive(sortedValues, value) {
  if (!Number.isFinite(value) || !sortedValues?.length) return null;
  let lower = 0;
  let upper = sortedValues.length;
  while (lower < upper) {
    const mid = Math.floor((lower + upper) / 2);
    if (sortedValues[mid] <= value) lower = mid + 1;
    else upper = mid;
  }
  return (lower / sortedValues.length) * 100;
}

function previousOf(dates, date) {
  const index = dates.indexOf(date);
  return index > 0 ? dates[index - 1] : null;
}

function windowSum(rows, index, length, key) {
  const start = Math.max(0, index - length + 1);
  const slice = rows.slice(start, index + 1);
  const values = slice.map((row) => row[key]).filter((value) => Number.isFinite(value));
  return {
    length,
    count: values.length,
    complete: slice.length === length && values.length === length,
    sum: values.length ? values.reduce((total, value) => total + value, 0) : null,
  };
}

export function forwardShareFactors(tradingDates, sharesByDate) {
  const factors = new Map();
  let previousDate = null;
  for (const date of tradingDates) {
    const shares = sharesByDate.has(date) ? sharesByDate.get(date) : null;
    if (!Number.isFinite(shares)) continue;
    const prior = previousDate ? previousOf(tradingDates, date) : null;
    if (previousDate && prior === previousDate) {
      const factor = shareUnitFactor(sharesByDate.get(previousDate), shares);
      if (factor) factors.set(date, factor);
    }
    previousDate = date;
  }
  const scale = new Map();
  let product = 1;
  for (let index = tradingDates.length - 1; index >= 0; index -= 1) {
    const date = tradingDates[index];
    scale.set(date, product);
    if (factors.has(date)) product *= factors.get(date);
  }
  return { factors, scale };
}

export function buildCodeSeries({ code, tradingDates, sharesByDate, quotesByDate }) {
  const { factors, scale } = forwardShareFactors(tradingDates, sharesByDate);
  const rows = [];
  let previousShareDate = null;
  for (const date of tradingDates) {
    const shares = sharesByDate.has(date) ? sharesByDate.get(date) : null;
    const quote = quotesByDate.get(date) || null;
    const priorTrading = previousOf(tradingDates, date);
    const typical = quote ? typicalPrice(quote.open, quote.high, quote.low, quote.close) : null;
    const turnover = quote && typical != null ? turnoverFromTypical(typical, quote.volumeLots) : null;
    const scaleToday = scale.get(date) || 1;
    const adjustedShares = Number.isFinite(shares) ? shares * scaleToday : null;
    let deltaShares = null;
    let shareChangePct = null;
    let shareComparable = false;
    let flowComparable = false;
    let reason = Number.isFinite(shares) ? 'series_start' : 'missing_shares';
    let adjustment = null;
    let previousAdjusted = null;
    if (!Number.isFinite(shares)) {
      reason = 'missing_shares';
    } else if (!priorTrading) {
      reason = 'series_start';
      previousShareDate = date;
    } else if (previousShareDate !== priorTrading) {
      reason = 'missing_prior_shares';
      previousShareDate = date;
    } else {
      previousAdjusted = sharesByDate.get(previousShareDate) * (scale.get(previousShareDate) || 1);
      const unitFactor = factors.get(date) || null;
      adjustment = unitFactor
        ? { kind: 'share_unit', comparable: true, ratio: unitFactor }
        : { kind: 'flow', comparable: true, ratio: null };
      deltaShares = adjustedShares - previousAdjusted;
      shareChangePct = previousAdjusted ? deltaShares / previousAdjusted : null;
      shareComparable = true;
      flowComparable = typical != null;
      reason = flowComparable ? 'ok' : 'missing_quote';
      previousShareDate = date;
    }
    const sharesYi = Number.isFinite(adjustedShares) ? roundDigits(adjustedShares / YI, 4) : null;
    const previousYi = shareComparable ? roundDigits(previousAdjusted / YI, 4) : null;
    const deltaYi = sharesYi != null && previousYi != null ? roundDigits(sharesYi - previousYi, 4) : null;
    const flowYi = deltaYi != null && typical != null && flowComparable ? deltaYi * typical : null;
    rows.push({
      code,
      tradeDate: date,
      algorithm: ALGORITHM,
      rawShares: Number.isFinite(shares) ? shares : null,
      adjustedShares,
      deltaShares,
      shareChangePct,
      closePrice: quote?.close ?? null,
      openPrice: quote?.open ?? null,
      highPrice: quote?.high ?? null,
      lowPrice: quote?.low ?? null,
      typicalPrice: typical,
      turnoverCny: turnover,
      volumeShares: quote ? lotToShares(quote.volumeLots) : null,
      volumeLots: quote?.volumeLots ?? null,
      averageTradePrice: typical,
      flowCny: flowYi == null ? null : flowYi * YI,
      flowYi,
      deltaYi,
      sharesYi,
      shareComparable,
      flowComparable,
      reason,
      adjustment,
    });
  }
  attachHistory(rows);
  return rows;
}

function attachHistory(rows) {
  const baseline = rows.filter((row) => row.tradeDate >= PERCENTILE_START);
  const turnover = baseline.map((row) => row.turnoverCny).filter(Number.isFinite).sort((a, b) => a - b);
  const flowAbs = baseline.map((row) => row.deltaShares).filter(Number.isFinite).map(Math.abs).sort((a, b) => a - b);
  const amountAbs = baseline.map((row) => row.flowCny).filter(Number.isFinite).map(Math.abs).sort((a, b) => a - b);
  let peak = null;
  rows.forEach((row, index) => {
    if (Number.isFinite(row.rawShares)) peak = peak == null ? row.rawShares : Math.max(peak, row.rawShares);
    const rolling252Start = Math.max(0, index - 251);
    const rolling = rows.slice(rolling252Start, index + 1).filter((item) => item.tradeDate >= PERCENTILE_START);
    const rollingAmount = rolling.map((item) => item.flowCny).filter(Number.isFinite).map(Math.abs).sort((a, b) => a - b);
    row.percentiles = {
      since20240101: {
        window: 'since_2024_01_01_inclusive',
        turnover: percentileInclusive(turnover, row.turnoverCny),
        absShareDelta: percentileInclusive(flowAbs, Number.isFinite(row.deltaShares) ? Math.abs(row.deltaShares) : null),
        absFlow: percentileInclusive(amountAbs, Number.isFinite(row.flowCny) ? Math.abs(row.flowCny) : null),
        sampleTurnover: turnover.length,
        sampleFlow: amountAbs.length,
      },
      rolling252: {
        window: 'rolling_252_trading_days_inclusive',
        absFlow: percentileInclusive(rollingAmount, Number.isFinite(row.flowCny) ? Math.abs(row.flowCny) : null),
        sampleFlow: rollingAmount.length,
        comparableToReferenceSite: false,
      },
    };
    row.rolling = {
      d5: windowSum(rows, index, 5, 'flowCny'),
      d20: windowSum(rows, index, 20, 'flowCny'),
      d21: windowSum(rows, index, 21, 'flowCny'),
      d60: windowSum(rows, index, 60, 'flowCny'),
      d63: windowSum(rows, index, 63, 'flowCny'),
    };
    row.shareToPeak = peak && row.rawShares ? row.rawShares / peak : null;
  });
}

export function aggregatePool(rows, { codes, tradeDate, groupKey = '' }) {
  const unique = [...new Set(codes)];
  const selected = unique.map((code) => rows.find((row) => row.code === code && row.tradeDate === tradeDate) || null);
  const present = selected.filter(Boolean);
  const withShares = present.filter((row) => Number.isFinite(row.rawShares));
  const withFlow = present.filter((row) => row.flowComparable && Number.isFinite(row.flowCny));
  const inflow = withFlow.filter((row) => row.deltaShares > 0);
  const outflow = withFlow.filter((row) => row.deltaShares < 0);
  return {
    groupKey,
    tradeDate,
    expected: unique.length,
    covered: present.length,
    shareCovered: withShares.length,
    flowCovered: withFlow.length,
    complete: withFlow.length === unique.length,
    inflowCount: inflow.length,
    outflowCount: outflow.length,
    deltaShares: withShares.every((row) => Number.isFinite(row.deltaShares)) && withShares.length === unique.length
      ? withShares.reduce((total, row) => total + row.deltaShares, 0)
      : null,
    flowCny: withFlow.length === unique.length ? withFlow.reduce((total, row) => total + row.flowCny, 0) : null,
    partialFlowCny: withFlow.reduce((total, row) => total + row.flowCny, 0),
    contributions: withFlow.map((row) => ({ code: row.code, flowCny: row.flowCny, deltaShares: row.deltaShares })),
  };
}

export function sumFlow(rows, { codes, startDate, endDate }) {
  const unique = [...new Set(codes)];
  const dates = [...new Set(rows.map((row) => row.tradeDate))].filter((date) => date >= startDate && date <= endDate).sort();
  const daily = dates.map((tradeDate) => aggregatePool(rows, { codes: unique, tradeDate }));
  const completeDays = daily.filter((day) => day.complete);
  return {
    startDate,
    endDate,
    dates,
    completeDayCount: completeDays.length,
    expectedDayCount: dates.length,
    flowCny: completeDays.length === dates.length && dates.length
      ? completeDays.reduce((total, day) => total + day.flowCny, 0)
      : null,
    partialFlowCny: daily.reduce((total, day) => total + (day.partialFlowCny || 0), 0),
    daily,
  };
}

export function disclosureUsableOn(disclosure, asOfDate) {
  if (!disclosure?.announcedOn) return false;
  return disclosure.announcedOn <= asOfDate && disclosure.reportEnd <= asOfDate;
}
