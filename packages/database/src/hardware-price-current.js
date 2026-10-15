import { hardwareQuoteIdentity, hardwareQuoteRank, isSupersededHardwareQuote } from '../../contracts/src/hardware-prices.js';

function mappedRow(row) {
  const body = JSON.parse(row.row_json);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    seriesKey: row.series_key,
    periodKey: row.period_key,
    periodStart: row.period_start,
    sourceUpdatedAt: row.source_updated_at,
    capturedAt: row.captured_at,
    specification: body.specification,
    category: body.category,
    quoteType: body.quoteType,
    unit: body.unit,
    period: body.period,
  };
}

// Marks older current rows, does not delete them. A dated quote with a unit
// replaces an unverified period, a unitless row, a specification that still
// contains a price column, and a SO-DIMM row still priced as chip.
export function retireSupersededHardwareQuotes(database, workspaceId = null) {
  const rows = workspaceId
    ? database.prepare(`SELECT id, workspace_id, series_key, period_key, period_start, source_updated_at, captured_at, row_json
        FROM hardware_price_observations WHERE workspace_id=? AND is_current=1`).all(workspaceId)
    : database.prepare(`SELECT id, workspace_id, series_key, period_key, period_start, source_updated_at, captured_at, row_json
        FROM hardware_price_observations WHERE is_current=1`).all();
  const groups = new Map();
  for (const row of rows.map(mappedRow)) {
    const key = `${row.workspaceId}\0${hardwareQuoteIdentity(row)}`;
    const list = groups.get(key) || [];
    list.push(row);
    groups.set(key, list);
  }
  const retire = [];
  for (const list of groups.values()) {
    const ranked = [...list].sort((a, b) => hardwareQuoteRank(b) - hardwareQuoteRank(a)
      || (b.periodStart ?? -1) - (a.periodStart ?? -1)
      || (b.sourceUpdatedAt ?? -1) - (a.sourceUpdatedAt ?? -1)
      || (b.capturedAt ?? 0) - (a.capturedAt ?? 0));
    const keeper = ranked[0];
    for (const row of list) {
      if (isSupersededHardwareQuote(row, keeper)) retire.push(row.id);
    }
  }
  const update = database.prepare('UPDATE hardware_price_observations SET is_current=0 WHERE id=? AND is_current=1');
  for (const id of retire) update.run(id);
  return retire.length;
}
