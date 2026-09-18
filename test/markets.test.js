import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteFromSpark, seriesFromSpark } from '../packages/connectors/src/yahoo.js';
import { buildCnMarketBoard, buildGlobalAssetBoard, buildOverviewBoard, buildUsMarketBoard, expiryFromFuturesName, parseCnExtraSymbols, parseUsExtraSymbols, preferredOverviewFocus } from '../packages/connectors/src/market-boards.js';
import { createMarketService } from '../packages/connectors/src/market-service.js';
import { parseMarketQuery } from '../packages/contracts/src/index.js';

test('yahoo spark result maps to a quote snapshot without raw provider fields', () => {
  const quote = quoteFromSpark({
    symbol: 'NVDA',
    response: [{
      meta: {
        symbol: 'NVDA',
        shortName: 'NVIDIA',
        currency: 'USD',
        regularMarketPrice: 212.18,
        regularMarketChangePercent: 0.58,
        previousClose: 210.95,
        regularMarketVolume: 131_000_000,
        regularMarketDayHigh: 214,
        regularMarketDayLow: 208,
        regularMarketTime: 1_700_000_000,
        fullExchangeName: 'NasdaqGS',
      },
      indicators: { quote: [{ close: [210, 211, 212.18] }] },
    }],
  }, 1_700_000_000);
  assert.equal(quote.symbol, 'NVDA');
  assert.equal(quote.lastPrice, 212.18);
  assert.equal(quote.changePct, 0.58);
  assert.deepEqual(quote.sparkline, [210, 211, 212.18]);
  assert.equal(quote.session, 'closed');
});

test('yahoo spark history maps timestamps to daily closes', () => {
  const series = seriesFromSpark({
    symbol: '000858.sz',
    response: [{
      timestamp: [1_700_000_000, 1_700_086_400],
      indicators: { quote: [{ close: [69.5, 69.7] }] },
    }],
  });
  assert.equal(series.symbol, '000858.SZ');
  assert.equal(series.points.length, 2);
  assert.equal(series.points[1].close, 69.7);
});

test('us board keeps catalog names, groups, and summaries', () => {
  const marketCatalog = {
    version: 1,
    us: {
      groups: ['全部', '科技'],
      indices: [],
      watchlist: [{ symbol: 'NVDA', name: 'NVIDIA', group: '科技', summary: 'GPU 测试标的' }],
    },
    asia: { groups: ['全部'], indices: [], watchlist: [] },
    global: { groups: ['指数'], watchlist: [] },
  };
  const board = buildUsMarketBoard({
    quotes: [{
      symbol: 'NVDA', name: 'NVIDIA Corporation', lastPrice: 212.18, changePct: 0.58, change: 1.23,
      high: 214, low: 208, prevClose: 210.95, volume: 1, sparkline: [210, 212], currency: 'USD',
      exchange: 'NasdaqGS', marketTime: 1_700_000_000, session: 'regular',
    }],
    session: 'regular',
    fetchedAt: 1_700_000_000_000,
    errors: 1,
    marketCatalog,
  });
  const nvidia = board.watchlist.find((item) => item.symbol === 'NVDA');
  assert.equal(nvidia.name, 'NVIDIA');
  assert.equal(nvidia.group, '科技');
  assert.equal(nvidia.summary, 'GPU 测试标的');
  assert.equal(nvidia.provider, 'yahoo');
  assert.equal(nvidia.market, 'us');
  assert.equal(board.groups[1], '科技');
  assert.equal(parseUsExtraSymbols('nvda,ZZZZ', marketCatalog).join(','), 'ZZZZ');
});

