const ALGORITHM = 'etf-whale-qfq-typical-v1';

function insufficientKeys(inputsJson) {
  try {
    const inputs = JSON.parse(inputsJson || '{}');
    return new Set(Array.isArray(inputs.insufficient) ? inputs.insufficient : []);
  } catch {
    return new Set();
  }
}

function storedScore(value, missing) {
  if (missing || value == null || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

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
  const upsertIntraday = database.prepare(`INSERT INTO etf_whale_intraday_bars
    (source, symbol, kind, interval_key, bar_time, trade_date, open, high, low, close, volume, amount_cny, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, symbol, interval_key, bar_time) DO UPDATE SET
      kind = excluded.kind, trade_date = excluded.trade_date,
      open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close,
      volume = excluded.volume, amount_cny = excluded.amount_cny, captured_at = excluded.captured_at`);
  const upsertIndexDaily = database.prepare(`INSERT INTO etf_whale_index_daily
    (symbol, trade_date, prev_close, open, high, low, close, amount_cny, low_time, low_drop_pct, rebound_pct, tail_pct, source, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, trade_date) DO UPDATE SET
      prev_close = excluded.prev_close, open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close,
      amount_cny = excluded.amount_cny, low_time = excluded.low_time, low_drop_pct = excluded.low_drop_pct,
      rebound_pct = excluded.rebound_pct, tail_pct = excluded.tail_pct, source = excluded.source, computed_at = excluded.computed_at`);
  const upsertTurnover = database.prepare(`INSERT INTO etf_whale_turnover
    (source, code, trade_date, amount_cny, volume_shares, close, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, code, trade_date) DO UPDATE SET
      amount_cny = excluded.amount_cny, volume_shares = excluded.volume_shares,
      close = excluded.close, captured_at = excluded.captured_at`);
  const upsertFutures = database.prepare(`INSERT INTO etf_whale_futures_rank
    (trade_date, product, contract, data_type, rank, party_id, member, volume, var_volume, source_url, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(trade_date, contract, data_type, rank) DO UPDATE SET
      product = excluded.product, party_id = excluded.party_id, member = excluded.member,
      volume = excluded.volume, var_volume = excluded.var_volume, source_url = excluded.source_url,
      captured_at = excluded.captured_at`);
  const upsertSignal = database.prepare(`INSERT INTO etf_whale_signals
    (trade_date, stage, algorithm, score, max_score, s_turnover, s_flow, s_breadth, s_index, level, inputs_json, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(trade_date, stage, algorithm) DO UPDATE SET
      score = excluded.score, max_score = excluded.max_score, s_turnover = excluded.s_turnover,
      s_flow = excluded.s_flow, s_breadth = excluded.s_breadth, s_index = excluded.s_index,
      level = excluded.level, inputs_json = excluded.inputs_json, computed_at = excluded.computed_at`);
  const supersedeStack = database.prepare(`UPDATE etf_whale_fetches
    SET status = 'superseded'
    WHERE source = 'szse-xlsx' AND status = 'error'
      AND (error LIKE '%Maximum call stack%' OR error LIKE '%call stack size%')`);
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

    listFetchDates(source, status) {
      return database.prepare(`SELECT date_start FROM etf_whale_fetches
        WHERE source = ? AND status = ? ORDER BY date_start`).all(source, status).map((row) => row.date_start);
    },

    maxShareDate(source, dateStart, dateEnd) {
      const row = database.prepare(`SELECT MAX(trade_date) AS trade_date FROM etf_whale_shares
        WHERE source = ? AND trade_date >= ? AND trade_date <= ?`).get(source, dateStart, dateEnd);
      return row?.trade_date || null;
    },

    hasShareOn(source, tradeDate) {
      return Boolean(database.prepare(`SELECT 1 AS ok FROM etf_whale_shares
        WHERE source = ? AND trade_date = ? LIMIT 1`).get(source, tradeDate));
    },

    listQuoteDates(code) {
      return database.prepare(`SELECT trade_date FROM etf_whale_quotes
        WHERE code = ? AND adjust = 'qfq' ORDER BY trade_date`).all(code).map((row) => row.trade_date);
    },

    supersedeStackOverflowFetches() {
      return supersedeStack.run().changes;
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

    saveIntradayBars(rows, capturedAt = Date.now()) {
      const write = database.transaction(() => {
        for (const row of rows) {
          upsertIntraday.run(
            row.source, row.symbol, row.kind, row.intervalKey || '5m', row.barTime, row.tradeDate,
            row.open, row.high, row.low, row.close, row.volume, row.amountCny, row.capturedAt || capturedAt,
          );
        }
      });
      write();
      return rows.length;
    },

    listIntradayBars(symbol, tradeDate, intervalKey = '5m') {
      return database.prepare(`SELECT * FROM etf_whale_intraday_bars
        WHERE symbol = ? AND trade_date = ? AND interval_key = ? ORDER BY bar_time`).all(symbol, tradeDate, intervalKey);
    },

    listIntradayDays(startDate, endDate, intervalKey = '5m') {
      return database.prepare(`SELECT symbol, trade_date FROM etf_whale_intraday_bars
        WHERE interval_key = ? AND trade_date >= ? AND trade_date <= ?
        GROUP BY symbol, trade_date`).all(intervalKey, startDate, endDate);
    },

    saveIndexDaily(rows, computedAt = Date.now()) {
      const write = database.transaction(() => {
        for (const row of rows) {
          upsertIndexDaily.run(
            row.symbol, row.tradeDate, row.prevClose, row.open, row.high, row.low, row.close, row.amountCny,
            row.lowTime, row.lowDropPct, row.reboundPct, row.tailPct, row.source, row.computedAt || computedAt,
          );
        }
      });
      write();
      return rows.length;
    },

    indexCloseBefore(symbol, tradeDate) {
      const row = database.prepare(`SELECT close FROM etf_whale_index_daily
        WHERE symbol = ? AND trade_date < ? ORDER BY trade_date DESC LIMIT 1`).get(symbol, tradeDate);
      return row ? row.close : null;
    },

    listIndexDaily(startDate, endDate) {
      return database.prepare(`SELECT * FROM etf_whale_index_daily
        WHERE trade_date >= ? AND trade_date <= ? ORDER BY trade_date, symbol`).all(startDate, endDate);
    },

    saveTurnover(rows, capturedAt = Date.now()) {
      const write = database.transaction(() => {
        for (const row of rows) {
          upsertTurnover.run(row.source, row.code, row.tradeDate, row.amountCny, row.volumeShares, row.close, row.capturedAt || capturedAt);
        }
      });
      write();
      return rows.length;
    },

    listTurnover(codes, source, startDate, endDate) {
      if (!codes?.length) return [];
      const marks = codes.map(() => '?').join(',');
      return database.prepare(`SELECT * FROM etf_whale_turnover
        WHERE source = ? AND trade_date >= ? AND trade_date <= ? AND code IN (${marks})
        ORDER BY trade_date, code`).all(source, startDate, endDate, ...codes);
    },

    saveFuturesRanks(rows, capturedAt = Date.now()) {
      const write = database.transaction(() => {
        for (const row of rows) {
          upsertFutures.run(
            row.tradeDate, row.product, row.contract, row.dataType, row.rank, row.partyId, row.member,
            row.volume, row.varVolume, row.sourceUrl, row.capturedAt || capturedAt,
          );
        }
      });
      write();
      return rows.length;
    },

    hasFutures(tradeDate, product) {
      return Boolean(database.prepare(`SELECT 1 AS ok FROM etf_whale_futures_rank
        WHERE trade_date = ? AND product = ? LIMIT 1`).get(tradeDate, product));
    },

    listFutures(tradeDate) {
      return database.prepare(`SELECT * FROM etf_whale_futures_rank
        WHERE trade_date = ? ORDER BY product, data_type, rank`).all(tradeDate);
    },

    saveSignal(row, computedAt = Date.now()) {
      const missing = insufficientKeys(row.inputsJson);
      upsertSignal.run(
        row.tradeDate, row.stage, row.algorithm, storedScore(row.score, false), row.maxScore,
        storedScore(row.sTurnover, missing.has('turnover')), storedScore(row.sFlow, false),
        storedScore(row.sBreadth, false), storedScore(row.sIndex, missing.has('index')),
        row.level, row.inputsJson, row.computedAt || computedAt,
      );
    },

    listSignals(startDate, endDate, algorithm) {
      return database.prepare(`SELECT * FROM etf_whale_signals
        WHERE trade_date >= ? AND trade_date <= ? AND algorithm = ?
        ORDER BY trade_date, stage`).all(startDate, endDate, algorithm);
    },

    latestShareDate() {
      const row = database.prepare('SELECT MAX(trade_date) AS trade_date FROM etf_whale_shares').get();
      return row?.trade_date || null;
    },

    latestQuoteDate() {
      const quotes = database.prepare(`SELECT MAX(trade_date) AS trade_date FROM etf_whale_quotes`).get()?.trade_date || null;
      const turnover = database.prepare(`SELECT MAX(trade_date) AS trade_date FROM etf_whale_turnover`).get()?.trade_date || null;
      const indexDaily = database.prepare(`SELECT MAX(trade_date) AS trade_date FROM etf_whale_index_daily`).get()?.trade_date || null;
      return [quotes, turnover, indexDaily].filter(Boolean).sort().at(-1) || null;
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
