import test from 'node:test';
import assert from 'node:assert/strict';
import { createCnQuoteClient, isCnFundYahooSymbol, isCnYahooSymbol, quoteFromHithinkItem, yahooToThscode } from '../packages/connectors/src/cn-quotes.js';
import { createMarketService } from '../packages/connectors/src/market-service.js';

test('cn yahoo symbols map to tonghuashun SH SZ codes', () => {
  assert.equal(isCnYahooSymbol('516640.SS'), true);
  assert.equal(isCnYahooSymbol('159915.sz'), true);
  assert.equal(isCnYahooSymbol('900948.SS'), true);
  assert.equal(isCnYahooSymbol('0981.HK'), false);
  assert.equal(isCnFundYahooSymbol('516640.SS'), true);
  assert.equal(isCnFundYahooSymbol('588940.SS'), true);
  assert.equal(isCnFundYahooSymbol('300346.SZ'), false);
  assert.equal(yahooToThscode('516640.SS'), '516640.SH');
  assert.equal(yahooToThscode('159915.SZ'), '159915.SZ');
  assert.equal(yahooToThscode('900948.SS'), '900948.SH');
});

test('hithink snapshot item maps to last price and previous close', () => {
  const quote = quoteFromHithinkItem({ thscode: '516640.SH', last_price: 1.375, prev_price: 1.342 });
  assert.equal(quote.symbol, '516640.SS');
  assert.equal(quote.lastPrice, 1.375);
  assert.equal(quote.prevClose, 1.342);
  assert.equal(quoteFromHithinkItem({ thscode: '516640.SH', last_price: null, prev_price: 1.342 }), null);
});

test('cn quote client calls snapshot with thscodes and api key', async () => {
  const requested = [];
  const client = createCnQuoteClient({
    apiKey: 'test-key',
    baseUrl: 'https://fuyao.example',
    fetchImpl: async (url, init) => {
      requested.push({ href: String(url), key: init.headers['X-api-key'] });
      const href = String(url);
      const item = href.includes('/fund/market/snapshot')
        ? { thscode: '516640.SH', last_price: 1.385, prev_price: 1.342 }
        : { thscode: '300346.SZ', last_price: 53.73, prev_price: 52.35 };
      return {
        ok: true,
        async json() {
          return { code: 0, data: { item: [item] } };
        },
      };
    },
  });
  const quotes = await client.fetchQuotes(['516640.SS', '300346.SZ']);
  assert.equal(quotes.find((item) => item.symbol === '516640.SS').lastPrice, 1.385);
  assert.equal(quotes.find((item) => item.symbol === '300346.SZ').lastPrice, 53.73);
  assert.equal(requested[0].key, 'test-key');
  assert.equal(requested.some((item) => item.href.includes('/api/fund/market/snapshot') && item.href.includes('thscode=516640.SH')), true);
  assert.equal(requested.some((item) => item.href.includes('/api/a-share/prices/snapshot') && item.href.includes('thscodes=300346.SZ')), true);
  assert.equal(requested.some((item) => item.href.includes('thscodes=') && item.href.includes('516640')), false);
});

test('cn quote client returns empty without api key', async () => {
  const client = createCnQuoteClient({
    apiKey: '',
    fetchImpl: async () => {
      throw new Error('should not request');
    },
  });
  assert.deepEqual(await client.fetchQuotes(['516640.SS']), []);
});

test('market service uses mainland last price for SS SZ holdings quotes', async () => {
  const yahooSymbols = [];
  const yahoo = {
    async fetchQuotes(symbols) {
      yahooSymbols.push(...symbols);
      return { quotes: symbols.map((symbol) => ({ symbol, lastPrice: 9, prevClose: 8, currency: 'USD', session: 'closed' })) };
    },
  };
  const cnQuotes = {
    async fetchQuotes(symbols) {
      return symbols.map((symbol) => ({ symbol, lastPrice: 1.375, prevClose: 1.342, session: 'regular' }));
    },
  };
  const service = createMarketService({ yahoo, cnQuotes, xueqiuQuotes: { async fetchQuotes() { return []; } }, ttlMs: 1, now: () => 1 });
  const quotes = await service.fetchQuotes(['516640.SS', 'USDCNY=X']);
  assert.equal(quotes.find((item) => item.symbol === '516640.SS').lastPrice, 1.375);
  assert.equal(quotes.find((item) => item.symbol === 'USDCNY=X').lastPrice, 9);
  assert.deepEqual(yahooSymbols, ['USDCNY=X']);
});

test('market service falls back to yahoo when mainland quotes are missing', async () => {
  const yahoo = {
    async fetchQuotes(symbols) {
      return { quotes: symbols.map((symbol) => ({ symbol, lastPrice: 1.37, prevClose: 1.342, currency: 'CNY', session: 'regular' })) };
    },
  };
  const service = createMarketService({
    yahoo,
    cnQuotes: { async fetchQuotes() { return []; } },
    xueqiuQuotes: { async fetchQuotes() { return []; } },
    ttlMs: 1,
    now: () => 1,
  });
  const quotes = await service.fetchQuotes(['516640.SS']);
  assert.equal(quotes[0].lastPrice, 1.37);
});
