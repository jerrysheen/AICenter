const venues = { runpod: 'RunPod', vast: 'Vast' };
const lanes = { secure: '安全云', community: '社区云', min: '最低', median: '中位' };

export function computeMarketItems(board, { kind = 'all' } = {}) {
  const tokens = (board?.tokens || []).map((row) => ({
    assetClass: 'compute',
    compute: { kind: 'token' },
    name: row.name,
    symbol: row.modelId,
    group: `每百万 token · 输出 ${row.completionPerMillion} · ${row.quoteDate}`,
    summary: row.modelId,
    lastPrice: row.promptPerMillion,
    priceSuffix: 'USD/1M',
    changePct: row.promptChangePct,
    sparkline: (row.history || []).map((point) => Number(point.promptPerMillion)),
  }));
  const gpus = (board?.gpus || []).filter((row) => row.venue !== 'vast' || Number(row.sampleCount) >= 3).map((row) => {
    const venue = venues[row.venue] || row.venue;
    const lane = lanes[row.lane] || row.lane;
    const count = Number(row.sampleCount) >= 3 ? ` · ${row.sampleCount} 条` : '';
    return {
      assetClass: 'compute',
      compute: { kind: 'gpu' },
      name: row.label,
      symbol: venue,
      group: `${venue} · ${lane}${count} · ${row.quoteDate}`,
      summary: `${venue} ${row.label}`,
      lastPrice: row.usdPerHour,
      priceSuffix: 'USD/时',
      changePct: row.changePct,
      sparkline: (row.history || []).map((point) => Number(point.amount)),
    };
  });
  if (kind === 'token') return tokens;
  if (kind === 'gpu') return gpus;
  return [...tokens, ...gpus];
}
