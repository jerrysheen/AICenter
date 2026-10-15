import test from 'node:test';
import assert from 'node:assert/strict';
import { createYahooClient, isUsMarketSymbol, preferNewerQuote, yahooCacheMs } from '../packages/connectors/src/yahoo.js';
import {
  quoteFromSinaUsBody,
  quoteFromTencentUsBody,
  yahooToSinaUs,
  yahooToTencentUs,
} from '../packages/connectors/src/us-quote-fallback.js';

const NOW = Date.parse('2026-10-15T13:53:10Z');

function spark(symbol, price) {
  return {
    symbol,
    response: [{
      meta: {
        symbol,
        shortName: symbol,
        currency: 'USD',
        regularMarketPrice: price,
        previousClose: price - 1,
        regularMarketTime: Math.trunc(NOW / 1000),
        currentTradingPeriod: { regular: { start: 0, end: 4_000_000_000 } },
      },
      timestamp: [Math.trunc(NOW / 1000)],
      indicators: { quote: [{ close: [price] }] },
    }],
  };
}

function response(body, { status = 200, headers = {} } = {}) {
  return new Response(body, { status, headers });
}

const TENCENT_AAPL = '200~苹果~AAPL.OQ~345.95~342.96~346.95~6332086~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~~2026-10-15 09:52:59~2.99~0.87~347.85~345.05~USD~6332086';
const SINA_SOX = '费交所半导体股指数,11229.6629,-3.89,2026-10-15 21:53:06,-454.7196,11280.8886,11406.3848,11203.0740,14655.2861,6160.0449,0,0,0,0.00,--,0.00,0.00,0.00,0.00,0,0,0.0000,0.00,0.00,,Oct 15 09:53AM EDT,11684.3825,0,1,2026';

test('US symbol map and live Tencent / Sina fields', () => {
  assert.equal(yahooToTencentUs('^GSPC'), 'us.INX');
  assert.equal(yahooToTencentUs('^DJI'), 'us.DJI');
  assert.equal(yahooToTencentUs('^IXIC'), 'us.IXIC');
  assert.equal(yahooToTencentUs('AAPL'), 'usAAPL');
  assert.equal(yahooToTencentUs('^KS11'), null);
  assert.equal(yahooToTencentUs('005930.KS'), null);
  assert.equal(yahooToSinaUs('^GSPC'), 'gb_inx');
  assert.equal(yahooToSinaUs('^SOX'), 'gb_sox');
  assert.equal(yahooToSinaUs('NVDA'), 'gb_nvda');
  assert.equal(yahooToSinaUs('^HSI'), null);

  const apple = quoteFromTencentUsBody(TENCENT_AAPL, 'AAPL', NOW);
  assert.equal(apple.lastPrice, 345.95);
  assert.equal(apple.prevClose, 342.96);
  assert.equal(apple.change, 2.99);
  assert.equal(apple.changePct, 0.87);
  assert.equal(apple.high, 347.85);
  assert.equal(apple.low, 345.05);
  assert.equal(apple.provider, 'tencent');
  assert.equal(apple.currency, 'USD');
  assert.equal(apple.session, 'regular');

  const sox = quoteFromSinaUsBody(SINA_SOX, '^SOX', NOW);
  assert.equal(sox.lastPrice, 11229.6629);
  assert.equal(sox.prevClose, 11684.3825);
  assert.equal(sox.change, -454.7196);
  assert.equal(sox.changePct, -3.89);
  assert.equal(sox.high, 11406.3848);
  assert.equal(sox.low, 11203.074);
  assert.equal(sox.provider, 'sina');

  const stale = Array(36).fill('0');
  stale[1] = 'VIX';
  stale[3] = '21.67';
  stale[4] = '21.67';
  stale[30] = '2026-09-14 09:30:00';
  stale[35] = 'USD';
  assert.equal(quoteFromTencentUsBody(stale.join('~'), '^VIX', NOW), null);
});

