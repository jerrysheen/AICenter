import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteFromSpark } from '../packages/connectors/src/yahoo.js';
import { buildOverviewBoard, buildUsMarketBoard, parseUsExtraSymbols } from '../packages/connectors/src/market-boards.js';
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

test('us board keeps catalog names, groups, and summaries', () => {
  const board = buildUsMarketBoard({
    quotes: [{
      symbol: 'NVDA', name: 'NVIDIA Corporation', lastPrice: 212.18, changePct: 0.58, change: 1.23,
      high: 214, low: 208, prevClose: 210.95, volume: 1, sparkline: [210, 212], currency: 'USD',
      exchange: 'NasdaqGS', marketTime: 1_700_000_000, session: 'regular',
    }],
    session: 'regular',
    fetchedAt: 1_700_000_000_000,
    errors: 1,
  });
  const nvidia = board.watchlist.find((item) => item.symbol === 'NVDA');
  assert.equal(nvidia.name, 'NVIDIA');
  assert.equal(nvidia.group, '科技巨头');
  assert.equal(nvidia.summary, 'GPU / AI 算力');
  assert.equal(nvidia.provider, 'yahoo');
  assert.equal(nvidia.market, 'us');
  assert.equal(board.groups[1], '科技巨头');
  assert.equal(parseUsExtraSymbols('nvda,ZZZZ').join(','), 'ZZZZ');
});

test('overview board aggregates us and asia breadth', () => {
  const us = buildUsMarketBoard({ quotes: [], session: 'closed', fetchedAt: 10 });
  const asia = buildUsMarketBoard({ quotes: [], session: 'closed', fetchedAt: 20 });
  asia.board = 'asia';
  asia.market = 'asia';
  asia.breadth = { advancers: 7, decliners: 27, unchanged: 0 };
  asia.sessions = { kr: 'closed', tw: 'closed', jp: 'closed' };
  const overview = buildOverviewBoard(us, asia);
  assert.equal(overview.sections[0].id, 'us');
  assert.equal(overview.sections[1].title, '亚洲半导体');
  assert.equal(overview.sections[1].breadth.decliners, 27);
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

test('market query only allows overview, us, and asia', () => {
  assert.equal(parseMarketQuery({ board: 'us' }).board, 'us');
  assert.throws(() => parseMarketQuery({ board: 'cn' }));
});
