function mapRow(row) {
  if (!row) return null;
  return {
    workspaceId: row.workspace_id,
    companyCode: row.company_code,
    yearMonth: row.year_month,
    rocYearMonth: row.roc_year_month || '',
    companyName: row.company_name || '',
    industry: row.industry || '',
    revenueMonth: row.revenue_month || '',
    revenuePreviousMonth: row.revenue_previous_month || '',
    revenueYearAgo: row.revenue_year_ago || '',
    revenueMomPct: row.revenue_mom_pct || '',
    revenueYoyPct: row.revenue_yoy_pct || '',
    revenueYtd: row.revenue_ytd || '',
    revenueYtdYearAgo: row.revenue_ytd_year_ago || '',
    revenueYtdPct: row.revenue_ytd_pct || '',
    note: row.note || '',
    publishedOn: row.published_on || '',
    publishedAt: row.published_at || null,
    sourceUrl: row.source_url || '',
    observedAt: row.observed_at,
  };
}

export function createTwseRevenueRepository(database) {
  const upsert = database.prepare(`INSERT INTO twse_monthly_revenue (
      workspace_id, company_code, year_month, roc_year_month, company_name, industry,
      revenue_month, revenue_previous_month, revenue_year_ago, revenue_mom_pct, revenue_yoy_pct,
      revenue_ytd, revenue_ytd_year_ago, revenue_ytd_pct, note, published_on, published_at,
      source_url, observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, company_code, year_month) DO UPDATE SET
      roc_year_month = excluded.roc_year_month,
      company_name = excluded.company_name,
      industry = excluded.industry,
      revenue_month = excluded.revenue_month,
      revenue_previous_month = excluded.revenue_previous_month,
      revenue_year_ago = excluded.revenue_year_ago,
      revenue_mom_pct = excluded.revenue_mom_pct,
      revenue_yoy_pct = excluded.revenue_yoy_pct,
      revenue_ytd = excluded.revenue_ytd,
      revenue_ytd_year_ago = excluded.revenue_ytd_year_ago,
      revenue_ytd_pct = excluded.revenue_ytd_pct,
      note = excluded.note,
      published_on = excluded.published_on,
      published_at = excluded.published_at,
      source_url = excluded.source_url,
      observed_at = excluded.observed_at`);
  return {
    upsertMany(workspaceId, rows, observedAt = Date.now()) {
      const sourceUrl = 'https://openapi.twse.com.tw/v1/opendata/t187ap05_L';
      const months = new Set();
      const saved = database.transaction(() => {
        let count = 0;
        for (const row of rows || []) {
          if (!row?.companyCode || !row.yearMonth) continue;
          upsert.run(
            workspaceId, row.companyCode, row.yearMonth, row.rocYearMonth || '', row.companyName || '', row.industry || '',
            row.revenueMonth || '', row.revenuePreviousMonth || '', row.revenueYearAgo || '', row.revenueMomPct || '', row.revenueYoyPct || '',
            row.revenueYtd || '', row.revenueYtdYearAgo || '', row.revenueYtdPct || '', row.note || '', row.publishedOn || '', row.publishedAt || null,
            sourceUrl, observedAt,
          );
          months.add(row.yearMonth);
          count += 1;
        }
        return count;
      })();
      return { saved, months: [...months].sort() };
    },
    listByCompany(workspaceId, companyCode) {
      return database.prepare(`SELECT * FROM twse_monthly_revenue
        WHERE workspace_id = ? AND company_code = ?
        ORDER BY year_month ASC`).all(workspaceId, companyCode).map(mapRow);
    },
    count(workspaceId) {
      return database.prepare('SELECT COUNT(*) AS n FROM twse_monthly_revenue WHERE workspace_id = ?').get(workspaceId).n;
    },
  };
}
