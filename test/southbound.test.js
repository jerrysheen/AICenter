import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  SOUTHBOUND_MIN_INTERVAL_MS,
  SOUTHBOUND_TIMEOUT_MS,
  compareSouthboundDeal,
  createSouthboundClient,
  mergeTop10,
  parseDealHistory,
  parseHkexDaily,
  parseTop10,
} from '../packages/connectors/src/southbound.js';
import { createStore } from '../packages/database/src/index.js';
import { classifyHkConnectDay, resolveBackfillStart } from '../packages/domain/src/hk-connect-calendar.js';
import {
  buildSouthboundView,
  createSouthboundReadService,
  formatSignedYi,
  formatSouthboundLine,
  normalizeHkCode,
} from '../packages/domain/src/southbound-service.js';
import { isApiTokenAllowlisted } from '../apps/web/src/http/api-token-access.js';
import {
  SOUTHBOUND_JOB_TYPE,
  ensureSouthboundSchedules,
  persistSouthboundDay,
  prepareSouthboundEnqueue,
  syncSouthboundDay,
} from '../packages/runtime/src/southbound-job.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/southbound/${name}`, import.meta.url), 'utf8');
const dealPayload = JSON.parse(fixture('eastmoney-deal-2026-10-16.json'));
const topPayload = JSON.parse(fixture('eastmoney-top10-2026-10-16.json'));
const hkexText = fixture('hkex-daily-20261016.txt');

function openStore() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-southbound-'));
  const file = path.join(directory, 'test.db');
  const store = createStore(file);
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

test('东财汇总按百万港元换算，十大成交按港元合并', () => {
  const daily = parseDealHistory(dealPayload);
  const total = daily.find((row) => row.channel === 'total');
  const sh = daily.find((row) => row.channel === 'sh');
  const sz = daily.find((row) => row.channel === 'sz');
  assert.equal(total.mutualType, '006');
  assert.equal(sh.mutualType, '002');
  assert.equal(sz.mutualType, '004');
  assert.equal(formatSignedYi(total.netAmt), '-35.68');
  assert.equal(sh.netAmt + sz.netAmt, total.netAmt);
  assert.equal(total.buyAmt - total.sellAmt, total.netAmt);
  assert.equal(total.dealNum, 1746664);

  const merged = mergeTop10(parseTop10(topPayload));
  const named = (needle) => merged.find((row) => row.name.includes(needle));
  assert.equal(formatSignedYi(named('药明生物').netAmt), '-6.68');
  assert.equal(formatSignedYi(named('小米').netAmt), '-5.06');
  assert.equal(formatSignedYi(named('友邦').netAmt), '+7.64');
  assert.equal(merged[0].code, '01299');
  assert.ok(merged.every((row, index) => index === 0 || Math.abs(merged[index - 1].netAmt) >= Math.abs(row.netAmt)));
  assert.equal(merged.every((row) => row.channel === 'total' && row.source === 'derived'), true);

  const hkex = parseHkexDaily(hkexText);
  assert.equal(hkex.markets.sh.buyTurnoverHkd, sh.buyAmt);
  assert.equal(hkex.markets.sz.sellTurnoverHkd, sz.sellAmt);
  assert.deepEqual(compareSouthboundDeal(total.dealAmt, hkex.dealAmt), { checkStatus: 'ok', checkDiffPct: 0 });
  const line = formatSouthboundLine(total.netAmt, merged);
  assert.equal(line, '南向净卖出 35.68 亿港元；友邦保险 +7.64 亿、药明生物 -6.68 亿、小米集团 -5.06 亿');
  const view = buildSouthboundView({
    dailyRows: daily.map((row) => ({ ...row, checkStatus: 'ok', checkDiffPct: 0 })),
    topRows: merged,
  });
  assert.equal(view.channels.total.net, '-35.68');
  assert.equal(view.buy[0].name, '友邦保险');
  assert.equal(view.sell[0].name, '药明生物');
  assert.equal(JSON.stringify(view).includes('eastmoney'), false);
  assert.equal(view.checkStatus, undefined);
  assert.equal(view.source, undefined);
  assert.match(view.scope, /十大成交口径/);
  assert.match(view.scope, /只进了一边前十/);
});

