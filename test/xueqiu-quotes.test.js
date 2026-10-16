import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SPARKLINE_FAIL_BACKOFF_MS,
  createXueqiuQuoteClient,
  isHkYahooSymbol,
  isXueqiuYahooSymbol,
  quoteFromXueqiuItem,
  sparklineFromXueqiuKline,
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
  assert.equal(isXueqiuYahooSymbol('AG00Y'), false);
  assert.equal(yahooToXueqiuSymbol('M00Y'), null);
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

test('xueqiu daily kline closes become the sparkline', async () => {
  const payload = {
    data: {
      column: ['timestamp', 'volume', 'open', 'high', 'low', 'close'],
      item: [
        [1, 10, 1.1, 1.4, 1.0, 1.2],
        [2, 11, 1.2, 1.5, 1.1, 1.44],
      ],
    },
  };
  assert.deepEqual(sparklineFromXueqiuKline(payload), [1.2, 1.44]);
  const quote = quoteFromXueqiuItem({
    ...xueqiuItem('SH516640', 1.44, 1.391),
    kline: payload,
  }, '516640.SS');
  assert.deepEqual(quote.sparkline, [1.2, 1.44]);
  assert.deepEqual(quoteFromXueqiuItem(xueqiuItem('SH516640', 1.44, 1.391), '516640.SS').sparkline, []);
  const requested = [];
  const client = createXueqiuQuoteClient({
    cookie: 'xq_a_token=user-token',
    now: () => 1_700_000_000_000,
    fetchImpl: async (url) => {
      requested.push(String(url));
      return jsonResponse(payload);
    },
  });
  const series = await client.fetchSparklines(['516640.SS', 'AAPL']);
  assert.equal(series.length, 1);
  assert.equal(series[0].symbol, '516640.SS');
  assert.deepEqual(series[0].sparkline, [1.2, 1.44]);
  assert.match(requested[0], /\/v5\/stock\/chart\/kline\.json/);
  assert.match(decodeURIComponent(requested[0]), /symbol=SH516640/);
  assert.match(requested[0], /period=day/);
  const again = await client.fetchSparklines(['516640.SS']);
  assert.deepEqual(again[0].sparkline, [1.2, 1.44]);
  assert.equal(requested.length, 1);
});

test('xueqiu kline cache keeps the previous series and caps a round at ten symbols', async () => {
  let fail = false;
  let calls = 0;
  const client = createXueqiuQuoteClient({
    cookie: 'xq_a_token=user-token',
    now: () => Date.parse('2026-10-16T02:00:00Z'),
    fetchImpl: async (url) => {
      const href = String(url);
      if (!href.includes('kline.json')) return jsonResponse({ data: { items: [] } });
      calls += 1;
      if (fail) throw new Error('waf');
      const symbol = new URL(href).searchParams.get('symbol');
      return jsonResponse({
        data: {
          column: ['timestamp', 'close'],
          item: [[1, 1], [2, 2]],
        },
        symbol,
      });
    },
  });
  const symbols = Array.from({ length: 12 }, (_, index) => `${String(600000 + index).padStart(6, '0')}.SS`);
  const first = await client.fetchSparklines(symbols);
  assert.equal(calls, 10);
  assert.equal(first.length, 10);
  fail = true;
  const second = await client.fetchSparklines(symbols.slice(0, 10));
  assert.equal(second.length, 10);
  assert.deepEqual(second[0].sparkline, [1, 2]);
  const aborted = new AbortController();
  aborted.abort();
  const before = calls;
  await client.fetchSparklines(['600100.SS'], { signal: aborted.signal });
  assert.equal(calls, before);
});

test('a symbol that keeps failing gives its slot to symbols after the tenth', async () => {
  assert.deepEqual([...SPARKLINE_FAIL_BACKOFF_MS], [10 * 60_000, 30 * 60_000, 60 * 60_000]);
  const clock = { value: Date.parse('2026-10-16T02:00:00Z') };
  const requested = [];
  const client = createXueqiuQuoteClient({
    cookie: 'xq_a_token=user-token',
    now: () => clock.value,
    fetchImpl: async (url) => {
      const href = String(url);
      if (!href.includes('kline.json')) return jsonResponse({ data: { items: [] } });
      const symbol = new URL(href).searchParams.get('symbol');
      requested.push(symbol);
      if (symbol === 'SH600000') throw new Error('waf');
      return jsonResponse({
        data: {
          column: ['timestamp', 'close'],
          item: [[clock.value - 86_400_000, 1], [clock.value, 2]],
        },
      });
    },
  });
  const symbols = Array.from({ length: 15 }, (_, index) => `${String(600000 + index).padStart(6, '0')}.SS`);
  const first = await client.fetchSparklines(symbols);
  assert.equal(requested.length, 10);
  assert.equal(requested[0], 'SH600000');
  assert.equal(requested.includes('SH600010'), false);
  assert.equal(first.some((item) => item.symbol === '600000.SS'), false);
  assert.equal(first.some((item) => item.symbol === '600009.SS'), true);
  requested.length = 0;
  const second = await client.fetchSparklines(symbols);
  assert.deepEqual(requested, ['SH600010', 'SH600011', 'SH600012', 'SH600013', 'SH600014']);
  assert.equal(second.some((item) => item.symbol === '600014.SS'), true);
  requested.length = 0;
  clock.value += 9 * 60_000;
  await client.fetchSparklines(symbols);
  assert.equal(requested.includes('SH600000'), false);
  clock.value += 60_000;
  await client.fetchSparklines(['600000.SS']);
  assert.deepEqual(requested, ['SH600000']);
  requested.length = 0;
  clock.value += 10 * 60_000;
  await client.fetchSparklines(['600000.SS']);
  assert.deepEqual(requested, []);
  clock.value += 20 * 60_000;
  await client.fetchSparklines(['600000.SS']);
  assert.deepEqual(requested, ['SH600000']);
  requested.length = 0;
  clock.value += 2 * 60 * 60_000;
  await client.fetchSparklines(symbols);
  assert.equal(requested.includes('SH600000'), false);
});
