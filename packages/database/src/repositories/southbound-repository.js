function mapDaily(row) {
  if (!row) return null;
  return {
    workspaceId: row.workspace_id,
    tradeDate: row.trade_date,
    channel: row.channel,
    buyAmt: row.buy_amt,
    sellAmt: row.sell_amt,
    netAmt: row.net_amt,
    dealAmt: row.deal_amt,
    dealNum: row.deal_num,
    indexClose: row.index_close,
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
    buyAmt: row.buy_amt,
    sellAmt: row.sell_amt,
    netAmt: row.net_amt,
    dealAmt: row.deal_amt,
    close: row.close,
    chgPct: row.chg_pct,
    source: row.source,
  };
}

export function createSouthboundRepository(database) {
  const upsertDaily = database.prepare(`INSERT INTO southbound_daily (
      workspace_id, trade_date, channel, buy_amt, sell_amt, net_amt, deal_amt, deal_num,
      index_close, source, check_status, check_diff_pct, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, trade_date, channel) DO UPDATE SET
      buy_amt = excluded.buy_amt,
      sell_amt = excluded.sell_amt,
      net_amt = excluded.net_amt,
      deal_amt = excluded.deal_amt,
      deal_num = excluded.deal_num,
      index_close = excluded.index_close,
      source = excluded.source,
      check_status = excluded.check_status,
      check_diff_pct = excluded.check_diff_pct,
      fetched_at = excluded.fetched_at`);
  const insertTop = database.prepare(`INSERT INTO southbound_top10 (
      workspace_id, trade_date, channel, rank, code, name, buy_amt, sell_amt, net_amt,
      deal_amt, close, chg_pct, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, trade_date, channel, code) DO UPDATE SET
      rank = excluded.rank,
      name = excluded.name,
      buy_amt = excluded.buy_amt,
      sell_amt = excluded.sell_amt,
      net_amt = excluded.net_amt,
      deal_amt = excluded.deal_amt,
      close = excluded.close,
      chg_pct = excluded.chg_pct,
      source = excluded.source`);
  const deleteTop = database.prepare(`DELETE FROM southbound_top10
    WHERE workspace_id = ? AND trade_date = ? AND channel = ?`);

  return {
    upsertDaily(workspaceId, rows) {
      const saved = database.transaction(() => {
        let count = 0;
        for (const row of rows || []) {
          if (!row?.tradeDate || !row.channel) continue;
          upsertDaily.run(
            workspaceId,
            row.tradeDate,
            row.channel,
            row.buyAmt ?? null,
            row.sellAmt ?? null,
            row.netAmt ?? null,
            row.dealAmt ?? null,
            row.dealNum ?? null,
            row.indexClose ?? null,
            row.source || 'eastmoney',
            row.checkStatus || 'unchecked',
            row.checkDiffPct ?? null,
            row.fetchedAt,
          );
          count += 1;
        }
        return count;
      })();
      return saved;
    },
    replaceTop10(workspaceId, tradeDate, channel, rows) {
      if (!tradeDate || !channel) return 0;
      return database.transaction(() => {
        deleteTop.run(workspaceId, tradeDate, channel);
        let count = 0;
        for (const row of rows || []) {
          if (!row?.code) continue;
          insertTop.run(
            workspaceId,
            tradeDate,
            channel,
            row.rank || 0,
            row.code,
            row.name || '',
            row.buyAmt ?? null,
            row.sellAmt ?? null,
            row.netAmt ?? null,
            row.dealAmt ?? null,
            row.close ?? null,
            row.chgPct ?? null,
            row.source || 'eastmoney',
          );
          count += 1;
        }
        return count;
      })();
    },
    getDaily(workspaceId, tradeDate, channel) {
      return mapDaily(database.prepare(`SELECT * FROM southbound_daily
        WHERE workspace_id = ? AND trade_date = ? AND channel = ?`)
        .get(workspaceId, tradeDate, channel));
    },
    listRecent(workspaceId, limit = 20) {
      const dates = database.prepare(`SELECT trade_date FROM southbound_daily
        WHERE workspace_id = ? AND channel = 'total'
        ORDER BY trade_date DESC LIMIT ?`).all(workspaceId, limit).map((row) => row.trade_date);
      if (!dates.length) return [];
      const marks = dates.map(() => '?').join(',');
      return database.prepare(`SELECT * FROM southbound_daily
        WHERE workspace_id = ? AND trade_date IN (${marks})
        ORDER BY trade_date ASC, channel ASC`).all(workspaceId, ...dates).map(mapDaily);
    },
    latestDate(workspaceId) {
      return database.prepare(`SELECT MAX(trade_date) AS trade_date FROM southbound_daily
        WHERE workspace_id = ? AND channel = 'total'`).get(workspaceId)?.trade_date || '';
    },
    listTop10(workspaceId, tradeDate, channel = 'total') {
      return database.prepare(`SELECT * FROM southbound_top10
        WHERE workspace_id = ? AND trade_date = ? AND channel = ?
        ORDER BY rank ASC, code ASC`).all(workspaceId, tradeDate, channel).map(mapTop);
    },
    listByCode(workspaceId, code, limit = 20) {
      return database.prepare(`SELECT * FROM southbound_top10
        WHERE workspace_id = ? AND code = ? AND channel = 'total'
        ORDER BY trade_date DESC LIMIT ?`).all(workspaceId, code, limit).map(mapTop);
    },
    countDaily(workspaceId) {
      return database.prepare('SELECT COUNT(*) AS n FROM southbound_daily WHERE workspace_id = ?').get(workspaceId).n;
    },
    countTop10(workspaceId, tradeDate) {
      return database.prepare(`SELECT COUNT(*) AS n FROM southbound_top10
        WHERE workspace_id = ? AND trade_date = ?`).get(workspaceId, tradeDate).n;
    },
  };
}
