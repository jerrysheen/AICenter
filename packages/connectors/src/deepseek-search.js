/**
 * LEGACY / LOCAL-RUNTIME ONLY
 *
 * Domain `search.web` Provider for the in-process Agent loop fallback.
 * Production Ask / article reading uses Harness built-in web_search / web_fetch.
 * Do not create this from the default Worker/Web composition root.
 */
import { WebSearchUnavailableError } from './searxng.js';

export const DEEPSEEK_SEARCH_PROVIDER_ID = 'deepseek';
export const DEEPSEEK_SEARCH_DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic/v1';
export const DEEPSEEK_SEARCH_DEFAULT_MODEL = 'deepseek-v4-flash';
export const DEEPSEEK_SEARCH_DEFAULT_API_VERSION = '2023-06-01';
export const DEEPSEEK_SEARCH_DEFAULT_MAX_TOKENS = 4096;
export const DEEPSEEK_SEARCH_DEFAULT_MAX_USES = 5;
export const DEEPSEEK_SEARCH_DEFAULT_TIMEOUT_MS = 60_000;
const USER_AGENT = 'ai-center-search/0.2.0';

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBaseUrl(value) {
  const raw = text(value, DEEPSEEK_SEARCH_DEFAULT_BASE_URL);
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('DEEPSEEK_SEARCH_BASE_URL 必须是 http(s) 地址');
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch (error) {
    if (error instanceof TypeError) throw new Error('DEEPSEEK_SEARCH_BASE_URL 不是有效 URL');
    throw error;
  }
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

function parsePublishedAt(raw) {
  const value = text(raw);
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

function clipError(value, max = 240) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
}

function readErrorDetail(payload) {
  if (typeof payload === 'string') return clipError(payload);
  if (!isRecord(payload)) return '';
  if (typeof payload.error === 'string') return clipError(payload.error);
  return clipError(payload.error?.message || payload.message || '');
}

/**
 * Join `text` block citations to result URLs. DeepSeek `web_search_result`
 * items typically carry url/title/page_age only; the excerpt lives in citations.
 */
export function citationSnippetsFromBlocks(blocks = []) {
  const map = new Map();
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block?.type !== 'text') continue;
    for (const cite of Array.isArray(block.citations) ? block.citations : []) {
      const url = httpUrl(cite?.url);
      const snippet = text(cite?.cited_text);
      if (url && snippet && !map.has(url)) map.set(url, snippet);
    }
  }
  return map;
}

export function mapDeepSeekSearchResponse(response, { query, limit = 5, observedAt = Date.now() } = {}) {
  const size = Math.min(20, Math.max(1, Number(limit) || 5));
  const blocks = isRecord(response) && Array.isArray(response.content) ? response.content : [];
  const resultBlocks = blocks.filter((block) => block?.type === 'web_search_tool_result');
  if (resultBlocks.length === 0) {
    throw new WebSearchUnavailableError('DeepSeek 未返回 web_search_tool_result，native search 当前不可用');
  }

  const snippets = citationSnippetsFromBlocks(blocks);
  const seen = new Set();
  const results = [];
  for (const block of resultBlocks) {
    for (const item of Array.isArray(block.content) ? block.content : []) {
      if (item?.type !== 'web_search_result') continue;
      const url = httpUrl(item.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      results.push({
        title: text(item.title),
        url,
        snippet: snippets.get(url) || '',
        engine: '',
        publishedAt: parsePublishedAt(item.page_age),
      });
      if (results.length >= size) break;
    }
    if (results.length >= size) break;
  }

  return {
    query: text(query),
    available: true,
    results,
    observedAt,
    note: '',
  };
}

export function createDeepSeekSearchProvider(options = {}) {
  const env = options.env || process.env;
  const apiKey = text(options.apiKey || env.DEEPSEEK_API_KEY);
  if (!apiKey) throw new Error('缺少 DEEPSEEK_API_KEY，search.web 未启用');

  const baseUrl = parseBaseUrl(options.baseUrl || env.DEEPSEEK_SEARCH_BASE_URL);
  const model = text(options.model || env.DEEPSEEK_SEARCH_MODEL, DEEPSEEK_SEARCH_DEFAULT_MODEL);
  const apiVersion = text(options.apiVersion, DEEPSEEK_SEARCH_DEFAULT_API_VERSION);
  const maxTokens = positiveInteger(options.maxTokens, DEEPSEEK_SEARCH_DEFAULT_MAX_TOKENS);
  const maxUses = positiveInteger(options.maxUses, DEEPSEEK_SEARCH_DEFAULT_MAX_USES);
  const timeoutMs = positiveInteger(options.timeoutMs, DEEPSEEK_SEARCH_DEFAULT_TIMEOUT_MS);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now || (() => Date.now());

  return Object.freeze({
    id: DEEPSEEK_SEARCH_PROVIDER_ID,
    baseUrl,
    async search({ query, limit = 5, signal } = {}) {
      const q = text(query);
      if (!q) throw new Error('搜索词不能为空');
      const size = Math.min(20, Math.max(1, Number(limit) || 5));
      const endpoint = `${baseUrl}/messages`;
      const body = {
        model,
        max_tokens: maxTokens,
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: `Perform a web search for the query: ${q}` }],
        }],
        tools: [{
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: maxUses,
        }],
      };

      const controller = new AbortController();
      const onAbort = () => controller.abort();
      if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'x-api-key': apiKey,
            authorization: `Bearer ${apiKey}`,
            'anthropic-version': apiVersion,
            'content-type': 'application/json',
            accept: 'application/json',
            'user-agent': USER_AGENT,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const status = Number(response.status) || 0;
        if (!response.ok) {
          let detail = '';
          try {
            detail = readErrorDetail(await response.json());
          } catch {
            detail = '';
          }
          if (status === 401 || status === 403) {
            throw new WebSearchUnavailableError(
              detail
                ? `DeepSeek search 权限错误（HTTP ${status}）：${detail}`
                : `DeepSeek search 权限错误（HTTP ${status}）`,
            );
          }
          throw new WebSearchUnavailableError(
            detail
              ? `DeepSeek search 不可用（HTTP ${status}）：${detail}`
              : `DeepSeek search 不可用（HTTP ${status}）`,
          );
        }
        let payload;
        try {
          payload = await response.json();
        } catch {
          throw new WebSearchUnavailableError('DeepSeek 未返回 JSON');
        }
        return mapDeepSeekSearchResponse(payload, { query: q, limit: size, observedAt: now() });
      } catch (error) {
        if (error instanceof WebSearchUnavailableError) throw error;
        if (error?.name === 'AbortError') {
          if (signal?.aborted) throw error;
          throw new WebSearchUnavailableError('DeepSeek search 请求超时');
        }
        const message = String(error?.message || error);
        if (/fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|network/i.test(message)) {
          throw new WebSearchUnavailableError('DeepSeek search 不可用');
        }
        throw new WebSearchUnavailableError(clipError(message, 300) || 'DeepSeek search 不可用');
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
      }
    },
  });
}
