import { WebSearchInputSchema, WebSearchViewSchema } from '../schemas.js';

function isAbortError(error, signal) {
  return signal?.aborted || error?.name === 'AbortError';
}

function isUnavailableError(error) {
  return error?.name === 'WebSearchUnavailableError'
    || /unavailable|timeout|timed out|ECONNREFUSED|fetch failed/i.test(String(error?.message ?? error));
}

function unavailableResult(query, note = 'Web 搜索不可用') {
  return {
    query,
    available: false,
    results: [],
    observedAt: Date.now(),
    note: String(note || 'Web 搜索不可用').slice(0, 1_000),
  };
}

export function createWebSearchSourceDefinition(searchProvider) {
  if (!searchProvider?.search) throw new TypeError('searchProvider.search is required');
  return {
    manifest: {
      id: 'search.web',
      title: 'Web 搜索',
      category: 'search',
      providerId: searchProvider.id ?? 'search',
      visibility: 'public',
      viewKind: 'search-results',
      capabilities: ['read'],
      guideRefs: [],
    },
    inputSchema: WebSearchInputSchema,
    outputSchema: WebSearchViewSchema,
    async read(input, context = {}) {
      try {
        const result = await searchProvider.search({
          query: input.query,
          limit: input.limit,
          signal: context.signal,
        });
        return result;
      } catch (error) {
        if (isAbortError(error, context.signal) || !isUnavailableError(error)) throw error;
        return unavailableResult(input.query, error?.message);
      }
    },
    observedAt(data) {
      return data.observedAt;
    },
    status(data) {
      if (!data.available) return 'unavailable';
      return data.note || data.results.length === 0 ? 'partial' : 'ready';
    },
    warnings(data) {
      if (!data.available) return [`web.search unavailable：${data.note || 'Web 搜索不可用'}`];
      return data.note ? [data.note] : [];
    },
    projectForAI(data) {
      return {
        query: data.query,
        available: data.available,
        results: data.results.map((item) => ({
          title: item.title,
          url: item.url,
          snippet: item.snippet,
          engine: item.engine,
          publishedAt: item.publishedAt,
        })),
        note: data.note || '',
      };
    },
  };
}
