const EXACT_PATHS = new Set([
  '/api/v1/reports/daily',
  '/api/v1/reports/daily/latest',
  '/api/v1/reports/daily/brief',
  '/api/v1/reports/daily/latest/brief',
  '/api/v1/reports/daily/briefs',
  '/api/v1/reports/daily/brief/window',
  '/api/v1/reports/daily/evidence',
  '/api/v1/reports/daily/tracking',
  '/api/v1/reports/daily/analysis/status',
  '/api/v1/reports/hourly',
  '/api/v1/reports/hourly/index',
  '/api/v1/reports/hourly/snapshot',
  '/api/v1/reports/hourly/search',
  '/api/v1/reports/hourly/evidence',
  '/api/v1/reports/tree',
  '/api/v1/reports/tree/edition',
  '/api/v1/reports/tree/node',
  '/api/v1/reports/tree/children',
  '/api/v1/reports/tree/editorial',
  '/api/v1/reports/reading-hour',
  '/api/v1/reports/reading-hour/index',
  '/api/v1/reports/reading-hour/snapshot',
  '/api/v1/investor-discussion',
  '/api/v1/markets',
  '/api/v1/markets/search',
  '/api/v1/markets/history',
  '/api/v1/markets/analysis',
  '/api/v1/markets/baskets',
  '/api/v1/hardware-prices',
  '/api/v1/compute-prices',
  '/api/v1/etf-whale/overview',
  '/api/v1/etf-whale/daily',
  '/api/v1/etf-whale/signals',
  '/api/v1/etf-whale/series',
  '/api/v1/feed',
  '/api/v1/feed/media/article',
  '/api/v1/posts',
]);

const PATH_PATTERNS = [
  /^\/api\/v1\/feed\/(?:x|xueqiu|bilibili|trendforce|media)$/,
  /^\/api\/v1\/hardware-prices\/series\/[a-f0-9]{64}$/,
  /^\/api\/v1\/hardware-prices\/snapshots\/[0-9a-f-]{36}$/i,
  /^\/api\/v1\/content-items\/(?:[0-9a-f-]{36}|[A-Za-z0-9_-]+:[^/]+)$/i,
  /^\/api\/v1\/content-items\/official\/[^/]+$/i,
  /^\/api\/v1\/(?:content-items|feed\/items)\/[^/]+\/original$/i,
  /^\/api\/v1\/posts\/[0-9a-f-]+$/i,
  /^\/api\/v1\/etf-whale\/etfs\/[^/]+$/,
];

export function isApiTokenAllowlisted(method, pathname) {
  if (method !== 'GET') return false;
  const path = String(pathname || '');
  if (EXACT_PATHS.has(path)) return true;
  return PATH_PATTERNS.some((pattern) => pattern.test(path));
}

export function readBearerToken(header) {
  const value = String(header || '').trim();
  if (!value) return { present: false, token: '' };
  const match = /^Bearer\s+(\S+)$/i.exec(value);
  if (!match || /\s/.test(value.slice(match[0].length))) return { present: false, token: '' };
  return { present: true, token: match[1] };
}

export function requestWantsRefresh(url) {
  const refresh = String(url?.searchParams?.get('refresh') || '').toLowerCase();
  return refresh === '1' || refresh === 'true';
}
