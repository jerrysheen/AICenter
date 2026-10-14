import {
  HARNESS_ELUCID_DEFAULT_BASE_URL,
  HARNESS_ELUCID_DEFAULT_MODEL,
  HARNESS_ELUCID_PROVIDER,
  HARNESS_PROVIDER,
} from './constants.js';
import { resolveHarnessLlm, resolveHarnessLlmProvider } from './llm-route.js';
import { createUsageFetch } from '../../connectors/src/model-usage-fetch.js';

export const HARNESS_ELUCID_SEARCH_PROVIDER_ID = HARNESS_ELUCID_PROVIDER;
export const HARNESS_DEEPSEEK_SEARCH_PROVIDER_ID = HARNESS_PROVIDER;

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function httpUrl(value) {
  const raw = text(value);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false;
}

const MISSING_GROK_SEARCH_KEY = '问答联网搜索需要 ELUCID_GROK_API_KEY，不会回退到 DeepSeek 搜索';

// Q&A search ignores DSH_WEB_SEARCH_PROVIDER. dsh-web prefers plugin config,
// and the overlay writes this return value into web.searchProvider.
export function resolveHarnessWebSearchProvider(env = process.env) {
  void env;
  return HARNESS_ELUCID_SEARCH_PROVIDER_ID;
}

export function resolveElucidSearchTarget(env = process.env) {
  const keyEnv = text(env.ELUCID_GROK_API_KEY)
    ? 'ELUCID_GROK_API_KEY'
    : (text(env.AI_CENTER_GROK_API_KEY) ? 'AI_CENTER_GROK_API_KEY' : 'ELUCID_GROK_API_KEY');
  const chat = resolveHarnessLlmProvider(env) === HARNESS_ELUCID_PROVIDER
    ? resolveHarnessLlm(env)
    : null;
  return {
    apiKeyEnv: keyEnv,
    apiKey: text(env[keyEnv]),
    baseURL: (text(env.AI_CENTER_ELUCID_GROK_API_ROOT) || chat?.baseURL || HARNESS_ELUCID_DEFAULT_BASE_URL).replace(/\/+$/, ''),
    model: chat?.model || HARNESS_ELUCID_DEFAULT_MODEL,
  };
}

export function extractElucidSearchSources(payload) {
  const seen = new Set();
  const sources = [];
  const add = (item = {}) => {
    const url = httpUrl(item.url || item.uri);
    if (!url || seen.has(url)) return;
    seen.add(url);
    const title = text(item.title);
    const snippet = text(item.snippet || item.cited_text || item.text);
    sources.push({
      url,
      ...(title ? { title } : {}),
      ...(snippet ? { snippet } : {}),
    });
  };
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node.type === 'url_citation' || node.type === 'citation') add(node);
    if (Array.isArray(node.sources)) node.sources.forEach(add);
    if (Array.isArray(node.annotations)) node.annotations.forEach(walk);
    if (node.action) walk(node.action);
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') walk(value);
    }
  };
  walk(payload);
  return sources;
}

export function extractElucidSearchText(payload) {
  if (text(payload?.output_text)) return text(payload.output_text);
  const blocks = [];
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    for (const block of Array.isArray(item?.content) ? item.content : []) {
      if (block?.type === 'output_text' || block?.type === 'text') {
        const value = text(block.text);
        if (value) blocks.push(value);
      }
    }
  }
  return blocks.join('\n').trim();
}

export function mapElucidSearchResponse(payload, { maxResults } = {}) {
  const usedSearch = (Array.isArray(payload?.output) ? payload.output : [])
    .some((item) => item?.type === 'web_search_call');
  if (!usedSearch) {
    throw new Error('Elucid 未返回 web_search_call，Grok 原生搜索当前不可用');
  }
  const sources = extractElucidSearchSources(payload);
  if (sources.length === 0) {
    throw new Error('Elucid 搜索没有返回可引用的 URL');
  }
  const size = Number(maxResults) > 0 ? Number(maxResults) : sources.length;
  const clipped = sources.slice(0, size);
  const content = extractElucidSearchText(payload);
  return {
    ...(content ? { content } : {}),
    sources: clipped,
    truncated: sources.length > clipped.length,
  };
}

export async function searchElucidWeb(request = {}, options = {}) {
  const query = text(request.query);
  if (!query) throw new Error('搜索词不能为空');
  const env = options.env || process.env;
  const target = resolveElucidSearchTarget(env);
  const llm = options.llm;
  const apiKey = text(options.apiKey || llm?.apiKey || target.apiKey);
  const baseURL = (text(options.baseURL || llm?.baseURL || target.baseURL) || HARNESS_ELUCID_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = text(options.model || llm?.model || target.model) || HARNESS_ELUCID_DEFAULT_MODEL;
  if (!apiKey) throw new Error(MISSING_GROK_SEARCH_KEY);
  const fetchImpl = createUsageFetch(options.fetchImpl || fetch, { provider: 'elucid-grok', model, observer: options.usageObserver, stage: 'web-search' });
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 90_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (request.signal) {
    if (request.signal.aborted) controller.abort();
    else request.signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
    const body = {
      model,
      input: `Search the live web for this query. Prefer official and primary sources. Query: ${query}`,
      tools: [{ type: 'web_search' }],
      tool_choice: 'required',
      include: ['web_search_call.action.sources'],
      max_output_tokens: 800,
    };
    const post = (payload) => fetchImpl(`${baseURL}/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    let response = await post(body);
    let payload = await response.json().catch(() => ({}));
    if (!response.ok && response.status === 400) {
      const { include: _include, ...withoutInclude } = body;
      void _include;
      response = await post(withoutInclude);
      payload = await response.json().catch(() => ({}));
    }
    if (!response.ok) {
      const detail = text(payload?.error?.message);
      throw new Error(detail || `Elucid 搜索失败（HTTP ${response.status}）`);
    }
    return mapElucidSearchResponse(payload, { maxResults: request.maxResults });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Elucid 搜索已取消或超时');
    throw error;
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener?.('abort', onAbort);
  }
}

export function createElucidWebSearchProvider(options = {}) {
  const env = options.env || process.env;
  return Object.freeze({
    id: HARNESS_ELUCID_SEARCH_PROVIDER_ID,
    available() {
      return Boolean(resolveElucidSearchTarget(env).apiKey);
    },
    search(request, signal) {
      const target = resolveElucidSearchTarget(env);
      if (!target.apiKey && !text(options.apiKey)) throw new Error(MISSING_GROK_SEARCH_KEY);
      return searchElucidWeb({ ...request, signal }, {
        ...options,
        env,
        apiKey: text(options.apiKey) || target.apiKey,
        baseURL: target.baseURL,
        model: target.model,
      });
    },
  });
}
