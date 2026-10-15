import { addDays, weekdays } from '../../domain/src/etf-whale/calculate.js';
import { classifyCalendarDay } from '../../domain/src/etf-whale/fetch-policy.js';
import { ETF_WHALE_INDICES, TURNOVER_SOURCE } from '../../domain/src/etf-whale/indices.js';
import { SCORE_ALGORITHM, median, priorPercentile, scoreGjdV1 } from '../../domain/src/etf-whale/score.js';
import { referencePool } from '../../domain/src/etf-whale/universe.js';

const CODES = () => referencePool().map((item) => item.code);

function groupAmounts(rows) {
  const byCode = new Map();
  for (const row of rows) {
    if (!byCode.has(row.code)) byCode.set(row.code, []);
    byCode.get(row.code).push({ tradeDate: row.trade_date, amount: row.amount_cny });
  }
  for (const list of byCode.values()) list.sort((left, right) => left.tradeDate.localeCompare(right.tradeDate));
  return byCode;
}

function poolSumOn(byCode, codes, tradeDate) {
  let sum = 0;
  for (const code of codes) {
    const row = (byCode.get(code) || []).find((item) => item.tradeDate === tradeDate);
    if (!row || !Number.isFinite(row.amount)) return null;
    sum += row.amount;
  }
  return codes.length ? sum : null;
}

function completePoolHistory(byCode, codes, tradeDate) {
  const dates = new Set();
  for (const code of codes) {
    for (const row of byCode.get(code) || []) {
      if (row.tradeDate < tradeDate) dates.add(row.tradeDate);
    }
  }
  return [...dates].sort().filter((date) => codes.every((code) => {
    const row = (byCode.get(code) || []).find((item) => item.tradeDate === date);
    return row && Number.isFinite(row.amount);
  })).map((date) => poolSumOn(byCode, codes, date));
}

export function scoreTradeDate(repository, tradeDate, stage, cache = null) {
  const codes = CODES();
  const amounts = cache?.amounts || groupAmounts(repository.listTurnover(codes, TURNOVER_SOURCE, addDays(tradeDate, -420), tradeDate));
  const names = codes.map((code) => {
    const series = (amounts.get(code) || []).filter((row) => row.tradeDate < tradeDate).map((row) => row.amount);
    const today = (amounts.get(code) || []).find((row) => row.tradeDate === tradeDate)?.amount ?? null;
    const base = median(series.slice(-20));
    return {
      code,
      multiple: base > 0 && Number.isFinite(today) ? today / base : null,
      sharePercentile: null,
    };
  });
  let flowToday = null;
  let flowHistory = [];
  if (stage === 'confirmed') {
    const daily = cache?.daily || repository.listDaily().filter((row) => codes.includes(row.code));
    const byDate = new Map();
    for (const row of daily) {
      if (!byDate.has(row.tradeDate)) byDate.set(row.tradeDate, []);
      byDate.get(row.tradeDate).push(row);
    }
    const dated = [...byDate.keys()].sort();
    flowHistory = dated.filter((date) => date < tradeDate).map((date) => {
      const rows = byDate.get(date);
      if (rows.length !== codes.length || rows.some((row) => !Number.isFinite(row.flowCny))) return null;
      return rows.reduce((total, row) => total + row.flowCny, 0);
    }).filter(Number.isFinite);
    const todayRows = byDate.get(tradeDate) || [];
    if (todayRows.length === codes.length && todayRows.every((row) => Number.isFinite(row.flowCny))) {
      flowToday = todayRows.reduce((total, row) => total + row.flowCny, 0);
    }
    for (const item of names) {
      const own = daily.filter((row) => row.code === item.code && row.tradeDate < tradeDate && Number.isFinite(row.deltaShares))
        .map((row) => row.deltaShares);
      const current = todayRows.find((row) => row.code === item.code);
      item.sharePercentile = priorPercentile(own, current?.deltaShares);
    }
  }
  const indexRows = (cache?.indexRows || repository.listIndexDaily(tradeDate, tradeDate))
    .filter((row) => row.trade_date === tradeDate);
  const indices = ETF_WHALE_INDICES.map((item) => {
    const row = indexRows.find((entry) => entry.symbol === item.symbol);
    return {
      symbol: item.symbol,
      lowDropPct: row?.low_drop_pct,
      reboundPct: row?.rebound_pct,
      tailPct: row?.tail_pct,
    };
  });
  const scored = scoreGjdV1({
    stage,
    poolSumToday: poolSumOn(amounts, codes, tradeDate),
    poolHistory: completePoolHistory(amounts, codes, tradeDate),
    names,
    indices,
    flowToday,
    flowHistory,
  });
  return {
    tradeDate,
    stage: scored.stage,
    algorithm: SCORE_ALGORITHM,
    score: scored.score,
    maxScore: scored.maxScore,
    sTurnover: scored.sTurnover,
    sFlow: scored.sFlow,
    sBreadth: scored.sBreadth,
    sIndex: scored.sIndex,
    level: scored.level,
    inputsJson: JSON.stringify({
      scaled: scored.scaled,
      turnover: scored.turnover,
      breadth: { count: scored.breadth.count, hasRed: scored.breadth.hasRed },
      index: scored.index,
      flow: scored.flow,
      futuresScored: false,
    }),
  };
}

export function refreshEtfWhaleSignals(repository, { startDate, endDate, stage }) {
  const dates = weekdays(startDate, endDate).filter((date) => classifyCalendarDay(date) === 'trading');
  if (!dates.length) return 0;
  const codes = CODES();
  const cache = {
    amounts: groupAmounts(repository.listTurnover(codes, TURNOVER_SOURCE, addDays(dates[0], -420), endDate)),
    daily: stage === 'confirmed' ? repository.listDaily().filter((row) => codes.includes(row.code)) : [],
    indexRows: repository.listIndexDaily(dates[0], endDate),
  };
  for (const tradeDate of dates) repository.saveSignal(scoreTradeDate(repository, tradeDate, stage, cache));
  return dates.length;
}
