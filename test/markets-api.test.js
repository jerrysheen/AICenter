import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAiCenterServer } from '../apps/web/src/server.js';

test('markets API returns injected board payload', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-markets-'));
  const marketService = {
    async getBoard({ board }) {
      return {
        board,
        mode: 'live',
        fetchedAt: 1,
        session: 'closed',
        note: 'test',
        groups: ['全部'],
        indices: [],
        watchlist: [{ symbol: 'AAPL', name: 'Apple', group: '科技巨头', lastPrice: 1, changePct: 0.1 }],
        gainers: [],
        losers: [],
        breadth: { advancers: 1, decliners: 0, unchanged: 0 },
      };
    },
    async search() {
      return [{ symbol: 'NVDA', name: 'NVIDIA', type: 'EQUITY', exchange: 'NMS' }];
    },
  };
  const app = createAiCenterServer({ host: '127.0.0.1', port: 0, dataDirectory: directory, marketService });
  const address = await app.listen();
  try {
    const payload = await fetch(`${address.localUrl}/api/v1/markets?board=us`).then((response) => response.json());
    assert.equal(payload.ok, true);
    assert.equal(payload.market.watchlist[0].symbol, 'AAPL');
    const search = await fetch(`${address.localUrl}/api/v1/markets/search?q=nvda`).then((response) => response.json());
    assert.equal(search.items[0].symbol, 'NVDA');
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
