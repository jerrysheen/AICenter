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
