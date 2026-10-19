import test from 'node:test';
import assert from 'node:assert/strict';
import { createYahooClient, isUsMarketSymbol, preferNewerQuote, quoteFromSpark, yahooCacheMs } from '../packages/connectors/src/yahoo.js';
import {
  createUsQuoteFallback,
  quoteFromSinaUsBody,
  quoteFromTencentUsBody,
  yahooToSinaUs,
  yahooToTencentUs,
} from '../packages/connectors/src/us-quote-fallback.js';
import { usSessionAt } from '../packages/connectors/src/us-session.js';

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
  let started = 0;
  const seen = [];
  const fetchImpl = async (url) => {
    const symbols = new URL(String(url)).searchParams.get('symbols');
    const order = started;
    started += 1;
    seen.push(symbols);
    if (order < 2) await gate;
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
  for (let attempt = 0; attempt < 40 && started < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const usPromise = client.fetchQuotes(['AAPL']);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all([bulkPromise, usPromise]);
  assert.equal(seen[2], 'AAPL');
  assert.match(seen[0], /\.KS/);
  assert.match(seen[1], /\.KS/);
  assert.match(seen[3], /\.KS/);
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

const PRE_NOW = Date.parse('2026-10-19T12:35:10Z');
const SINA_NVDA_PRE = [
  '英伟达', '214.1300', '-1.43', '2026-10-19 20:35:03', '-3.1000', '216.5600',
  '218.6760', '213.3200', '243.3700', '164.0200', '121252502', '', '', '', '', '', '', '', '', '',
  '69', '218.2000', '1.90', '4.07', 'Oct 19 08:35AM EDT', 'Oct 16 04:00PM EDT', '217.2300', '', '', '2026',
].join(',');

test('Sina premarket fields price off the regular close', () => {
  assert.equal(usSessionAt(Date.parse('2026-10-19T11:00:00Z')), 'pre');
  const quote = quoteFromSinaUsBody(SINA_NVDA_PRE, 'NVDA', PRE_NOW);
  assert.equal(quote.provider, 'sina');
  assert.equal(quote.session, 'pre');
  assert.equal(quote.lastPrice, 218.2);
  assert.equal(quote.prevClose, 214.13);
  assert.equal(quote.change, 4.07);
  assert.equal(quote.changePct, 1.9);
  assert.equal(quote.asOf, Date.parse('2026-10-19T12:35:00Z'));
  assert.ok(Math.abs((quote.lastPrice - quote.prevClose) - quote.change) < 0.02);
  assert.notEqual(quote.prevClose, 217.23);

  const fields = SINA_NVDA_PRE.split(',');
  fields[21] = '0.0000';
  fields[24] = '';
  const regular = quoteFromSinaUsBody(fields.join(','), 'NVDA', PRE_NOW);
  assert.equal(regular.session, 'closed');
  assert.equal(regular.lastPrice, 214.13);
  assert.equal(regular.prevClose, 217.23);
  assert.equal(regular.asOf, Date.parse('2026-10-16T20:00:00Z'));
});

test('premarket prefers Sina because Tencent has no extended fields', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    if (String(url).includes('hq.sinajs.cn')) {
      return response(`var hq_str_gb_nvda="${SINA_NVDA_PRE}";`);
    }
    throw new Error(`unexpected ${url}`);
  };
  const quotes = await createUsQuoteFallback({
    fetchImpl,
    now: () => PRE_NOW,
    timeoutMs: 1_000,
  }).fetchQuotes(['NVDA']);
  assert.match(urls[0], /hq\.sinajs\.cn/);
  assert.equal(urls.some((url) => url.includes('qt.gtimg.cn')), false);
  assert.equal(quotes[0].session, 'pre');
  assert.equal(quotes[0].lastPrice, 218.2);
});

