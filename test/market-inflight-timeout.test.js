import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarketService } from '../packages/source/src/market/service.js';

test('a stuck market read times out, drops the in-flight record, and the next read can start', async () => {
  let calls = 0;
  const service = createMarketService({
    inflightTimeoutMs: 30,
    ttlMs: 60_000,
    now: () => 1_000,
    tushare: null,
    sinaFutures: null,
    xueqiuQuotes: { fetchQuotes: async () => [] },
    cnQuotes: { fetchQuotes: async () => [] },
    yahoo: {
      fetchQuotes: () => {
        calls += 1;
        if (calls === 1) return new Promise(() => {});
        return Promise.resolve({ quotes: [], session: 'closed' });
      },
    },
  });
  await assert.rejects(service.getBoard({ board: 'us' }), /行情请求超时/);
  const board = await service.getBoard({ board: 'us' });
  assert.equal(calls, 2);
  assert.equal(board.board, 'us');
});

test('concurrent refresh reuses the in-flight board and quote request', async () => {
  let boardCalls = 0;
  let quoteCalls = 0;
  let releaseBoard;
  let releaseQuote;
  const boardGate = new Promise((resolve) => { releaseBoard = resolve; });
  const quoteGate = new Promise((resolve) => { releaseQuote = resolve; });
  const service = createMarketService({
    ttlMs: 60_000,
    now: () => 5_000_000,
    log() {},
    tushare: null,
    sinaFutures: null,
    xueqiuQuotes: { fetchQuotes: async () => [] },
    cnQuotes: { fetchQuotes: async () => [] },
    yahoo: {
      fetchQuotes: async (symbols) => {
        const key = (symbols || []).map((symbol) => String(symbol).toUpperCase()).sort().join(',');
        if (key === 'AAPL,NVDA') {
          quoteCalls += 1;
          await quoteGate;
          return {
            quotes: [
              { symbol: 'AAPL', lastPrice: 11, prevClose: 10, session: 'regular' },
              { symbol: 'NVDA', lastPrice: 12, prevClose: 10, session: 'regular' },
            ],
            session: 'regular',
          };
        }
        boardCalls += 1;
        await boardGate;
        return { quotes: [], session: 'closed' };
      },
    },
  });
  const first = service.getBoard({ board: 'us', refresh: true });
  const second = service.getBoard({ board: 'us', refresh: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(boardCalls, 1);
  releaseBoard();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left, right);
  assert.equal(boardCalls, 1);

  const quotesA = service.fetchQuotes(['NVDA', 'AAPL'], { refresh: true });
  const quotesB = service.fetchQuotes(['AAPL', 'NVDA'], { refresh: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(quoteCalls, 1);
  releaseQuote();
  const [quoteLeft, quoteRight] = await Promise.all([quotesA, quotesB]);
  assert.equal(quoteLeft.find((item) => item.symbol === 'AAPL').lastPrice, 11);
  assert.equal(quoteRight.find((item) => item.symbol === 'NVDA').lastPrice, 12);
  assert.equal(quoteCalls, 1);
});
