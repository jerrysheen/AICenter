import { fetchAllowlisted } from './media/http.js';

export const INFERENCEX_ORIGIN = 'https://inferencex.semianalysis.com';
export const INFERENCEX_PARSER_VERSION = 'inferencex-1';
export const INFERENCEX_MIN_INTERVAL_MS = 3000;
const AVAILABILITY_URL = `${INFERENCEX_ORIGIN}/api/v1/availability`;
const MODEL_NAME = /^[\w.+-]{1,120}$/;

export function createInferenceRequestGate({
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let last = null;
  return async function wait() {
    const current = now();
    if (last != null && current - last < INFERENCEX_MIN_INTERVAL_MS) {
      await sleep(INFERENCEX_MIN_INTERVAL_MS - (current - last));
    }
    last = now();
  };
}

export function defaultBenchmarkModels(value = process.env.AI_CENTER_INFERENCEX_BENCHMARK_MODELS) {
  const raw = value == null || String(value).trim() === '' ? 'DeepSeek-R1-0528' : String(value);
  const models = [];
  for (const part of raw.split(/[,\s]+/)) {
    const name = part.trim();
    if (!MODEL_NAME.test(name) || models.includes(name)) continue;
    models.push(name);
  }
  return models.slice(0, 4);
}

export function buildAvailabilityUrl() {
  const url = new URL(AVAILABILITY_URL);
  if (url.search) throw new Error('availability 不接受查询参数');
  return url.toString();
}

export function buildBenchmarkUrl(model) {
  const name = String(model || '').trim();
  if (!MODEL_NAME.test(name)) throw new Error('benchmarks 的 model 参数无效');
  const url = new URL('/api/v1/benchmarks', INFERENCEX_ORIGIN);
  url.searchParams.set('model', name);
  if ([...url.searchParams.keys()].some((key) => key !== 'model')) throw new Error('benchmarks 只发送 model');
  return url.toString();
}

function finiteNumber(value) {
  const number = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function decimalString(value) {
  const number = finiteNumber(value);
  if (number == null || number < 0) return null;
  const text = Number.isInteger(number) ? String(number) : number.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text) ? text : null;
}

export function citationEligible(row) {
  if (!row || typeof row !== 'object') return false;
  if (!String(row.model || '').trim()) return false;
  if (!String(row.hardware || '').trim()) return false;
  if (!String(row.framework || '').trim()) return false;
  if (!String(row.precision || '').trim()) return false;
  if (!String(row.specMethod || row.spec_method || '').trim()) return false;
  if (!String(row.benchmarkType || row.benchmark_type || '').trim()) return false;
  if (typeof row.disagg !== 'boolean') return false;
  if (finiteNumber(row.isl) == null || row.isl < 0) return false;
  if (finiteNumber(row.osl) == null || row.osl < 0) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(row.date || ''))) return false;
  const sourceUrl = String(row.sourceUrl || '');
  if (!sourceUrl.startsWith('https://inferencex.semianalysis.com/')) return false;
  return true;
}

function conditionFrom(row, sourceUrl) {
  const mapped = {
    model: String(row?.model || '').trim(),
    hardware: String(row?.hardware || '').trim(),
    framework: String(row?.framework || '').trim(),
    precision: String(row?.precision || '').trim(),
    isl: finiteNumber(row?.isl),
    osl: finiteNumber(row?.osl),
    disagg: row?.disagg,
    specMethod: String(row?.spec_method || '').trim(),
    benchmarkType: String(row?.benchmark_type || '').trim(),
    date: String(row?.date || '').trim(),
    sourceUrl,
  };
  if (!citationEligible(mapped)) return null;
  return {
    ...mapped,
    isl: mapped.isl,
    osl: mapped.osl,
  };
}

export function parseAvailabilityPayload(payload, sourceUrl = AVAILABILITY_URL) {
  if (!Array.isArray(payload)) return { ok: false, health: 'parse_failed', rows: [], rejected: 0, note: 'availability 不是数组' };
  const rows = [];
  let rejected = 0;
  for (const item of payload) {
    const row = conditionFrom(item, sourceUrl);
    if (!row) {
      rejected += 1;
      continue;
    }
    rows.push(row);
    if (rows.length >= 800) break;
  }
  const truncated = payload.length - rejected > rows.length;
  return {
    ok: true,
    health: rows.length ? 'ready' : 'empty',
    rows,
    rejected,
    note: [rejected ? `skipped=${rejected}` : '', truncated ? 'truncated=1' : ''].filter(Boolean).join(' '),
  };
}

export function parseBenchmarkPayload(payload, sourceUrl) {
  if (!Array.isArray(payload)) return { ok: false, health: 'parse_failed', rows: [], rejected: 0, note: 'benchmarks 不是数组' };
  const rows = [];
  let rejected = 0;
  for (const item of payload) {
    const base = conditionFrom(item, sourceUrl);
    if (!base) {
      rejected += 1;
      continue;
    }
    rows.push({
      ...base,
      tokensPerSecondPerGpu: decimalString(item?.metrics?.tput_per_gpu),
      citationEligible: true,
      investmentUse: 'not_a_conclusion',
    });
    if (rows.length >= 400) break;
  }
  const truncated = payload.length - rejected > rows.length;
  return {
    ok: true,
    health: rows.length ? 'ready' : 'empty',
    rows,
    rejected,
    note: [rejected ? `skipped=${rejected}` : '', truncated ? 'truncated=1' : ''].filter(Boolean).join(' '),
  };
}

async function readJson(url, { fetchImpl, lookupImpl, gate, maxBytes = 8_000_000 } = {}) {
  if (gate) await gate();
  const fetched = await fetchAllowlisted({
    url,
    allowedHosts: ['inferencex.semianalysis.com'],
    redirectHosts: ['inferencex.semianalysis.com'],
  }, { fetchImpl, lookupImpl, maxBytes, maxAttempts: 1 });
  if (!fetched.ok) return { ok: false, health: fetched.status === 400 ? 'bad_request' : fetched.health, status: fetched.status ?? null, note: fetched.note || '' };
  try {
    return { ok: true, health: 'ready', status: fetched.status, payload: JSON.parse(fetched.body || 'null') };
  } catch {
    return { ok: false, health: 'parse_failed', status: fetched.status, note: '响应不是 JSON' };
  }
}

export async function fetchInferenceAvailability(options = {}) {
  const url = buildAvailabilityUrl();
  const fetched = await readJson(url, options);
  if (!fetched.ok) return { ...fetched, rows: [], rejected: 0, sourceUrl: url };
  const parsed = parseAvailabilityPayload(fetched.payload, url);
  return { ...parsed, sourceUrl: url, status: fetched.status };
}

export async function fetchInferenceBenchmarks(model, options = {}) {
  const url = buildBenchmarkUrl(model);
  const fetched = await readJson(url, options);
  if (!fetched.ok) return { ...fetched, rows: [], rejected: 0, sourceUrl: url, model };
  const parsed = parseBenchmarkPayload(fetched.payload, url);
  return { ...parsed, sourceUrl: url, model, status: fetched.status };
}
