import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { latestSchemaVersion } from '../packages/database/src/migrations.js';
import { createStore } from '../packages/database/src/index.js';
import {
  buildAvailabilityUrl,
  buildBenchmarkUrl,
  citationEligible,
  createInferenceRequestGate,
  parseAvailabilityPayload,
  parseBenchmarkPayload,
} from '../packages/connectors/src/inferencex.js';
import { inferenceDisplayRows, renderInferencePanel } from '../apps/web/public/compute-prices.js';
import {
  createInferencexJobHandlers,
  ensureInferencexSchedules,
  inferencexScheduleConfig,
} from '../packages/runtime/src/inferencex-job.js';

const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34', family: 4 }];
const NOW = Date.parse('2026-10-31T00:00:00Z');

function response(body, status = 200) {
  return {
    status,
    headers: { get: () => '' },
    async arrayBuffer() { return Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)); },
  };
}

function availabilityRow(extra = {}) {
  return {
    model: 'dsr1',
    isl: 1024,
    osl: 1024,
    precision: 'fp8',
    hardware: 'h200_sxm',
    framework: 'vllm',
    spec_method: 'none',
    disagg: false,
    benchmark_type: 'single_turn',
    date: '2026-08-08',
    ...extra,
  };
}

function openFixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-inferencex-'));
  const store = createStore(path.join(directory, 'test.db'));
  return {
    store,
    remove() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('benchmark urls send only model and incomplete rows are not citation eligible', () => {
  assert.equal(buildAvailabilityUrl(), 'https://inferencex.semianalysis.com/api/v1/availability');
  const benchmark = new URL(buildBenchmarkUrl('DeepSeek-R1-0528'));
  assert.deepEqual([...benchmark.searchParams.keys()], ['model']);
  assert.equal(benchmark.searchParams.get('model'), 'DeepSeek-R1-0528');
  assert.throws(() => buildBenchmarkUrl('bad model'), /model/);
  const parsed = parseAvailabilityPayload([
    availabilityRow(),
    availabilityRow({ isl: null, hardware: '' }),
    { tput_per_gpu: 120 },
  ]);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rejected, 2);
  assert.equal(citationEligible(parsed.rows[0]), true);
  assert.equal(citationEligible({ tokensPerSecondPerGpu: '120' }), false);
  const benchmarks = parseBenchmarkPayload([
    { ...availabilityRow(), metrics: { tput_per_gpu: 128.4 } },
    { metrics: { tput_per_gpu: 90 } },
  ], 'https://inferencex.semianalysis.com/api/v1/benchmarks?model=DeepSeek-R1-0528');
  assert.equal(benchmarks.rows.length, 1);
  assert.equal(benchmarks.rows[0].tokensPerSecondPerGpu, '128.4');
  assert.equal(benchmarks.rows[0].investmentUse, 'not_a_conclusion');
  assert.equal(benchmarks.rows[0].citationEligible, true);
  assert.equal(inferenceDisplayRows({ benchmarks: [...benchmarks.rows, { citationEligible: false, investmentUse: 'not_a_conclusion', tokensPerSecondPerGpu: '90' }] }).length, 1);
});

test('compute panel refuses bare throughput as an investment conclusion', () => {
  function element() {
    return {
      className: '',
      textContent: '',
      href: '',
      rel: '',
      target: '',
      children: [],
      append(child) { this.children.push(child); },
      replaceChildren(...children) { this.children = children; },
    };
  }
  globalThis.document = { createElement: element };
  try {
    const root = element();
    renderInferencePanel(root, {
      benchmarks: [{ citationEligible: false, investmentUse: 'not_a_conclusion', tokensPerSecondPerGpu: '90' }],
    });
    const text = JSON.stringify(root);
    assert.match(text, /不是投资结论/);
    assert.equal(text.includes('>90<') || text.includes('"90"'), false);
  } finally {
    delete globalThis.document;
  }
});

test('request gate waits at least three seconds', async () => {
  let clock = 10;
  const waits = [];
  const gate = createInferenceRequestGate({
    now: () => clock,
    sleep: async (ms) => { waits.push(ms); clock += ms; },
  });
  await gate();
  await gate();
  assert.ok(waits[0] >= 3000);
});

test('jobs store complete snapshots only and the schedule stays off', async () => {
  assert.equal(latestSchemaVersion(), 98);
  assert.equal(inferencexScheduleConfig({}).enabled, false);
  const fixture = openFixture();
  const urls = [];
  let availabilityStatus = 200;
  const handlers = createInferencexJobHandlers({
    repository: fixture.store.repositories.inferencex,
    now: () => NOW,
    env: { AI_CENTER_INFERENCEX_BENCHMARK_MODELS: 'DeepSeek-R1-0528', AI_CENTER_INFERENCEX_TIMEZONE: 'Asia/Shanghai' },
    lookupImpl: PUBLIC_LOOKUP,
    gate: async () => {},
    fetch: async (url) => {
      urls.push(String(url));
      if (String(url).endsWith('/api/v1/availability')) {
        if (availabilityStatus === 400) return response({ error: 'bad' }, 400);
        return response([availabilityRow(), availabilityRow({ isl: null })]);
      }
      return response([{ ...availabilityRow({ model: 'DeepSeek-R1-0528' }), metrics: { tput_per_gpu: 10 } }]);
    },
  });
  try {
    const schedules = ensureInferencexSchedules(fixture.store, {});
    assert.equal(schedules.every((item) => item.enabled === false), true);
    const saved = await handlers['market.inferencex.availability']({}, { job: { workspaceId: 'local' } });
    assert.equal(saved.rowCount, 1);
    assert.equal(saved.rejected, 1);
    const board = fixture.store.repositories.inferencex.latest('local');
    assert.equal(board.availability.length, 1);
    assert.equal(board.availability[0].specMethod, 'none');
    const again = await handlers['market.inferencex.availability']({}, { job: { workspaceId: 'local' } });
    assert.equal(again.unchanged, true);
    assert.equal(fixture.store.repositories.inferencex.latest('local').availability.length, 1);
    const benchmarks = await handlers['market.inferencex.benchmarks']({}, { job: { workspaceId: 'local' } });
    assert.equal(benchmarks.rowCount, 1);
    const view = fixture.store.repositories.inferencex.latest('local');
    assert.equal(view.benchmarks[0].citationEligible, true);
    assert.equal(view.benchmarks[0].investmentUse, 'not_a_conclusion');
    assert.equal(view.benchmarks[0].tokensPerSecondPerGpu, '10');
    availabilityStatus = 400;
    await assert.rejects(() => handlers['market.inferencex.availability']({}, { job: { workspaceId: 'local' } }));
    assert.equal(fixture.store.repositories.inferencex.latest('local').availability.length, 1);
    assert.equal(urls.every((url) => url.startsWith('https://inferencex.semianalysis.com/api/v1/')), true);
    assert.equal(urls.some((url) => url.includes('view=') || url.includes('sequence=')), false);
  } finally {
    fixture.remove();
  }
});
