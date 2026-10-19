import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  createSouthboundClient,
  parseHkexDaily,
  parseNorthboundHistory,
  parseNorthboundTop10,
} from '../packages/connectors/src/southbound.js';
import { createStore } from '../packages/database/src/index.js';
import { formatYiAmount } from '../packages/domain/src/southbound-service.js';
import {
  NORTHBOUND_EMPTY,
  NORTHBOUND_NET_UNAVAILABLE,
  buildNorthboundView,
  createNorthboundReadService,
} from '../packages/domain/src/northbound-service.js';
import { isApiTokenAllowlisted } from '../apps/web/src/http/api-token-access.js';
import { persistSouthboundDay, saveNorthboundTop10, syncSouthboundDay } from '../packages/runtime/src/southbound-job.js';
import { parseDealHistory, parseTop10 } from '../packages/connectors/src/southbound.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/southbound/${name}`, import.meta.url), 'utf8');
const dealPayload = JSON.parse(fixture('eastmoney-deal-2026-10-16.json'));
const topPayload = JSON.parse(fixture('eastmoney-top10-2026-10-16.json'));
const hkexText = fixture('hkex-daily-20261016.txt');

function openStore() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-northbound-'));
  const store = createStore(path.join(directory, 'test.db'));
  return {
    store,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
  };
}

test('北向只保留成交额，净买入保持为空', () => {
  const daily = parseNorthboundHistory(dealPayload);
  const sh = daily.find((row) => row.channel === 'sh');
  const sz = daily.find((row) => row.channel === 'sz');
  const total = daily.find((row) => row.channel === 'total');
  assert.equal(daily.length, 3);
  assert.equal(sh.mutualType, '001');
  assert.equal(sz.mutualType, '003');
  assert.equal(total.mutualType, '005');
  assert.equal(Object.hasOwn(total, 'netAmt'), false);
  assert.equal(Object.hasOwn(total, 'buyAmt'), false);
  assert.equal(sh.dealAmt + sz.dealAmt, total.dealAmt);
  assert.equal(formatYiAmount(total.dealAmt), '2252.73');
  assert.equal(formatYiAmount(sh.dealAmt), '1148.65');

  const top = parseNorthboundTop10(topPayload);
  const leader = top.find((row) => row.channel === 'sh' && row.rank === 1);
  assert.equal(leader.name, '药明康德');
  assert.equal(leader.code, '603259');
  assert.equal(leader.dealAmt, 3_851_651_670);
  assert.equal(Object.hasOwn(leader, 'netAmt'), false);
  assert.equal(top.filter((row) => row.channel === 'sh').length, 10);
  assert.equal(top.filter((row) => row.channel === 'sz').length, 10);
  assert.equal(top.some((row) => row.channel === 'total'), false);

  const hkex = parseHkexDaily(hkexText);
  assert.equal(hkex.northbound.markets.sh.totalTurnoverCny, sh.dealAmt);
  assert.equal(hkex.northbound.markets.sz.totalTurnoverCny, sz.dealAmt);
  assert.equal(hkex.northbound.dealAmt, total.dealAmt);

  const view = buildNorthboundView({
    dailyRows: daily.map((row) => ({ ...row, checkStatus: 'ok', checkDiffPct: 0 })),
    topRows: top,
    today: '2026-10-19',
  });
  assert.equal(view.dateLabel, '数据日期 2026-10-16，不是今天');
  assert.equal(view.channels.total.turnover, '2252.73');
  assert.equal(view.channels.sh.net, undefined);
  assert.equal(view.shTop[0].symbol, '603259.SH');
  assert.equal(view.shTop[0].turnover, '38.52');
  assert.equal(view.szTop[0].symbol.endsWith('.SZ'), true);
  assert.equal(view.unavailable, NORTHBOUND_NET_UNAVAILABLE);
  assert.match(view.unavailable, /不是净流入/);
  assert.match(view.scope, /不是净买入/);
  const encoded = JSON.stringify(view);
  assert.equal(encoded.includes('eastmoney'), false);
  assert.equal(encoded.includes('fetchedAt'), false);
  assert.equal(encoded.includes('checkStatus'), false);
  assert.equal(encoded.includes('更新时间'), false);
  assert.equal(encoded.includes('已处理'), false);
  assert.equal(encoded.includes('netAmt'), false);

  const sameDay = buildNorthboundView({
    dailyRows: daily,
    topRows: top,
    today: '2026-10-16',
  });
  assert.equal(sameDay.dateLabel, '数据日期 2026-10-16');
  const missing = buildNorthboundView({ today: '2026-10-19' });
  assert.equal(missing.tradeDate, '');
  assert.equal(missing.dateLabel, '');
  assert.equal(missing.empty, NORTHBOUND_EMPTY);
  assert.equal(missing.channels.total.turnover, '');
});

