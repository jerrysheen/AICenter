const DEFAULT_URL = 'https://api.tushare.pro';
const DEFAULT_TIMEOUT_MS = 12_000;
const RANGE_DAYS = {
  '1mo': 40,
  '3mo': 110,
  '6mo': 200,
  '1y': 400,
  '2y': 800,
  '5y': 1900,
  max: 12000,
};

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && value !== 'None') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export function isTushareDailySymbol(symbol) {
  return /^\d{6}\.(SS|SZ)$/i.test(String(symbol || '').trim());
}

export function yahooToTushareCode(symbol) {
  const match = String(symbol || '').trim().toUpperCase().match(/^(\d{6})\.(SS|SZ)$/);
  if (!match) return null;
  return `${match[1]}.${match[2] === 'SS' ? 'SH' : 'SZ'}`;
}

export function tushareCodeToYahoo(code) {
  const match = String(code || '').trim().toUpperCase().match(/^(\d{6})\.(SH|SZ)$/);
  if (!match) return null;
  return `${match[1]}.${match[2] === 'SH' ? 'SS' : 'SZ'}`;
}

export function yyyymmddInShanghai(ms) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
  return parts.replaceAll('-', '');
}

export function rangeWindow(range, now = Date.now()) {
  const days = RANGE_DAYS[range] || RANGE_DAYS['6mo'];
  return {
    startDate: yyyymmddInShanghai(now - days * 86_400_000),
    endDate: yyyymmddInShanghai(now),
  };
}

export function seriesFromTushareDaily(payload, yahooSymbol) {
  const symbol = String(yahooSymbol || tushareCodeToYahoo(payload?.tsCode) || '').toUpperCase();
  const data = isRecord(payload) && isRecord(payload.data) ? payload.data : payload;
  const fields = Array.isArray(data?.fields) ? data.fields.map((item) => String(item || '').toLowerCase()) : [];
  const items = Array.isArray(data?.items) ? data.items : [];
  if (!symbol || !fields.length || !items.length) return null;
  const indexOf = (name) => fields.indexOf(name);
  const tradeDate = indexOf('trade_date');
  const open = indexOf('open');
  const high = indexOf('high');
  const low = indexOf('low');
  const close = indexOf('close');
  const volume = indexOf('vol') >= 0 ? indexOf('vol') : indexOf('volume');
  const bars = [];
  for (const row of items) {
    if (!Array.isArray(row)) continue;
    const dateText = text(row[tradeDate]);
    const closePrice = num(row[close]);
    if (!/^\d{8}$/.test(dateText) || closePrice == null) continue;
    const at = Date.parse(`${dateText.slice(0, 4)}-${dateText.slice(4, 6)}-${dateText.slice(6, 8)}T00:00:00+08:00`);
    if (!Number.isFinite(at)) continue;
    const openPrice = num(row[open]) ?? closePrice;
    bars.push({
      at,
      open: openPrice,
      high: num(row[high]) ?? Math.max(openPrice, closePrice),
      low: num(row[low]) ?? Math.min(openPrice, closePrice),
      close: closePrice,
      volume: num(row[volume]),
    });
  }
  bars.sort((left, right) => left.at - right.at);
  if (!bars.length) return null;
  return {
    symbol,
    points: bars.map((bar) => ({ at: bar.at, close: bar.close })),
    bars,
  };
}

function rowsFromPayload(payload) {
  const data = isRecord(payload) && isRecord(payload.data) ? payload.data : payload;
  const fields = Array.isArray(data?.fields) ? data.fields.map((item) => String(item || '').toLowerCase()) : [];
  const items = Array.isArray(data?.items) ? data.items : [];
  return { fields, items };
}

function tradeDateAt(dateText) {
  if (!/^\d{8}$/.test(dateText)) return null;
  const at = Date.parse(`${dateText.slice(0, 4)}-${dateText.slice(4, 6)}-${dateText.slice(6, 8)}T00:00:00+08:00`);
  return Number.isFinite(at) ? at : null;
}

function percentRatio(value) {
  return Number.isFinite(value) ? value / 100 : value;
}

function fieldValue(row, fields, name) {
  const index = fields.indexOf(name);
  if (index < 0) return null;
  return num(row[index]);
}

