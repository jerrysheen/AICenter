import { readWorkbookSheets } from './xlsx-workbook.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';
const WAN_FEN = 10_000;

function sseUrl(tradeDate, pageNo) {
  const url = new URL('https://query.sse.com.cn/commonQuery.do');
  url.searchParams.set('isPagination', 'true');
  url.searchParams.set('pageHelp.pageSize', '10000');
  url.searchParams.set('pageHelp.pageNo', String(pageNo));
  url.searchParams.set('pageHelp.beginPage', String(pageNo));
  url.searchParams.set('pageHelp.cacheSize', '1');
  url.searchParams.set('pageHelp.endPage', String(pageNo));
  url.searchParams.set('sqlId', 'COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L');
  url.searchParams.set('STAT_DATE', tradeDate);
  return url;
}

function szseUrl(kind, startDate, endDate) {
  const url = new URL(kind === 'json'
    ? 'https://www.szse.cn/api/report/ShowReport/data'
    : 'https://www.szse.cn/api/report/ShowReport');
  url.searchParams.set('SHOWTYPE', kind === 'json' ? 'JSON' : 'xlsx');
  url.searchParams.set('CATALOGID', 'scsj_fund_jjgm');
  url.searchParams.set('TABKEY', 'tab1');
  url.searchParams.set('txtStart', startDate);
  url.searchParams.set('txtEnd', endDate);
  url.searchParams.set('jjlb', 'ETF');
  url.searchParams.set('random', '0.17');
  return url;
}

async function request(fetchImpl, url, headers, timeoutMs) {
  const started = Date.now();
  try {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    const body = Buffer.from(await response.arrayBuffer());
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get('content-type') || '',
      body,
      ms: Date.now() - started,
      error: response.ok ? '' : `HTTP ${response.status}`,
    };
  } catch (error) {
    return { ok: false, status: 0, contentType: '', body: Buffer.alloc(0), ms: Date.now() - started, error: error.message || String(error) };
  }
}

function parseJsonBody(body) {
  const text = body.toString('utf8').trim();
  if (!text) throw new Error('空响应');
  if (text.startsWith('{') || text.startsWith('[')) return JSON.parse(text);
  const start = text.indexOf('(');
  const end = text.lastIndexOf(')');
  if (start >= 0 && end > start) return JSON.parse(text.slice(start + 1, end));
  throw new Error('响应不是 JSON');
}

export function parseSseSharePayload(payload, tradeDate) {
  const result = Array.isArray(payload?.result) ? payload.result : [];
  const rows = [];
  for (const item of result) {
    const code = String(item?.SEC_CODE || '').trim();
    const date = String(item?.STAT_DATE || '').slice(0, 10);
    const raw = Number(String(item?.TOT_VOL || '').replaceAll(',', ''));
    if (!/^\d{6}$/.test(code) || !Number.isFinite(raw)) continue;
    if (tradeDate && date && date !== tradeDate) continue;
    rows.push({
      code,
      name: String(item?.SEC_NAME || ''),
      tradeDate: date || tradeDate,
      rawValue: raw,
      rawUnit: '万份',
      shares: raw * WAN_FEN,
      source: 'sse',
    });
  }
  return {
    rows,
    pageCount: Number(payload?.pageHelp?.pageCount || 1),
    total: Number(payload?.pageHelp?.total || rows.length),
  };
}

export function parseSzseShareSheet(sheetRows) {
  const rows = [];
  for (const row of sheetRows || []) {
    if (!Array.isArray(row) || row.length < 4) continue;
    const date = excelDate(row[0]);
    const code = padCode(row[1]);
    const raw = Number(String(row[3] ?? '').replaceAll(',', ''));
    if (!date || !code || !Number.isFinite(raw)) continue;
    if (String(row[0]).includes('日期') || String(row[1]).includes('代码')) continue;
    rows.push({
      code,
      name: String(row[2] || ''),
      tradeDate: date,
      rawValue: raw,
      rawUnit: '份',
      shares: raw,
      source: 'szse-xlsx',
    });
  }
  return rows;
}

export function parseSzseShareJson(payload) {
  const block = Array.isArray(payload) ? payload[0] : payload;
  const data = Array.isArray(block?.data) ? block.data : [];
  const rows = [];
  for (const item of data) {
    const code = padCode(item?.fund_code);
    const raw = Number(String(item?.current_size || '').replaceAll(',', ''));
    const date = String(item?.size_date || '').slice(0, 10);
    if (!code || !date || !Number.isFinite(raw)) continue;
    rows.push({
      code,
      name: String(item?.security_short_name || ''),
      tradeDate: date,
      rawValue: raw,
      rawUnit: '万份',
      shares: raw * WAN_FEN,
      source: 'szse-json',
    });
  }
  return {
    rows,
    pageCount: Number(block?.metadata?.pagecount || 1),
    recordCount: Number(block?.metadata?.recordcount || rows.length),
    pageSize: Number(block?.metadata?.pagesize || rows.length),
    error: block?.error || '',
  };
}

