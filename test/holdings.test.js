import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HoldingsBoardSchema, parseContract } from '../packages/contracts/src/index.js';
import { createManualHoldingsBook, legacyHoldingsBookToPortfolioImport } from '../packages/connectors/src/manual-holdings-book.js';
import { buildHoldingsBoard, buildHoldingsMoveGroups, buildHoldingsMoves } from '../packages/domain/src/holdings-board.js';
import { createTradingService } from '../packages/domain/src/trading-service.js';
import { createStore } from '../packages/database/src/index.js';
import { createAiCenterServer } from '../apps/web/src/server.js';

function syntheticPortfolioImport() {
  return legacyHoldingsBookToPortfolioImport({
    accounts: [
      {
        id: 'broker-cn', name: '合成 A 股账户', marketScope: 'mixed', baseCurrency: 'CNY',
        cash: [{ currency: 'CNY', amount: '1000' }],
      },
      {
        id: 'broker-b', name: '合成 B 股账户', marketScope: 'cn', baseCurrency: 'USD',
        cash: [{ currency: 'USD', amount: '10' }, { currency: 'HKD', amount: '20' }],
      },
    ],
    lots: [
      {
        id: 'synthetic-a', portfolioId: 'broker-cn', board: 'a_share', symbol: '600000', name: '合成沪股',
        quantity: '100', costPrice: '10', listingCurrency: 'CNY', exchangeCode: 'XSHG', market: 'cn', yahoo: '600000.SS',
      },
      {
        id: 'synthetic-hk', portfolioId: 'broker-cn', board: 'hk_connect', symbol: '00001', name: '合成港股',
        quantity: '50', costPrice: '20', listingCurrency: 'HKD', exchangeCode: 'XHKG', market: 'hk', yahoo: '0001.HK',
      },
      {
        id: 'synthetic-b', portfolioId: 'broker-b', board: 'b_sz', symbol: '200001', name: '合成 B 股',
        quantity: '200', costPrice: '2', listingCurrency: 'HKD', exchangeCode: 'XSHE', market: 'cn', yahoo: '200001.SZ',
      },
    ],
  });
}

test('legacy manual holdings entry keeps its old shape without personal seed data', () => {
  assert.deepEqual(createManualHoldingsBook(), { accounts: [], lots: [] });
  const legacy = { accounts: [{ id: 'synthetic' }], lots: [] };
  assert.deepEqual(createManualHoldingsBook(legacy), legacy);
});

test('holdings board converts B shares and HK connect with live FX', () => {
  const board = buildHoldingsBoard({
    now: 1,
    accounts: [
      { id: 'synthetic-a-account', name: '合成 A 股账户', group: 'a', cash: [{ currency: 'CNY', amount: '1000' }] },
      { id: 'synthetic-b-account', name: '合成 B 股账户', group: 'b', cash: [{ currency: 'USD', amount: '10' }, { currency: 'HKD', amount: '20' }] },
    ],
    lots: [
      { id: 'lot-a', portfolioId: 'synthetic-a-account', instrumentId: 'i-a', board: 'a_share', quantity: '100', costPrice: '10', listingCurrency: 'CNY' },
      { id: 'lot-hk', portfolioId: 'synthetic-a-account', instrumentId: 'i-hk', board: 'hk_connect', quantity: '100', costPrice: '20', listingCurrency: 'HKD' },
      { id: 'lot-b', portfolioId: 'synthetic-b-account', instrumentId: 'i-b', board: 'b_sh', quantity: '200', costPrice: '2', listingCurrency: 'USD' },
    ],
    instruments: [
      { id: 'i-a', symbol: '600001', name: '合成 A 股' },
      { id: 'i-hk', symbol: '00001', name: '合成港股' },
      { id: 'i-b', symbol: '900901', name: '合成 B 股' },
    ],
    aliases: [
      { instrumentId: 'i-a', providerId: 'yahoo', providerSymbol: '600001.SS' },
      { instrumentId: 'i-hk', providerId: 'yahoo', providerSymbol: '0001.HK' },
      { instrumentId: 'i-b', providerId: 'yahoo', providerSymbol: '900901.SS' },
    ],
    quotes: [
      { symbol: '600001.SS', lastPrice: 12, prevClose: 11 },
      { symbol: '0001.HK', lastPrice: 25, prevClose: 24 },
      { symbol: '900901.SS', lastPrice: 3, prevClose: 2.8 },
      { symbol: 'USDCNY=X', lastPrice: 7 },
      { symbol: 'HKDCNY=X', lastPrice: 0.9 },
    ],
  });
  parseContract(HoldingsBoardSchema, board);
  assert.equal(board.positions.find((item) => item.symbol === '900901').marketValueListing, '600');
  const syntheticHongKong = board.positions.find((item) => item.symbol === '00001');
  assert.equal(syntheticHongKong.quoteStatus, 'live');
  assert.equal(syntheticHongKong.costCny, '2000');
  assert.equal(syntheticHongKong.marketValueCny, '2250');
  assert.equal(syntheticHongKong.positionPnlCny, '250');
  assert.ok(Number(board.summary.bShareCny) > 1000);
  assert.equal(board.missingQuotes.length, 0);
  const shanghai = board.summary.lines.find((item) => item.id === 'b_sh');
  assert.equal(shanghai.stockListing, '600');
  assert.equal(shanghai.cashListing, '10');
  assert.equal(board.summary.lines.length, 3);
});