test('401 refreshes the Yahoo crumb and retries once', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const href = String(url);
    calls.push(href);
    if (href.startsWith('https://fc.yahoo.com')) {
      return response('', { status: 404, headers: { 'set-cookie': 'A3=cookie1; Path=/; Domain=.yahoo.com' } });
    }
    if (href.includes('/v1/test/getcrumb')) {
      assert.match(init.headers.Cookie, /A3=cookie1/);
      return response('crumb1');
    }
    if (href.includes('/v7/finance/spark')) {
      const parsed = new URL(href);
      if (parsed.searchParams.get('crumb') !== 'crumb1') return response('no', { status: 401 });
      assert.match(init.headers.Cookie, /A3=cookie1/);
      const symbols = parsed.searchParams.get('symbols').split(',');
      return response(JSON.stringify({ spark: { result: symbols.map((symbol) => spark(symbol, 10)) } }));
    }
    throw new Error(`unexpected ${href}`);
  };
  const client = createYahooClient({
    fetchImpl,
    now: () => NOW,
    timeoutMs: 1_000,
    minIntervalMs: 0,
    log() {},
    fallback: { async fetchQuotes() { return []; } },
  });
  const board = await client.fetchQuotes(['AAPL']);
  assert.equal(board.quotes[0].lastPrice, 10);
  assert.equal(board.quotes[0].provider, 'yahoo');
  assert.equal(calls.filter((href) => href.includes('/v7/finance/spark')).length, 2);
  assert.equal(calls.filter((href) => href.includes('getcrumb')).length, 1);
});

test('429 backs off with Retry-After, coalesces callers, and falls back to Tencent', async () => {
  let clock = NOW;
  let sparkCalls = 0;
  const logs = [];
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes('/v7/finance/spark')) {
      sparkCalls += 1;
      const symbols = new URL(href).searchParams.get('symbols').split(',');
      if (sparkCalls === 1) {
        return response('busy', { status: 429, headers: { 'retry-after': '30' } });
      }
      return response(JSON.stringify({ spark: { result: symbols.map((symbol) => spark(symbol, 20)) } }));
    }
    if (href.includes('qt.gtimg.cn')) {
      const codes = href.split('q=')[1].split(',');
      const lines = codes.map((code) => {
        const fields = TENCENT_AAPL.split('~');
        fields[2] = code;
        return `v_${code}="${fields.join('~')}";`;
      });
      return response(lines.join('\n'));
    }
    if (href.includes('hq.sinajs.cn')) return response('var hq_str_gb_sox="";');
    throw new Error(`unexpected ${href}`);
  };
  const client = createYahooClient({
    fetchImpl,
    now: () => clock,
    timeoutMs: 1_000,
    cacheTtlMs: 45_000,
    minIntervalMs: 0,
    log(_level, message) { logs.push(message); },
  });
  const [first, second] = await Promise.all([
    client.fetchQuotes(['AAPL', 'NVDA']),
    client.fetchQuotes(['NVDA', 'MSFT']),
  ]);
  assert.equal(sparkCalls, 1);
  assert.equal(first.quotes.find((item) => item.symbol === 'AAPL').provider, 'tencent');
  assert.equal(first.quotes.find((item) => item.symbol === 'AAPL').lastPrice, 345.95);
  assert.equal(second.quotes.find((item) => item.symbol === 'NVDA').provider, 'tencent');
  assert.match(logs.join('\n'), /Yahoo HTTP 429 backoffMs=30000 retryAfterMs=30000/);
  const afterLimit = sparkCalls;
  clock += 1_000;
  const again = await client.fetchQuotes(['AMD']);
  assert.equal(sparkCalls, afterLimit);
  assert.equal(again.quotes.find((item) => item.symbol === 'AMD')?.provider, 'tencent');
});

