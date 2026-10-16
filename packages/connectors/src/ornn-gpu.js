import { decimalFromNumber } from './compute-prices.js';

export const ORNN_INDEX_ROOT = 'https://data.ornn.com/api/public-index/gpu';
const USER_AGENT = 'AICenter/0.2 (Ornn GPU index; internal attribution)';

export function ornnIndexUrl(pathName) {
  return `${ORNN_INDEX_ROOT}/${encodeURIComponent(pathName)}/index-history`;
}

export function selectOrnnIndexHistory(payload, pathName = '') {
  const label = pathName || '指数';
  if (!payload || payload.success !== true || !Array.isArray(payload.data)) {
    return { points: [], warnings: [`Ornn ${label} 没有返回数据`] };
  }
  const points = [];
  for (const item of payload.data) {
    const capturedAt = Date.parse(item?.timestamp);
    const close = decimalFromNumber(item?.index_value);
    if (!Number.isFinite(capturedAt) || !close || close === '0') continue;
    points.push({ capturedAt, close });
  }
  points.sort((left, right) => left.capturedAt - right.capturedAt);
  const kept = points.length > 400 ? points.slice(-400) : points;
  const warnings = kept.length ? [] : [`Ornn ${label} 没有可保存的结算价`];
  return { points: kept, warnings };
}

export async function fetchOrnnIndex({ fetch: fetchImpl = fetch, pathName } = {}) {
  const response = await fetchImpl(ornnIndexUrl(pathName), {
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Ornn ${response.status}`);
  return selectOrnnIndexHistory(await response.json(), pathName);
}
