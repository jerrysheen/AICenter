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

const TENCENT_AMOUNT_ENDPOINTS = Object.freeze([
  'https://web.ifzq.gtimg.cn/appstock/app/newfqkline/get',
  'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get',
]);
const TENCENT_PAGE_BARS = 480;

export function tencentWanToCny(value) {
  const wan = Number(value);
  if (!Number.isFinite(wan)) return null;
  return Math.round(wan * 10_000);
}

function coherentBar(open, high, low, close) {
  return high >= Math.max(open, close) && low <= Math.min(open, close);
}

export function parseTencentAmountRows(rows) {
  const bars = [];
  for (const row of rows || []) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const tradeDate = String(row[0] || '').slice(0, 10);
    const open = Number(row[1]);
    const close = Number(row[2]);
    const high = Number(row[3]);
    const low = Number(row[4]);
    const volume = Number(row[5]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) continue;
    if (![open, close, high, low].every(Number.isFinite)) continue;
    if (!coherentBar(open, high, low, close)) continue;
    bars.push({
      tradeDate,
      open,
      high,
      low,
      close,
      volume: Number.isFinite(volume) ? volume : null,
      amountCny: row.length >= 9 ? tencentWanToCny(row[8]) : null,
      adjust: 'none',
    });
  }
  return bars;
}

export function parseTencentAmountPayload(payload, symbol) {
  const node = payload?.data?.[symbol] || {};
  const rows = Array.isArray(node.day) ? node.day : (Array.isArray(node.qfqday) ? node.qfqday : []);
  return parseTencentAmountRows(rows);
}

function addIsoDays(iso, days) {
  const [year, month, day] = String(iso).split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, 10);
}

async function readTencentResponse(fetchImpl, url, timeoutMs) {
  const started = Date.now();
  const timeout = timeoutMs ?? 20_000;
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), timeout);
  let bodyTimer;
  try {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT, Referer: 'https://gu.qq.com/' },
      signal: controller.signal,
    });
    const body = Buffer.from(await Promise.race([
      response.arrayBuffer(),
      new Promise((_, reject) => {
        bodyTimer = setTimeout(() => reject(new Error('timeout')), timeout);
      }),
    ]));
    return {
      ok: response.ok,
      status: response.status,
      body,
      ms: Date.now() - started,
      error: response.ok ? '' : `HTTP ${response.status}`,
    };
  } catch (error) {
    const message = error?.name === 'AbortError' ? 'timeout' : (error.message || String(error));
    return { ok: false, status: 0, body: Buffer.alloc(0), ms: Date.now() - started, error: message };
  } finally {
    clearTimeout(abortTimer);
    clearTimeout(bodyTimer);
  }
}

export async function fetchTencentAmountDaily(code, exchange, startDate, endDate, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const symbol = tencentSymbol(code, exchange);
  const pageBars = options.pageBars ?? TENCENT_PAGE_BARS;
  const endpoints = options.endpoints || TENCENT_AMOUNT_ENDPOINTS;
  const probes = [];
  let lastError = '腾讯不复权日线为空';
  for (const endpoint of endpoints) {
    const collected = new Map();
    let cursorEnd = endDate;
    let hostError = '';
    let covered = false;
    for (let page = 0; page < 12 && cursorEnd >= startDate; page += 1) {
      const url = new URL(endpoint);
      url.searchParams.set('param', `${symbol},day,${startDate},${cursorEnd},${pageBars},`);
      const response = await readTencentResponse(fetchImpl, url, options.timeoutMs);
      const probe = {
        source: 'tencent',
        url: url.toString(),
        code,
        status: response.status,
        bytes: response.body.length,
        ms: response.ms,
        error: response.error,
        rowCount: 0,
      };
      probes.push(probe);
      if (!response.ok) {
        hostError = response.error || `HTTP ${response.status}`;
        probe.error = hostError;
        break;
      }
      let bars = [];
      try {
        bars = parseTencentAmountPayload(JSON.parse(response.body.toString('utf8')), symbol)
          .filter((bar) => bar.tradeDate >= startDate && bar.tradeDate <= cursorEnd && Number.isFinite(bar.amountCny));
      } catch (error) {
        hostError = error.message || String(error);
        probe.error = hostError;
        break;
      }
      probe.rowCount = bars.length;
      if (!bars.length) {
        hostError = '腾讯不复权日线为空';
        probe.error = hostError;
        break;
      }
      bars.sort((left, right) => left.tradeDate.localeCompare(right.tradeDate));
      for (const bar of bars) collected.set(bar.tradeDate, bar);
      if (bars[0].tradeDate <= startDate) {
        covered = true;
        hostError = '';
        break;
      }
      const nextEnd = addIsoDays(bars[0].tradeDate, -1);
      if (nextEnd >= cursorEnd) {
        hostError = '腾讯日线没有继续向前';
        break;
      }
      cursorEnd = nextEnd;
      hostError = '';
    }
    if (collected.size && covered) {
      const bars = [...collected.values()].sort((left, right) => left.tradeDate.localeCompare(right.tradeDate));
      return { ok: true, bars, probes, body: Buffer.alloc(0), error: '', source: 'tencent' };
    }
    const earliest = collected.size ? [...collected.keys()].sort()[0] : '';
    lastError = hostError || (earliest ? `腾讯日线只到 ${earliest}，未到 ${startDate}` : lastError);
  }
  return { ok: false, bars: [], probes, body: Buffer.alloc(0), error: lastError, source: 'tencent' };
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