test('日期区间可以分页', () => {
  const page1 = parseDealHistory(JSON.parse(fixture('eastmoney-deal-range-006.json')));
  const page2 = parseDealHistory(JSON.parse(fixture('eastmoney-deal-range-006-page2.json')));
  assert.deepEqual(page1.map((row) => row.tradeDate), ['2026-10-16', '2026-10-15', '2026-10-14']);
  assert.deepEqual(page2.map((row) => row.tradeDate), ['2026-10-13', '2026-10-12', '2026-10-09']);
  assert.equal(JSON.parse(fixture('eastmoney-deal-range-006.json')).result.pages, 3);
});

test('校验超过 1% 才记 mismatch', () => {
  assert.equal(compareSouthboundDeal(100_000_000, 100_900_000).checkStatus, 'ok');
  assert.equal(compareSouthboundDeal(100_000_000, 101_000_000).checkStatus, 'ok');
  assert.equal(compareSouthboundDeal(100_000_000, 101_100_000).checkStatus, 'mismatch');
  assert.ok(compareSouthboundDeal(100_000_000, 100_900_000).checkDiffPct < 1);
  assert.ok(compareSouthboundDeal(100_000_000, 101_100_000).checkDiffPct > 1);
  assert.equal(compareSouthboundDeal(100_000_000, null).checkStatus, 'hkex_missing');
});

test('港股通日历区分周末、港股假日、沪深休市和未核验日期', () => {
  assert.deepEqual(classifyHkConnectDay('2026-10-17'), { date: '2026-10-17', trading: false, reason: '周末' });
  assert.deepEqual(classifyHkConnectDay('2026-07-01'), { date: '2026-07-01', trading: false, reason: '港股休市' });
  assert.deepEqual(classifyHkConnectDay('2026-10-02'), { date: '2026-10-02', trading: false, reason: '沪深休市' });
  assert.equal(classifyHkConnectDay('2026-10-16').trading, true);
  assert.equal(classifyHkConnectDay('2025-03-03').trading, null);
  assert.equal(classifyHkConnectDay('2025-03-03').reason, '交易日历尚未核验');
  assert.deepEqual(classifyHkConnectDay('2027-07-01'), { date: '2027-07-01', trading: false, reason: '港股休市' });
  assert.equal(classifyHkConnectDay('2027-03-03').trading, null);
  assert.equal(classifyHkConnectDay('2027-02-05').trading, null);
});

test('两次上游请求至少间隔 1 秒', async () => {
  assert.equal(SOUTHBOUND_TIMEOUT_MS, 15_000);
  assert.equal(SOUTHBOUND_MIN_INTERVAL_MS, 1_000);
  let clock = 1_000;
  const waits = [];
  const client = createSouthboundClient({
    minIntervalMs: 1_000,
    now: () => clock,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    fetchImpl: async () => jsonResponse({ result: { data: [], pages: 1 } }),
  });
  await client.fetchDay('2026-10-16');
  await client.fetchDay('2026-10-15');
  assert.deepEqual(waits, [1_000]);

  let hkexHeaders;
  let eastmoneyHeaders;
  const headerClient = createSouthboundClient({
    minIntervalMs: 0,
    fetchImpl: async (url, init) => {
      if (String(url).includes('hkex.com.hk')) {
        hkexHeaders = init.headers;
        return jsonResponse('', 404);
      }
      eastmoneyHeaders = init.headers;
      return jsonResponse({ result: { data: [], pages: 1 } });
    },
  });
  await headerClient.fetchHkex('2026-10-16');
  await headerClient.fetchDay('2026-10-16');
  assert.equal(hkexHeaders.Referer, 'https://www.hkex.com.hk/');
  assert.equal(String(hkexHeaders.Referer).includes('eastmoney'), false);
  assert.equal(eastmoneyHeaders.Referer, 'https://data.eastmoney.com/');
});

