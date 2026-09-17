import test from 'node:test';
import assert from 'node:assert/strict';
import { createSearxngSearchProvider, normalizeWebSearchResults, WebSearchUnavailableError } from '../packages/connectors/src/searxng.js';
import { createLocalToolRegistry } from '../packages/runtime/src/local-tools.js';
import { createToolRegistry } from '../packages/runtime/src/tool-registry.js';
import { createModuleRegistry } from '../packages/runtime/src/capability-registry.js';
import { createAgentRuntime } from '../packages/runtime/src/agent-runtime.js';
import { createSourceHub } from '../packages/source/src/source-hub.js';
import { createWebSearchSourceDefinition } from '../packages/source/src/search/definitions.js';

function createSearchSourcePort(provider = null) {
  const modules = createModuleRegistry();
  if (provider) {
    modules.register({
      manifest: {
        id: 'connector.search-test', version: '1.0.0', capabilities: ['search.web'],
        jobTypes: [], sourceIds: ['search.web'],
      },
      sources: [createWebSearchSourceDefinition(provider)],
    });
  }
  return createSourceHub(modules);
}

test('searxng connector maps json results and rejects remote hosts', async () => {
  const mapped = normalizeWebSearchResults({
    query: 'HBM',
    results: [
      { title: 'SK hynix', url: 'https://example.com/hbm', content: 'capacity', engine: 'bing' },
      { title: 'skip', url: 'ftp://example.com/x' },
    ],
  }, { query: 'HBM', limit: 8 });
  assert.equal(mapped.results.length, 1);
  assert.equal(mapped.results[0].url, 'https://example.com/hbm');
  assert.equal(mapped.results[0].snippet, 'capacity');
  assert.equal(mapped.results[0].publishedAt, null);

  const dated = normalizeWebSearchResults({
    query: 'FOMC',
    results: [{
      title: 'Fed',
      url: 'https://example.com/fed',
      content: 'decision',
      engine: 'bing',
      publishedDate: '2026-09-16T18:00:00Z',
    }],
  }, { query: 'FOMC', limit: 5 });
  assert.equal(dated.results[0].publishedAt, '2026-09-16T18:00:00.000Z');

  assert.throws(() => createSearxngSearchProvider({ baseUrl: 'https://searx.example' }), /回环地址/);

  const provider = createSearxngSearchProvider({
    fetchImpl: async () => ({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ query: 'nvda', results: [{ title: 'NVIDIA', url: 'https://nvidia.com', content: 'gpu' }] }),
    }),
  });
  const data = await provider.search({ query: 'nvda', limit: 3 });
  assert.equal(data.results[0].title, 'NVIDIA');
});

test('searxng connector treats connection failure as unavailable', async () => {
  const provider = createSearxngSearchProvider({
    fetchImpl: async () => { throw new Error('fetch failed'); },
  });
  await assert.rejects(() => provider.search({ query: 'test' }), (error) => {
    assert.equal(error.name, 'WebSearchUnavailableError');
    return true;
  });
});

test('web.search tool is optional and degrades when the port is down', async () => {
  const base = {
    contextService: { async build() { return { generatedAt: 1, knowledge: [], recentFeed: [], holdings: null, refs: [] }; } },
    feedService: { searchContentItems() { return []; } },
    knowledgeService: {
      search() { return []; },
      getCurrentRevision() { return null; },
      getCurrentRevisionByMetadataKind() { return null; },
      listTaxonomy() { return []; },
      persistStructuredArtifact() { return { resourceType: 'inspiration', resourceId: '1', title: 'x', taxonomy: [] }; },
    },
    tradingService: {
      async getBoard() { return { board: 'overview', fetchedAt: 1, sections: [] }; },
      async getHoldingsBoard() { return { updatedAt: 1, missingQuotes: [], positions: [] }; },
      async getPersonalAssetDashboard() { return { updatedAt: 1, note: '', latest: {}, points: [] }; },
    },
  };
  const without = createLocalToolRegistry({ ...base, sourcePort: createSearchSourcePort() });
  assert.equal(without.list().some((tool) => tool.id === 'web.search'), false);

  const down = createLocalToolRegistry({
    ...base,
    sourcePort: createSearchSourcePort({
      async search() {
        throw new WebSearchUnavailableError('SearXNG 不可用');
      },
    }),
  });
  assert.ok(down.list().some((tool) => tool.id === 'web.search'));
  const failed = await down.execute('web.search', { query: 'HBM' }, { workspaceId: 'local' });
  assert.equal(failed.data.available, false);
  assert.match(failed.warnings[0], /unavailable/);

  const up = createLocalToolRegistry({
    ...base,
    sourcePort: createSearchSourcePort({
      async search({ query }) {
        return {
          query, available: true, observedAt: 9,
          results: [{ title: 'Example', url: 'https://example.com/a', snippet: 'hello', engine: 'bing' }],
        };
      },
    }),
  });
  const ok = await up.execute('web.search', { query: 'HBM', limit: 3 }, { workspaceId: 'local' });
  assert.equal(ok.data.results[0].title, 'Example');
  assert.equal(ok.refs[0].resourceType, 'web-result');
});

