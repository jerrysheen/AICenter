import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ValidationError } from '../../contracts/src/errors.js';
import { YI, addDays, aggregatePool, roundDigits, sumFlow, weekdays } from './etf-whale/calculate.js';
import { classifyCalendarDay, lastTradingOnOrBefore, shanghaiToday } from './etf-whale/fetch-policy.js';
import { citicNetShort, citicNetShortChange } from './etf-whale/futures.js';
import { CFFEX_PRODUCTS, ETF_WHALE_INDICES, TURNOVER_SOURCE, citicPartyId } from './etf-whale/indices.js';
import { SCORE_ALGORITHM, ETF_WHALE_DISCLAIMER, median, nameFlag, priorPercentile } from './etf-whale/score.js';
import { indexShapeHit } from './etf-whale/session-shape.js';
import { referencePool, universeByCode } from './etf-whale/universe.js';

export { ETF_WHALE_DISCLAIMER };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function createEtfWhaleReadService({ repository, parityDirectory = '' }) {
  const pool = referencePool();
  const codes = pool.map((item) => item.code);

  function rows() {
    return repository.listDaily().filter((row) => codes.includes(row.code) || row.code === '588000');
  }

  function completeDates(allRows) {
    return [...new Set(allRows.map((row) => row.tradeDate))].sort().filter((tradeDate) => {
      return aggregatePool(allRows, { codes, tradeDate }).complete;
    });
  }

  return {
    overview() {
      const coverage = repository.coverage();
      const allRows = rows();
      const dates = completeDates(allRows);
      const latest = dates.at(-1) || null;
      const freshness = fresh(repository);
      if (!latest) {
        return { ready: false, reason: 'no_complete_day', coverage, report: readReport(parityDirectory), disclaimer: ETF_WHALE_DISCLAIMER, ...freshness };
      }
      const groups = [...new Set(pool.map((item) => item.groupKey))].map((groupKey) => {
        const grouped = aggregatePool(allRows, {
          codes: pool.filter((item) => item.groupKey === groupKey).map((item) => item.code),
          tradeDate: latest,
          groupKey,
        });
        return presentGroup(grouped);
      });
      const total = presentGroup(aggregatePool(allRows, { codes, tradeDate: latest, groupKey: '20只宽基' }));
      const start = dates[Math.max(0, dates.length - 5)];
      const week = sumFlow(allRows, { codes, startDate: start, endDate: latest });
      return {
        ready: true,
        algorithm: 'etf-whale-qfq-typical-v1',
        latest,
        completeDays: dates.length,
        pool: total,
        recentFlowYi: week.flowCny == null ? null : roundDigits(week.flowCny / YI, 4),
        recentStart: start,
        recentComplete: week.completeDayCount === week.dates.length,
        groups,
        coverage,
        report: readReport(parityDirectory),
        disclaimer: ETF_WHALE_DISCLAIMER,
        ...freshness,
      };
    },

    series(code) {
      const resolved = resolveCode(code);
      if (!resolved) return null;
      const selected = rows().filter((row) => row.code === resolved);
      return {
        code: resolved,
        inPool: codes.includes(resolved),
        disclaimer: ETF_WHALE_DISCLAIMER,
        points: selected.filter((row) => row.rawShares != null).slice(-180).map((row) => ({
          tradeDate: row.tradeDate,
          sharesYi: row.sharesYi,
          deltaYi: row.deltaYi,
          flowYi: row.flowYi == null ? null : roundDigits(row.flowYi, 4),
          closePrice: row.closePrice,
          reason: row.reason,
        })),
      };
    },

    daily(date) {
      if (date && !DATE.test(date)) throw new ValidationError('date 需要 YYYY-MM-DD', ['date']);
      const tradeDate = date || repository.latestQuoteDate() || repository.latestShareDate();
      return presentDaily(repository, pool, tradeDate);
    },

    signals(query = {}) {
      const range = signalRange(repository, query);
      const rows = range.start ? repository.listSignals(range.start, range.end, SCORE_ALGORITHM) : [];
      const byDate = new Map();
      for (const row of rows) {
        if (!byDate.has(row.trade_date)) byDate.set(row.trade_date, {});
        byDate.get(row.trade_date)[row.stage] = presentSignal(row);
      }
      return {
        start: range.start,
        end: range.end,
        disclaimer: ETF_WHALE_DISCLAIMER,
        days: [...byDate.entries()].map(([tradeDate, stages]) => ({ tradeDate, ...stages })),
      };
    },
  };
}