function recordingClient(routes) {
  const calls = [];
  const client = createSouthboundClient({
    minIntervalMs: 0,
    fetchImpl: async (url) => {
      const href = String(url);
      calls.push(href);
      const route = routes.find((item) => href.includes(item.match));
      if (!route) return jsonResponse({ result: { data: [], pages: 0 } }, 404);
      return route.respond(href);
    },
  });
  return { client, calls };
}

function healthStore(repository) {
  const health = [];
  const snapshots = [];
  return {
    health,
    snapshots,
    store: {
      setProviderHealth: (...args) => health.push(args),
      repositories: {
        southbound: repository,
        runtimeSnapshots: { saveSnapshot: (...args) => snapshots.push(args) },
      },
    },
  };
}

test('交易日没数据记 pending，补跑记 late，已经 ok 则跳过', async () => {
  const opened = openStore();
  try {
    const repository = opened.store.repositories.southbound;
    const empty = recordingClient([{ match: 'RPT_MUTUAL_DEAL_HISTORY', respond: () => jsonResponse({ result: { data: [], pages: 1 } }) }]);
    const pendingHealth = healthStore(repository);
    const pending = await syncSouthboundDay({
      repository,
      store: pendingHealth.store,
      client: empty.client,
      tradeDate: '2026-10-16',
      slot: 'primary',
    });
    assert.equal(pending.status, 'pending');
    assert.equal(empty.calls.length, 1);
    assert.equal(pendingHealth.health[0][1], 'healthy');
    assert.equal(pendingHealth.snapshots[0][2].note, '等待公布');

    const lateClient = recordingClient([{ match: 'RPT_MUTUAL_DEAL_HISTORY', respond: () => jsonResponse({ result: { data: [], pages: 1 } }) }]);
    const late = await syncSouthboundDay({
      repository,
      store: healthStore(repository).store,
      client: lateClient.client,
      tradeDate: '2026-10-16',
      slot: 'catchup',
    });
    assert.equal(late.status, 'late');
    assert.equal(lateClient.calls.length, 1);

    persistSouthboundDay({
      repository,
      workspaceId: 'local',
      dailyRows: parseDealHistory(dealPayload),
      topRows: parseTop10(topPayload),
      hkex: parseHkexDaily(hkexText),
      fetchedAt: 1,
    });
    const skippedClient = recordingClient([]);
    const skipped = await syncSouthboundDay({
      repository,
      store: healthStore(repository).store,
      client: skippedClient.client,
      tradeDate: '2026-10-16',
      slot: 'catchup',
    });
    assert.equal(skipped.status, 'skipped');
    assert.equal(skippedClient.calls.length, 0);

    const uncovered = recordingClient([{ match: 'RPT_MUTUAL_DEAL_HISTORY', respond: () => jsonResponse({ result: { data: [], pages: 1 } }) }]);
    const uncoveredDay = await syncSouthboundDay({
      repository,
      store: healthStore(repository).store,
      client: uncovered.client,
      tradeDate: '2027-03-03',
      slot: 'primary',
    });
    assert.equal(uncoveredDay.status, 'pending');
    assert.equal(uncovered.calls.length, 1);
    const uncoveredLate = await syncSouthboundDay({
      repository,
      client: uncovered.client,
      tradeDate: '2025-03-03',
      slot: 'catchup',
    });
    assert.equal(uncoveredLate.status, 'late');
  } finally {
    opened.close();
  }
});

