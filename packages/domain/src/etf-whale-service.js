import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { YI, aggregatePool, roundDigits, sumFlow } from './etf-whale/calculate.js';
import { referencePool } from './etf-whale/universe.js';

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
      if (!latest) {
        return { ready: false, reason: 'no_complete_day', coverage, report: readReport(parityDirectory) };
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
      };
    },

    series(code) {
      const selected = rows().filter((row) => row.code === code);
      return {
        code,
        inPool: codes.includes(code),
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
  };
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
