const ALGORITHM = 'etf-whale-qfq-typical-v1';

function mapDaily(row) {
  if (!row) return null;
  const payload = JSON.parse(row.payload_json);
  return {
    ...payload,
    code: row.code,
    tradeDate: row.trade_date,
    algorithm: row.algorithm,
    rawShares: row.raw_shares,
    deltaShares: row.delta_shares,
    shareChangePct: row.share_change_pct,
    closePrice: row.close_price,
    typicalPrice: row.typical_price,
    turnoverCny: row.turnover_cny,
    volumeShares: row.volume_shares,
    flowCny: row.flow_cny,
    flowComparable: Boolean(row.comparable),
    reason: row.reason,
    computedAt: row.computed_at,
  };
}

export function createEtfWhaleRepository(database, emitEvent = () => {}) {
  const upsertInstrument = database.prepare(`INSERT INTO etf_whale_instruments
    (code, exchange, name, group_key, reference_pool, source, verified_on, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET
      exchange = excluded.exchange,
      name = excluded.name,
      group_key = excluded.group_key,
      reference_pool = excluded.reference_pool,
      source = excluded.source,
      verified_on = excluded.verified_on,
      updated_at = excluded.updated_at`);
  const upsertFetch = database.prepare(`INSERT INTO etf_whale_fetches
    (source, date_start, date_end, status, row_count, error, blob_path, content_hash, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, date_start, date_end) DO UPDATE SET
      status = excluded.status,
      row_count = excluded.row_count,
      error = excluded.error,
      blob_path = excluded.blob_path,
      content_hash = excluded.content_hash,
      captured_at = excluded.captured_at`);
  const upsertShare = database.prepare(`INSERT INTO etf_whale_shares
    (source, trade_date, code, name, shares, raw_value, raw_unit, blob_path, content_hash, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, trade_date, code) DO UPDATE SET
      name = excluded.name,
      shares = excluded.shares,
      raw_value = excluded.raw_value,
      raw_unit = excluded.raw_unit,
      blob_path = excluded.blob_path,
      content_hash = excluded.content_hash,
      captured_at = excluded.captured_at`);
  const upsertQuote = database.prepare(`INSERT INTO etf_whale_quotes
    (source, code, trade_date, open, high, low, close, volume_lots, volume_shares, typical_price, turnover_cny, adjust, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, code, trade_date, adjust) DO UPDATE SET
      open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close,
      volume_lots = excluded.volume_lots, volume_shares = excluded.volume_shares,
      typical_price = excluded.typical_price, turnover_cny = excluded.turnover_cny,
      captured_at = excluded.captured_at`);
  const upsertAdjustment = database.prepare(`INSERT INTO etf_whale_adjustments
    (code, trade_date, event_type, share_ratio, price_ratio, comparable, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(code, trade_date, event_type) DO UPDATE SET
      share_ratio = excluded.share_ratio,
      price_ratio = excluded.price_ratio,
      comparable = excluded.comparable,
      note = excluded.note`);
  const upsertDaily = database.prepare(`INSERT INTO etf_whale_daily
    (code, trade_date, algorithm, raw_shares, delta_shares, share_change_pct, close_price, typical_price,
     turnover_cny, volume_shares, flow_cny, comparable, reason, payload_json, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(code, trade_date, algorithm) DO UPDATE SET
      raw_shares = excluded.raw_shares, delta_shares = excluded.delta_shares,
      share_change_pct = excluded.share_change_pct, close_price = excluded.close_price,
      typical_price = excluded.typical_price, turnover_cny = excluded.turnover_cny,
      volume_shares = excluded.volume_shares, flow_cny = excluded.flow_cny,
      comparable = excluded.comparable, reason = excluded.reason,
      payload_json = excluded.payload_json, computed_at = excluded.computed_at`);
  const upsertDisclosure = database.prepare(`INSERT INTO etf_whale_disclosures
    (code, source, report_end, announced_on, captured_on, ratio_pct, value_cny, total_shares)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(code, source, report_end) DO UPDATE SET
      announced_on = excluded.announced_on,
      captured_on = excluded.captured_on,
      ratio_pct = excluded.ratio_pct,
      value_cny = excluded.value_cny,
      total_shares = excluded.total_shares`);

  return {
    replaceInstruments(items, now = Date.now()) {
      const write = database.transaction(() => {
        for (const item of items) {
          upsertInstrument.run(item.code, item.exchange, item.name, item.groupKey, item.referencePool ? 1 : 0, item.source, item.verifiedOn, now);
        }
      });
      write();
      return items.length;
    },

    getFetch(source, dateStart, dateEnd) {
      return database.prepare('SELECT * FROM etf_whale_fetches WHERE source = ? AND date_start = ? AND date_end = ?')
        .get(source, dateStart, dateEnd) || null;
    },

    saveFetch(entry) {
      upsertFetch.run(entry.source, entry.dateStart, entry.dateEnd, entry.status, entry.rowCount, entry.error || '', entry.blobPath || '', entry.contentHash || '', entry.capturedAt || Date.now());
    },

    saveShares(rows, meta) {
      const write = database.transaction(() => {
        for (const row of rows) {
          upsertShare.run(row.source, row.tradeDate, row.code, row.name, row.shares, row.rawValue, row.rawUnit, meta.blobPath, meta.contentHash, meta.capturedAt);
        }
        upsertFetch.run(meta.source, meta.dateStart, meta.dateEnd, meta.status, rows.length, meta.error || '', meta.blobPath, meta.contentHash, meta.capturedAt);
        emitEvent('etf.whale.shares.saved.v1', 'etf-whale-fetch', `${meta.source}:${meta.dateStart}`, {
          source: meta.source, dateStart: meta.dateStart, dateEnd: meta.dateEnd, rowCount: rows.length,
        });
      });
      write();
      return rows.length;
    },

    saveQuotes(rows, meta) {
      const write = database.transaction(() => {
        for (const row of rows) upsertQuote.run(row.source, row.code, row.tradeDate, row.open, row.high, row.low, row.close, row.volumeLots, row.volumeShares, row.typicalPrice, row.turnoverCny, row.adjust, meta.capturedAt);
      });
      write();
      return rows.length;
    },

    saveAdjustments(rows) {
      const write = database.transaction(() => {
        for (const row of rows) upsertAdjustment.run(row.code, row.tradeDate, row.eventType, row.shareRatio, row.priceRatio, row.comparable ? 1 : 0, row.note);
      });
      write();
    },

    saveDaily(rows, now = Date.now()) {
      const write = database.transaction(() => {
        for (const row of rows) {
          upsertDaily.run(
            row.code, row.tradeDate, row.algorithm || ALGORITHM, row.rawShares, row.deltaShares, row.shareChangePct,
            row.closePrice, row.typicalPrice, row.turnoverCny, row.volumeShares, row.flowCny,
            row.flowComparable ? 1 : 0, row.reason || '', JSON.stringify(row), now,
          );
        }
        emitEvent('etf.whale.daily.computed.v1', 'etf-whale-daily', ALGORITHM, { rowCount: rows.length, algorithm: ALGORITHM });
      });
      write();
      return rows.length;
    },

    saveDisclosures(rows) {
      const write = database.transaction(() => {
        for (const row of rows) {
          upsertDisclosure.run(row.code, row.source, row.reportEnd, row.announcedOn || null, row.capturedOn, row.ratioPct, row.valueCny, row.totalShares);
        }
      });
      write();
    },

    listShares(codes, source) {
      if (!codes.length) return [];
      const marks = codes.map(() => '?').join(',');
      return database.prepare(`SELECT * FROM etf_whale_shares WHERE source = ? AND code IN (${marks}) ORDER BY trade_date, code`)
        .all(source, ...codes);
    },

    listQuotes(codes) {
      if (!codes.length) return [];
      const marks = codes.map(() => '?').join(',');
      return database.prepare(`SELECT * FROM etf_whale_quotes WHERE adjust = 'qfq' AND code IN (${marks}) ORDER BY trade_date, code`)
        .all(...codes);
    },

    listDaily(algorithm = ALGORITHM) {
      return database.prepare('SELECT * FROM etf_whale_daily WHERE algorithm = ? ORDER BY trade_date, code').all(algorithm).map(mapDaily);
    },

    listDailyForDate(tradeDate, algorithm = ALGORITHM) {
      return database.prepare('SELECT * FROM etf_whale_daily WHERE algorithm = ? AND trade_date = ? ORDER BY code').all(algorithm, tradeDate).map(mapDaily);
    },

    coverage() {
      const shares = database.prepare(`SELECT source, COUNT(DISTINCT trade_date) AS days, COUNT(DISTINCT code) AS codes, MIN(trade_date) AS start_date, MAX(trade_date) AS end_date, COUNT(*) AS rows
        FROM etf_whale_shares GROUP BY source`).all();
      const quotes = database.prepare(`SELECT COUNT(DISTINCT trade_date) AS days, COUNT(DISTINCT code) AS codes, MIN(trade_date) AS start_date, MAX(trade_date) AS end_date
        FROM etf_whale_quotes`).get();
      const fetches = database.prepare(`SELECT source, status, COUNT(*) AS runs FROM etf_whale_fetches GROUP BY source, status`).all();
      return { shares, quotes, fetches };
    },
  };
}