test('overview board switches A shares and US by Shanghai 17:00', () => {
  const catalog = {
    version: 1,
    us: { groups: ['全部'], indices: [], watchlist: [] },
    asia: { groups: ['全部'], indices: [], watchlist: [] },
    cn: {
      groups: ['全部', '芯片设计'],
      indices: [{ symbol: '000001.SS', name: '上证指数', group: '指数', summary: '' }],
      watchlist: [{ symbol: '688110.SS', name: '东芯股份', group: '芯片设计', summary: '存储芯片' }],
    },
    global: { groups: ['指数'], watchlist: [] },
  };
  const us = buildUsMarketBoard({ quotes: [], session: 'closed', fetchedAt: 10, marketCatalog: catalog });
  const cn = buildCnMarketBoard({
    quotes: [{ symbol: '688110.SS', name: '东芯股份', lastPrice: 80, prevClose: 70, change: 10, changePct: 14.29, session: 'regular', currency: 'CNY' }],
    fetchedAt: 20,
    marketCatalog: catalog,
  });
  const daytime = buildOverviewBoard(us, null, cn, { now: Date.UTC(2026, 8, 18, 8, 0, 0) });
  const evening = buildOverviewBoard(us, null, cn, { now: Date.UTC(2026, 8, 18, 9, 0, 0) });
  assert.equal(preferredOverviewFocus(Date.UTC(2026, 8, 18, 8, 59, 0)), 'cn');
  assert.equal(preferredOverviewFocus(Date.UTC(2026, 8, 18, 9, 0, 0)), 'us');
  assert.equal(preferredOverviewFocus(Date.UTC(2026, 8, 19, 2, 0, 0)), 'us');
  assert.equal(daytime.focus, 'cn');
  assert.equal(daytime.sections.length, 1);
  assert.equal(daytime.sections[0].id, 'cn');
  assert.equal(daytime.sections[0].title, 'A股观察');
  assert.equal(evening.focus, 'us');
  assert.equal(evening.sections[0].id, 'us');
  assert.equal(evening.sections[0].title, '美股观察');
});

test('cn board keeps the same ticker in multiple industry groups', () => {
  const marketCatalog = {
    version: 1,
    us: { groups: ['全部'], indices: [], watchlist: [] },
    asia: { groups: ['全部'], indices: [], watchlist: [] },
    cn: {
      groups: ['全部', '半导体设备', '功率半导体', '自选'],
      indices: [],
      watchlist: [
        { symbol: '300316.SZ', name: '晶盛机电', group: '半导体设备', summary: '减薄 / 划片 / 激光加工' },
        { symbol: '300316.SZ', name: '晶盛机电', group: '功率半导体', summary: 'SiC 衬底 / 外延' },
      ],
    },
    global: { groups: ['指数'], watchlist: [] },
  };
  const board = buildCnMarketBoard({
    quotes: [{
      symbol: '300316.SZ', name: '晶盛机电', lastPrice: 70, prevClose: 68, change: 2, changePct: 2.94,
      currency: 'CNY', session: 'regular',
    }],
    extraSymbols: ['688001.SS'],
    fetchedAt: 1,
    marketCatalog,
  });
  const rows = board.watchlist.filter((item) => item.symbol === '300316.SZ');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((item) => item.group), ['半导体设备', '功率半导体']);
  assert.equal(rows[0].lastPrice, 70);
  assert.equal(board.provider || rows[0].provider, 'market');
  assert.equal(parseCnExtraSymbols('688001.SS,NVDA,300316.SZ', marketCatalog).join(','), '688001.SS');
});

test('market service uses injected yahoo client and cache', async () => {
  let calls = 0;
  const yahoo = {
    async fetchQuotes(symbols) {
      calls += 1;
      return {
        session: 'closed',
        quotes: symbols.slice(0, 2).map((symbol) => ({
          symbol, name: symbol, lastPrice: 1, changePct: 1, change: 0, high: 1, low: 1,
          prevClose: 1, volume: 1, sparkline: [1, 1], currency: 'USD', exchange: 'NMS',
          marketTime: 1, session: 'closed',
        })),
      };
    },
    async searchSymbols(query) {
      return [{ symbol: query.toUpperCase(), name: query, type: 'EQUITY', exchange: 'NMS' }];
    },
  };
  const service = createMarketService({ yahoo, ttlMs: 60_000, now: () => 1_000 });
  const first = await service.getBoard({ board: 'us' });
  const second = await service.getBoard({ board: 'us' });
  assert.equal(first.board, 'us');
  assert.equal(second.watchlist[0].symbol, first.watchlist[0].symbol);
  assert.equal(calls, 1);
  const items = await service.search('nvda');
  assert.equal(items[0].symbol, 'NVDA');
});

