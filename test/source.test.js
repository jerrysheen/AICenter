import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { createAiCenterServer } from '../apps/web/src/server.js';
import { ValidationError } from '../packages/contracts/src/index.js';
import { createModuleRegistry } from '../packages/runtime/src/capability-registry.js';
import { createSourceHub } from '../packages/source/src/source-hub.js';

function testDefinition(overrides = {}) {
  let reads = 0;
  return {
    reads: () => reads,
    definition: {
      manifest: {
        id: 'market.test', title: '测试市场', category: 'market', providerId: 'test-provider',
        visibility: 'public', viewKind: 'market-board', capabilities: ['read'], refresh: { ttlMs: 1_000 }, guideRefs: [],
      },
      inputSchema: z.object({ symbol: z.string().trim().min(1) }).strict(),
      outputSchema: z.object({ symbol: z.string(), price: z.number() }).strict(),
      async read(input) { reads += 1; return { symbol: input.symbol, price: 1 }; },
      projectForAI(data) { return { symbol: data.symbol }; },
      ...overrides,
    },
  };
}

test('module registry owns source contributions and SourceHub validates both boundaries', async () => {
  const registry = createModuleRegistry();
  const fixture = testDefinition();
  registry.register({
    manifest: { id: 'connector.test', version: '1.0.0', capabilities: ['market.read'], jobTypes: [], sourceIds: ['market.test'] },
    sources: [fixture.definition],
  });
  const hub = createSourceHub(registry, { now: () => 100 });
  assert.equal(hub.list()[0].id, 'market.test');
  const first = await hub.read('market.test', { symbol: 'AAPL' });
  const second = await hub.read('market.test', { symbol: 'AAPL' });
  assert.equal(first.data.price, 1);
  assert.equal(second, first);
  assert.equal(fixture.reads(), 1);
  const ai = await hub.projectForAI('market.test', { symbol: 'MSFT' });
  assert.deepEqual(ai.data, { symbol: 'MSFT' });
  await assert.rejects(() => hub.read('market.test', { symbol: '' }), ValidationError);
  assert.throws(() => registry.register({
    manifest: { id: 'connector.bad', version: '1.0.0', capabilities: ['market.read'], jobTypes: [], sourceIds: [] },
    sources: [testDefinition().definition],
  }), /未声明 Source/);
});

test('SourceHub rejects an invalid source output before it reaches routes or tools', async () => {
  const registry = createModuleRegistry();
  const fixture = testDefinition({ read: async () => ({ symbol: 'AAPL', price: '1' }) });
  registry.register({
    manifest: { id: 'connector.test', version: '1.0.0', capabilities: ['market.read'], jobTypes: [], sourceIds: ['market.test'] },
    sources: [fixture.definition],
  });
  await assert.rejects(() => createSourceHub(registry).read('market.test', { symbol: 'AAPL' }), ValidationError);
});

test('source API lists manifests and reads a source while legacy market API remains compatible', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-sources-'));
  const board = {
    board: 'us', mode: 'live', fetchedAt: 1, session: 'closed', note: 'test', groups: [],
    indices: [], watchlist: [], gainers: [], losers: [], breadth: { advancers: 0, decliners: 0, unchanged: 0 },
  };
  const marketService = {
    async getBoard({ board: requested }) { return { ...board, board: requested }; },
    async search() { return []; },
    async fetchQuotes() { return []; },
    async fetchHistory() { return []; },
  };
  const webSearchPort = {
    id: 'searxng',
    async search({ query }) {
      return {
        query, available: true, observedAt: 2,
        results: [{
          title: 'Example', url: 'https://example.com/search', snippet: 'result',
          engine: 'test', publishedAt: null,
        }],
      };
    },
  };
  const app = createAiCenterServer({
    host: '127.0.0.1', port: 0, dataDirectory: directory, marketService, webSearchPort,
  });
  const address = await app.listen();
  try {
    const catalog = await fetch(`${address.localUrl}/api/v1/sources`).then((response) => response.json());
    assert.equal(catalog.ok, true);
    assert.ok(catalog.sources.some((source) => source.id === 'market.us' && source.viewKind === 'market-board'));
    assert.ok(catalog.sources.some((source) => source.id === 'search.web' && source.viewKind === 'search-results'));
    assert.equal(catalog.sources.some((source) => source.id === 'market.quotes'), false);

    const source = await fetch(`${address.localUrl}/api/v1/sources/market.us`).then((response) => response.json());
    assert.equal(source.ok, true);
    assert.equal(source.snapshot.sourceId, 'market.us');
    assert.equal(source.snapshot.data.board, 'us');

    const search = await fetch(`${address.localUrl}/api/v1/sources/search.web?query=HBM&limit=3`).then((response) => response.json());
    assert.equal(search.ok, true);
    assert.equal(search.snapshot.sourceId, 'search.web');
    assert.equal(search.snapshot.data.results[0].title, 'Example');

    const legacy = await fetch(`${address.localUrl}/api/v1/markets?board=us`).then((response) => response.json());
    assert.equal(legacy.ok, true);
    assert.equal(legacy.market.board, 'us');
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