test('同一轮同步写入北向成交额，已经齐了就跳过', async () => {
  const opened = openStore();
  try {
    const repository = opened.store.repositories.southbound;
    const northboundRepository = opened.store.repositories.northbound;
    const calls = [];
    const client = createSouthboundClient({
      minIntervalMs: 0,
      fetchImpl: async (url) => {
        const href = String(url);
        calls.push(href);
        if (href.includes('RPT_MUTUAL_TOP10DEAL')) return jsonResponse(topPayload);
        if (href.includes('hkex.com.hk')) {
          return { ok: true, status: 200, async json() { return {}; }, async text() { return hkexText; } };
        }
        return jsonResponse(dealPayload);
      },
    });
    const saved = await syncSouthboundDay({
      repository,
      northboundRepository,
      client,
      tradeDate: '2026-10-16',
      slot: 'primary',
    });
    assert.equal(saved.status, 'ok');
    const total = northboundRepository.getDaily('local', '2026-10-16', 'total');
    assert.equal(formatYiAmount(total.dealAmt), '2252.73');
    assert.equal(total.checkStatus, 'ok');
    assert.equal(Object.hasOwn(total, 'netAmt'), false);
    const names = northboundRepository.listTop10('local', '2026-10-16', 'sh').map((row) => row.name);
    assert.equal(names[0], '药明康德');
    const before = calls.length;
    const skipped = await syncSouthboundDay({
      repository,
      northboundRepository,
      client,
      tradeDate: '2026-10-16',
      slot: 'catchup',
    });
    assert.equal(skipped.status, 'skipped');
    assert.equal(calls.length, before);

    const service = createNorthboundReadService({ repository: northboundRepository });
    const board = service.board(20);
    assert.match(board.dateLabel, /^数据日期 2026-10-16/);
    assert.equal(board.channels.total.turnover, '2252.73');
    assert.equal(isApiTokenAllowlisted('GET', '/api/v1/market/northbound'), true);
    assert.equal(isApiTokenAllowlisted('GET', '/api/market/northbound'), true);
  } finally {
    opened.close();
  }
});

test('南向已经入库时补写北向，不把成交额写成净额', async () => {
  const opened = openStore();
  try {
    const repository = opened.store.repositories.southbound;
    const northboundRepository = opened.store.repositories.northbound;
    persistSouthboundDay({
      repository,
      workspaceId: 'local',
      dailyRows: parseDealHistory(dealPayload),
      topRows: parseTop10(topPayload),
      hkex: parseHkexDaily(hkexText),
      fetchedAt: 1,
    });
    const calls = [];
    const client = createSouthboundClient({
      minIntervalMs: 0,
      fetchImpl: async (url) => {
        calls.push(String(url));
        const href = String(url);
        if (href.includes('RPT_MUTUAL_TOP10DEAL')) return jsonResponse(topPayload);
        if (href.includes('hkex.com.hk')) {
          return { ok: true, status: 200, async json() { return {}; }, async text() { return hkexText; } };
        }
        return jsonResponse(dealPayload);
      },
    });
    const filled = await syncSouthboundDay({
      repository,
      northboundRepository,
      client,
      tradeDate: '2026-10-16',
    });
    assert.equal(filled.northbound, true);
    assert.equal(formatYiAmount(northboundRepository.getDaily('local', '2026-10-16', 'sh').dealAmt), '1148.65');
    assert.ok(calls.length > 0);
    const after = calls.length;
    const skipped = await syncSouthboundDay({
      repository,
      northboundRepository,
      client,
      tradeDate: '2026-10-16',
    });
    assert.equal(skipped.status, 'skipped');
    assert.equal(calls.length, after);
  } finally {
    opened.close();
  }
});

