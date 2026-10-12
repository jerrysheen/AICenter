import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../packages/database/src/index.js';
import { selectCcirGpuRates, selectBargoGpuRates, selectGpuEconomyRates } from '../packages/connectors/src/gpu-price-sources.js';
import { createComputePriceService } from '../packages/domain/src/compute-price-service.js';
import { createComputePriceJobHandlers, ensureComputePriceSchedules } from '../packages/runtime/src/compute-price-job.js';
import { computeMarketItems, gpuMatchesSource, gpuSourceUrl } from '../apps/web/public/compute-prices.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/compute-prices/${name}`, import.meta.url), 'utf8');

function store() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gpu-sources-'));
  const database = createStore(path.join(directory, 'test.db'));
  return {
    directory,
    database,
    close() {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('CCIR ladders keep provider tiers, both grades, B300 and A100', () => {
  const parsed = selectCcirGpuRates(fixture('ccir-rates.html'));
  assert.equal(parsed.quoteDate, '2026-10-11');
  assert.equal(parsed.rows.length, 22);
  const cell = (label, lane) => parsed.rows.find((row) => row.label === label && row.lane === lane);
  assert.equal(cell('B300', 'neocloud-guaranteed').usdPerHour, '8.20');
  assert.equal(cell('B300', 'neocloud-guaranteed').sampleCount, 12);
  assert.equal(cell('B300', 'hyperscaler-guaranteed'), undefined);
  assert.equal(cell('B300', 'marketplace-guaranteed').usdPerHour, '7.96');
  assert.equal(cell('H100', 'marketplace-guaranteed').usdPerHour, '3.07');
  assert.equal(cell('H100', 'marketplace-guaranteed').sampleCount, 8);
  assert.equal(cell('A100', 'neocloud-interruptible').usdPerHour, '1.14');
  assert.equal(cell('A100', 'neocloud-interruptible').sampleCount, 4);
  assert.equal(cell('H200', 'hyperscaler-interruptible').usdPerHour, '6.67');
  assert.equal(parsed.filtered.length, 0);
});

test('CCIR skips a blank cell and a price under the family cutoff', () => {
  const parsed = selectCcirGpuRates(`
    <span>AS OF 2026-10-11</span>
    On-demand, guaranteed
    <table><tr><th>Silicon</th><th>Hyperscaler</th><th>Neocloud</th></tr>
      <tr><td>H100</td><td class="posted" title="Median (n=4)">11.00</td><td class="empty">—</td></tr>
      <tr><td>H100 bargain</td><td class="posted" title="n=2">0.20</td><td class="posted">3.00</td></tr>
    </table>
  `);
  assert.equal(parsed.rows.some((row) => row.lane === 'neocloud-guaranteed' && row.label === 'H100'), false);
  assert.equal(parsed.rows.some((row) => row.usdPerHour === '0.20'), false);
  assert.ok(parsed.filtered.some((item) => item.usdPerHour === '0.20' && item.reason.includes('40%')));
  assert.equal(parsed.rows.find((row) => row.label === 'H100').sampleCount, 4);
});

test('GPU Economy median comes from the provider sentence or a comparison table', () => {
  const card = selectGpuEconomyRates(fixture('gpueconomy-h100-sxm.html'), 'https://gpueconomy.com/gpu/h100-sxm');
  assert.equal(card.quoteDate, '2026-10-12');
  assert.equal(card.rows.length, 1);
  assert.equal(card.rows[0].gpuKey, 'h100-sxm');
  assert.equal(card.rows[0].lane, 'median');
  assert.equal(card.rows[0].usdPerHour, '3.49');
  assert.equal(card.rows[0].sampleCount, 35);
  const compare = selectGpuEconomyRates(fixture('gpueconomy-compare.html'), 'https://gpueconomy.com/gpus/h100-sxm-vs-b200');
  assert.deepEqual(compare.rows.map((row) => `${row.gpuKey}:${row.usdPerHour}:${row.sampleCount}`), [
    'h100-sxm:3.49:36',
    'b200:6.99:36',
  ]);
});

test('Bargo keeps on-demand spot and reserved averages and the vendor count', () => {
  const parsed = selectBargoGpuRates(fixture('bargo-gpu-prices.html'));
  assert.equal(parsed.quoteDate, '2026-10-12');
  const h100 = parsed.rows.filter((row) => row.gpuKey === 'h100');
  assert.deepEqual(h100.map((row) => `${row.lane}:${row.usdPerHour}`), ['ondemand:3.40', 'spot:2.00', 'reserved:3.23']);
  assert.equal(h100[0].sampleCount, 57);
  const b200 = parsed.rows.filter((row) => row.gpuKey === 'b200');
  assert.deepEqual(b200.map((row) => row.usdPerHour), ['7.26', '4.22', '5.36']);
  assert.equal(b200[0].sampleCount, 38);
  assert.equal(parsed.rows.some((row) => /MI/i.test(row.label)), false);
  assert.equal(parsed.rows.some((row) => row.usdPerHour === '—'), false);
});

test('new gpu sources keep their own clocks and can be switched off', () => {
  const fixtureDb = store();
  try {
    const now = Date.parse('2026-10-12T02:00:00Z');
    const saved = ensureComputePriceSchedules(fixtureDb.database, {}, now);
    const byKey = Object.fromEntries(saved.map((row) => [row.key, row]));
    assert.equal(byKey['market.ccir-gpu.snapshot'].schedule.hour, 20);
    assert.equal(byKey['market.ccir-gpu.snapshot'].schedule.minute, 30);
    assert.equal(byKey['market.ccir-gpu.retry'].schedule.hour, 21);
    assert.equal(byKey['market.ccir-gpu.retry'].schedule.minute, 30);
    assert.equal(byKey['market.ccir-gpu.snapshot'].jobType, 'market.ccir-gpu.snapshot');
    assert.equal(byKey['market.ccir-gpu.retry'].jobType, 'market.ccir-gpu.snapshot');
    assert.equal(byKey['market.gpueconomy-gpu.snapshot'].schedule.intervalMinutes, 120);
    assert.equal(byKey['market.bargo-gpu.snapshot'].schedule.hour, 9);
    assert.equal(byKey['market.bargo-gpu.snapshot'].schedule.minute, 0);
    const off = ensureComputePriceSchedules(fixtureDb.database, {
      AI_CENTER_CCIR_GPU_SYNC: '0',
      AI_CENTER_GPUECONOMY_SYNC: '0',
      AI_CENTER_BARGO_GPU_SYNC: '0',
      AI_CENTER_GPUECONOMY_INTERVAL_MINUTES: '180',
      AI_CENTER_BARGO_GPU_AT: '10:15',
    }, now + 1);
    const disabled = Object.fromEntries(off.map((row) => [row.key, row]));
    assert.equal(disabled['market.ccir-gpu.snapshot'].enabled, false);
    assert.equal(disabled['market.ccir-gpu.retry'].enabled, false);
    assert.equal(disabled['market.gpueconomy-gpu.snapshot'].enabled, false);
    assert.equal(disabled['market.gpueconomy-gpu.snapshot'].schedule.intervalMinutes, 180);
    assert.equal(disabled['market.bargo-gpu.snapshot'].enabled, false);
    assert.equal(disabled['market.bargo-gpu.snapshot'].schedule.hour, 10);
    assert.equal(disabled['market.bargo-gpu.snapshot'].schedule.minute, 15);
  } finally {
    fixtureDb.close();
  }
});

test('CCIR job stores the printed quote date and the board cites the source', async () => {
  const fixtureDb = store();
  const handlers = createComputePriceJobHandlers({
    repository: fixtureDb.database.repositories.computePrices,
    now: () => Date.parse('2026-10-12T12:30:00Z'),
    fetch: async () => ({ ok: true, text: async () => fixture('ccir-rates.html') }),
  });
  try {
    const saved = await handlers['market.ccir-gpu.snapshot']({}, { job: { workspaceId: 'local' } });
    assert.equal(saved.rows, 22);
    assert.equal(saved.quoteDate, '2026-10-11');
    const listed = createComputePriceService({ repository: fixtureDb.database.repositories.computePrices }).list('local');
    assert.equal(listed.gpus[0].venue, 'ccir');
    assert.equal(listed.gpus[0].quoteDate, '2026-10-11');
    const items = computeMarketItems(listed, { kind: 'gpu' });
    assert.equal(items[0].compute.sourceUrl, 'https://ccir.io/rates');
    assert.match(items.find((item) => item.name === 'B300' && item.group.includes('新云')).group, /12 条/);
    assert.equal(gpuSourceUrl('gpueconomy', 'h100-sxm'), 'https://gpueconomy.com/gpu/h100-sxm');
    assert.equal(gpuSourceUrl('bargo', 'h100'), 'https://www.bargo.ai/gpu-prices');
    assert.equal(gpuMatchesSource(items[0], 'ccir'), true);
    assert.equal(gpuMatchesSource(items[0], 'runpod'), false);
    assert.equal(gpuMatchesSource({ compute: { kind: 'token' } }, 'ccir'), true);
  } finally {
    fixtureDb.close();
  }
});
