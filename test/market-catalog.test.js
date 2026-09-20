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

test('instance cn industry map catalog allows the same ticker in multiple groups', () => {
  const catalog = readMarketCatalogFile(path.resolve('config/markets.json'));
  assert.ok(catalog.cn.groups.includes('芯片设计'));
  assert.ok(catalog.cn.groups.includes('光通信'));
  const jingsheng = catalog.cn.watchlist.filter((item) => item.symbol === '300316.SZ');
  assert.ok(jingsheng.length >= 2);
  assert.equal(new Set(jingsheng.map((item) => item.group)).size, jingsheng.length);
});

test('instance US watchlist uses US listings for Hynix and SanDisk', () => {
  const catalog = readMarketCatalogFile(path.resolve('config/markets.json'));
  const us = new Map(catalog.us.watchlist.map((item) => [item.symbol, item]));
  const asia = new Map(catalog.asia.watchlist.map((item) => [item.symbol, item]));
  assert.equal(us.has('000660.KS'), false);
  assert.equal(us.has('005930.KS'), false);
  assert.equal(us.get('SKHY')?.name, 'SK 海力士');
  assert.equal(us.get('SKHY')?.group, '算力链');
  assert.equal(us.get('SNDK')?.name, '闪迪');
  assert.equal(us.get('SNDK')?.group, '算力链');
  assert.equal(us.get('MU')?.name, '美光');
  assert.equal(asia.get('000660.KS')?.name, 'SK 海力士');
  assert.equal(asia.get('005930.KS')?.name, '三星电子');
});

test('catalog rejects Korean listings on the US board and US listings on Asia watchlist', () => {
  const mixedUs = {
    ...smallCatalog(),
    us: {
      groups: ['全部', '自选'],
      indices: [],
      watchlist: [{ symbol: '000660.KS', name: 'SK 海力士', group: '全部', summary: '韩交所' }],
    },
  };
  const mixedAsia = {
    ...smallCatalog(),
    asia: {
      groups: ['全部', '自选'],
      indices: [],
      watchlist: [{ symbol: 'SNDK', name: '闪迪', group: '全部', summary: '纳斯达克' }],
    },
  };
  assert.equal(MarketCatalogSchema.safeParse(mixedUs).success, false);
  assert.equal(MarketCatalogSchema.safeParse(mixedAsia).success, false);
});

test('instance overview indices use SSE 50 ChiNext 50 STAR 50 Hang Seng and HSTECH', () => {
  const catalog = readMarketCatalogFile(path.resolve('config/markets.json'));
  assert.deepEqual(catalog.cn.indices.map((item) => item.symbol), [
    '000016.SS', '399673.SZ', '000688.SS', '^HSI', '^HSTECH',
  ]);
  const globalSymbols = catalog.global.watchlist.map((item) => item.symbol);
  assert.ok(catalog.global.groups.includes('国债'));
  for (const symbol of ['US2Y', 'US5Y', 'US10Y', 'US30Y', 'CNTS', 'CNTF', 'CNT', 'CNTL', 'XAGUSD', 'LC', 'M']) {
    assert.ok(globalSymbols.includes(symbol), symbol);
  }
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
