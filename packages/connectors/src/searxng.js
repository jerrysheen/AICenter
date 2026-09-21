/**
 * LEGACY Host search connector. Not the production `search.web` Provider.
 * Production Ask uses Harness built-in web_search / web_fetch.
 */
const DEFAULT_BASE_URL = 'http://127.0.0.1:8888';
const DEFAULT_TIMEOUT_MS = 20_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const SAME_HOST_FLOOD = 3;
const MULTI_PART_SUFFIXES = new Set([
  'ac.uk', 'co.in', 'co.jp', 'co.uk', 'com.au', 'com.cn', 'com.tw', 'gov.in',
]);
const DEGRADED_ENGINES = new Set(['bing']);
const INTERSTITIAL_HOSTS = new Set([
  'account.microsoft.com',
  'accounts.google.com',
  'login.live.com',
  'login.microsoftonline.com',
  'myaccount.microsoft.com',
  'signup.live.com',
  'web.whatsapp.com',
]);

export class WebSearchUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WebSearchUnavailableError';
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false;
}

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function parseBaseUrl(value) {
  const raw = text(value, DEFAULT_BASE_URL);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('AI_CENTER_SEARCH_URL 不是有效 URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Search Worker 只支持 http 或 https');
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error('Search Worker 只允许回环地址');
  }
  return parsed.origin;
}

function publishedAtFrom(row) {
  const raw = row.publishedDate ?? row.published_at ?? row.pubdate ?? row.date ?? null;
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const millis = raw > 1e12 ? raw : raw * 1000;
    const parsed = new Date(millis);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const value = text(String(raw));
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

function httpUrl(value) {
  const raw = text(value);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function hostKey(url) {
  const host = hostnameOf(url).replace(/^www\./, '');
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return host;
  const tail2 = parts.slice(-2).join('.');
  if (MULTI_PART_SUFFIXES.has(tail2) && parts.length >= 3) return parts.slice(-3).join('.');
  return tail2;
}

function engineKey(value) {
  return text(value).toLowerCase();
}

export function searchLanguage(query) {
  return /[\u3400-\u9fff]/.test(String(query || '')) ? 'zh-CN' : 'en-US';
}

export function parseUnresponsiveEngines(payload) {
  const raw = isRecord(payload) ? payload.unresponsive_engines : null;
  const rows = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (Array.isArray(item)) {
        const engine = text(item[0]);
        if (engine) rows.push({ engine, reason: text(item[1]) });
      } else if (typeof item === 'string' && item.trim()) {
        rows.push({ engine: item.trim(), reason: '' });
      }
    }
  } else if (isRecord(raw)) {
    for (const [engine, reason] of Object.entries(raw)) {
      if (text(engine)) rows.push({ engine: text(engine), reason: text(reason) });
    }
  }
  return rows;
}

function isInterstitialUrl(url) {
  const host = hostnameOf(url);
  if (!host) return false;
  if (INTERSTITIAL_HOSTS.has(host)) return true;
  if (/^(accounts?|login|signin|signup)\./i.test(host)) return true;
  try {
    const path = new URL(url).pathname;
    return /\/(login|signin|account|signup)(\/|$)/i.test(path)
      && /microsoft|google|apple|facebook|live\.com/i.test(host);
  } catch {
    return false;
  }
}

function mapRawResults(payload, limit) {
  const rows = isRecord(payload) && Array.isArray(payload.results) ? payload.results : [];
  const seen = new Set();
  const results = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const url = httpUrl(row.url || row.pretty_url);
    const title = text(row.title, url);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    results.push({
      title,
      url,
      snippet: text(row.content || row.snippet).slice(0, 500),
      engine: text(row.engine),
      publishedAt: publishedAtFrom(row),
    });
    if (results.length >= Math.max(limit * 3, 20)) break;
  }
  return results;
}

function floodedHosts(results, minSameHost = SAME_HOST_FLOOD) {
  const counts = new Map();
  for (const row of results) {
    const host = hostKey(row.url);
    if (!host) continue;
    counts.set(host, (counts.get(host) || 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count >= minSameHost).map(([host]) => host);
}

function buildSearchNote({ unresponsive, flooded, droppedInterstitial, droppedDegraded }) {
  const parts = [];
  if (unresponsive.length) parts.push('部分检索源不可用（验证码或限流）。');
  if (flooded.length) parts.push('已丢弃同一站点刷屏结果。');
  if (droppedInterstitial) parts.push('已丢弃登录页或应用壳页面。');
  if (droppedDegraded) parts.push('已丢弃降级检索源结果。');
  return parts.join(' ').slice(0, 1_000);
}

export function normalizeWebSearchResults(payload, { query, limit = 5, observedAt = Date.now() } = {}) {
  const size = Math.min(20, Math.max(1, Number(limit) || 5));
  const unresponsive = parseUnresponsiveEngines(payload);
  const raw = mapRawResults(payload, size);
  const afterInterstitial = raw.filter((row) => !isInterstitialUrl(row.url));
  const droppedInterstitial = afterInterstitial.length !== raw.length;
  const flooded = floodedHosts(afterInterstitial);
  const floodedSet = new Set(flooded);
  const afterFlood = afterInterstitial.filter((row) => !floodedSet.has(hostKey(row.url)));
  const trusted = afterFlood.filter((row) => !DEGRADED_ENGINES.has(engineKey(row.engine)));
  const droppedDegraded = trusted.length !== afterFlood.length;
  return {
    query: text(isRecord(payload) ? payload.query : '', query),
    available: true,
    results: trusted.slice(0, size),
    observedAt,
    note: buildSearchNote({
      unresponsive,
      flooded,
      droppedInterstitial,
      droppedDegraded,
    }),
  };
}

export function createSearxngSearchProvider(options = {}) {
  const baseUrl = parseBaseUrl(options.baseUrl || process.env.AI_CENTER_SEARCH_URL);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;

  return Object.freeze({
    id: 'searxng',
    baseUrl,
    async search({ query, limit = 5, signal } = {}) {
      const q = text(query);
      if (!q) throw new Error('搜索词不能为空');
      const size = Math.min(20, Math.max(1, Number(limit) || 5));
      const url = new URL('/search', baseUrl);
      url.searchParams.set('q', q);
      url.searchParams.set('format', 'json');
      url.searchParams.set('language', searchLanguage(q));

      const controller = new AbortController();
      const onAbort = () => controller.abort();
      if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
          signal: controller.signal,
        });
        const contentType = String(response.headers?.get?.('content-type') || '');
        if (!response.ok) {
          throw new WebSearchUnavailableError(`SearXNG HTTP ${response.status}`);
        }
        if (contentType.includes('text/html')) {
          throw new WebSearchUnavailableError('SearXNG 未启用 JSON 输出');
        }
        const payload = await response.json();
        return normalizeWebSearchResults(payload, { query: q, limit: size });
      } catch (error) {
        if (error instanceof WebSearchUnavailableError) throw error;
        if (error?.name === 'AbortError') {
          if (signal?.aborted) throw error;
          throw new WebSearchUnavailableError('SearXNG 请求超时');
        }
        if (error instanceof SyntaxError) {
          throw new WebSearchUnavailableError('SearXNG 未返回 JSON');
        }
        const message = String(error?.message || error);
        if (/fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|network/i.test(message)) {
          throw new WebSearchUnavailableError('SearXNG 不可用');
        }
        throw new WebSearchUnavailableError(message.slice(0, 300));
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
      }
    },
  });
}
