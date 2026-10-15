const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';

function marketSymbol(code, exchange) {
  return `${exchange === 'SZ' ? 'sz' : 'sh'}${code}`;
}

function eastmoneySecid(code, exchange) {
  return `${exchange === 'SZ' ? '0' : '1'}.${code}`;
}

function inRange(tradeDate, startDate, endDate) {
  if (startDate && tradeDate < startDate) return false;
  if (endDate && tradeDate > endDate) return false;
  return true;
}

function coherent(open, high, low, close) {
  return high >= Math.max(open, close) && low <= Math.min(open, close);
}

export function parseSinaKlinePayload(text, { startDate, endDate } = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed || trimmed === 'null') return [];
  const payload = JSON.parse(trimmed);
  if (!Array.isArray(payload)) return [];
  const bars = [];
  for (const item of payload) {
    const day = String(item?.day || '').trim();
    const tradeDate = day.slice(0, 10);
    const open = Number(item?.open);
    const high = Number(item?.high);
    const low = Number(item?.low);
    const close = Number(item?.close);
    const volume = Number(item?.volume);
    const amount = Number(item?.amount);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) continue;
    if (![open, high, low, close].every(Number.isFinite)) continue;
    if (!coherent(open, high, low, close)) continue;
    if (!inRange(tradeDate, startDate, endDate)) continue;
    const clock = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(day) ? day.slice(0, 16) : null;
    bars.push({
      tradeDate,
      barTime: clock,
      open,
      high,
      low,
      close,
      volume: Number.isFinite(volume) ? volume : null,
      amountCny: Number.isFinite(amount) ? amount : null,
    });
  }
  return bars;
}

export function parseEastmoneyKlines(payload, { startDate, endDate } = {}) {
  const lines = Array.isArray(payload?.data?.klines) ? payload.data.klines : [];
  const bars = [];
  for (const line of lines) {
    const parts = String(line).split(',');
    const stamp = parts[0] || '';
    const tradeDate = stamp.slice(0, 10);
    const open = Number(parts[1]);
    const close = Number(parts[2]);
    const high = Number(parts[3]);
    const low = Number(parts[4]);
    const volume = Number(parts[5]);
    const amount = Number(parts[6]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) continue;
    if (![open, high, low, close].every(Number.isFinite)) continue;
    if (!coherent(open, high, low, close)) continue;
    if (!inRange(tradeDate, startDate, endDate)) continue;
    const clock = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(stamp) ? stamp.slice(0, 16) : null;
    bars.push({
      tradeDate,
      barTime: clock,
      open,
      high,
      low,
      close,
      volume: Number.isFinite(volume) ? volume : null,
      amountCny: Number.isFinite(amount) ? amount : null,
    });
  }
  return bars;
}

async function request(fetchImpl, url, timeoutMs) {
  const started = Date.now();
  try {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT, Referer: 'https://finance.sina.com.cn/' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = Buffer.from(await response.arrayBuffer());
    return {
      ok: response.ok,
      status: response.status,
      body,
      ms: Date.now() - started,
      error: response.ok ? '' : `HTTP ${response.status}`,
    };
  } catch (error) {
    return { ok: false, status: 0, body: Buffer.alloc(0), ms: Date.now() - started, error: error.message || String(error) };
  }
}

