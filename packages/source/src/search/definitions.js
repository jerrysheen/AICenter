import { WebSearchInputSchema, WebSearchViewSchema } from '../schemas.js';

function isAbortError(error, signal) {
  return signal?.aborted || error?.name === 'AbortError';
}

function isUnavailableError(error) {
  return error?.name === 'WebSearchUnavailableError'
    || /unavailable|timeout|timed out|ECONNREFUSED|fetch failed/i.test(String(error?.message ?? error));
}

function unavailableResult(query) {
  return {
    query,
    available: false,
    results: [],
    observedAt: Date.now(),
  };
}

export function createWebSearchSourceDefinition(searchProvider) {
  if (!searchProvider?.search) throw new TypeError('searchProvider.search is required');
  return {
    manifest: {
      id: 'search.web',
      title: 'Web 搜索',
      category: 'search',
      providerId: searchProvider.id ?? 'searxng',
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
        return unavailableResult(input.query);
      }
    },
    observedAt(data) {
      return data.observedAt;
    },
    status(data) {
      return data.available ? 'ready' : 'unavailable';
    },
    warnings(data) {
      return data.available ? [] : ['web.search unavailable：Search Worker 不可用'];
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
      };
    },
  };
}
