import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../packages/database/src/index.js';
import { latestSchemaVersion } from '../packages/database/src/migrations.js';
import { gpuRentNormalization, normalizeGpuRentRow } from '../packages/domain/src/gpu-rent-normalization.js';
import { beijingDayStart, checkInstant, easternDay, rollGpuRentDays, shiftIsoDay } from '../packages/domain/src/gpu-rent-daily.js';
import { createComputePriceService } from '../packages/domain/src/compute-price-service.js';
import { selectOrnnIndexHistory } from '../packages/connectors/src/ornn-gpu.js';
import { createComputePriceJobHandlers, ensureComputePriceSchedules } from '../packages/runtime/src/compute-price-job.js';
import { describeGpuRentHistory, gpuHistoryQuery } from '../apps/web/public/compute-prices.js';
import { isApiTokenAllowlisted } from '../apps/web/src/http/api-token-access.js';
import { createAiCenterServer } from '../apps/web/src/server.js';

const day11 = Date.parse('2026-10-11T02:00:00Z');
const day11Later = Date.parse('2026-10-11T08:00:00Z');
const day12 = Date.parse('2026-10-12T02:00:00Z');
const day13 = Date.parse('2026-10-13T02:00:00Z');

function store() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gpu-rent-daily-'));
  const database = createStore(path.join(directory, 'test.db'));
  const service = createComputePriceService({ repository: database.repositories.computePrices });
  return {
    directory,
    database,
    service,
    close() {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function gpu(sortIndex, gpuKey, label, lane, usdPerHour, sampleCount = null) {
  return { sortIndex, gpuKey, label, lane, usdPerHour, sampleCount };
}

function snapshot(sourceKey, capturedAt, gpus, quoteDate) {
  const value = {
    sourceKey,
    capturedAt,
    parserVersion: 'compute-prices-2',
    warnings: [],
    gpus,
  };
  if (quoteDate) value.quoteDate = quoteDate;
  return value;
}

test('normalization config maps lanes and leaves GB200 without a source', () => {
  const mapping = gpuRentNormalization();
  const tier = (source, lane) => normalizeGpuRentRow(mapping, { sourceKey: source, variant: 'h100-sxm', label: 'H100 SXM', lane })?.tier;
  assert.equal(tier('runpod', 'secure'), 'guaranteed');
  assert.equal(tier('ccir', 'hyperscaler-guaranteed'), 'guaranteed');
  assert.equal(tier('ccir', 'marketplace-guaranteed'), 'guaranteed');
  assert.equal(tier('bargo', 'reserved'), 'guaranteed');
  assert.equal(tier('bargo', 'ondemand'), 'guaranteed');
  assert.equal(tier('runpod', 'community'), 'community');
  assert.equal(tier('ccir', 'neocloud-interruptible'), 'community');
  assert.equal(tier('bargo', 'spot'), 'community');
  assert.equal(tier('vast', 'min'), 'community');
  assert.equal(tier('vast', 'median'), 'median');
  assert.equal(tier('gpueconomy', 'median'), 'median');
  assert.equal(tier('ornn', 'ocpi'), 'index');
  assert.equal(normalizeGpuRentRow(mapping, { sourceKey: 'runpod', variant: 'a100', label: 'A100', lane: 'secure' }), null);
  assert.equal(normalizeGpuRentRow(mapping, { sourceKey: 'runpod', variant: 'gb200', label: 'GB200', lane: 'secure' }).model, 'gb200');
  assert.equal(normalizeGpuRentRow(mapping, { sourceKey: 'bargo', variant: 'b200', label: 'B200', lane: 'ondemand' }).model, 'b200');
  assert.deepEqual(mapping.ornn.map((item) => item.path), ['H100 SXM', 'H200', 'B200']);
  assert.ok(latestSchemaVersion() >= 75);
});

test('daily rollup is idempotent, carries an unchanged check, and keeps today live', async () => {
  const fixture = store();
  const later = snapshot('runpod', day11Later, [
    gpu(0, 'h100-sxm', 'H100 SXM', 'secure', '3.90'),
    gpu(1, 'h100-sxm', 'H100 SXM', 'community', '2.20'),
    gpu(2, 'h100-pcie', 'H100 PCIe', 'secure', '2.80'),
  ], '2026-10-11');
  try {
    fixture.service.save('local', snapshot('runpod', day11, [
      gpu(0, 'h100-sxm', 'H100 SXM', 'secure', '3.50'),
      gpu(1, 'h100-sxm', 'H100 SXM', 'community', '2.20'),
      gpu(2, 'h100-pcie', 'H100 PCIe', 'secure', '2.80'),
      gpu(3, 'a100', 'A100', 'secure', '1.20'),
    ], '2026-10-11'));
    fixture.service.save('local', later);
    fixture.service.save('local', snapshot('runpod', day12, later.gpus, '2026-10-11'));
    fixture.service.save('local', snapshot('vast', day11, [
      gpu(0, 'h100', 'H100', 'min', '2.10', 8),
      gpu(1, 'h100', 'H100', 'median', '3.40', 8),
    ], '2026-10-11'));
    fixture.service.save('local', snapshot('ccir', day11, [
      gpu(0, 'h100', 'H100', 'marketplace-guaranteed', '3.07', 8),
    ], '2026-10-11'));
    fixture.service.save('local', snapshot('bargo', day11, [
      gpu(0, 'b200', 'B200', 'ondemand', '7.26', 38),
      gpu(1, 'b200', 'B200', 'spot', '4.22', 38),
    ], '2026-10-11'));
    fixture.service.save('local', snapshot('gpueconomy', day11, [
      gpu(0, 'h200', 'H200', 'median', '6.10', 12),
    ], '2026-10-11'));
    const readDaily = () => fixture.database.repositories.computePrices.listDailyRange('local', '2026-10-11', '2026-10-13');
    const first = fixture.service.rollup('local', { now: day13 });
    const before = readDaily();
    const second = fixture.service.rollup('local', { now: day13 });
    assert.equal(first.throughDay, '2026-10-12');
    assert.equal(second.days, 1);
    assert.deepEqual(readDaily(), before);
    const table = before;
    assert.equal(table.some((row) => row.model === 'a100' || row.variant === 'a100'), false);
    assert.equal(table.some((row) => row.day === '2026-10-13'), false);
    const sxm = table.find((row) => row.day === '2026-10-11' && row.variant === 'h100-sxm' && row.lane === 'secure');
    assert.equal(sxm.close, '3.90');
    assert.equal(sxm.low, '3.50');
    assert.equal(sxm.high, '3.90');
    assert.equal(sxm.model, 'h100');
    assert.equal(sxm.tier, 'guaranteed');
    assert.equal(sxm.carriedForward, false);
    const carried = table.find((row) => row.day === '2026-10-12' && row.variant === 'h100-sxm' && row.lane === 'secure');
    assert.equal(carried.close, '3.90');
    assert.equal(carried.low, '3.90');
    assert.equal(carried.high, '3.90');
    assert.equal(carried.carriedForward, true);
    assert.equal(table.find((row) => row.sourceKey === 'vast' && row.lane === 'min').tier, 'community');
    assert.equal(table.find((row) => row.sourceKey === 'vast' && row.lane === 'median').tier, 'median');
    assert.equal(table.find((row) => row.sourceKey === 'ccir').tier, 'guaranteed');
    assert.equal(table.find((row) => row.sourceKey === 'bargo' && row.lane === 'ondemand').tier, 'guaranteed');
    assert.equal(table.find((row) => row.sourceKey === 'bargo' && row.lane === 'spot').tier, 'community');
    assert.equal(table.find((row) => row.sourceKey === 'gpueconomy').model, 'h200');

    fixture.service.save('local', snapshot('runpod', day13, [
      gpu(0, 'h100-sxm', 'H100 SXM', 'secure', '4.00'),
    ], '2026-10-13'));
    fixture.service.rollup('local', { now: day13 });
    const app = createAiCenterServer({
      host: '127.0.0.1',
      port: 0,
      dataDirectory: fixture.directory,
      store: fixture.database,
      feedFilter: null,
    });
    const address = await app.listen();
    try {
      const read = await fetch(`${address.localUrl}/api/v1/compute-prices/history?start=2026-10-11&end=2026-10-13`);
      assert.equal(read.status, 200);
      const body = await read.json();
      assert.equal(body.grain, 'day');
      assert.equal(JSON.stringify(body).includes('parserVersion'), false);
      assert.equal(body.coverage.find((item) => item.model === 'gb200').status, 'no_source');
      assert.equal(body.coverage.find((item) => item.model === 'h100').status, 'ok');
      const guaranteed = body.series.find((item) => item.model === 'h100' && item.tier === 'guaranteed' && item.source === 'runpod');
      assert.equal(guaranteed.variant, undefined);
      assert.equal(guaranteed.points.find((point) => point.day === '2026-10-11').close, '3.35');
      assert.equal(guaranteed.points.find((point) => point.day === '2026-10-11').low, '2.80');
      assert.equal(guaranteed.dayBasis, 'Beijing');
      assert.equal(guaranteed.points.find((point) => point.day === '2026-10-12').carriedForward, true);
      const today = guaranteed.points.find((point) => point.day === '2026-10-13');
      assert.equal(today.close, '4.00');
      assert.equal(today.carriedForward, false);
      assert.equal(readDaily().some((row) => row.day === '2026-10-13'), false);
      const raw = await (await fetch(`${address.localUrl}/api/v1/compute-prices/history?start=2026-10-11&end=2026-10-13&grain=raw&sources=runpod&models=h100&tiers=guaranteed`)).json();
      assert.equal(raw.series.find((item) => item.variant === 'h100-pcie').points.length, 2);
      assert.equal(raw.coverage.find((item) => item.model === 'gb200').status, 'no_source');
      assert.equal((await fetch(`${address.localUrl}/api/v1/compute-prices/history?start=2026-10-13&end=2026-10-11`)).status, 400);
      assert.equal((await fetch(`${address.localUrl}/api/v1/compute-prices/history?start=2025-01-01&end=2026-01-03`)).status, 400);
      assert.equal((await fetch(`${address.localUrl}/api/v1/compute-prices/history?start=2026-10-01&end=2026-11-01&grain=raw`)).status, 400);
      assert.equal((await fetch(`${address.localUrl}/api/v1/compute-prices/history`)).status, 400);
      const view = describeGpuRentHistory(body, 'runpod');
      assert.deepEqual(view.notes, ['B300 暂无来源', 'GB200 暂无来源']);
      assert.equal(view.panels.some((panel) => panel.title === 'H100 · 保障'), true);
      assert.equal(view.panels.every((panel) => panel.series.every((series) => series.label === 'RunPod')), true);
      assert.equal(describeGpuRentHistory(body, 'ornn').panels.length, 0);
    } finally {
      await app.close();
    }
  } finally {
    fixture.close();
  }
});

test('Ornn stores the Eastern settlement day and the daily clocks stay internal', async () => {
  assert.equal(easternDay(Date.parse('2026-10-15T20:00:00.000Z')), '2026-10-15');
  assert.equal(easternDay(Date.parse('2026-10-16T03:30:00.000Z')), '2026-10-15');
  const parsed = selectOrnnIndexHistory({
    success: true,
    data: [
      { timestamp: '2026-10-15T20:00:00.000Z', index_value: 3.13 },
      { timestamp: '2026-10-16T03:30:00.000Z', index_value: 3.2 },
      { timestamp: '2026-10-16T20:00:00.000Z', index_value: 3.4 },
    ],
  }, 'H100 SXM');
  assert.equal(parsed.points.length, 3);
  const fixture = store();
  const handlers = createComputePriceJobHandlers({
    repository: fixture.database.repositories.computePrices,
    now: () => day13,
    fetch: async (url) => {
      const name = decodeURIComponent(String(url));
      const value = name.includes('H100 SXM') ? 3.13 : name.includes('H200') ? 6.51 : name.includes('B200') ? 7.92 : 0;
      if (!value) return { ok: false, status: 404, json: async () => ({ success: false }) };
      return {
        ok: true,
        json: async () => ({ success: true, data: [{ timestamp: '2026-10-15T20:00:00.000Z', index_value: value }] }),
      };
    },
  });
  try {
    const saved = await handlers['market.ornn-gpu.snapshot']({}, { job: { workspaceId: 'local' } });
    assert.deepEqual(saved.saved.map((item) => item.path), ['H100 SXM', 'H200', 'B200']);
    const again = await handlers['market.ornn-gpu.snapshot']({}, { job: { workspaceId: 'local' } });
    assert.equal(again.saved.every((item) => item.days === 1), true);
    const ornnRows = fixture.database.repositories.computePrices.listDailyRange('local', '2026-10-15', '2026-10-15')
      .filter((row) => row.sourceKey === 'ornn');
    assert.equal(ornnRows.length, 3);
    const h100 = ornnRows.find((row) => row.variant === 'h100-sxm');
    assert.equal(h100.day, '2026-10-15');
    assert.equal(h100.lane, 'ocpi');
    assert.equal(h100.model, 'h100');
    assert.equal(h100.tier, 'index');
    assert.equal(h100.close, '3.13');
    const history = fixture.service.history('local', { start: '2026-10-15', end: '2026-10-15', sources: 'ornn' }, day13);
    assert.equal(history.series[0].dayBasis, 'ET');
    assert.equal(history.series[0].tier, 'index');
    assert.equal(history.series[0].points[0].close, '3.13');
    const schedules = ensureComputePriceSchedules(fixture.database, {}, Date.parse('2026-10-12T02:00:00Z'));
    const byKey = Object.fromEntries(schedules.map((row) => [row.key, row]));
    assert.equal(byKey['market.gpu-rent.daily'].schedule.hour, 0);
    assert.equal(byKey['market.gpu-rent.daily'].schedule.minute, 10);
    assert.equal(byKey['market.ornn-gpu.snapshot'].schedule.hour, 6);
    assert.equal(byKey['market.ornn-gpu.retry'].schedule.hour, 9);
    assert.equal(byKey['market.ornn-gpu.retry'].jobType, 'market.ornn-gpu.snapshot');
    const off = ensureComputePriceSchedules(fixture.database, {
      AI_CENTER_GPU_RENT_DAILY_SYNC: '0',
      AI_CENTER_ORNN_GPU_SYNC: '0',
    }, Date.parse('2026-10-12T02:01:00Z'));
    const disabled = Object.fromEntries(off.map((row) => [row.key, row]));
    assert.equal(disabled['market.gpu-rent.daily'].enabled, false);
    assert.equal(disabled['market.ornn-gpu.snapshot'].enabled, false);
    assert.equal(isApiTokenAllowlisted('GET', '/api/v1/compute-prices/history'), true);
    assert.equal(isApiTokenAllowlisted('GET', '/api/v1/holdings'), false);
    assert.equal(isApiTokenAllowlisted('GET', '/api/v1/assets/personal'), false);
    assert.equal(isApiTokenAllowlisted('POST', '/api/v1/compute-prices/history'), false);
    const query = gpuHistoryQuery(day13, '90');
    assert.equal(query.end, '2026-10-13');
    assert.equal(query.grain, 'day');
  } finally {
    fixture.close();
  }
});

test('history and rollup read observations only inside the Beijing day window', () => {
  assert.equal(checkInstant([], 'runpod', '2026-10-12'), null);
  assert.equal(checkInstant([{
    sourceKey: 'runpod',
    lastCheckedAt: Date.parse('2026-10-11T04:00:00Z'),
    capturedAt: Date.parse('2026-10-11T04:00:00Z'),
  }], 'runpod', '2026-10-12'), null);
  const mapping = gpuRentNormalization();
  const rolled = rollGpuRentDays({
    observations: [
      { id: 'a', sourceKey: 'runpod', variant: 'h100-sxm', label: 'H100 SXM', lane: 'secure', usdPerHour: '3.10', sampleCount: null, capturedAt: day11 },
      { id: 'b', sourceKey: 'runpod', variant: 'h100-pcie', label: 'H100 PCIe', lane: 'secure', usdPerHour: '2.40', sampleCount: null, capturedAt: day11 },
      { id: 'c', sourceKey: 'runpod', variant: 'h100-sxm', label: 'H100 SXM', lane: 'secure', usdPerHour: '3.80', sampleCount: 4, capturedAt: day11Later },
    ],
    snapshots: [],
    mapping,
    sinceDay: '2026-10-11',
    throughDay: '2026-10-11',
  });
  assert.equal(rolled.some((row) => row.variant === 'h100-pcie'), false);
  assert.equal(rolled.find((row) => row.variant === 'h100-sxm').close, '3.80');
  assert.equal(rolled.find((row) => row.variant === 'h100-sxm').low, '3.10');
  assert.equal(rolled.find((row) => row.variant === 'h100-sxm').sampleCount, 4);

  const fixture = store();
  const repo = fixture.database.repositories.computePrices;
  const observationCalls = [];
  const snapshotCalls = [];
  const observationsBetween = repo.listGpuObservationsBetween.bind(repo);
  const snapshotsBetween = repo.listGpuSnapshotChecksBetween.bind(repo);
  repo.listGpuObservationsBetween = (workspaceId, fromMs, toMs) => {
    observationCalls.push([fromMs, toMs]);
    return observationsBetween(workspaceId, fromMs, toMs);
  };
  repo.listGpuSnapshotChecksBetween = (workspaceId, fromMs, toMs) => {
    snapshotCalls.push([fromMs, toMs]);
    return snapshotsBetween(workspaceId, fromMs, toMs);
  };
  repo.listGpuObservations = () => { throw new Error('全表观测'); };
  repo.listGpuSnapshotChecks = () => { throw new Error('全表快照'); };
  const early = Date.parse('2026-09-01T04:00:00Z');
  try {
    fixture.service.save('local', snapshot('runpod', early, [
      gpu(0, 'h100-sxm', 'H100 SXM', 'secure', '9.99'),
    ], '2026-09-01'));
    fixture.service.save('local', snapshot('runpod', day11, [
      gpu(0, 'h100-sxm', 'H100 SXM', 'secure', '3.50'),
    ], '2026-10-11'));
    const read = () => fixture.service.history('local', { start: '2026-10-11', end: '2026-10-13' }, day13);
    const body = read();
    const earliest = beijingDayStart('2026-10-11');
    const tomorrow = beijingDayStart(shiftIsoDay('2026-10-13', 1));
    assert.ok(observationCalls.length > 0);
    assert.ok(snapshotCalls.length > 0);
    for (const [fromMs, toMs] of [...observationCalls, ...snapshotCalls]) {
      assert.ok(fromMs >= earliest, String(fromMs));
      assert.ok(toMs <= tomorrow, String(toMs));
      assert.equal(fromMs, beijingDayStart(new Date(fromMs + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)));
      assert.equal(toMs, beijingDayStart(new Date(toMs + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)));
      assert.ok(early < fromMs);
    }
    assert.equal(JSON.stringify(body).includes('9.99'), false);
    assert.equal(body.series.find((item) => item.source === 'runpod').points[0].close, '3.50');
    const todayStart = beijingDayStart('2026-10-13');
    const todayReads = () => observationCalls.filter(([fromMs]) => fromMs === todayStart).length;
    const before = todayReads();
    read();
    assert.equal(todayReads(), before);
    observationCalls.length = 0;
    fixture.service.rollup('local', { now: day13 });
    assert.ok(observationCalls.length > 0);
    for (const [fromMs, toMs] of observationCalls) {
      assert.ok(fromMs >= earliest);
      assert.ok(toMs <= beijingDayStart('2026-10-13'));
    }
  } finally {
    fixture.close();
  }
});
