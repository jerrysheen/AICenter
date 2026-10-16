import { MarketNativeBoardSchema, parseContract, ValidationError } from '../../contracts/src/index.js';

export const EVENT_QUOTE_HOUR_MS = 3_600_000;
export const EVENT_QUOTE_DAY_MS = 24 * EVENT_QUOTE_HOUR_MS;
// 约 24 小时：只接受目标时刻前后 3 小时内的快照，避免把几小时前的报价标成较昨日。
export const EVENT_QUOTE_24H_WINDOW_MS = 3 * EVENT_QUOTE_HOUR_MS;

export function probabilityString(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized)) return null;
  const number = Number(normalized);
  if (!Number.isFinite(number) || number < 0 || number > 1) return null;
  return normalized;
}

export function eventQuoteSnapshotHour(now) {
  const value = Number(now);
  if (!Number.isFinite(value) || value < 0) throw new ValidationError('快照时间不正确', ['observedAt']);
  return Math.floor(value / EVENT_QUOTE_HOUR_MS) * EVENT_QUOTE_HOUR_MS;
}

export function snapshotRowsFromQuotes(quotes, observedAt) {
  const at = eventQuoteSnapshotHour(observedAt);
  const bySymbol = new Map();
  for (const quote of quotes || []) {
    const symbol = String(quote?.quoteId || '').trim();
    const probability = probabilityString(quote?.midPrice == null ? null : String(quote.midPrice));
    if (!symbol || symbol.length > 512 || !probability) continue;
    bySymbol.set(symbol, probability);
  }
  return [...bySymbol.entries()].map(([symbol, probability]) => ({ symbol, probability, observedAt: at }));
}

export function selectProbability24hAgo(rows, now) {
  const moment = Number(now);
  if (!Number.isFinite(moment)) return null;
  const target = moment - EVENT_QUOTE_DAY_MS;
  const min = target - EVENT_QUOTE_24H_WINDOW_MS;
  const max = target + EVENT_QUOTE_24H_WINDOW_MS;
  let best = null;
  for (const row of rows || []) {
    const at = Number(row?.observedAt);
    const probability = probabilityString(row?.probability);
    if (!probability || !Number.isFinite(at) || at < min || at > max) continue;
    if (!best) {
      best = { at, probability };
      continue;
    }
    const distance = Math.abs(at - target);
    const bestDistance = Math.abs(best.at - target);
    const closer = distance < bestDistance;
    const tiePreferEarlier = distance === bestDistance && at <= target && best.at > target;
    if (closer || tiePreferEarlier) best = { at, probability };
  }
  return best ? best.probability : null;
}

export function withPriorPrices(board, rows, now) {
  const grouped = new Map();
  for (const row of rows || []) {
    const list = grouped.get(row.symbol) || [];
    list.push(row);
    grouped.set(row.symbol, list);
  }
  const parsed = parseContract(MarketNativeBoardSchema, {
    ...board,
    predictionMarkets: (board.predictionMarkets || []).map((quote) => {
      if (quote.midPrice24hAgo) return quote;
      const probability = selectProbability24hAgo(grouped.get(quote.quoteId) || [], now);
      if (probability == null) return quote;
      return { ...quote, midPrice24hAgo: probability };
    }),
  });
  return {
    ...parsed,
    predictionMarkets: parsed.predictionMarkets.map((quote) => {
      if (quote.midPrice24hAgo == null) {
        const { midPrice24hAgo, ...rest } = quote;
        return rest;
      }
      return quote;
    }),
  };
}

export function createEventQuoteSnapshotService({ repository, now = () => Date.now() }) {
  if (!repository?.saveEventQuoteSnapshots || !repository?.listEventQuoteSnapshotsBetween) {
    throw new Error('event quote snapshots require a repository');
  }
  return {
    saveSnapshots(quotes, at = now()) {
      const rows = snapshotRowsFromQuotes(quotes, at);
      const count = repository.saveEventQuoteSnapshots(rows);
      return { observedAt: rows[0]?.observedAt ?? eventQuoteSnapshotHour(at), count };
    },

    attachPriorPrices(board, at = now()) {
      const moment = Number(at);
      const target = moment - EVENT_QUOTE_DAY_MS;
      const rows = repository.listEventQuoteSnapshotsBetween(
        Math.trunc(target - EVENT_QUOTE_24H_WINDOW_MS),
        Math.trunc(target + EVENT_QUOTE_24H_WINDOW_MS),
      );
      return withPriorPrices(board, rows, moment);
    },
  };
}