test('market service refresh option bypasses quote cache', async () => {
  let calls = 0;
  const yahoo = {
    async fetchQuotes() {
      calls += 1;
      return { quotes: [{ symbol: 'USDCNY=X', lastPrice: calls, prevClose: 1, currency: 'CNY', session: 'regular' }] };
    },
  };
  const service = createMarketService({ yahoo, ttlMs: 60_000, now: () => 1_000 });
  const first = await service.fetchQuotes(['USDCNY=X']);
  const cached = await service.fetchQuotes(['USDCNY=X']);
  const live = await service.fetchQuotes(['USDCNY=X'], { refresh: true });
  assert.equal(first[0].lastPrice, 1);
  assert.equal(cached[0].lastPrice, 1);
  assert.equal(live[0].lastPrice, 2);
  assert.equal(calls, 2);
});

test('market service returns a partial board when yahoo fails', async () => {
  const yahoo = {
    async fetchQuotes() {
      throw new Error('Yahoo 行情请求超时。');
    },
    async searchSymbols() {
      return [];
    },
  };
  const service = createMarketService({ yahoo, ttlMs: 60_000, now: () => 1_000 });
  const board = await service.getBoard({ board: 'us' });
  assert.equal(board.board, 'us');
  assert.equal(board.mode, 'partial');
  assert.match(board.note, /暂未获取成功/);
  assert.equal(board.watchlist[0].lastPrice, null);
});

test('market query allows overview, us, asia, cn, and global', () => {
  assert.equal(parseMarketQuery({ board: 'us' }).board, 'us');
  assert.equal(parseMarketQuery({ board: 'global' }).board, 'global');
  assert.equal(parseMarketQuery({ board: 'cn' }).board, 'cn');
  assert.equal(parseMarketQuery({ extraCn: '688110.SS' }).extraCn, '688110.SS');
  assert.throws(() => parseMarketQuery({ board: 'crypto' }));
});

test('global asset board maps yahoo symbols to stable display codes', () => {
  const board = buildGlobalAssetBoard({
    quotes: [
      { symbol: 'DX-Y.NYB', name: 'ICE US Dollar Index', lastPrice: 99.55, changePct: 0.16, change: 0.16, high: 100, low: 99, prevClose: 99.4, volume: 1, sparkline: [99, 99.55], currency: 'USD', exchange: 'ICE', marketTime: 1, session: 'regular' },
      { symbol: 'GC=F', name: 'Gold Dec 26', lastPrice: 4334.7, changePct: -0.4, change: -17, high: 4350, low: 4320, prevClose: 4352, volume: 1, sparkline: [4330, 4334.7], currency: 'USD', exchange: 'COMEX', marketTime: 1, session: 'regular' },
      { symbol: 'CNY=X', name: 'USD/CNY', lastPrice: 6.6995, changePct: 0.02, change: 0.001, high: 6.7, low: 6.69, prevClose: 6.698, volume: 0, sparkline: [6.7, 6.6995], currency: 'CNY', exchange: 'CCY', marketTime: 1, session: 'regular' },
    ],
    session: 'regular',
    fetchedAt: 1_700_000_000_000,
    errors: 0,
  });
  const dxy = board.watchlist.find((item) => item.symbol === 'DXY');
  const gold = board.watchlist.find((item) => item.symbol === 'XAUUSD');
  const cny = board.watchlist.find((item) => item.symbol === 'USDCNY');
  const future = board.watchlist.find((item) => item.symbol === 'GC');
  assert.equal(board.board, 'global');
  assert.equal(dxy.assetClass, 'fx');
  assert.equal(dxy.lastPrice, 99.55);
  assert.equal(gold.assetClass, 'metal');
  assert.equal(gold.summary, 'COMEX 黄金主力');
  assert.equal(gold.expiry, '2026-12');
  assert.equal(future.assetClass, 'future');
  assert.equal(future.lastPrice, gold.lastPrice);
  assert.equal(cny.market, 'global');
  assert.equal(expiryFromFuturesName('Crude Oil Oct 26'), '2026-10');
});