export async function fetchSinaKline({ symbol, scale, datalen = 1000, startDate, endDate, fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const url = new URL('https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketDataService.getKLineData');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('scale', String(scale));
  url.searchParams.set('ma', 'no');
  url.searchParams.set('datalen', String(datalen));
  const response = await request(fetchImpl, url, timeoutMs);
  const probe = { source: 'sina', url: url.toString(), symbol, scale, status: response.status, bytes: response.body.length, error: response.error, rowCount: 0 };
  if (!response.ok) return { ok: false, bars: [], probes: [probe], body: response.body, error: response.error };
  try {
    const bars = parseSinaKlinePayload(response.body.toString('utf8'), { startDate, endDate });
    probe.rowCount = bars.length;
    return { ok: bars.length > 0, bars, probes: [probe], body: response.body, error: bars.length ? '' : '新浪 K 线为空' };
  } catch (error) {
    probe.error = error.message;
    return { ok: false, bars: [], probes: [probe], body: response.body, error: error.message };
  }
}

export async function fetchEastmoneyKline({ secid, klt, fqt = 0, startDate, endDate, fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const url = new URL('https://push2his.eastmoney.com/api/qt/stock/kline/get');
  url.searchParams.set('secid', secid);
  url.searchParams.set('klt', String(klt));
  url.searchParams.set('fqt', String(fqt));
  url.searchParams.set('beg', String(startDate || '20240101').replaceAll('-', ''));
  url.searchParams.set('end', String(endDate || '20500101').replaceAll('-', ''));
  url.searchParams.set('fields1', 'f1,f2,f3,f4,f5,f6');
  url.searchParams.set('fields2', 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61');
  const response = await request(fetchImpl, url, timeoutMs);
  const probe = { source: 'eastmoney', url: url.toString(), secid, klt, status: response.status, bytes: response.body.length, error: response.error, rowCount: 0 };
  if (!response.ok) return { ok: false, bars: [], probes: [probe], body: response.body, error: response.error };
  try {
    const bars = parseEastmoneyKlines(JSON.parse(response.body.toString('utf8')), { startDate, endDate });
    probe.rowCount = bars.length;
    return { ok: bars.length > 0, bars, probes: [probe], body: response.body, error: bars.length ? '' : '东财 K 线为空' };
  } catch (error) {
    probe.error = error.message;
    return { ok: false, bars: [], probes: [probe], body: response.body, error: error.message };
  }
}

export async function fetchIntradayBars({ code, exchange, kind, startDate, endDate, fetchImpl, timeoutMs } = {}) {
  const symbol = marketSymbol(code, exchange);
  const sina = await fetchSinaKline({ symbol, scale: 5, datalen: 1000, startDate, endDate, fetchImpl, timeoutMs });
  if (sina.ok) {
    return {
      ok: true,
      source: 'sina',
      symbol: code,
      kind,
      bars: sina.bars.filter((bar) => bar.barTime).map((bar) => ({ ...bar, intervalKey: '5m' })),
      probes: sina.probes,
    };
  }
  const east = await fetchEastmoneyKline({
    secid: eastmoneySecid(code, exchange), klt: 5, fqt: 0, startDate, endDate, fetchImpl, timeoutMs,
  });
  return {
    ok: east.ok,
    source: 'eastmoney',
    symbol: code,
    kind,
    bars: (east.bars || []).filter((bar) => bar.barTime).map((bar) => ({ ...bar, intervalKey: '5m' })),
    probes: [...sina.probes, ...east.probes],
    error: east.error || sina.error,
  };
}

export async function fetchDailyBars({ code, exchange, startDate, endDate, fetchImpl, timeoutMs, adjusted = false } = {}) {
  const spanDays = startDate && endDate ? Math.ceil((Date.parse(endDate) - Date.parse(startDate)) / 86400000) + 10 : 30;
  const datalen = Math.min(1023, Math.max(30, spanDays));
  const sina = await fetchSinaKline({
    symbol: marketSymbol(code, exchange), scale: 240, datalen, startDate, endDate, fetchImpl, timeoutMs,
  });
  if (sina.ok && sina.bars.length) return { ...sina, source: 'sina' };
  const east = await fetchEastmoneyKline({
    secid: eastmoneySecid(code, exchange),
    klt: 101,
    fqt: adjusted ? 1 : 0,
    startDate,
    endDate,
    fetchImpl,
    timeoutMs,
  });
  return {
    ok: east.ok,
    source: east.ok ? 'eastmoney' : 'sina',
    bars: east.bars || [],
    probes: [...(sina.probes || []), ...(east.probes || [])],
    error: east.error || sina.error,
    body: east.body || sina.body,
  };
}
