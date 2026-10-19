export const SOUTHBOUND_TIMEOUT_MS = 15_000;
export const SOUTHBOUND_MIN_INTERVAL_MS = 1_000;

const EASTMONEY_URL = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
const CHANNEL_BY_TYPE = { '002': 'sh', '004': 'sz', '006': 'total' };
const NORTHBOUND_CHANNEL_BY_TYPE = { '001': 'sh', '003': 'sz', '005': 'total' };

export function millionHkdToHkd(value) {
  if (value == null || value === '') return null;
  const number = Number(String(value).replace(/,/g, ''));
  if (!Number.isFinite(number)) return null;
  return Math.round(number * 1_000_000);
}

export function hkdAmount(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.round(number);
}

export function tradeDateOf(value) {
  const text = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

export function parseDealHistory(payload) {
  const rows = payload?.result?.data;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const channel = CHANNEL_BY_TYPE[String(row?.MUTUAL_TYPE || '')];
    const tradeDate = tradeDateOf(row?.TRADE_DATE);
    if (!channel || !tradeDate) return [];
    return [{
      tradeDate,
      channel,
      mutualType: String(row.MUTUAL_TYPE),
      buyAmt: millionHkdToHkd(row.BUY_AMT),
      sellAmt: millionHkdToHkd(row.SELL_AMT),
      netAmt: millionHkdToHkd(row.NET_DEAL_AMT),
      dealAmt: millionHkdToHkd(row.DEAL_AMT),
      dealNum: row.DEAL_NUM == null || row.DEAL_NUM === '' ? null : Math.round(Number(row.DEAL_NUM)),
      indexClose: row.INDEX_CLOSE_PRICE == null || row.INDEX_CLOSE_PRICE === '' ? null : Number(row.INDEX_CLOSE_PRICE),
      source: 'eastmoney',
    }];
  });
}

export function parseTop10(payload) {
  const rows = payload?.result?.data;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const channel = CHANNEL_BY_TYPE[String(row?.MUTUAL_TYPE || '')];
    const tradeDate = tradeDateOf(row?.TRADE_DATE);
    const code = String(row?.SECURITY_CODE || '').replace(/\D/g, '').padStart(5, '0');
    if (!channel || channel === 'total' || !tradeDate || !/^\d{5}$/.test(code)) return [];
    return [{
      tradeDate,
      channel,
      rank: Number(row.RANK) || 0,
      code,
      name: String(row.SECURITY_NAME || '').trim(),
      buyAmt: hkdAmount(row.BUY_AMT),
      sellAmt: hkdAmount(row.SELL_AMT),
      netAmt: hkdAmount(row.NET_BUY_AMT),
      dealAmt: hkdAmount(row.DEAL_AMT),
      close: row.CLOSE_PRICE == null || row.CLOSE_PRICE === '' ? null : Number(row.CLOSE_PRICE),
      chgPct: row.CHANGE_RATE == null || row.CHANGE_RATE === '' ? null : Number(row.CHANGE_RATE),
      source: 'eastmoney',
    }];
  });
}

export function parseNorthboundHistory(payload) {
  const rows = payload?.result?.data;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const channel = NORTHBOUND_CHANNEL_BY_TYPE[String(row?.MUTUAL_TYPE || '')];
    const tradeDate = tradeDateOf(row?.TRADE_DATE);
    const dealAmt = millionHkdToHkd(row?.DEAL_AMT);
    if (!channel || !tradeDate || dealAmt == null) return [];
    return [{
      tradeDate,
      channel,
      mutualType: String(row.MUTUAL_TYPE),
      dealAmt,
      dealNum: row.DEAL_NUM == null || row.DEAL_NUM === '' ? null : Math.round(Number(row.DEAL_NUM)),
      source: 'eastmoney',
    }];
  });
}

export function parseNorthboundTop10(payload) {
  const rows = payload?.result?.data;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const channel = NORTHBOUND_CHANNEL_BY_TYPE[String(row?.MUTUAL_TYPE || '')];
    const tradeDate = tradeDateOf(row?.TRADE_DATE);
    const digits = String(row?.SECURITY_CODE || '').replace(/\D/g, '');
    const code = digits.length > 0 && digits.length <= 6 ? digits.padStart(6, '0') : '';
    const dealAmt = hkdAmount(row?.DEAL_AMT);
    if (!channel || channel === 'total' || !tradeDate || !/^\d{6}$/.test(code) || dealAmt == null) return [];
    return [{
      tradeDate,
      channel,
      rank: Number(row.RANK) || 0,
      code,
      name: String(row.SECURITY_NAME || '').trim(),
      dealAmt,
      source: 'eastmoney',
    }];
  });
}