test('market service returns a global board from injected yahoo quotes', async () => {
  const yahoo = {
    async fetchQuotes(symbols) {
      return {
        session: 'regular',
        quotes: symbols.map((symbol) => ({
          symbol, name: symbol, lastPrice: 10, changePct: 0.1, change: 0.01, high: 11, low: 9,
          prevClose: 9.9, volume: 1, sparkline: [10, 10], currency: 'USD', exchange: 'TEST',
          marketTime: 1, session: 'regular',
        })),
      };
    },
    async searchSymbols() {
      return [];
    },
  };
  const service = createMarketService({ yahoo, ttlMs: 60_000, now: () => 1_000 });
  const board = await service.getBoard({ board: 'global' });
  assert.equal(board.board, 'global');
  assert.equal(board.watchlist[0].symbol, '000001.SH');
  assert.equal(board.mode, 'live');
});

test('overview service loads A shares before Shanghai 17:00 and US after', async () => {
  const xueqiuSymbols = [];
  const yahooSymbols = [];
  const marketCatalog = {
    version: 1,
    us: {
      groups: ['全部'],
      indices: [],
      watchlist: [{ symbol: 'NVDA', name: 'NVIDIA', group: '全部', summary: 'GPU' }],
    },
    asia: { groups: ['全部'], indices: [], watchlist: [] },
    cn: {
      groups: ['全部', '芯片设计'],
      indices: [{ symbol: '000001.SS', name: '上证指数', group: '指数', summary: '' }],
      watchlist: [{ symbol: '688110.SS', name: '东芯股份', group: '芯片设计', summary: '存储芯片' }],
    },
    global: { groups: ['指数'], watchlist: [] },
  };
  function service(nowMs) {
    xueqiuSymbols.length = 0;
    yahooSymbols.length = 0;
    return createMarketService({
      marketCatalog,
      ttlMs: 1,
      xueqiuTtlMs: 1,
      now: () => nowMs,
      yahoo: {
        async fetchQuotes(symbols) {
          yahooSymbols.push(...symbols);
          return {
            session: 'closed',
            quotes: symbols.map((symbol) => ({
              symbol, name: symbol, lastPrice: 10, changePct: 1, change: 0.1, high: 11, low: 9,
              prevClose: 9.9, volume: 1, sparkline: [10], currency: 'USD', exchange: 'TEST',
              marketTime: 1, session: 'closed',
            })),
          };
        },
        async searchSymbols() { return []; },
      },
      xueqiuQuotes: {
        async fetchQuotes(symbols) {
          xueqiuSymbols.push(...symbols);
          return symbols.map((symbol) => ({
            symbol, name: symbol, lastPrice: 80, prevClose: 70, change: 10, changePct: 14.29,
            session: 'regular', currency: 'CNY',
          }));
        },
      },
      cnQuotes: { async fetchQuotes() { return []; } },
    });
  }
  const day = await service(Date.UTC(2026, 8, 18, 8, 0, 0)).getBoard({ board: 'overview' });
  assert.equal(day.focus, 'cn');
  assert.equal(day.sections[0].id, 'cn');
  assert.ok(xueqiuSymbols.includes('688110.SS'));
  assert.equal(yahooSymbols.includes('NVDA'), false);
  const night = await service(Date.UTC(2026, 8, 18, 9, 0, 0)).getBoard({ board: 'overview' });
  assert.equal(night.focus, 'us');
  assert.equal(night.sections[0].id, 'us');
  assert.ok(yahooSymbols.includes('NVDA'));
  assert.equal(xueqiuSymbols.includes('688110.SS'), false);
});
