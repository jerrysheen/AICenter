const DEFAULT_BASE_URL = 'http://127.0.0.1:8888';
const DEFAULT_TIMEOUT_MS = 20_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

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

export function normalizeWebSearchResults(payload, { query, limit = 5, observedAt = Date.now() } = {}) {
  const rows = isRecord(payload) && Array.isArray(payload.results) ? payload.results : [];
  const results = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const url = httpUrl(row.url || row.pretty_url);
    const title = text(row.title, url);
    if (!url || !title) continue;
    results.push({
      title,
      url,
      snippet: text(row.content || row.snippet).slice(0, 500),
      engine: text(row.engine),
      publishedAt: publishedAtFrom(row),
    });
    if (results.length >= limit) break;
  }
  return {
    query: text(isRecord(payload) ? payload.query : '', query),
    available: true,
    results,
    observedAt,
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