test('holdings board aggregates multiple accounts in one group and same-currency cash', () => {
  const board = buildHoldingsBoard({
    now: 1,
    accounts: [
      { id: 'cn-one', name: '账户一', group: 'a' },
      { id: 'cn-two', name: '账户二', group: 'a' },
    ],
    lots: [
      { id: 'lot-one', portfolioId: 'cn-one', instrumentId: 'i-one', board: 'a_share', quantity: '10', costPrice: '5', listingCurrency: 'CNY' },
      { id: 'lot-two', portfolioId: 'cn-two', instrumentId: 'i-two', board: 'a_share', quantity: '20', costPrice: '5', listingCurrency: 'CNY' },
    ],
    instruments: [
      { id: 'i-one', symbol: '600001', name: '合成一' },
      { id: 'i-two', symbol: '600002', name: '合成二' },
    ],
    aliases: [
      { instrumentId: 'i-one', providerId: 'yahoo', providerSymbol: '600001.SS' },
      { instrumentId: 'i-two', providerId: 'yahoo', providerSymbol: '600002.SS' },
    ],
    cash: [
      { portfolioId: 'cn-one', currency: 'CNY', amount: '100' },
      { portfolioId: 'cn-two', currency: 'CNY', amount: '200' },
    ],
    quotes: [
      { symbol: '600001.SS', lastPrice: 10, prevClose: 9 },
      { symbol: '600002.SS', lastPrice: 10, prevClose: 9 },
      { symbol: 'USDCNY=X', lastPrice: 7 },
      { symbol: 'HKDCNY=X', lastPrice: 0.9 },
    ],
  });
  assert.equal(board.summary.aShareCny, '300');
  assert.equal(board.summary.cashCny, '300');
  assert.equal(board.summary.totalCny, '600');
  assert.equal(board.summary.lines.find((line) => line.id === 'a_share').cashListing, '300');
});

