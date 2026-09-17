import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_MARKET_CATALOG,
  MarketCatalogSchema,
  defaultMarketCatalogPath,
  readMarketCatalogFile,
  resolveMarketCatalog,
} from '../packages/source/src/market/catalog.js';
import {
  ASIA_GROUPS,
  ASIA_INDICES,
  ASIA_WATCHLIST,
  GLOBAL_GROUPS,
  GLOBAL_WATCHLIST,
  US_GROUPS,
  US_INDICES,
  US_WATCHLIST,
} from '../packages/connectors/src/index.js';
import { createMarketService } from '../packages/source/src/market/service.js';

function smallCatalog(symbol = 'ONLY') {
  return {
    version: 1,
    us: {
      groups: ['全部', '自选'],
      indices: [],
      watchlist: [{ symbol, name: '实例自选', group: '全部', summary: '来自实例配置' }],
    },
    asia: { groups: ['全部', '自选'], indices: [], watchlist: [] },
    global: { groups: ['指数'], watchlist: [] },
  };
}

test('default market catalog is runtime validated outside connector code', () => {
  const catalog = readMarketCatalogFile(defaultMarketCatalogPath);
  assert.equal(MarketCatalogSchema.parse(catalog).version, 1);
  assert.ok(catalog.us.watchlist.length > 0);
  assert.deepEqual(catalog.us.groups, ['全部', '指数', 'ETF', '自选']);
  assert.equal(JSON.stringify(catalog).includes('算力链'), false);
  assert.equal(JSON.stringify(catalog).includes('CPO'), false);
});

test('market service consumes an instance catalog instead of core constants', async () => {
  const requested = [];
  const service = createMarketService({
    marketCatalog: smallCatalog(),
    yahoo: {
      async fetchQuotes(symbols) { requested.push(...symbols); return { quotes: [], session: 'closed' }; },
      async fetchHistory() { return []; },
      async searchSymbols() { return []; },
    },
    cnQuotes: { async fetchQuotes() { return []; } },
  });
  const board = await service.getBoard({ board: 'us' });
  assert.deepEqual(requested, ['ONLY']);
  assert.equal(board.watchlist[0].name, '实例自选');
});

test('configured catalog falls back to the default template only when missing', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-market-catalog-'));
  try {
    const configured = path.join(directory, 'markets.json');
    writeFileSync(configured, JSON.stringify(smallCatalog('LOCAL')));
    assert.equal(resolveMarketCatalog(configured).us.watchlist[0].symbol, 'LOCAL');
    assert.equal(resolveMarketCatalog(path.join(directory, 'missing.json')).version, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy catalog modules remain compatible during phase 1', () => {
  assert.equal(US_GROUPS, DEFAULT_MARKET_CATALOG.us.groups);
  assert.equal(US_INDICES, DEFAULT_MARKET_CATALOG.us.indices);
  assert.equal(US_WATCHLIST, DEFAULT_MARKET_CATALOG.us.watchlist);
  assert.equal(ASIA_GROUPS, DEFAULT_MARKET_CATALOG.asia.groups);
  assert.equal(ASIA_INDICES, DEFAULT_MARKET_CATALOG.asia.indices);
  assert.equal(ASIA_WATCHLIST, DEFAULT_MARKET_CATALOG.asia.watchlist);
  assert.equal(GLOBAL_GROUPS, DEFAULT_MARKET_CATALOG.global.groups);
  assert.equal(GLOBAL_WATCHLIST, DEFAULT_MARKET_CATALOG.global.watchlist);
});
