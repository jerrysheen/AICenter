import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createStore } from '../packages/database/src/index.js';
import { latestSchemaVersion } from '../packages/database/src/migrations.js';
import { createHardwareArtifactStore } from '../packages/connectors/src/hardware-artifacts.js';
import { parseStructuredPricePage } from '../packages/connectors/src/trendforce-prices.js';
import { createHardwarePriceService } from '../packages/domain/src/hardware-price-service.js';
import { preferHardwareQuotes } from '../packages/contracts/src/hardware-prices.js';
import { createJobRunner, formatJobLoopDelay } from '../packages/runtime/src/job-runner.js';
import { HARDWARE_PRICE_CACHE_TTL_MS } from '../apps/web/src/http/stale-read-cache.js';
import {
  HARDWARE_PRICE_JOB_TYPE,
  HARDWARE_PRICE_SAVED_EVENT,
  HARDWARE_PRICE_SNAPSHOT_TTL_MS,
  ensureHardwarePriceSchedule,
  ensureMarketBoardsSchedule,
  enqueueHardwarePriceSnapshotFromEvents,
} from '../packages/runtime/src/web-snapshot-jobs.js';

const at = Date.parse('2026-10-05T04:00:00Z');

function openHardware() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'hardware-loop-'));
  const store = createStore(path.join(directory, 'test.db'));
  const hardware = createHardwarePriceService({
    repository: store.repositories.hardwarePrices,
    artifactStore: createHardwareArtifactStore({ dataDirectory: directory }),
  });
  return {
    directory,
    store,
    hardware,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function ingest(hardware, { pageKey, format = 'html', parserVersion, capturedAt, spec, average = '10.00', period = '2026-10-05', extraSpec = '' }) {
  const raw = `<div class="price-title">DRAM Spot Price (US$/chip, 未稅)</div>
<div class="price-last-update">Last Update ${period} 18:10 (GMT+8)</div>
<table class="price-table"><tr><th>Item</th><th>High</th><th>Low</th><th>Average</th><th>Change</th></tr>
<tr><td>${spec}</td><td>12.00</td><td>8.00</td><td>${average}</td><td>+2%</td></tr></table>
<!-- ${pageKey} ${parserVersion} ${capturedAt} ${spec} -->`;
  const value = parseStructuredPricePage(raw, {
    pageKey,
    title: pageKey,
    sourceUrl: 'https://www.trendforce.com.tw/price/dram/dram_spot',
    capturedAt,
  });
  value.format = format;
  value.parserVersion = parserVersion;
  if (extraSpec) {
    value.rows.push({ ...value.rows[0], specification: extraSpec, average: '1.00', rowIndex: value.rows[0].rowIndex + 1 });
  }
  if (format === 'legacy-text') value.raw = `legacy ${spec} ${extraSpec} ${capturedAt} ${average}`;
  return hardware.ingest('local', value);
}

function legacyBoard(repository, workspaceId = 'local') {
  const snapshots = repository.savedSnapshots(workspaceId).sort((a, b) => Number(b.format === 'html') - Number(a.format === 'html')
    || b.capturedAt - a.capturedAt
    || b.parserVersion.localeCompare(a.parserVersion, undefined, { numeric: true }));
  const pages = new Set();
  const series = new Set();
  const rows = [];
  for (const snapshot of snapshots) {
    const page = JSON.stringify([snapshot.sourceKey, snapshot.pageKey]);
    if (pages.has(page)) continue;
    pages.add(page);
    for (const row of repository.list(workspaceId, { snapshotId: snapshot.id, limit: 500 })) {
      if (series.has(row.seriesKey)) continue;
      series.add(row.seriesKey);
      rows.push(repository.list(workspaceId, { seriesKey: row.seriesKey, limit: 1 })[0] || row);
    }
  }
  return preferHardwareQuotes(rows);
}

const identity = (row) => ({
  id: row.id,
  seriesKey: row.seriesKey,
  specification: row.specification,
  average: row.average,
  snapshotId: row.snapshotId,
  capturedAt: row.capturedAt,
});

test('migration 91 indexes snapshot rows by observation', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'hardware-index-'));
  const dbPath = path.join(directory, 'test.db');
  const store = createStore(dbPath);
  store.close();
  const db = new Database(dbPath, { readonly: true });
  try {
    assert.equal(latestSchemaVersion(), 96);
    const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'hardware_price_snapshot_rows_observation'`).get();
    assert.match(row.sql, /ON hardware_price_snapshot_rows\(workspace_id, observation_id\)/);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('current board matches the per-series lookup and keeps every saved snapshot', () => {
  const f = openHardware();
  try {
    ingest(f.hardware, { pageKey: 'dram', parserVersion: 'trendforce-tables-3', capturedAt: at + 100, spec: 'DDR5 16Gb', average: '10.00' });
    ingest(f.hardware, {
      pageKey: 'dram', format: 'legacy-text', parserVersion: 'legacy-text-1', capturedAt: at + 300,
      spec: 'DDR5 16Gb', average: '12.00', period: '2026-10-06',
      extraSpec: 'ONLY-LEGACY',
    });
    ingest(f.hardware, { pageKey: 'flash', parserVersion: 'trendforce-tables-3', capturedAt: at + 400, spec: 'V3 NAND', average: '3.00' });
    ingest(f.hardware, { pageKey: 'flash', parserVersion: 'trendforce-tables-10', capturedAt: at + 400, spec: 'V10 NAND', average: '10.00' });
    const repository = f.store.repositories.hardwarePrices;
    const expected = legacyBoard(repository).map(identity);
    const actual = f.hardware.list('local', { limit: 500 }).items.map(identity);
    assert.deepEqual(actual, expected);
    assert.deepEqual(actual.map((row) => [row.specification, row.average]), [
      ['V10 NAND', '10.00'],
      ['DDR5 16Gb', '12.00'],
    ]);
    assert.equal(repository.savedSnapshots('local').length, 4);
    assert.equal(repository.latestSnapshotsByPage('local').length, 2);
    assert.deepEqual(repository.latestSnapshotsByPage('local').map((row) => [row.pageKey, row.parserVersion, row.format]), [
      ['flash', 'trendforce-tables-10', 'html'],
      ['dram', 'trendforce-tables-3', 'html'],
    ]);
  } finally {
    f.close();
  }
});

test('hardware price snapshots run once a day after the last collection', () => {
  const store = createStore(':memory:');
  try {
    const now = Date.parse('2026-10-12T02:00:00Z');
    const env = {
      AI_CENTER_TRENDFORCE_PRICE_AT: '10:30,17:30',
      AI_CENTER_TRENDFORCE_PRICE_TIMEZONE: 'Asia/Shanghai',
    };
    const hardware = ensureHardwarePriceSchedule(store, now, env);
    const boards = ensureMarketBoardsSchedule(store, now);
    assert.deepEqual(hardware.schedule, { kind: 'daily', timezone: 'Asia/Shanghai', hour: 17, minute: 40 });
    assert.equal(hardware.nextRunAt, Date.parse('2026-10-12T09:40:00Z'));
    assert.equal(boards.schedule.intervalMinutes, 1);
    const morning = ensureHardwarePriceSchedule(store, now, {
      AI_CENTER_TRENDFORCE_PRICE_AT: '10:30',
      AI_CENTER_TRENDFORCE_PRICE_TIMEZONE: 'Asia/Shanghai',
    });
    assert.deepEqual(morning.schedule, { kind: 'daily', timezone: 'Asia/Shanghai', hour: 10, minute: 40 });
    const late = ensureHardwarePriceSchedule(store, now, {
      AI_CENTER_TRENDFORCE_PRICE_AT: '23:55',
      AI_CENTER_TRENDFORCE_PRICE_TIMEZONE: 'Asia/Shanghai',
    });
    assert.deepEqual(late.schedule, { kind: 'daily', timezone: 'Asia/Shanghai', hour: 0, minute: 5 });
    assert.equal(HARDWARE_PRICE_SNAPSHOT_TTL_MS, 26 * 60 * 60 * 1000);
    assert.ok(HARDWARE_PRICE_SNAPSHOT_TTL_MS >= 24 * 60 * 60 * 1000 + 60 * 60 * 1000);
    assert.equal(HARDWARE_PRICE_CACHE_TTL_MS, HARDWARE_PRICE_SNAPSHOT_TTL_MS);
  } finally {
    store.close();
  }
});

test('a saved hardware price event enqueues one snapshot refresh', () => {
  const store = createStore(':memory:');
  try {
    assert.equal(enqueueHardwarePriceSnapshotFromEvents(store, [{ name: 'feed.capture.saved.v1' }]), null);
    const job = enqueueHardwarePriceSnapshotFromEvents(store, [{ name: HARDWARE_PRICE_SAVED_EVENT, payload: { snapshotId: 'not-logged' } }]);
    assert.equal(job.type, HARDWARE_PRICE_JOB_TYPE);
    assert.deepEqual(job.input, {});
    assert.equal(enqueueHardwarePriceSnapshotFromEvents(store, [{ name: HARDWARE_PRICE_SAVED_EVENT }]), null);
    assert.equal(store.listOpenJobs(HARDWARE_PRICE_JOB_TYPE).length, 1);
  } finally {
    store.close();
  }
});

test('job end logs only the event-loop stall duration', async () => {
  const store = createStore(':memory:');
  try {
    const lines = [];
    const runner = createJobRunner({
      store,
      handlers: {
        'demo.stall': async () => {
          const started = Date.now();
          while (Date.now() - started < 60) { /* hold the loop */ }
          return { secret: 'do-not-log' };
        },
      },
      onJobEnd(job, delay) {
        lines.push(formatJobLoopDelay(job, delay));
      },
    });
    store.createJob({ type: 'demo.stall', input: { token: 'secret-token' } });
    await runner.runOnce();
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[worker\] demo\.stall [\w-]+ loopMaxMs=\d+ loopMeanMs=\d+$/);
    assert.equal(lines[0].includes('secret'), false);
    assert.equal(lines[0].includes('do-not-log'), false);
  } finally {
    store.close();
  }
});