export function seriesFromTushareDailyBasic(payload, yahooSymbol) {
  const symbol = String(yahooSymbol || '').toUpperCase();
  const { fields, items } = rowsFromPayload(payload);
  const byDate = new Map();
  for (const row of items) {
    if (!Array.isArray(row)) continue;
    const dateText = text(row[fields.indexOf('trade_date')]);
    const at = tradeDateAt(dateText);
    if (!at) continue;
    const tradeDate = `${dateText.slice(0, 4)}-${dateText.slice(4, 6)}-${dateText.slice(6, 8)}`;
    byDate.set(tradeDate, {
      tradeDate,
      at,
      close: fieldValue(row, fields, 'close'),
      turnoverRate: fieldValue(row, fields, 'turnover_rate'),
      turnoverRateFloat: fieldValue(row, fields, 'turnover_rate_f'),
      volumeRatio: fieldValue(row, fields, 'volume_ratio'),
      pe: fieldValue(row, fields, 'pe'),
      peTtm: fieldValue(row, fields, 'pe_ttm'),
      pb: fieldValue(row, fields, 'pb'),
      ps: fieldValue(row, fields, 'ps'),
      psTtm: fieldValue(row, fields, 'ps_ttm'),
      dividendYield: percentRatio(fieldValue(row, fields, 'dv_ratio')),
      dividendYieldTtm: percentRatio(fieldValue(row, fields, 'dv_ttm')),
      totalShares: fieldValue(row, fields, 'total_share'),
      floatShares: fieldValue(row, fields, 'float_share'),
      freeShares: fieldValue(row, fields, 'free_share'),
      totalMarketValue: fieldValue(row, fields, 'total_mv'),
      circulatingMarketValue: fieldValue(row, fields, 'circ_mv'),
    });
  }
  return [...byDate.values()].sort((left, right) => left.at - right.at);
}

export function seriesFromTushareAdjFactors(payload) {
  const { fields, items } = rowsFromPayload(payload);
  const byDate = new Map();
  for (const row of items) {
    if (!Array.isArray(row)) continue;
    const dateText = text(row[fields.indexOf('trade_date')]);
    const at = tradeDateAt(dateText);
    const adjFactor = fieldValue(row, fields, 'adj_factor');
    if (!at || !(adjFactor > 0)) continue;
    const tradeDate = `${dateText.slice(0, 4)}-${dateText.slice(4, 6)}-${dateText.slice(6, 8)}`;
    byDate.set(tradeDate, { tradeDate, at, adjFactor });
  }
  return [...byDate.values()].sort((left, right) => left.at - right.at);
}

export function normalizeCnIndexCode(value) {
  const match = String(value || '').trim().toUpperCase().match(/^(\d{6})(?:\.(SH|SZ|SS|CSI))?$/);
  if (!match) return null;
  const code = match[1];
  let suffix = match[2] || '';
  if (suffix === 'SS') suffix = 'SH';
  if (!suffix) suffix = code === '000922' ? 'CSI' : (code.startsWith('399') ? 'SZ' : 'SH');
  return { code, tsCode: `${code}.${suffix}` };
}

function yearSlices(startDate, endDate) {
  const startYear = Number(startDate.slice(0, 4));
  const endYear = Number(endDate.slice(0, 4));
  const slices = [];
  for (let year = startYear; year <= endYear; year += 1) {
    slices.push({
      startDate: year === startYear ? startDate : `${year}0101`,
      endDate: year === endYear ? endDate : `${year}1231`,
    });
  }
  return slices;
}

export function seriesFromTushareIndexWeight(payload) {
  const { fields, items } = rowsFromPayload(payload);
  const grouped = new Map();
  for (const row of items) {
    if (!Array.isArray(row)) continue;
    const dateText = text(row[fields.indexOf('trade_date')]);
    const at = tradeDateAt(dateText);
    const symbol = tushareCodeToYahoo(text(row[fields.indexOf('con_code')]));
    const weightPercent = fieldValue(row, fields, 'weight');
    if (!at || !symbol || !(weightPercent > 0)) continue;
    const tradeDate = `${dateText.slice(0, 4)}-${dateText.slice(4, 6)}-${dateText.slice(6, 8)}`;
    const bucket = grouped.get(tradeDate) || { tradeDate, at, members: new Map() };
    bucket.members.set(symbol, { symbol, weight: weightPercent / 100 });
    grouped.set(tradeDate, bucket);
  }
  return [...grouped.values()]
    .sort((left, right) => left.at - right.at)
    .map((snapshot) => ({
      tradeDate: snapshot.tradeDate,
      at: snapshot.at,
      members: [...snapshot.members.values()].sort((left, right) => right.weight - left.weight || left.symbol.localeCompare(right.symbol)),
    }));
}