test('Yahoo pre and post prevClose is the previous regular close', () => {
  const nowSec = Math.trunc(Date.parse('2026-10-19T12:00:00Z') / 1000);
  function extended(sessionName) {
    return quoteFromSpark({
      symbol: 'ARM',
      response: [{
        meta: {
          symbol: 'ARM',
          shortName: 'ARM',
          currency: 'USD',
          regularMarketPrice: 227.8,
          previousClose: 244.79,
          chartPreviousClose: 244.79,
          fulldayPrice: 236.98,
          fulldayChangePercent: 4.03,
          fulldayChange: -7.81,
          regularMarketChangePercent: -6.94,
          currentTradingPeriod: {
            [sessionName]: { start: nowSec - 60, end: nowSec + 60 },
          },
        },
        indicators: { quote: [{ close: [227.8] }] },
      }],
    }, nowSec);
  }
  for (const sessionName of ['pre', 'post']) {
    const quote = extended(sessionName);
    assert.equal(quote.session, sessionName);
    assert.equal(quote.lastPrice, 236.98);
    assert.equal(quote.prevClose, 227.8);
    assert.equal(quote.change, 236.98 - 227.8);
    assert.equal(quote.changePct, ((236.98 - 227.8) / 227.8) * 100);
  }
});

test('a timed out Yahoo batch retries once and only that batch falls back', async () => {
  const attempts = new Map();
  const fallbackSymbols = [];
  const fetchImpl = async (url) => {
    const symbols = new URL(String(url)).searchParams.get('symbols').split(',');
    const key = symbols.includes('S0') ? 'slow' : symbols.join(',');
    const count = (attempts.get(key) || 0) + 1;
    attempts.set(key, count);
    if (symbols.includes('S0') && count <= 2) throw new Error('Yahoo 行情请求超时。');
    return response(JSON.stringify({ spark: { result: symbols.map((symbol) => spark(symbol, 5)) } }));
  };
  const client = createYahooClient({
    fetchImpl,
    now: () => NOW,
    timeoutMs: 1_000,
    minIntervalMs: 0,
    log() {},
    fallback: {
      async fetchQuotes(symbols) {
        fallbackSymbols.push(...symbols);
        return symbols.map((symbol) => ({
          symbol,
          lastPrice: 1,
          prevClose: 2,
          change: -1,
          changePct: -50,
          session: 'pre',
          provider: 'sina',
          asOf: NOW,
        }));
      },
    },
  });
  const slow = Array.from({ length: 10 }, (_, index) => `S${index}`);
  const board = await client.fetchQuotes([...slow, 'TAIL']);
  assert.equal(attempts.get('slow'), 2);
  assert.equal(attempts.get('TAIL'), 1);
  assert.deepEqual(fallbackSymbols, slow);
  assert.equal(board.quotes.find((item) => item.symbol === 'S0').provider, 'sina');
  assert.equal(board.quotes.find((item) => item.symbol === 'TAIL').provider, 'yahoo');
  assert.equal(board.quotes.find((item) => item.symbol === 'TAIL').lastPrice, 5);
});

test('two Yahoo spark batches are in flight together', async () => {
  let inflight = 0;
  let maxInflight = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let started = 0;
  const fetchImpl = async (url) => {
    inflight += 1;
    maxInflight = Math.max(maxInflight, inflight);
    started += 1;
    if (started <= 2) await gate;
    inflight -= 1;
    const symbols = new URL(String(url)).searchParams.get('symbols').split(',');
    return response(JSON.stringify({ spark: { result: symbols.map((symbol) => spark(symbol, 6)) } }));
  };
  const client = createYahooClient({
    fetchImpl,
    now: () => NOW,
    timeoutMs: 2_000,
    minIntervalMs: 0,
    log() {},
    fallback: { async fetchQuotes() { return []; } },
  });
  const symbols = Array.from({ length: 20 }, (_, index) => `B${index}`);
  const pending = client.fetchQuotes(symbols);
  for (let attempt = 0; attempt < 40 && started < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(maxInflight, 2);
  release();
  const board = await pending;
  assert.equal(board.quotes.length, 20);
});
