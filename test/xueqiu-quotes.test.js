import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createXueqiuQuoteClient,
  isHkYahooSymbol,
  isXueqiuYahooSymbol,
  quoteFromXueqiuItem,
  yahooToXueqiuSymbol,
} from '../packages/connectors/src/xueqiu-quotes.js';
import { createMarketService } from '../packages/connectors/src/market-service.js';

function jsonResponse(payload, headers = {}) {
  const setCookies = headers.setCookies || [];
  return {
    ok: true,
    status: 200,
    headers: {
      getSetCookie: () => setCookies,
      get(name) {
        if (String(name).toLowerCase() === 'set-cookie') return setCookies[0] || null;
        return null;
      },
    },
    async arrayBuffer() {
      return Buffer.from(JSON.stringify(payload));
    },
  };
}

function htmlResponse(setCookies = ['xq_a_token=test-token; path=/; domain=.xueqiu.com']) {
  return {
    ok: true,
    status: 200,
    headers: {
      getSetCookie: () => setCookies,
      get(name) {
        if (String(name).toLowerCase() === 'set-cookie') return setCookies[0] || null;
        return null;
      },
    },
    async arrayBuffer() {
      return Buffer.from('<html>hq</html>');
    },
  };
}

function xueqiuItem(symbol, current, lastClose, extras = {}) {
  return {
    market: { status: '交易中', status_id: 5, delay_tag: 0, ...(extras.market || {}) },
    quote: {
      symbol,
      current,
      last_close: lastClose,
      currency: extras.currency || 'CNY',
      ...(extras.quote || {}),
    },
  };
}

test('yahoo symbols map to xueqiu codes across A shares ETFs B shares and HK', () => {
  assert.equal(yahooToXueqiuSymbol('516640.SS'), 'SH516640');
  assert.equal(yahooToXueqiuSymbol('300346.SZ'), 'SZ300346');
  assert.equal(yahooToXueqiuSymbol('900901.SS'), 'SH900901');
  assert.equal(yahooToXueqiuSymbol('0981.HK'), '00981');
  assert.equal(yahooToXueqiuSymbol('0001.HK'), '00001');
  assert.equal(yahooToXueqiuSymbol('00700.HK'), '00700');
  assert.equal(isXueqiuYahooSymbol('516640.SS'), true);
  assert.equal(isXueqiuYahooSymbol('0981.HK'), true);
  assert.equal(isHkYahooSymbol('USDCNY=X'), false);
  assert.equal(isXueqiuYahooSymbol('AAPL'), false);
  assert.equal(yahooToXueqiuSymbol('AAPL'), null);
});

test('xueqiu quote item maps to last price previous close and session', () => {
  const quote = quoteFromXueqiuItem(xueqiuItem('SH516640', 1.44, 1.391), '516640.SS');
  assert.equal(quote.symbol, '516640.SS');
  assert.equal(quote.lastPrice, 1.44);
  assert.equal(quote.prevClose, 1.391);
  assert.equal(quote.session, 'regular');
  assert.equal(quote.currency, 'CNY');
  assert.equal(quoteFromXueqiuItem({ market: null, quote: null }, '516640.SS'), null);
});

test('xueqiu quote client bootstraps anonymous token then batches stocks and ETFs', async () => {
  const requested = [];
  const client = createXueqiuQuoteClient({
    cookie: '',
    now: () => 1,
    fetchImpl: async (url, init) => {
      requested.push({ href: String(url), cookie: init.headers.Cookie || '' });
      if (String(url).includes('xueqiu.com/hq')) return htmlResponse();
      assert.equal(decodeURIComponent(String(url)).includes('/v5/stock/batch/quote.json'), true);
      assert.equal(decodeURIComponent(String(url)).includes('symbol=SH516640,SZ300346'), true);
      assert.equal(String(url).includes('516640.SS'), false);
      return jsonResponse({
        error_code: 0,
        data: {
          items: [
            xueqiuItem('SH516640', 1.44, 1.391),
            xueqiuItem('SZ300346', 53.73, 52.35),
          ],
        },
      });
    },
  });
  const quotes = await client.fetchQuotes(['516640.SS', '300346.SZ']);
  assert.equal(requested[0].href, 'https://xueqiu.com/hq');
  assert.equal(requested[1].cookie.includes('xq_a_token=test-token'), true);
  assert.equal(quotes.find((item) => item.symbol === '516640.SS').lastPrice, 1.44);
  assert.equal(quotes.find((item) => item.symbol === '300346.SZ').lastPrice, 53.73);
});

