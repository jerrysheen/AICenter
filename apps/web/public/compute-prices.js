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
  const gpus = (board?.gpus || []).map((row) => ({
    assetClass: 'compute',
    compute: { kind: 'gpu' },
    name: row.label,
    symbol: venues[row.venue] || row.venue,
    group: `${venues[row.venue] || row.venue} · ${lanes[row.lane] || row.lane} · ${row.quoteDate}`,
    summary: `${venues[row.venue] || row.venue} ${row.label}`,
    lastPrice: row.usdPerHour,
    priceSuffix: 'USD/时',
    changePct: row.changePct,
    sparkline: (row.history || []).map((point) => Number(point.amount)),
  }));
  if (kind === 'token') return tokens;
  if (kind === 'gpu') return gpus;
  return [...tokens, ...gpus];
}