test('17:00 十大成交失败后，17:30 只补十大，不改汇总', async () => {
  const opened = openStore();
  try {
    const repository = opened.store.repositories.southbound;
    let failTop = true;
    const calls = [];
    const client = createSouthboundClient({
      minIntervalMs: 0,
      fetchImpl: async (url) => {
        const href = String(url);
        calls.push(href);
        if (href.includes('RPT_MUTUAL_TOP10DEAL')) {
          if (failTop) return jsonResponse({ result: null }, 500);
          return jsonResponse(topPayload);
        }
        if (href.includes('hkex.com.hk')) {
          return { ok: true, status: 200, async json() { return {}; }, async text() { return hkexText; } };
        }
        return jsonResponse(dealPayload);
      },
    });
    const first = await syncSouthboundDay({
      repository,
      store: healthStore(repository).store,
      client,
      tradeDate: '2026-10-16',
      slot: 'primary',
    });
    assert.equal(first.status, 'ok');
    assert.equal(repository.countTop10('local', '2026-10-16'), 0);
    const fetchedAt = repository.getDaily('local', '2026-10-16', 'total').fetchedAt;
    const netAmt = repository.getDaily('local', '2026-10-16', 'total').netAmt;
    assert.equal(calls.filter((href) => href.includes('RPT_MUTUAL_TOP10DEAL')).length, 1);

    failTop = false;
    const before = calls.length;
    const second = await syncSouthboundDay({
      repository,
      client,
      tradeDate: '2026-10-16',
      slot: 'catchup',
    });
    assert.equal(second.status, 'ok');
    assert.ok(second.savedTop > 0);
    assert.equal(calls.slice(before).every((href) => href.includes('RPT_MUTUAL_TOP10DEAL')), true);
    assert.equal(calls.slice(before).length, 1);
    assert.equal(repository.getDaily('local', '2026-10-16', 'total').fetchedAt, fetchedAt);
    assert.equal(repository.getDaily('local', '2026-10-16', 'total').netAmt, netAmt);
    assert.equal(repository.listTop10('local', '2026-10-16', 'total')[0].code, '01299');

    const after = calls.length;
    const third = await syncSouthboundDay({
      repository,
      client,
      tradeDate: '2026-10-16',
      slot: 'catchup',
    });
    assert.equal(third.status, 'skipped');
    assert.equal(calls.length, after);
  } finally {
    opened.close();
  }
});

test('休市不请求上游，两边都没有数据时记 closed_by_data', async () => {
  const opened = openStore();
  try {
    const repository = opened.store.repositories.southbound;
    const client = recordingClient([]);
    const weekend = await syncSouthboundDay({ repository, client: client.client, tradeDate: '2026-10-18' });
    const hkHoliday = await syncSouthboundDay({ repository, client: client.client, tradeDate: '2026-07-01' });
    const cnHoliday = await syncSouthboundDay({ repository, client: client.client, tradeDate: '2026-10-02' });
    const hk2027 = await syncSouthboundDay({ repository, client: client.client, tradeDate: '2027-07-01' });
    assert.equal(weekend.status, 'closed');
    assert.equal(weekend.reason, '周末');
    assert.equal(hkHoliday.reason, '港股休市');
    assert.equal(cnHoliday.reason, '沪深休市');
    assert.equal(hk2027.status, 'closed');
    assert.equal(hk2027.reason, '港股休市');
    assert.equal(client.calls.length, 0);

    const fallback = recordingClient([
      { match: 'RPT_MUTUAL_DEAL_HISTORY', respond: () => jsonResponse({ result: { data: [], pages: 1 } }) },
      { match: 'hkex.com.hk', respond: () => jsonResponse('', 404) },
    ]);
    const closed = await syncSouthboundDay({
      repository,
      client: fallback.client,
      tradeDate: '2025-03-03',
      mode: 'backfill',
    });
    assert.equal(closed.status, 'closed_by_data');
    assert.equal(fallback.calls.length, 2);
  } finally {
    opened.close();
  }
});

