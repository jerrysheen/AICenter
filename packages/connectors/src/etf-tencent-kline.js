const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';

export function tencentSymbol(code, exchange) {
  const prefix = exchange === 'SZ' ? 'sz' : 'sh';
  return `${prefix}${code}`;
}

export function parseTencentDayRows(rows) {
  const bars = [];
  for (const row of rows || []) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const tradeDate = String(row[0] || '').slice(0, 10);
    const open = Number(row[1]);
    const close = Number(row[2]);
    const high = Number(row[3]);
    const low = Number(row[4]);
    const volumeLots = Number(row[5]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) continue;
    if (![open, close, high, low, volumeLots].every(Number.isFinite)) continue;
    bars.push({ tradeDate, open, high, low, close, volumeLots, adjust: 'qfq' });
  }
  return bars;
}

export async function fetchTencentQfqDaily(code, exchange, startDate, endDate, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const symbol = tencentSymbol(code, exchange);
  const url = new URL('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get');
  url.searchParams.set('param', `${symbol},day,${startDate},${endDate},2000,qfq`);
  const started = Date.now();
  try {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT, Referer: 'https://gu.qq.com/' },
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    });
    const body = Buffer.from(await response.arrayBuffer());
    const probe = {
      source: 'tencent-qfq',
      url: url.toString(),
      code,
      status: response.status,
      bytes: body.length,
      ms: Date.now() - started,
      error: response.ok ? '' : `HTTP ${response.status}`,
      rowCount: 0,
    };
    if (!response.ok) return { ok: false, bars: [], probes: [probe], body, error: probe.error };
    const payload = JSON.parse(body.toString('utf8'));
    const node = payload?.data?.[symbol] || {};
    const bars = parseTencentDayRows(node.qfqday || node.day || []);
    probe.rowCount = bars.length;
    return { ok: bars.length > 0, bars, probes: [probe], body, error: bars.length ? '' : '腾讯前复权日线为空' };
  } catch (error) {
    return {
      ok: false,
      bars: [],
      probes: [{ source: 'tencent-qfq', url: url.toString(), code, status: 0, error: error.message || String(error), rowCount: 0 }],
      body: Buffer.alloc(0),
      error: error.message || String(error),
    };
  }
}