function mergeWeightSnapshots(groups) {
  const byDate = new Map();
  for (const snapshot of groups) {
    const current = byDate.get(snapshot.tradeDate) || { tradeDate: snapshot.tradeDate, at: snapshot.at, members: new Map() };
    for (const member of snapshot.members) current.members.set(member.symbol, member);
    byDate.set(snapshot.tradeDate, current);
  }
  return [...byDate.values()]
    .sort((left, right) => left.at - right.at)
    .map((snapshot) => ({
      tradeDate: snapshot.tradeDate,
      at: snapshot.at,
      members: [...snapshot.members.values()],
    }));
}

export function createTushareClient(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const token = String(options.token ?? process.env.TUSHARE_TOKEN ?? '').trim();
  const baseUrl = String(options.baseUrl ?? process.env.TUSHARE_URL ?? DEFAULT_URL).replace(/\/+$/, '');

  async function request(apiName, params, fields) {
    if (!token) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          api_name: apiName,
          token,
          params,
          fields,
        }),
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Tushare HTTP ${response.status}`);
      const payload = await response.json();
      if (isRecord(payload) && payload.code != null && Number(payload.code) !== 0) {
        const message = text(payload.msg) || `Tushare ${apiName} 请求失败`;
        throw new Error(message);
      }
      return payload;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error('Tushare 请求超时');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchHistory(symbols, { range = '6mo', interval = '1d' } = {}) {
    if (interval !== '1d' || !token) return [];
    const unique = [...new Set((symbols || []).map((item) => String(item || '').trim().toUpperCase()).filter(isTushareDailySymbol))];
    if (!unique.length) return [];
    const window = rangeWindow(range);
    const series = [];
    for (const symbol of unique) {
      const tsCode = yahooToTushareCode(symbol);
      if (!tsCode) continue;
      try {
        const payload = await request('daily', {
          ts_code: tsCode,
          start_date: window.startDate,
          end_date: window.endDate,
        }, 'ts_code,trade_date,open,high,low,close,vol');
        const mapped = seriesFromTushareDaily(payload, symbol);
        if (mapped) series.push(mapped);
      } catch {
        continue;
      }
    }
    const bySymbol = new Map(series.map((item) => [item.symbol, item]));
    return unique.map((symbol) => bySymbol.get(symbol)).filter(Boolean);
  }

  async function fetchTable(apiName, symbol, range, fields, mapRows) {
    if (!token || !isTushareDailySymbol(symbol)) return null;
    const tsCode = yahooToTushareCode(symbol);
    if (!tsCode) return null;
    const window = rangeWindow(range);
    const payload = await request(apiName, {
      ts_code: tsCode,
      start_date: window.startDate,
      end_date: window.endDate,
    }, fields);
    if (!payload) return null;
    return mapRows(payload, String(symbol).trim().toUpperCase());
  }

  async function fetchDailyBasic(symbol, { range = '5y' } = {}) {
    return fetchTable(
      'daily_basic',
      symbol,
      range,
      'ts_code,trade_date,close,turnover_rate,turnover_rate_f,volume_ratio,pe,pe_ttm,pb,ps,ps_ttm,dv_ratio,dv_ttm,total_share,float_share,free_share,total_mv,circ_mv',
      seriesFromTushareDailyBasic,
    );
  }

  async function fetchAdjFactors(symbol, { range = '5y' } = {}) {
    return fetchTable(
      'adj_factor',
      symbol,
      range,
      'ts_code,trade_date,adj_factor',
      seriesFromTushareAdjFactors,
    );
  }

  async function fetchIndexWeights(index, { range = '5y' } = {}) {
    if (!token) return null;
    const normalized = normalizeCnIndexCode(index);
    if (!normalized) return null;
    const window = rangeWindow(range);
    const groups = [];
    for (const slice of yearSlices(window.startDate, window.endDate)) {
      const payload = await request('index_weight', {
        index_code: normalized.tsCode,
        start_date: slice.startDate,
        end_date: slice.endDate,
      }, 'index_code,con_code,trade_date,weight');
      if (!payload) return null;
      groups.push(...seriesFromTushareIndexWeight(payload));
    }
    return { index: normalized.code, snapshots: mergeWeightSnapshots(groups) };
  }

  return { fetchHistory, fetchDailyBasic, fetchAdjFactors, fetchIndexWeights, enabled: Boolean(token) };
}