test('迁移 81 建立南向表，重复写入不增加行', () => {
  const opened = openStore();
  const repository = opened.store.repositories.southbound;
  const daily = parseDealHistory(dealPayload);
  const top = parseTop10(topPayload);
  const hkex = parseHkexDaily(hkexText);
  const first = persistSouthboundDay({
    repository, workspaceId: 'local', dailyRows: daily, topRows: top, hkex, fetchedAt: 10,
  });
  const second = persistSouthboundDay({
    repository, workspaceId: 'local', dailyRows: daily, topRows: top, hkex, fetchedAt: 20,
  });
  assert.equal(first.checkStatus, 'ok');
  assert.equal(second.savedDaily, first.savedDaily);
  assert.equal(repository.countDaily('local'), 3);
  assert.equal(repository.countTop10('local', '2026-10-16'), second.savedTop);
  assert.equal(repository.getDaily('local', '2026-10-16', 'total').netAmt, daily.find((row) => row.channel === 'total').netAmt);
  assert.equal(repository.getDaily('local', '2026-10-16', 'total').fetchedAt, 20);
  const ranked = repository.listTop10('local', '2026-10-16', 'total');
  assert.equal(ranked[0].code, '01299');
  assert.equal(ranked[1].code, '02269');
  opened.close();
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-southbound-schema-'));
  const dbPath = path.join(directory, 'schema.db');
  const schemaStore = createStore(dbPath);
  schemaStore.close();
  const database = new Database(dbPath, { readonly: true });
  const migration = database.prepare(`SELECT version, name FROM schema_migrations WHERE name = 'southbound_flow'`).get();
  assert.equal(migration.version, 81);
  assert.equal(database.prepare('SELECT version FROM schema_migrations WHERE version = 80').get(), undefined);
  assert.ok(database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'southbound_daily'`).get());
  assert.ok(database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'southbound_top10'`).get());
  const index = database.prepare(`SELECT sql FROM sqlite_master WHERE name = 'idx_southbound_top10_code'`).get();
  assert.match(index.sql, /code, trade_date DESC/i);
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

test('调度在 17:00 和 17:30，同一槽位不重复入队', () => {
  const saved = [];
  const store = { upsertJobSchedule: (value) => { saved.push(value); return value; } };
  ensureSouthboundSchedules(store, {}, Date.parse('2026-10-16T00:00:00+08:00'));
  assert.equal(saved.length, 2);
  assert.deepEqual(saved.map((item) => [item.jobType, item.schedule.hour, item.schedule.minute, item.schedule.timezone, item.input.slot]), [
    [SOUTHBOUND_JOB_TYPE, 17, 0, 'Asia/Shanghai', 'primary'],
    [SOUTHBOUND_JOB_TYPE, 17, 30, 'Asia/Shanghai', 'catchup'],
  ]);
  const disabled = [];
  ensureSouthboundSchedules({ upsertJobSchedule: (value) => disabled.push(value) }, { AI_CENTER_SOUTHBOUND_SYNC: '0' });
  assert.equal(disabled.every((item) => item.enabled === false), true);
  const moved = [];
  ensureSouthboundSchedules({ upsertJobSchedule: (value) => moved.push(value) }, { AI_CENTER_SOUTHBOUND_AT: '18:10' });
  assert.deepEqual(moved.map((item) => [item.schedule.hour, item.schedule.minute]), [[18, 10], [18, 40]]);

  const busy = {
    listOpenJobs: () => [{ input: { slot: 'primary' } }],
  };
  assert.equal(prepareSouthboundEnqueue(busy, { jobType: SOUTHBOUND_JOB_TYPE, input: { slot: 'primary' } }), false);
  assert.equal(prepareSouthboundEnqueue(busy, { jobType: SOUTHBOUND_JOB_TYPE, input: { slot: 'catchup' } }), true);
});

test('持仓标签和只读令牌', () => {
  const opened = openStore();
  try {
    const repository = opened.store.repositories.southbound;
    persistSouthboundDay({
      repository,
      workspaceId: 'local',
      dailyRows: parseDealHistory(dealPayload),
      topRows: parseTop10(topPayload),
      hkex: parseHkexDaily(hkexText),
      fetchedAt: 1,
    });
    const service = createSouthboundReadService({ repository });
    const board = { positions: [{ symbol: '1299.HK', name: '友邦保险' }, { symbol: '600519.SH', name: '贵州茅台' }] };
    service.annotateHoldings(board);
    assert.equal(board.positions[0].southboundTag, '南向 +7.64 亿');
    assert.equal(board.positions[1].southboundTag, '');
    assert.equal(normalizeHkCode('1810.HK'), '01810');
    assert.equal(service.history('02269', 5).items[0].net, '-6.68');
    assert.equal(isApiTokenAllowlisted('GET', '/api/v1/market/southbound'), true);
    assert.equal(isApiTokenAllowlisted('GET', '/api/v1/holdings'), false);
    assert.equal(resolveBackfillStart('2021-10-16', '2026-10-16', '2024-01-05'), '2024-01-06');
  } finally {
    opened.close();
  }
});
