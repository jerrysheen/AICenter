import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../packages/database/src/index.js';
import { latestSchemaVersion } from '../packages/database/src/migrations.js';
import {
  medianDecimal,
  selectCuratedTokenModels,
  selectRunPodGpuRates,
  selectVastH100Rates,
  usdPerMillionTokens,
} from '../packages/connectors/src/compute-prices.js';
import { createComputePriceService } from '../packages/domain/src/compute-price-service.js';
import { COMPUTE_PRICE_PARSER_VERSION } from '../packages/connectors/src/compute-prices.js';
import { createComputePriceJobHandlers, ensureComputePriceSchedules } from '../packages/runtime/src/compute-price-job.js';
import { computeMarketItems } from '../apps/web/public/compute-prices.js';
import { createAiCenterServer } from '../apps/web/src/server.js';

const dayOne = Date.parse('2026-10-10T16:00:00Z');
const dayTwo = Date.parse('2026-10-11T16:00:00Z');

function store() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'compute-prices-'));
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

test('token prices scale from per-token dollars to per million', () => {
  assert.equal(usdPerMillionTokens('0.000001'), '1');
  assert.equal(usdPerMillionTokens('0.0000027'), '2.7');
  assert.equal(usdPerMillionTokens('0.00000005'), '0.05');
  assert.equal(usdPerMillionTokens('1e-6'), null);
  assert.equal(medianDecimal(['2', '1', '4']), '2');
  assert.equal(medianDecimal(['1', '2']), '1.5');
});