test('holdings moves sample day week month from daily series', () => {
  const now = Date.UTC(2026, 8, 15, 14, 0, 0);
  const moves = buildHoldingsMoves({
    now,
    nowCny: '1200',
    fx: { usdCny: '7', hkdCny: '0.9' },
    lots: [{ id: 'lot-a', instrumentId: 'i-a', board: 'a_share', quantity: '100', listingCurrency: 'CNY' }],
    aliases: [{ instrumentId: 'i-a', providerId: 'yahoo', providerSymbol: '600001.SS' }],
    cash: [],
    series: [{
      symbol: '600001.SS',
      points: [
        { at: Date.UTC(2026, 7, 1, 16, 0, 0), close: 8 },
        { at: Date.UTC(2026, 7, 31, 16, 0, 0), close: 9 },
        { at: Date.UTC(2026, 8, 7, 16, 0, 0), close: 9.2 },
        { at: Date.UTC(2026, 8, 13, 16, 0, 0), close: 9.5 },
        { at: Date.UTC(2026, 8, 14, 15, 0, 0), close: 10 },
      ],
    }],
  });
  const day = moves.find((item) => item.id === 'day');
  assert.equal(day.pnlCny, '200');
  assert.equal(day.pnlPct, '0.2');
  assert.equal(day.sampleLabel, '昨日');
  assert.equal(day.backcast, true);
  assert.equal(day.addedPnlCny, null);
  assert.equal(moves.find((item) => item.id === 'week').sampleLabel, '上周');
  assert.equal(moves.find((item) => item.id === 'month').sampleLabel, '上月');
});

test('holdings move groups keep A share day pnl off B share lots', () => {
  const now = Date.UTC(2026, 8, 15, 14, 0, 0);
  const series = [
    {
      symbol: '600001.SS',
      points: [
        { at: Date.UTC(2026, 8, 14, 15, 0, 0), close: 10 },
        { at: Date.UTC(2026, 8, 15, 14, 0, 0), close: 12 },
      ],
    },
    {
      symbol: '900901.SS',
      points: [
        { at: Date.UTC(2026, 8, 14, 15, 0, 0), close: 1 },
        { at: Date.UTC(2026, 8, 15, 14, 0, 0), close: 2 },
      ],
    },
  ];
  const groups = buildHoldingsMoveGroups({
    now,
    fx: { usdCny: '7', hkdCny: '0.9' },
    lots: [
      { id: 'lot-a', instrumentId: 'i-a', board: 'a_share', quantity: '100', listingCurrency: 'CNY' },
      { id: 'lot-b', instrumentId: 'i-b', board: 'b_sh', quantity: '100', listingCurrency: 'USD' },
    ],
    aliases: [
      { instrumentId: 'i-a', providerId: 'yahoo', providerSymbol: '600001.SS' },
      { instrumentId: 'i-b', providerId: 'yahoo', providerSymbol: '900901.SS' },
    ],
    cash: [],
    series,
    positions: [
      { lotId: 'lot-a', board: 'a_share', marketValueCny: '1200', dayPnlCny: '150' },
      { lotId: 'lot-b', board: 'b_sh', marketValueCny: '1400', dayPnlCny: '80' },
    ],
    summary: {
      lines: [
        { id: 'a_share', totalCny: '1200' },
        { id: 'b_sh', totalCny: '1400' },
        { id: 'b_sz', totalCny: '0' },
      ],
    },
  });
  const aDay = groups.find((item) => item.id === 'a_share').moves.find((item) => item.id === 'day');
  const bDay = groups.find((item) => item.id === 'b_share').moves.find((item) => item.id === 'day');
  assert.equal(aDay.pnlCny, '150');
  assert.equal(bDay.pnlCny, '80');
});

