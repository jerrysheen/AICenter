function mapDaily(row) {
  if (!row) return null;
  return {
    workspaceId: row.workspace_id,
    tradeDate: row.trade_date,
    channel: row.channel,
    dealAmt: row.deal_amt,
    dealNum: row.deal_num,
    source: row.source,
    checkStatus: row.check_status,
    checkDiffPct: row.check_diff_pct,
    fetchedAt: row.fetched_at,
  };
}

function mapTop(row) {
  if (!row) return null;
  return {
    workspaceId: row.workspace_id,
    tradeDate: row.trade_date,
    channel: row.channel,
    rank: row.rank,
    code: row.code,
    name: row.name,
    dealAmt: row.deal_amt,
    source: row.source,
  };
}

export function createNorthboundRepository(database) {
  const upsertDaily = database.prepare(`INSERT INTO northbound_daily (
      workspace_id, trade_date, channel, deal_amt, deal_num, source, check_status, check_diff_pct, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, trade_date, channel) DO UPDATE SET
      deal_amt = excluded.deal_amt,
      deal_num = excluded.deal_num,
      source = excluded.source,
      check_status = excluded.check_status,
      check_diff_pct = excluded.check_diff_pct,
      fetched_at = excluded.fetched_at`);
  const insertTop = database.prepare(`INSERT INTO northbound_top10 (
      workspace_id, trade_date, channel, rank, code, name, deal_amt, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, trade_date, channel, code) DO UPDATE SET
      rank = excluded.rank,
      name = excluded.name,
      deal_amt = excluded.deal_amt,
      source = excluded.source`);
  const deleteTop = database.prepare(`DELETE FROM northbound_top10
    WHERE workspace_id = ? AND trade_date = ? AND channel = ?`);

  return {
    upsertDaily(workspaceId, rows) {
      return database.transaction(() => {
        let count = 0;
        for (const row of rows || []) {
          if (!row?.tradeDate || !row.channel || row.dealAmt == null) continue;
          upsertDaily.run(
            workspaceId,
            row.tradeDate,
            row.channel,
            row.dealAmt,
            row.dealNum ?? null,
            row.source || 'eastmoney',
            row.checkStatus || 'unchecked',
            row.checkDiffPct ?? null,
            row.fetchedAt,
          );
          count += 1;
        }
        return count;
      })();
    },
    replaceTop10(workspaceId, tradeDate, channel, rows) {
      if (!tradeDate || !channel) return 0;
      return database.transaction(() => {
        deleteTop.run(workspaceId, tradeDate, channel);
        let count = 0;
        for (const row of rows || []) {
          if (!row?.code || row.dealAmt == null) continue;
          insertTop.run(
            workspaceId,
            tradeDate,
            channel,
            row.rank || 0,
            row.code,
            row.name || '',
            row.dealAmt,
            row.source || 'eastmoney',
          );
          count += 1;
        }
        return count;
      })();
    },
    getDaily(workspaceId, tradeDate, channel) {
      return mapDaily(database.prepare(`SELECT * FROM northbound_daily
        WHERE workspace_id = ? AND trade_date = ? AND channel = ?`)
        .get(workspaceId, tradeDate, channel));
    },
    listRecent(workspaceId, limit = 20) {
      const dates = database.prepare(`SELECT trade_date FROM northbound_daily
        WHERE workspace_id = ? AND channel = 'total'
        ORDER BY trade_date DESC LIMIT ?`).all(workspaceId, limit).map((row) => row.trade_date);
      if (!dates.length) return [];
      const marks = dates.map(() => '?').join(',');
      return database.prepare(`SELECT * FROM northbound_daily
        WHERE workspace_id = ? AND trade_date IN (${marks})
        ORDER BY trade_date ASC, channel ASC`).all(workspaceId, ...dates).map(mapDaily);
    },
    latestDate(workspaceId) {
      return database.prepare(`SELECT trade_date FROM northbound_daily
        WHERE workspace_id = ? AND channel = 'total'
        ORDER BY trade_date DESC LIMIT 1`).get(workspaceId)?.trade_date || '';
    },
    listTop10(workspaceId, tradeDate, channel) {
      return database.prepare(`SELECT * FROM northbound_top10
        WHERE workspace_id = ? AND trade_date = ? AND channel = ?
        ORDER BY rank ASC, code ASC`).all(workspaceId, tradeDate, channel).map(mapTop);
    },
  };
}