test('curated models keep one current price per family and skip batch aliases', () => {
  const selected = selectCuratedTokenModels({
    data: [
      { id: 'openai/gpt-4o-mini', name: 'GPT-4o mini', created: 1, pricing: { prompt: '0.00000015', completion: '0.0000006' }, context_length: 128000 },
      { id: 'openai/gpt-4o', name: 'GPT-4o', created: 2, pricing: { prompt: '0.0000025', completion: '0.00001' }, context_length: 128000 },
      { id: 'openai/gpt-4o:batch', name: 'GPT-4o batch', created: 9, pricing: { prompt: '0.000001', completion: '0.000004' }, context_length: 128000 },
      { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet', created: 3, pricing: { prompt: '0.000003', completion: '0.000015' }, context_length: 200000 },
      { id: 'x-ai/grok-4', name: 'Grok 4', created: 4, pricing: { prompt: '0.000002', completion: '0.000006' }, context_length: 131072 },
    ],
  });
  const gpt = selected.rows.find((row) => row.modelKey === 'gpt-flagship');
  assert.equal(gpt.modelId, 'openai/gpt-4o');
  assert.equal(gpt.promptPerMillion, '2.5');
  assert.equal(gpt.completionPerMillion, '10');
  assert.equal(selected.rows.some((row) => row.modelId.includes(':batch')), false);
  assert.equal(selected.rows.find((row) => row.modelKey === 'gpt-mini').promptPerMillion, '0.15');
  assert.ok(selected.warnings.some((warning) => warning.includes('Claude Opus')));
});

test('RunPod keeps H100 H200 and B200 lanes and Vast reports H100 min and median', () => {
  const runpod = selectRunPodGpuRates({
    data: {
      gpuTypes: [
        { id: 'NVIDIA H100 80GB HBM3', displayName: 'H100 SXM', securePrice: 3.99, communityPrice: 2.69 },
        { id: 'NVIDIA H100 PCIe', displayName: 'H100 PCIe', securePrice: 2.89, communityPrice: 0 },
        { id: 'NVIDIA H200', displayName: 'H200 SXM', securePrice: 5.29, communityPrice: 3.59 },
        { id: 'NVIDIA B200', displayName: 'B200', securePrice: 7.99, communityPrice: 5.98 },
        { id: 'NVIDIA H100 MIG', displayName: 'H100 MIG', securePrice: 1, communityPrice: 1 },
        { id: 'NVIDIA A100', displayName: 'A100', securePrice: 1.79, communityPrice: 1.19 },
      ],
    },
  });
  assert.deepEqual(runpod.rows.map((row) => `${row.gpuKey}:${row.lane}:${row.usdPerHour}`), [
    'h100-pcie:secure:2.89',
    'h100-sxm:secure:3.99',
    'h100-sxm:community:2.69',
    'h200-sxm:secure:5.29',
    'h200-sxm:community:3.59',
    'b200:secure:7.99',
    'b200:community:5.98',
  ]);
  const vast = selectVastH100Rates({
    offers: [
      { gpu_name: 'H100 NVL', num_gpus: 1, gpu_frac: 1, dph_total: 2 },
      { gpu_name: 'H100 SXM', num_gpus: 2, gpu_frac: 1, dph_total: 4 },
      { gpu_name: 'H100 NVL', num_gpus: 1, gpu_frac: 0.5, dph_total: 0.2 },
      { gpu_name: 'A100', num_gpus: 1, dph_total: 1 },
    ],
  });
  assert.equal(vast.rows.find((row) => row.lane === 'min').usdPerHour, '2');
  assert.equal(vast.rows.find((row) => row.lane === 'median').usdPerHour, '2');
  assert.equal(vast.rows[0].sampleCount, 2);
  assert.deepEqual(selectVastH100Rates({ offers: [] }).rows, []);
});

test('daily token and gpu snapshots keep the previous day for change and a repeated check', () => {
  const fixture = store();
  try {
    assert.equal(fixture.database.pragma?.('user_version') || latestSchemaVersion(), latestSchemaVersion());
    fixture.service.save('local', {
      sourceKey: 'openrouter',
      capturedAt: dayOne,
      parserVersion: COMPUTE_PRICE_PARSER_VERSION,
      warnings: [],
      tokens: [{ sortIndex: 0, modelKey: 'grok', modelId: 'x-ai/grok-4', name: 'Grok 4', promptPerMillion: '2', completionPerMillion: '6', contextLength: 131072 }],
      gpus: [],
    });
    fixture.service.save('local', {
      sourceKey: 'openrouter',
      capturedAt: dayTwo,
      parserVersion: COMPUTE_PRICE_PARSER_VERSION,
      warnings: [],
      tokens: [{ sortIndex: 0, modelKey: 'grok', modelId: 'x-ai/grok-4', name: 'Grok 4', promptPerMillion: '2.5', completionPerMillion: '6', contextLength: 131072 }],
      gpus: [],
    });
    fixture.service.save('local', {
      sourceKey: 'runpod',
      capturedAt: dayOne,
      parserVersion: COMPUTE_PRICE_PARSER_VERSION,
      warnings: [],
      tokens: [],
      gpus: [{ sortIndex: 0, gpuKey: 'h100-sxm', label: 'H100 SXM', lane: 'secure', usdPerHour: '3.99', sampleCount: null }],
    });
    fixture.service.save('local', {
      sourceKey: 'runpod',
      capturedAt: dayTwo,
      parserVersion: COMPUTE_PRICE_PARSER_VERSION,
      warnings: [],
      tokens: [],
      gpus: [{ sortIndex: 0, gpuKey: 'h100-sxm', label: 'H100 SXM', lane: 'secure', usdPerHour: '3.99', sampleCount: null }],
    });
    const again = fixture.service.save('local', {
      sourceKey: 'openrouter',
      capturedAt: dayTwo + 60_000,
      parserVersion: COMPUTE_PRICE_PARSER_VERSION,
      warnings: [],
      tokens: [{ sortIndex: 0, modelKey: 'grok', modelId: 'x-ai/grok-4', name: 'Grok 4', promptPerMillion: '2.5', completionPerMillion: '6', contextLength: 131072 }],
      gpus: [],
    });
    assert.equal(again.unchanged, true);
    const board = fixture.service.list('local');
    assert.equal(board.tokens[0].quoteDate, '2026-10-12');
    assert.equal(board.tokens[0].promptChangePct, 25);
    assert.equal(board.tokens[0].completionChangePct, 0);
    assert.equal(board.tokens[0].history.length, 2);
    assert.equal(board.gpus[0].changePct, 0);
    assert.equal(board.gpus[0].history.length, 2);
    const tokenCheck = board.checks.find((row) => row.sourceKey === 'openrouter');
    assert.equal(tokenCheck.unchanged, true);
    assert.equal(tokenCheck.lastCheckedAt, dayTwo + 60_000);
    const rows = computeMarketItems(board, { kind: 'token' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].priceSuffix, 'USD/1M');
    assert.equal(computeMarketItems(board, { kind: 'gpu' })[0].symbol, 'RunPod');
  } finally {
    fixture.close();
  }
});

test('worker schedules default to a morning token pull and a six hour gpu pull', () => {
  const fixture = store();
  try {
    const now = Date.parse('2026-10-12T02:00:00Z');
    const saved = ensureComputePriceSchedules(fixture.database, {}, now);
    assert.equal(saved[0].enabled, true);
    assert.equal(saved[0].schedule.hour, 8);
    assert.equal(saved[0].schedule.minute, 20);
    assert.equal(saved[0].schedule.timezone, 'Asia/Shanghai');
    assert.ok(saved[0].nextRunAt > now);
    assert.equal(saved[1].enabled, true);
    assert.equal(saved[1].schedule.intervalMinutes, 360);
    const off = ensureComputePriceSchedules(fixture.database, {
      AI_CENTER_TOKEN_PRICE_SYNC: '0',
      AI_CENTER_GPU_RENT_SYNC: '0',
      AI_CENTER_GPU_RENT_INTERVAL_MINUTES: '120',
    }, now + 1);
    assert.equal(off[0].enabled, false);
    assert.equal(off[1].enabled, false);
    assert.equal(off[1].schedule.intervalMinutes, 120);
  } finally {
    fixture.close();
  }
});

test('registered jobs save fixture catalogs and the market route is read only', async () => {
  const fixture = store();
  const handlers = createComputePriceJobHandlers({
    repository: fixture.database.repositories.computePrices,
    now: () => dayTwo,
    fetch: async (url) => ({
      ok: true,
      json: async () => {
        if (String(url).includes('openrouter')) {
          return { data: [{ id: 'x-ai/grok-4', name: 'Grok 4', created: 1, pricing: { prompt: '0.000002', completion: '0.000006' }, context_length: 131072 }] };
        }
        if (String(url).includes('runpod')) {
          return { data: { gpuTypes: [{ id: 'NVIDIA B200', displayName: 'B200', securePrice: 7.99, communityPrice: 5.98 }] } };
        }
        return { offers: [{ gpu_name: 'H100 SXM', num_gpus: 1, gpu_frac: 1, dph_total: 2.5 }] };
      },
    }),
  });
  const app = createAiCenterServer({
    host: '127.0.0.1',
    port: 0,
    dataDirectory: fixture.directory,
    store: fixture.database,
    feedFilter: null,
  });
  const address = await app.listen();
  try {
    const tokens = await handlers['market.token-prices.snapshot']({}, { job: { workspaceId: 'local' } });
    const gpus = await handlers['market.gpu-rent.snapshot']({ scheduleKey: 'market.gpu-rent.snapshot', scheduledFor: dayTwo }, { job: { workspaceId: 'local' } });
    assert.equal(tokens.models, 1);
    assert.equal(gpus.saved.length, 2);
    const read = await fetch(`${address.localUrl}/api/v1/compute-prices`);
    assert.equal(read.status, 200);
    const body = await read.json();
    assert.equal(body.tokens[0].promptPerMillion, '2');
    assert.equal(body.gpus.some((row) => row.venue === 'vast' && row.lane === 'median' && row.usdPerHour === '2.5'), true);
    assert.equal(JSON.stringify(body).includes('parserVersion'), false);
    assert.equal((await fetch(`${address.localUrl}/api/v1/compute-prices`, { method: 'POST' })).status, 404);
  } finally {
    await app.close();
    fixture.close();
  }
});