test('北向失败时，南向状态仍然正确', async () => {
  const opened = openStore();
  try {
    const repository = opened.store.repositories.southbound;
    persistSouthboundDay({
      repository,
      workspaceId: 'local',
      dailyRows: parseDealHistory(dealPayload),
      hkex: parseHkexDaily(hkexText),
      fetchedAt: 1,
    });
    const client = createSouthboundClient({
      minIntervalMs: 0,
      fetchImpl: async (url) => {
        const href = String(url);
        if (href.includes('RPT_MUTUAL_TOP10DEAL')) return jsonResponse(topPayload);
        throw new Error('北向汇总失败');
      },
    });
    const saved = await syncSouthboundDay({
      repository,
      northboundRepository: opened.store.repositories.northbound,
      client,
      tradeDate: '2026-10-16',
      mode: 'live',
      slot: 'catchup',
    });
    assert.equal(saved.status, 'ok');
    assert.equal(saved.northboundStatus, 'northbound_missing');
    assert.equal(repository.listTop10('local', '2026-10-16', 'total').length > 0, true);
    assert.equal(opened.store.repositories.northbound.getDaily('local', '2026-10-16', 'total'), null);
  } finally {
    opened.close();
  }
});

test('北向十大返回空数组时，不清空已有数据', () => {
  const opened = openStore();
  try {
    const repository = opened.store.repositories.northbound;
    const rows = parseNorthboundTop10(topPayload);
    assert.ok(saveNorthboundTop10(repository, 'local', '2026-10-16', rows) > 0);
    assert.equal(repository.listTop10('local', '2026-10-16', 'sh').length, 10);
    assert.equal(repository.listTop10('local', '2026-10-16', 'sz').length, 10);
    assert.equal(saveNorthboundTop10(repository, 'local', '2026-10-16', []), 0);
    assert.equal(repository.listTop10('local', '2026-10-16', 'sh').map((row) => row.name)[0], '药明康德');
    assert.equal(repository.listTop10('local', '2026-10-16', 'sz').length, 10);
    saveNorthboundTop10(repository, 'local', '2026-10-16', rows.filter((row) => row.channel === 'sh'));
    assert.equal(repository.listTop10('local', '2026-10-16', 'sz').length, 10);
  } finally {
    opened.close();
  }
});

test('迁移 88 建立北向表，没有净额列', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-northbound-schema-'));
  const dbPath = path.join(directory, 'schema.db');
  const schemaStore = createStore(dbPath);
  schemaStore.close();
  const database = new Database(dbPath, { readonly: true });
  const migration = database.prepare(`SELECT version, name FROM schema_migrations WHERE name = 'northbound_flow'`).get();
  assert.equal(migration.version, 88);
  assert.equal(database.prepare(`SELECT name FROM schema_migrations WHERE version = 87`).get().name, 'youtube_podcast_backfill');
  const columns = database.prepare(`PRAGMA table_info(northbound_daily)`).all().map((row) => row.name);
  assert.equal(columns.includes('deal_amt'), true);
  assert.equal(columns.includes('net_amt'), false);
  assert.equal(columns.includes('buy_amt'), false);
  assert.ok(database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'northbound_top10'`).get());
  database.close();
  rmSync(directory, { recursive: true, force: true });
});
