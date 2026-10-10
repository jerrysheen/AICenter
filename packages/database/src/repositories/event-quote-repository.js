import { ValidationError } from '../../../contracts/src/index.js';

function snapshotRow(value) {
  const symbol = String(value?.symbol || '').trim();
  const probability = String(value?.probability || '').trim();
  const observedAt = Number(value?.observedAt);
  if (!symbol || symbol.length > 512) throw new ValidationError('事件标识不正确', ['symbol']);
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(probability)) throw new ValidationError('事件概率不正确', ['probability']);
  const number = Number(probability);
  if (!Number.isFinite(number) || number < 0 || number > 1) throw new ValidationError('事件概率不正确', ['probability']);
  if (!Number.isInteger(observedAt) || observedAt < 0) throw new ValidationError('快照时间不正确', ['observedAt']);
  return { symbol, probability, observedAt };
}

function mapSnapshot(row) {
  return { symbol: row.symbol, probability: row.probability, observedAt: row.observed_at };
}

export function createEventQuoteRepository(database, emitEvent) {
  const upsert = database.prepare(`INSERT INTO event_quote_snapshots (symbol, probability, observed_at)
    VALUES (?, ?, ?)
    ON CONFLICT(symbol, observed_at) DO UPDATE SET probability = excluded.probability`);
  const listBetween = database.prepare(`SELECT symbol, probability, observed_at
    FROM event_quote_snapshots
    WHERE observed_at >= ? AND observed_at <= ?
    ORDER BY symbol ASC, observed_at ASC`);

  return {
    saveEventQuoteSnapshots(rows) {
      const snapshots = (rows || []).map(snapshotRow);
      if (!snapshots.length) return 0;
      const observedAt = snapshots[0].observedAt;
      database.transaction(() => {
        for (const row of snapshots) upsert.run(row.symbol, row.probability, row.observedAt);
        emitEvent('market.event-quote.snapshot.saved.v1', 'event-quote-snapshot', String(observedAt), {
          observedAt,
          count: snapshots.length,
        });
      })();
      return snapshots.length;
    },

    listEventQuoteSnapshotsBetween(from, to) {
      const start = Number(from);
      const end = Number(to);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) return [];
      return listBetween.all(start, end).map(mapSnapshot);
    },
  };
}