function resolveCode(code) {
  const text = String(code ?? '').trim();
  if (!text) throw new ValidationError('缺少 code', ['code']);
  if (!/^\d{6}$/.test(text)) throw new ValidationError('代码需要 6 位数字', ['code']);
  if (!universeByCode().has(text)) return null;
  return text;
}

function fresh(repository) {
  return {
    sharesLatest: repository.latestShareDate(),
    quotesLatest: repository.latestQuoteDate(),
    pendingDates: repository.listFetchDates('sse', 'pending'),
  };
}

function signalRange(repository, query) {
  const start = query.start ? String(query.start) : '';
  const end = query.end ? String(query.end) : '';
  if (start && !DATE.test(start)) throw new ValidationError('start 需要 YYYY-MM-DD', ['start']);
  if (end && !DATE.test(end)) throw new ValidationError('end 需要 YYYY-MM-DD', ['end']);
  if ((start && !end) || (!start && end)) throw new ValidationError('start 和 end 需要同时给出', ['start']);
  if (start && end && start > end) throw new ValidationError('start 不能晚于 end', ['start']);
  if (start && end) {
    const span = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;
    if (span > 250) throw new ValidationError('区间不能超过 250 天', ['end']);
    return { start, end };
  }
  const dates = repository.listQuoteDates('510300');
  const today = shanghaiToday();
  const trading = dates.length ? dates : weekdays(addDays(today, -40), today)
    .filter((date) => classifyCalendarDay(date) === 'trading');
  const selected = trading.slice(-20);
  return { start: selected[0] || null, end: selected.at(-1) || null };
}

function presentSignal(row) {
  const inputs = JSON.parse(row.inputs_json || '{}');
  return {
    score: row.score,
    maxScore: row.max_score,
    scaled: inputs.scaled ?? null,
    sTurnover: row.s_turnover,
    sFlow: row.s_flow,
    sBreadth: row.s_breadth,
    sIndex: row.s_index,
    level: row.level,
    algorithm: row.algorithm,
    insufficient: Array.isArray(inputs.insufficient) ? inputs.insufficient : [],
  };
}

