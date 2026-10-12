const venues = {
  runpod: 'RunPod',
  vast: 'Vast',
  ccir: 'CCIR',
  gpueconomy: 'GPU Economy',
  bargo: 'Bargo',
};
const lanes = {
  secure: '安全云',
  community: '社区云',
  min: '最低',
  median: '中位',
  'hyperscaler-guaranteed': '超大规模 · 保障',
  'neocloud-guaranteed': '新云 · 保障',
  'marketplace-guaranteed': '市场 · 保障',
  'hyperscaler-interruptible': '超大规模 · 可中断',
  'neocloud-interruptible': '新云 · 可中断',
  'marketplace-interruptible': '市场 · 可中断',
  ondemand: '按需',
  spot: '竞价',
  reserved: '预留',
};

export function gpuSourceUrl(venue, gpuKey) {
  if (venue === 'gpueconomy' && gpuKey) return `https://gpueconomy.com/gpu/${gpuKey}`;
  if (venue === 'ccir') return 'https://ccir.io/rates';
  if (venue === 'bargo') return 'https://www.bargo.ai/gpu-prices';
  if (venue === 'runpod') return 'https://www.runpod.io/pricing';
  if (venue === 'vast') return 'https://vast.ai/';
  return '';
}

export function gpuMatchesSource(item, source = 'all') {
  if (!source || source === 'all') return true;
  if (item?.compute?.kind !== 'gpu') return true;
  return item.compute.venue === source;
}

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
    const count = Number(row.sampleCount) >= 1 ? ` · ${row.sampleCount} 条` : '';
    const sourceUrl = gpuSourceUrl(row.venue, row.gpuKey);
    return {
      assetClass: 'compute',
      compute: { kind: 'gpu', venue: row.venue, sourceUrl },
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