test('a fresh shared cache serves the second snapshot without another Yahoo request', async () => {
  let clock = NOW;
  let sparkCalls = 0;
  const fetchImpl = async (url) => {
    const href = String(url);
    if (!href.includes('/v7/finance/spark')) throw new Error(href);
    sparkCalls += 1;
    const symbols = new URL(href).searchParams.get('symbols').split(',');
    return response(JSON.stringify({ spark: { result: symbols.map((symbol) => spark(symbol, 7)) } }));
  };
  const client = createYahooClient({
    fetchImpl,
    now: () => clock,
    timeoutMs: 1_000,
    cacheTtlMs: 45_000,
    minIntervalMs: 0,
    log() {},
    fallback: { async fetchQuotes() { return []; } },
  });
  const first = await client.fetchQuotes(['AAPL']);
  const second = await client.fetchQuotes(['AAPL']);
  assert.equal(first.quotes[0].lastPrice, 7);
  assert.equal(second.quotes[0].lastPrice, 7);
  assert.equal(sparkCalls, 1);
  clock += 46_000;
  await client.fetchQuotes(['AAPL']);
  assert.equal(sparkCalls, 2);
});

test('Yahoo cache default is 30 seconds and US symbols are separate from Asia', () => {
  assert.equal(yahooCacheMs({}), 30_000);
  assert.equal(isUsMarketSymbol('AAPL'), true);
  assert.equal(isUsMarketSymbol('^GSPC'), true);
  assert.equal(isUsMarketSymbol('BRK-B'), true);
  assert.equal(isUsMarketSymbol('005930.KS'), false);
  assert.equal(isUsMarketSymbol('^KS11'), false);
  assert.equal(isUsMarketSymbol('CNY=X'), false);
});

test('Yahoo HTTP 404 skips that symbol and keeps the rest of the batch', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    const href = String(url);
    if (!href.includes('/v7/finance/spark')) throw new Error(href);
    const symbols = new URL(href).searchParams.get('symbols').split(',');
    seen.push(symbols.join(','));
    if (symbols.includes('BAD')) return response('missing', { status: 404 });
    return response(JSON.stringify({ spark: { result: symbols.map((symbol) => spark(symbol, 5)) } }));
  };
  const client = createYahooClient({
    fetchImpl,
    now: () => NOW,
    timeoutMs: 1_000,
    minIntervalMs: 0,
    log() {},
    fallback: { async fetchQuotes() { return []; } },
  });
  const board = await client.fetchQuotes(['AAPL', 'BAD', 'NVDA']);
  assert.equal(board.quotes.find((item) => item.symbol === 'AAPL').lastPrice, 5);
  assert.equal(board.quotes.find((item) => item.symbol === 'NVDA').lastPrice, 5);
  assert.equal(board.quotes.find((item) => item.symbol === 'BAD'), undefined);
  assert.ok(seen.includes('BAD'));
});

test('a later caller joins the in-flight Yahoo request', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const seen = [];
  const fetchImpl = async (url) => {
    const symbols = new URL(String(url)).searchParams.get('symbols');
    seen.push(symbols);
    if (seen.length === 1) await gate;
    const names = symbols.split(',');
    return response(JSON.stringify({ spark: { result: names.map((symbol) => spark(symbol, 4)) } }));
  };
  const client = createYahooClient({
    fetchImpl,
    now: () => NOW,
    timeoutMs: 2_000,
    minIntervalMs: 0,
    log() {},
    fallback: { async fetchQuotes() { return []; } },
  });
  const first = client.fetchQuotes(['AAPL']);
  for (let attempt = 0; attempt < 40 && seen.length < 1; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const second = client.fetchQuotes(['AAPL', 'NVDA']);
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.deepEqual(seen, ['AAPL', 'NVDA']);
  assert.equal(left.quotes[0].lastPrice, 4);
  assert.equal(right.quotes.find((item) => item.symbol === 'AAPL').lastPrice, 4);
  assert.equal(right.quotes.find((item) => item.symbol === 'NVDA').lastPrice, 4);
});