test('web.search projection keeps publishedAt from the search port', async () => {
  const base = {
    contextService: { async build() { return { generatedAt: 1, knowledge: [], recentFeed: [], holdings: null, refs: [] }; } },
    feedService: { searchContentItems() { return []; } },
    knowledgeService: {
      search() { return []; },
      getCurrentRevision() { return null; },
      getCurrentRevisionByMetadataKind() { return null; },
      listTaxonomy() { return []; },
      persistStructuredArtifact() { return { resourceType: 'inspiration', resourceId: '1', title: 'x', taxonomy: [] }; },
    },
    tradingService: {
      async getBoard() { return { board: 'overview', fetchedAt: 1, sections: [] }; },
      async getHoldingsBoard() { return { updatedAt: 1, missingQuotes: [], positions: [] }; },
      async getPersonalAssetDashboard() { return { updatedAt: 1, note: '', latest: {}, points: [] }; },
    },
    sourcePort: createSearchSourcePort({
      async search({ query }) {
        return {
          query, available: true, observedAt: 9,
          results: [{
            title: 'FOMC', url: 'https://example.com/fomc', snippet: 'held rates',
            engine: 'bing', publishedAt: '2026-09-16T00:00:00.000Z',
          }],
        };
      },
    }),
  };
  const registry = createLocalToolRegistry(base);
  const ok = await registry.execute('web.search', { query: 'FOMC', limit: 3 }, { workspaceId: 'local' });
  assert.equal(ok.data.results[0].publishedAt, '2026-09-16T00:00:00.000Z');
});

test('agent runtime hides web.search unless webMode allows it', async () => {
  const tools = createToolRegistry();
  let searches = 0;
  tools.register({
    id: 'web.search', effect: 'read', description: 'search',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    async execute() {
      searches += 1;
      return { data: { results: [] }, refs: [], observedAt: 1, warnings: [] };
    },
  });
  const responses = [
    { toolCalls: [{ name: 'web_search', args: { query: 'news' } }], modelContent: { role: 'model', parts: [] }, providerId: 'fake', modelId: 'fake' },
    { text: 'done', providerId: 'fake', modelId: 'fake' },
  ];
  const hidden = createAgentRuntime({ llm: { respond: async () => responses.shift() }, tools });
  await assert.rejects(() => hidden.run({ message: '搜一下', workspaceId: 'local', webMode: 'off' }), /未注册工具/);
  assert.equal(searches, 0);

  const allowedResponses = [
    { toolCalls: [{ name: 'web_search', args: { query: 'news' } }], modelContent: { role: 'model', parts: [] }, providerId: 'fake', modelId: 'fake' },
    { text: '网上有新闻。', providerId: 'fake', modelId: 'fake' },
  ];
  const allowed = createAgentRuntime({ llm: { respond: async () => allowedResponses.shift() }, tools });
  const result = await allowed.run({ message: '搜一下', workspaceId: 'local', webMode: 'always' });
  assert.equal(searches, 1);
  assert.equal(result.answer, '网上有新闻。');
});