test('xueqiu quote client uses provided cookie and does not visit hq', async () => {
  const requested = [];
  const client = createXueqiuQuoteClient({
    cookie: 'xq_a_token=user-token; u=1',
    now: () => 1,
    fetchImpl: async (url, init) => {
      requested.push({ href: String(url), cookie: init.headers.Cookie || '' });
      return jsonResponse({
        error_code: 0,
        data: { items: [xueqiuItem('00700', 423.8, 420, { currency: 'HKD' })] },
      });
    },
  });
  const quotes = await client.fetchQuotes(['00700.HK']);
  assert.equal(requested.some((item) => item.href.includes('/hq')), false);
  assert.equal(requested[0].href.includes('symbol=00700'), true);
  assert.equal(requested[0].cookie.includes('xq_a_token=user-token'), true);
  assert.equal(quotes[0].lastPrice, 423.8);
  assert.equal(quotes[0].currency, 'HKD');
});

test('market service prefers xueqiu over tonghuashun and yahoo for CN and HK', async () => {
  const yahooSymbols = [];
  const thsSymbols = [];
  const service = createMarketService({
    ttlMs: 1,
    xueqiuTtlMs: 1,
    now: () => 1,
    yahoo: {
      async fetchQuotes(symbols) {
        yahooSymbols.push(...symbols);
        return { quotes: symbols.map((symbol) => ({ symbol, lastPrice: 9, prevClose: 8, currency: 'USD', session: 'closed' })) };
      },
    },
    cnQuotes: {
      async fetchQuotes(symbols) {
        thsSymbols.push(...symbols);
        return symbols.map((symbol) => ({ symbol, lastPrice: 2, prevClose: 1, session: 'regular' }));
      },
    },
    xueqiuQuotes: {
      async fetchQuotes(symbols) {
        return symbols.map((symbol) => ({ symbol, lastPrice: 1.44, prevClose: 1.391, session: 'regular', currency: 'CNY' }));
      },
    },
  });
  const quotes = await service.fetchQuotes(['516640.SS', '0981.HK', 'USDCNY=X']);
  assert.equal(quotes.find((item) => item.symbol === '516640.SS').lastPrice, 1.44);
  assert.equal(quotes.find((item) => item.symbol === '0981.HK').lastPrice, 1.44);
  assert.equal(quotes.find((item) => item.symbol === 'USDCNY=X').lastPrice, 9);
  assert.deepEqual(yahooSymbols, ['USDCNY=X']);
  assert.deepEqual(thsSymbols, []);
});

test('market service falls back to tonghuashun then yahoo when xueqiu misses', async () => {
  const yahooSymbols = [];
  const service = createMarketService({
    ttlMs: 1,
    xueqiuTtlMs: 1,
    now: () => 1,
    yahoo: {
      async fetchQuotes(symbols) {
        yahooSymbols.push([...symbols]);
        return { quotes: symbols.map((symbol) => ({ symbol, lastPrice: 9, prevClose: 8, currency: 'CNY', session: 'regular' })) };
      },
    },
    cnQuotes: {
      async fetchQuotes(symbols) {
        return symbols
          .filter((symbol) => symbol === '300346.SZ')
          .map((symbol) => ({ symbol, lastPrice: 53.73, prevClose: 52.35, session: 'regular' }));
      },
    },
    xueqiuQuotes: { async fetchQuotes() { return []; } },
  });
  const quotes = await service.fetchQuotes(['300346.SZ', '900901.SS', '0981.HK']);
  assert.equal(quotes.find((item) => item.symbol === '300346.SZ').lastPrice, 53.73);
  assert.equal(quotes.find((item) => item.symbol === '900901.SS').lastPrice, 9);
  assert.equal(quotes.find((item) => item.symbol === '0981.HK').lastPrice, 9);
  assert.deepEqual(yahooSymbols[0], ['900901.SS', '0981.HK']);
});