function padCode(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.padStart(6, '0').slice(-6);
}

function excelDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const text = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  return '';
}

export async function fetchSseEtfShares(tradeDate, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const pages = [];
  const bodies = [];
  let pageNo = 1;
  let pageCount = 1;
  while (pageNo <= pageCount && pageNo <= 20) {
    const url = sseUrl(tradeDate, pageNo);
    const response = await request(fetchImpl, url, {
      Referer: 'https://www.sse.com.cn/',
      'User-Agent': USER_AGENT,
      Accept: 'application/json, text/javascript, */*; q=0.01',
    }, timeoutMs);
    const probe = {
      source: 'sse',
      url: url.toString(),
      tradeDate,
      pageNo,
      status: response.status,
      bytes: response.body.length,
      contentType: response.contentType,
      ms: response.ms,
      error: response.error,
      rowCount: 0,
    };
    if (!response.ok) {
      pages.push(probe);
      return { ok: false, rows: [], probes: pages, body: Buffer.concat(bodies), error: response.error || `HTTP ${response.status}` };
    }
    let parsed;
    try {
      parsed = parseSseSharePayload(parseJsonBody(response.body), tradeDate);
    } catch (error) {
      probe.error = error.message;
      pages.push(probe);
      return { ok: false, rows: [], probes: pages, body: response.body, error: error.message };
    }
    probe.rowCount = parsed.rows.length;
    probe.total = parsed.total;
    pages.push(probe);
    bodies.push(response.body);
    pageCount = Number.isFinite(parsed.pageCount) && parsed.pageCount > 0 ? parsed.pageCount : 1;
    if (pageNo === 1 && parsed.rows.length === 0) break;
    pageNo += 1;
  }
  const rows = pages.flatMap((probe, index) => {
    try {
      return parseSseSharePayload(parseJsonBody(bodies[index]), tradeDate).rows;
    } catch {
      return [];
    }
  });
  return { ok: true, rows, probes: pages, body: Buffer.concat(bodies), error: '' };
}

export async function fetchSzseEtfShares(startDate, endDate, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const url = szseUrl('xlsx', startDate, endDate);
  const response = await request(fetchImpl, url, {
    Referer: 'https://www.szse.cn/market/fund/volume/etf/index.html',
    'User-Agent': USER_AGENT,
  }, timeoutMs);
  const probe = {
    source: 'szse-xlsx',
    url: url.toString(),
    startDate,
    endDate,
    status: response.status,
    bytes: response.body.length,
    contentType: response.contentType,
    ms: response.ms,
    error: response.error,
    rowCount: 0,
  };
  if (!response.ok) return { ok: false, rows: [], probes: [probe], body: response.body, error: probe.error };
  if (response.body.length < 4 || response.body.slice(0, 2).toString() !== 'PK') {
    probe.error = '响应不是 xlsx';
    return { ok: false, rows: [], probes: [probe], body: response.body, error: probe.error };
  }
  try {
    const sheets = readWorkbookSheets(response.body);
    const sheet = Object.values(sheets)[0] || [];
    const rows = parseSzseShareSheet(sheet);
    probe.rowCount = rows.length;
    return { ok: true, rows, probes: [probe], body: response.body, error: '' };
  } catch (error) {
    probe.error = error.message;
    return { ok: false, rows: [], probes: [probe], body: response.body, error: error.message };
  }
}

export async function fetchSzseEtfShareJsonPage(startDate, endDate, pageNo = 1, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = szseUrl('json', startDate, endDate);
  url.searchParams.set('PAGENO', String(pageNo));
  const response = await request(fetchImpl, url, {
    Referer: 'https://www.szse.cn/market/fund/volume/etf/index.html',
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
  }, options.timeoutMs ?? 20_000);
  const probe = {
    source: 'szse-json',
    url: url.toString(),
    startDate,
    endDate,
    pageNo,
    status: response.status,
    bytes: response.body.length,
    contentType: response.contentType,
    ms: response.ms,
    error: response.error,
    rowCount: 0,
  };
  if (!response.ok) return { ok: false, rows: [], probes: [probe], body: response.body, error: probe.error };
  try {
    const parsed = parseSzseShareJson(parseJsonBody(response.body));
    probe.rowCount = parsed.rows.length;
    probe.pageCount = parsed.pageCount;
    probe.recordCount = parsed.recordCount;
    probe.pageSize = parsed.pageSize;
    return { ok: true, ...parsed, probes: [probe], body: response.body, error: parsed.error || '' };
  } catch (error) {
    probe.error = error.message;
    return { ok: false, rows: [], probes: [probe], body: response.body, error: error.message };
  }
}