test('US quotes run before a bulk batch that is only queued', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const seen = [];
  const fetchImpl = async (url) => {
    const symbols = new URL(String(url)).searchParams.get('symbols');
    seen.push(symbols);
    if (seen.length === 1) await gate;
    const names = symbols.split(',');
    return response(JSON.stringify({ spark: { result: names.map((symbol) => spark(symbol, 3)) } }));
  };
  const client = createYahooClient({
    fetchImpl,
    now: () => NOW,
    timeoutMs: 2_000,
    minIntervalMs: 0,
    log() {},
    fallback: { async fetchQuotes() { return []; } },
  });
  const bulk = Array.from({ length: 21 }, (_, index) => `${String(index).padStart(6, '0')}.KS`);
  const bulkPromise = client.fetchQuotes(bulk);
  for (let attempt = 0; attempt < 40 && seen.length < 1; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const usPromise = client.fetchQuotes(['AAPL']);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all([bulkPromise, usPromise]);
  assert.equal(seen[1], 'AAPL');
  assert.match(seen[0], /\.KS/);
  assert.match(seen[2], /\.KS/);
});

test('an older quote does not replace a newer cached quote', async () => {
  assert.equal(preferNewerQuote(
    { symbol: 'AAPL', lastPrice: 9, marketTime: 200 },
    { symbol: 'AAPL', lastPrice: 1, marketTime: 100 },
  ).lastPrice, 9);
  let clock = NOW;
  let generation = 0;
  const fetchImpl = async (url) => {
    const symbols = new URL(String(url)).searchParams.get('symbols').split(',');
    generation += 1;
    const marketTime = generation === 1 ? Math.trunc(NOW / 1000) + 120 : Math.trunc(NOW / 1000);
    const price = generation === 1 ? 9 : 1;
    return response(JSON.stringify({
      spark: {
        result: symbols.map((symbol) => ({
          ...spark(symbol, price),
          response: [{
            ...spark(symbol, price).response[0],
            meta: { ...spark(symbol, price).response[0].meta, regularMarketTime: marketTime, regularMarketPrice: price },
          }],
        })),
      },
    }));
  };
  const client = createYahooClient({
    fetchImpl,
    now: () => clock,
    timeoutMs: 1_000,
    cacheTtlMs: 30_000,
    minIntervalMs: 0,
    log() {},
    fallback: { async fetchQuotes() { return []; } },
  });
  const first = await client.fetchQuotes(['AAPL']);
  assert.equal(first.quotes[0].lastPrice, 9);
  clock += 31_000;
  const second = await client.fetchQuotes(['AAPL']);
  assert.equal(second.quotes[0].lastPrice, 9);
  assert.equal(generation, 2);
});

test('a quote cached from the previous snapshot is fetched again before the next minute', async () => {
  let clock = NOW;
  let release;
  let gate = new Promise((resolve) => { release = resolve; });
  let sparkCalls = 0;
  const fetchImpl = async (url) => {
    const symbols = new URL(String(url)).searchParams.get('symbols').split(',');
    sparkCalls += 1;
    if (sparkCalls === 1) await gate;
    return response(JSON.stringify({ spark: { result: symbols.map((symbol) => spark(symbol, sparkCalls)) } }));
  };
  const client = createYahooClient({
    fetchImpl,
    now: () => clock,
    timeoutMs: 2_000,
    cacheTtlMs: 30_000,
    minIntervalMs: 0,
    log() {},
    fallback: { async fetchQuotes() { return []; } },
  });
  const first = client.fetchQuotes(['AAPL']);
  for (let attempt = 0; attempt < 40 && sparkCalls < 1; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  clock = NOW + 40_000;
  release();
  await first;
  clock = NOW + 46_000;
  await client.fetchQuotes(['AAPL']);
  assert.equal(sparkCalls, 2);
});