test('holdings moves keep new lots out of original holding pnl', () => {
  const now = Date.UTC(2026, 8, 15, 14, 0, 0);
  const moves = buildHoldingsMoves({
    now,
    nowCny: '2300',
    fx: { usdCny: '7', hkdCny: '0.9' },
    lots: [
      { id: 'lot-old', instrumentId: 'i-a', board: 'a_share', quantity: '100', listingCurrency: 'CNY', openedAt: null },
      {
        id: 'lot-new',
        instrumentId: 'i-b',
        board: 'a_share',
        quantity: '100',
        costPrice: '11',
        listingCurrency: 'CNY',
        openedAt: Date.UTC(2026, 8, 8, 8, 0, 0),
      },
    ],
    aliases: [
      { instrumentId: 'i-a', providerId: 'yahoo', providerSymbol: '600001.SS' },
      { instrumentId: 'i-b', providerId: 'yahoo', providerSymbol: '600099.SS' },
    ],
    cash: [],
    series: [
      {
        symbol: '600001.SS',
        points: [
          { at: Date.UTC(2026, 6, 31, 16, 0, 0), close: 8 },
          { at: Date.UTC(2026, 7, 1, 16, 0, 0), close: 8 },
          { at: Date.UTC(2026, 7, 31, 16, 0, 0), close: 9 },
          { at: Date.UTC(2026, 8, 7, 16, 0, 0), close: 9.2 },
          { at: Date.UTC(2026, 8, 13, 16, 0, 0), close: 9.5 },
          { at: Date.UTC(2026, 8, 14, 15, 0, 0), close: 10 },
        ],
      },
      {
        symbol: '600099.SS',
        points: [
          { at: Date.UTC(2026, 6, 31, 16, 0, 0), close: 8 },
          { at: Date.UTC(2026, 7, 1, 16, 0, 0), close: 8 },
          { at: Date.UTC(2026, 7, 31, 16, 0, 0), close: 9 },
          { at: Date.UTC(2026, 8, 7, 16, 0, 0), close: 11 },
          { at: Date.UTC(2026, 8, 13, 16, 0, 0), close: 12 },
          { at: Date.UTC(2026, 8, 14, 15, 0, 0), close: 13 },
        ],
      },
    ],
  });
  const month = moves.find((item) => item.id === 'month');
  assert.equal(month.pnlCny, '100');
  assert.equal(month.addedPnlCny, '200');
  const lastMonth = month.samplePnlCny;
  assert.equal(lastMonth, '100');
  assert.equal(month.sampleAddedPnlCny, null);
});

