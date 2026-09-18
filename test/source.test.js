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
  const officialSources = {
    urls: { bls: 'https://www.bls.gov/schedule/news_release/bls.ics' },
    async bls() {
      return {
        available: true, observedAt: 3, sourceUrl: this.urls.bls, note: '',
        events: [{
          eventId: 'bls:test', country: 'US', authority: 'U.S. Bureau of Labor Statistics',
          eventType: 'economic-release', title: 'Consumer Price Index', scheduledAt: 4,
          scheduledEndAt: null, referencePeriod: null, status: 'scheduled',
          scheduleBasis: 'official-calendar', timePrecision: 'exact', sourceUrl: this.urls.bls, observedAt: 3,
        }],
      };
    },
  };
  const emptyLiquidityMetric = (key, label) => ({
    key, label, supplyUsd: '1', change1dUsd: '0', change7dUsd: '0', change30dUsd: '0',
  });
  const marketNativeSources = {
    async polymarket() {
      return {
        available: true, observedAt: 5, sourceUrl: 'https://example.com/polymarket', note: '',
        quotes: [{
          quoteId: 'polymarket:test:yes', venue: 'polymarket', marketId: 'test',
          marketQuestion: 'Will the Fed cut?', outcome: 'Yes', midPrice: '0.6', bestBid: '0.59', bestAsk: '0.61',
          spread: '0.02', lastPrice: '0.6', volume24h: '10', totalVolume: '100', liquidity: '20',
          openInterest: '30', endAt: 10, sourceUrl: 'https://example.com/polymarket/test', observedAt: 5,
        }],
      };
    },
    async kalshi() { return { available: true, observedAt: 5, sourceUrl: 'https://example.com/kalshi', note: '', quotes: [] }; },
    async hyperliquid() {
      return {
        available: true, observedAt: 5, sourceUrl: 'https://example.com/hyperliquid', note: '',
        quotes: [{
          quoteId: 'hyperliquid:BTC:perp', venue: 'hyperliquid', symbol: 'BTC', markPrice: '1', midPrice: '1',
          oraclePrice: '1', previousDayPrice: '1', fundingRate: '0', openInterest: '2',
          openInterestUnit: 'base-asset', volume24h: '3', sourceUrl: 'https://example.com/hyperliquid/btc', observedAt: 5,
        }],
      };
    },
    async stablecoins() {
      return {
        available: true, observedAt: 5, sourceUrl: 'https://example.com/stablecoins', note: '',
        total: emptyLiquidityMetric('total', 'Total'), assets: [emptyLiquidityMetric('USDT', 'USDT')], chains: [],
      };
    },
  };
  const app = createAiCenterServer({
    host: '127.0.0.1', port: 0, dataDirectory: directory, marketService, webSearchPort, officialSources, marketNativeSources,
  });
  const address = await app.listen();
  try {
    const catalog = await fetch(`${address.localUrl}/api/v1/sources`).then((response) => response.json());
    assert.equal(catalog.ok, true);
    assert.ok(catalog.sources.some((source) => source.id === 'market.us' && source.viewKind === 'market-board'));
    assert.ok(catalog.sources.some((source) => source.id === 'market.cn' && source.viewKind === 'market-board'));
    assert.ok(catalog.sources.some((source) => source.id === 'search.web' && source.viewKind === 'search-results'));
    assert.ok(catalog.sources.some((source) => source.id === 'calendar.us.bls' && source.viewKind === 'calendar'));
    assert.ok(catalog.sources.some((source) => source.id === 'policy.cn.gov' && source.viewKind === 'official-release'));
    assert.ok(catalog.sources.some((source) => source.id === 'market-native.prediction.polymarket' && source.viewKind === 'prediction-market'));
    assert.ok(catalog.sources.some((source) => source.id === 'market-native.derivatives.hyperliquid' && source.viewKind === 'crypto-derivatives'));
    assert.ok(catalog.sources.some((source) => source.id === 'calendar.cn.scio' && source.viewKind === 'calendar'));
    assert.ok(catalog.sources.some((source) => source.id === 'policy.cn.gov-news' && source.viewKind === 'official-release'));
    assert.equal(catalog.sources.some((source) => source.id === 'policy.official-detail'), false);
    assert.equal(catalog.sources.some((source) => source.id === 'market.quotes'), false);

    const source = await fetch(`${address.localUrl}/api/v1/sources/market.us`).then((response) => response.json());
    assert.equal(source.ok, true);
    assert.equal(source.snapshot.sourceId, 'market.us');
    assert.equal(source.snapshot.data.board, 'us');

    const search = await fetch(`${address.localUrl}/api/v1/sources/search.web?query=HBM&limit=3`).then((response) => response.json());
    assert.equal(search.ok, true);
    assert.equal(search.snapshot.sourceId, 'search.web');
    assert.equal(search.snapshot.data.results[0].title, 'Example');

    const calendar = await fetch(`${address.localUrl}/api/v1/sources/calendar.us.bls?limit=10`).then((response) => response.json());
    assert.equal(calendar.ok, true);
    assert.equal(calendar.snapshot.data.events[0].title, 'Consumer Price Index');
    assert.equal('forecast' in calendar.snapshot.data.events[0], false);

    const internalDetail = await fetch(`${address.localUrl}/api/v1/sources/policy.official-detail?sourceUrl=https%3A%2F%2Fwww.gov.cn%2F`);
    assert.equal(internalDetail.status, 404);

    const missingOfficial = await fetch(`${address.localUrl}/api/v1/official-detail`);
    assert.equal(missingOfficial.status, 400);

    const marketNative = await fetch(`${address.localUrl}/api/v1/market-native/board?predictionLimit=10`).then((response) => response.json());
    assert.equal(marketNative.ok, true);
    assert.equal(marketNative.board.predictionMarkets[0].venue, 'polymarket');
    assert.equal(marketNative.board.cryptoDerivatives[0].symbol, 'BTC');
    assert.equal(marketNative.board.stablecoinLiquidity.total.supplyUsd, '1');

    const staticBoard = await fetch(`${address.localUrl}/api/v1/static-signals/board?from=0&to=10000&focus=1&includeUndated=0`).then((response) => response.json());
    assert.equal(staticBoard.ok, true);
    assert.ok(staticBoard.board.sourceHealth.some((source) => source.sourceId === 'calendar.cn.scio'));
    assert.equal(Array.isArray(staticBoard.board.upcoming), true);

    const legacy = await fetch(`${address.localUrl}/api/v1/markets?board=us`).then((response) => response.json());
    assert.equal(legacy.ok, true);
    assert.equal(legacy.market.board, 'us');
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