export function mergeTop10(rows) {
  const byCode = new Map();
  for (const row of rows || []) {
    if (row?.channel !== 'sh' && row?.channel !== 'sz') continue;
    const current = byCode.get(row.code) || {
      tradeDate: row.tradeDate,
      channel: 'total',
      code: row.code,
      name: row.name || '',
      buyAmt: 0,
      sellAmt: 0,
      netAmt: 0,
      dealAmt: 0,
      close: row.close ?? null,
      chgPct: row.chgPct ?? null,
      source: 'derived',
    };
    current.buyAmt += row.buyAmt || 0;
    current.sellAmt += row.sellAmt || 0;
    current.netAmt += row.netAmt || 0;
    current.dealAmt += row.dealAmt || 0;
    if (!current.name && row.name) current.name = row.name;
    if (current.close == null && row.close != null) current.close = row.close;
    if (current.chgPct == null && row.chgPct != null) current.chgPct = row.chgPct;
    if (!current.tradeDate) current.tradeDate = row.tradeDate;
    byCode.set(row.code, current);
  }
  return [...byCode.values()]
    .sort((left, right) => Math.abs(right.netAmt) - Math.abs(left.netAmt) || left.code.localeCompare(right.code))
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

function summaryCells(table) {
  return (table?.tr || []).map((row) => {
    const cell = row?.td?.[0];
    if (Array.isArray(cell)) return cell.length === 1 ? cell[0] : cell.join(',');
    return cell ?? '';
  });
}

export function parseHkexDaily(text) {
  const source = String(text || '').replace(/\r\n/g, '\n');
  const start = source.indexOf('[');
  const end = source.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  let tabs;
  try {
    tabs = JSON.parse(source.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(tabs)) return null;
  const markets = {};
  const northboundMarkets = {};
  for (const tab of tabs) {
    const market = String(tab?.market || '');
    const summary = (tab.content || []).find((block) => block?.style === 1)?.table;
    const values = summaryCells(summary);
    if (market === 'SSE Southbound' || market === 'SZSE Southbound') {
      const channel = market === 'SSE Southbound' ? 'sh' : 'sz';
      markets[channel] = {
        tradeDate: tradeDateOf(tab.date),
        totalTurnoverHkd: millionHkdToHkd(values[0]),
        buyTurnoverHkd: millionHkdToHkd(values[1]),
        sellTurnoverHkd: millionHkdToHkd(values[2]),
        tradeCount: Number(String(values[3] || '').replace(/,/g, '')) || null,
      };
      continue;
    }
    if (market === 'SSE Northbound' || market === 'SZSE Northbound') {
      const channel = market === 'SSE Northbound' ? 'sh' : 'sz';
      northboundMarkets[channel] = {
        tradeDate: tradeDateOf(tab.date),
        totalTurnoverCny: millionHkdToHkd(values[0]),
        tradeCount: Number(String(values[1] || '').replace(/,/g, '')) || null,
      };
    }
  }
  if (!markets.sh && !markets.sz && !northboundMarkets.sh && !northboundMarkets.sz) return null;
  const dealAmt = (markets.sh?.totalTurnoverHkd || 0) + (markets.sz?.totalTurnoverHkd || 0);
  const northDeal = (northboundMarkets.sh?.totalTurnoverCny || 0) + (northboundMarkets.sz?.totalTurnoverCny || 0);
  const northbound = northboundMarkets.sh || northboundMarkets.sz
    ? { markets: northboundMarkets, dealAmt: northDeal || null }
    : null;
  return { markets, dealAmt: dealAmt || null, northbound };
}

export function compareSouthboundDeal(eastmoneyHkd, hkexHkd) {
  if (hkexHkd == null) return { checkStatus: 'hkex_missing', checkDiffPct: null };
  if (eastmoneyHkd == null) return { checkStatus: 'unchecked', checkDiffPct: null };
  if (eastmoneyHkd === 0) {
    return {
      checkStatus: hkexHkd === 0 ? 'ok' : 'mismatch',
      checkDiffPct: hkexHkd === 0 ? 0 : null,
    };
  }
  const checkDiffPct = Math.abs(hkexHkd - eastmoneyHkd) / Math.abs(eastmoneyHkd) * 100;
  return { checkStatus: checkDiffPct > 1 ? 'mismatch' : 'ok', checkDiffPct };
}

function historyUrl({ mutualType, start, end, pageNumber, pageSize }) {
  const params = new URLSearchParams({
    reportName: 'RPT_MUTUAL_DEAL_HISTORY',
    columns: 'ALL',
    pageNumber: String(pageNumber),
    pageSize: String(pageSize),
    sortColumns: 'TRADE_DATE',
    sortTypes: '-1',
    source: 'WEB',
    client: 'WEB',
  });
  const filters = [];
  if (mutualType) filters.push(`(MUTUAL_TYPE="${mutualType}")`);
  if (start && end) {
    if (start === end) filters.push(`(TRADE_DATE='${start}')`);
    else {
      filters.push(`(TRADE_DATE>='${start}')`);
      filters.push(`(TRADE_DATE<='${end}')`);
    }
  }
  if (filters.length) params.set('filter', filters.join(''));
  return `${EASTMONEY_URL}?${params.toString()}`;
}

function top10Url(date) {
  const params = new URLSearchParams({
    reportName: 'RPT_MUTUAL_TOP10DEAL',
    columns: 'ALL',
    filter: `(TRADE_DATE='${date}')`,
    pageNumber: '1',
    pageSize: '100',
    sortColumns: 'RANK',
    sortTypes: '1',
    source: 'WEB',
    client: 'WEB',
  });
  return `${EASTMONEY_URL}?${params.toString()}`;
}

function hkexUrl(date) {
  return `https://www.hkex.com.hk/eng/csm/DailyStat/data_tab_daily_${date.replaceAll('-', '')}e.js`;
}

export function createSouthboundClient(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? SOUTHBOUND_TIMEOUT_MS;
  const minIntervalMs = options.minIntervalMs ?? SOUTHBOUND_MIN_INTERVAL_MS;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now || Date.now;
  let lastAt = 0;
  let chain = Promise.resolve();

  function schedule(task) {
    const run = chain.then(async () => {
      if (lastAt) {
        const wait = Math.max(0, lastAt + minIntervalMs - now());
        if (wait > 0) await sleep(wait);
      }
      lastAt = now();
      return task();
    });
    chain = run.then(() => {}, () => {});
    return run;
  }

  async function getResponse(url, accept, referer) {
    return schedule(async () => {
      const headers = {
        'User-Agent': 'Mozilla/5.0',
        Accept: accept,
      };
      if (referer) headers.Referer = referer;
      const response = await fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      return response;
    });
  }

  async function getJson(url) {
    const response = await getResponse(url, 'application/json,text/plain,*/*', 'https://data.eastmoney.com/');
    if (!response?.ok) {
      const error = new Error(`南向接口 HTTP ${response?.status || 0}`);
      error.status = response?.status || 0;
      throw error;
    }
    return response.json();
  }

  return {
    async fetchHistory({ mutualType = '', start, end, pageSize = 200, parse = parseDealHistory } = {}) {
      const rows = [];
      let page = 1;
      let pages = 1;
      while (page <= pages && page <= 40) {
        const payload = await getJson(historyUrl({ mutualType, start, end, pageNumber: page, pageSize }));
        pages = Number(payload?.result?.pages) || 1;
        rows.push(...parse(payload));
        page += 1;
      }
      return rows;
    },
    async fetchDayBundle(date) {
      const payload = await getJson(historyUrl({ start: date, end: date, pageNumber: 1, pageSize: 20 }));
      return {
        southbound: parseDealHistory(payload),
        northbound: parseNorthboundHistory(payload),
      };
    },
    fetchDay(date) {
      return this.fetchDayBundle(date).then((bundle) => bundle.southbound);
    },
    fetchNorthboundHistory(args = {}) {
      return this.fetchHistory({ ...args, parse: parseNorthboundHistory });
    },
    async fetchTop10Bundle(date) {
      const payload = await getJson(top10Url(date));
      return {
        southbound: parseTop10(payload),
        northbound: parseNorthboundTop10(payload),
      };
    },
    fetchTop10(date) {
      return this.fetchTop10Bundle(date).then((bundle) => bundle.southbound);
    },
    async fetchHkex(date) {
      const response = await getResponse(hkexUrl(date), 'application/javascript,text/plain,*/*', 'https://www.hkex.com.hk/');
      if (response?.status === 404) return null;
      if (!response?.ok) {
        const error = new Error(`港交所 HTTP ${response?.status || 0}`);
        error.status = response?.status || 0;
        throw error;
      }
      const text = await response.text();
      return parseHkexDaily(text);
    },
  };
}