test('portfolio import merges synthetic data idempotently and sqlite drives holdings reads', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-holdings-'));
  const store = createStore(path.join(directory, 'test.db'));
  const service = createTradingService({
    tradingRepository: store.repositories.trading,
    sourcePort: {
      async read(sourceId) {
        if (sourceId !== 'market.quotes') return { data: [] };
        return { data: [
          { symbol: '600000.SS', lastPrice: 12, prevClose: 11 },
          { symbol: '0001.HK', lastPrice: 25, prevClose: 24 },
          { symbol: '200001.SZ', lastPrice: 3, prevClose: 2.8 },
          { symbol: 'USDCNY=X', lastPrice: 7, prevClose: 7 },
          { symbol: 'HKDCNY=X', lastPrice: 0.9, prevClose: 0.9 },
        ] };
      },
    },
  });
  const first = service.importPortfolio(syntheticPortfolioImport());
  const second = service.importPortfolio(syntheticPortfolioImport());
  const partial = syntheticPortfolioImport();
  partial.positions = partial.positions.slice(0, 1);
  partial.cash = [];
  service.importPortfolio(partial);
  assert.deepEqual(first, { accountsMerged: 2, positionsMerged: 3, cashMerged: 3 });
  assert.deepEqual(second, first);
  const board = await service.getHoldingsBoard();
  assert.equal(board.positions.length, 3);
  assert.deepEqual(board.accounts.map((item) => item.id), ['broker-cn', 'broker-b']);
  assert.equal(store.repositories.trading.listPortfolios('local').length, 2);
  assert.equal(store.repositories.trading.listHoldingLots('local').length, 3);
  assert.equal(store.repositories.trading.listWorkspaceCash('local').length, 3);
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test('portfolio import is atomic when persistence fails', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-holdings-atomic-'));
  const store = createStore(path.join(directory, 'test.db'));
  const service = createTradingService({
    tradingRepository: store.repositories.trading,
    sourcePort: { async read() { return { data: [] }; } },
  });
  const value = syntheticPortfolioImport();
  value.accounts = [value.accounts[0]];
  value.cash = [];
  value.positions = [
    value.positions[0],
    {
      ...value.positions[0],
      id: 'synthetic-conflict',
      instrument: {
        ...value.positions[0].instrument,
        id: value.positions[0].instrument.id || 'same-instrument-id',
        canonicalKey: 'CN:XSHG:600099',
        symbol: '600099',
      },
    },
  ];
  value.positions[0].instrument.id = value.positions[1].instrument.id;
  assert.throws(() => service.importPortfolio(value));
  assert.equal(store.repositories.trading.getPortfolio('broker-cn'), null);
  assert.deepEqual(store.repositories.trading.listHoldingLots('local'), []);
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test('holdings read is side-effect free and accepts arbitrary data-owned portfolio ids', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-holdings-read-'));
  const store = createStore(path.join(directory, 'test.db'));
  const service = createTradingService({
    tradingRepository: store.repositories.trading,
    sourcePort: {
      async read(sourceId, input) {
        return { data: sourceId === 'market.quotes' ? input.symbols.map((symbol) => ({ symbol, lastPrice: 1, prevClose: 1 })) : [] };
      },
    },
  });
  assert.equal(store.repositories.trading.listHoldingLots('local').length, 0);
  service.importPortfolio(syntheticPortfolioImport());
  for (const cash of store.repositories.trading.listWorkspaceCash('local')) {
    store.repositories.trading.upsertPortfolioCash({ portfolioId: cash.portfolioId, currency: cash.currency, amount: '0' });
  }
  service.addHoldingLot({
    portfolioId: 'broker-cn', board: 'a_share', yahoo: '600004.SS', symbol: '600004', name: '合成新股',
    quantity: '10', costPrice: '8',
  });
  assert.throws(() => service.addHoldingLot({
    portfolioId: 'missing-portfolio', board: 'a_share', yahoo: '600005.SS', symbol: '600005', name: '不存在',
    quantity: '10', costPrice: '8',
  }), /不存在或不属于/);
  const beforeLots = store.repositories.trading.listHoldingLots('local');
  const beforeCash = store.repositories.trading.listWorkspaceCash('local');
  assert.ok(beforeCash.length > 0);
  assert.ok(beforeCash.every((item) => item.amount === '0'));
  await service.getHoldingsBoard({ workspaceId: 'local' });
  assert.deepEqual(store.repositories.trading.listHoldingLots('local'), beforeLots);
  assert.deepEqual(store.repositories.trading.listWorkspaceCash('local'), beforeCash);
  await assert.rejects(() => service.getHoldingsBoard({ workspaceId: 'other' }), /不支持该工作区/);
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test('holdings API leaves a new sqlite instance empty and still honors quote refresh', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-holdings-api-'));
  let lastQuoteOptions = null;
  const app = createAiCenterServer({
    host: '127.0.0.1',
    port: 0,
    dataDirectory: directory,
    marketService: {
      async getBoard() { return { board: 'us' }; },
      async search() { return []; },
      async fetchQuotes(symbols, options) {
        lastQuoteOptions = options || {};
        return symbols.map((symbol) => ({ symbol, lastPrice: symbol.includes('=X') ? 1 : 2, prevClose: 2 }));
      },
    },
  });
  const address = await app.listen();
  try {
    const payload = await fetch(`${address.localUrl}/api/v1/holdings`).then((response) => response.json());
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.holdings.positions, []);
    assert.deepEqual(payload.holdings.accounts, []);
    assert.equal(payload.holdings.summary.totalCny, '0');
    assert.equal(app.store.repositories.trading.listPortfolios('local').length, 0);
    assert.equal(payload.holdings.moves.length, 3);
    assert.equal(payload.holdings.moveGroups.length, 2);
    assert.deepEqual(payload.holdings.moveGroups.map((item) => item.id), ['a_share', 'b_share']);
    assert.equal(lastQuoteOptions.refresh, false);
    await fetch(`${address.localUrl}/api/v1/holdings?refresh=1`).then((response) => response.json());
    assert.equal(lastQuoteOptions.refresh, true);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