function presentDaily(repository, pool, tradeDate) {
  if (!tradeDate) {
    return {
      tradeDate: null,
      sharesStatus: 'pending',
      disclaimer: ETF_WHALE_DISCLAIMER,
      pool: null,
      etfs: [],
      indices: [],
      futures: emptyFutures(),
    };
  }
  const codes = pool.map((item) => item.code);
  const watched = [...pool, ...universeByCode().values()].filter((item, index, list) => list.findIndex((other) => other.code === item.code) === index);
  const historyStart = addDays(tradeDate, -420);
  const turnover = repository.listTurnover(watched.map((item) => item.code), TURNOVER_SOURCE, historyStart, tradeDate);
  const quotes = repository.listQuotes(watched.map((item) => item.code)).filter((row) => row.trade_date <= tradeDate);
  const dailyRows = repository.listDaily().filter((row) => watched.some((item) => item.code === row.code) && row.tradeDate <= tradeDate);
  const confirmed = repository.listSignals(tradeDate, tradeDate, SCORE_ALGORITHM).some((row) => row.stage === 'confirmed');
  const etfs = watched.map((item) => {
    const amounts = turnover.filter((row) => row.code === item.code && row.trade_date < tradeDate).map((row) => row.amount_cny);
    const todayAmount = turnover.find((row) => row.code === item.code && row.trade_date === tradeDate);
    const base = median(amounts.slice(-20));
    const multiple = base > 0 && todayAmount ? todayAmount.amount_cny / base : null;
    const ownDaily = dailyRows.filter((row) => row.code === item.code);
    const todayDaily = ownDaily.find((row) => row.tradeDate === tradeDate);
    const sharePercentile = priorPercentile(
      ownDaily.filter((row) => row.tradeDate < tradeDate && Number.isFinite(row.deltaShares)).map((row) => row.deltaShares),
      todayDaily?.deltaShares,
    );
    const quote = quotes.find((row) => row.code === item.code && row.trade_date === tradeDate);
    return {
      code: item.code,
      name: item.name,
      referencePool: item.referencePool,
      close: quote?.close ?? todayAmount?.close ?? null,
      amountCny: todayAmount?.amount_cny ?? null,
      amountMultiple: multiple,
      amountPercentile: priorPercentile(amounts, todayAmount?.amount_cny),
      deltaShares: todayDaily?.deltaShares ?? null,
      flowCny: todayDaily?.flowCny ?? null,
      flowPercentile: priorPercentile(
        ownDaily.filter((row) => row.tradeDate < tradeDate && Number.isFinite(row.flowCny)).map((row) => row.flowCny),
        todayDaily?.flowCny,
      ),
      flag: nameFlag(multiple, sharePercentile, confirmed),
    };
  });
  const poolRows = etfs.filter((item) => item.referencePool);
  const poolAmounts = poolRows.map((item) => item.amountCny);
  const poolComplete = poolAmounts.length === poolRows.length && poolAmounts.every(Number.isFinite);
  const indexRows = repository.listIndexDaily(tradeDate, tradeDate);
  const sse = repository.getFetch('sse', tradeDate, tradeDate);
  return {
    tradeDate,
    sharesStatus: sse?.status === 'ok' ? 'ok' : 'pending',
    disclaimer: ETF_WHALE_DISCLAIMER,
    pool: {
      amountCny: poolComplete ? poolAmounts.reduce((total, value) => total + value, 0) : null,
      abnormalCount: poolRows.filter((item) => item.flag).length,
      redCount: poolRows.filter((item) => item.flag === 'red').length,
    },
    etfs,
    indices: ETF_WHALE_INDICES.map((item) => {
      const row = indexRows.find((entry) => entry.symbol === item.symbol);
      const shape = {
        symbol: item.symbol,
        name: item.name,
        lowDropPct: row?.low_drop_pct ?? null,
        reboundPct: row?.rebound_pct ?? null,
        tailPct: row?.tail_pct ?? null,
      };
      return { ...shape, hit: indexShapeHit(shape) };
    }),
    futures: presentFutures(repository, tradeDate),
  };
}

function presentFutures(repository, tradeDate) {
  const partyId = citicPartyId();
  const today = citicNetShort(repository.listFutures(tradeDate), partyId);
  const previousDate = lastTradingOnOrBefore(addDays(tradeDate, -1));
  const previous = previousDate ? citicNetShort(repository.listFutures(previousDate), partyId) : {};
  const change = citicNetShortChange(today, previous);
  const products = {};
  for (const product of CFFEX_PRODUCTS) {
    products[product] = { netShort: today[product]?.netShort ?? null, change: change[product] };
  }
  return { partyId, displayOnly: true, products };
}

function emptyFutures() {
  return { partyId: citicPartyId(), displayOnly: true, products: {} };
}

function presentGroup(group) {
  return {
    group: group.groupKey,
    expected: group.expected,
    covered: group.flowCovered,
    complete: group.complete,
    inflowCount: group.inflowCount,
    outflowCount: group.outflowCount,
    deltaYi: group.deltaShares == null ? null : roundDigits(group.deltaShares / YI, 4),
    flowYi: group.flowCny == null ? null : roundDigits(group.flowCny / YI, 4),
  };
}

function readReport(directory) {
  if (!directory) return null;
  let names = [];
  try {
    names = readdirSync(directory).sort();
  } catch {
    return null;
  }
  const runId = names.at(-1);
  if (!runId) return null;
  try {
    const summary = JSON.parse(readFileSync(path.join(directory, runId, 'summary.json'), 'utf8'));
    return { runId, headline: summary.answer?.headline || '', shareRate: summary.answer?.shareRate || null, direction: summary.answer?.direction || null };
  } catch {
    return { runId, headline: '', shareRate: null, direction: null };
  }
}
