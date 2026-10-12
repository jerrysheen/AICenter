import { z } from 'zod';
import { parseContract } from '../../contracts/src/index.js';
import {
  COMPUTE_PRICE_PARSER_VERSION,
  fetchOpenRouterTokenPrices,
  fetchRunPodGpuRates,
  fetchVastH100Rates,
} from '../../connectors/src/compute-prices.js';
import { createComputePriceService } from '../../domain/src/compute-price-service.js';
import { nextDailyInstant } from '../../domain/src/zoned-time.js';

export const TOKEN_PRICE_JOB_TYPE = 'market.token-prices.snapshot';
export const GPU_RENT_JOB_TYPE = 'market.gpu-rent.snapshot';
const TOKEN_SCHEDULE_KEY = 'market.token-prices.snapshot';
const GPU_SCHEDULE_KEY = 'market.gpu-rent.snapshot';

export const computePriceManifest = Object.freeze({
  id: 'market.compute-prices',
  version: '1.0.0',
  capabilities: ['market.token-prices.snapshot', 'market.gpu-rent.snapshot'],
  jobTypes: [TOKEN_PRICE_JOB_TYPE, GPU_RENT_JOB_TYPE],
});

const jobInput = z.object({
  workspaceId: z.string().min(1).default('local'),
  scheduleKey: z.string().max(128).optional(),
  scheduledFor: z.number().optional(),
}).strict();

function parseClock(value = '08:20') {
  const match = String(value || '08:20').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error('AI_CENTER_TOKEN_PRICE_AT 需要 HH:MM');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error('AI_CENTER_TOKEN_PRICE_AT 需要 HH:MM');
  return { hour, minute };
}

function intervalMinutes(value) {
  if (value === undefined || value === '') return 360;
  const number = Number(value);
  if (!Number.isFinite(number)) return 360;
  return Math.min(1440, Math.max(60, Math.trunc(number)));
}

export function computePriceScheduleConfig(env = process.env) {
  const clock = parseClock(env.AI_CENTER_TOKEN_PRICE_AT || '08:20');
  return {
    tokenEnabled: String(env.AI_CENTER_TOKEN_PRICE_SYNC ?? '1') !== '0',
    gpuEnabled: String(env.AI_CENTER_GPU_RENT_SYNC ?? '1') !== '0',
    timeZone: String(env.AI_CENTER_TOKEN_PRICE_TIMEZONE || 'Asia/Shanghai').trim() || 'Asia/Shanghai',
    hour: clock.hour,
    minute: clock.minute,
    gpuIntervalMinutes: intervalMinutes(env.AI_CENTER_GPU_RENT_INTERVAL_MINUTES),
  };
}

export function ensureComputePriceSchedules(store, env = process.env, now = Date.now()) {
  const config = computePriceScheduleConfig(env);
  const token = store.upsertJobSchedule({
    workspaceId: 'local',
    key: TOKEN_SCHEDULE_KEY,
    jobType: TOKEN_PRICE_JOB_TYPE,
    enabled: config.tokenEnabled,
    schedule: { kind: 'daily', timezone: config.timeZone, hour: config.hour, minute: config.minute },
    input: {},
    priority: 0,
    maxAttempts: 2,
    nextRunAt: nextDailyInstant(now - 1, config),
  });
  const gpu = store.upsertJobSchedule({
    workspaceId: 'local',
    key: GPU_SCHEDULE_KEY,
    jobType: GPU_RENT_JOB_TYPE,
    enabled: config.gpuEnabled,
    schedule: { kind: 'interval', intervalMinutes: config.gpuIntervalMinutes },
    input: {},
    priority: 0,
    maxAttempts: 2,
    nextRunAt: Math.trunc(now),
  });
  return [token, gpu];
}

function snapshot(sourceKey, capturedAt, parsed) {
  return {
    sourceKey,
    capturedAt,
    parserVersion: COMPUTE_PRICE_PARSER_VERSION,
    warnings: parsed.warnings,
    tokens: parsed.rows.filter((row) => row.modelKey),
    gpus: parsed.rows.filter((row) => row.gpuKey),
  };
}

export function createComputePriceJobHandlers({ repository, fetch: fetchImpl = fetch, now = () => Date.now() } = {}) {
  const service = repository ? createComputePriceService({ repository }) : null;
  return {
    async [TOKEN_PRICE_JOB_TYPE](input, context) {
      const value = parseContract(jobInput, input || {});
      if (!service) throw new Error('缺少算力价格存储');
      const capturedAt = now();
      const parsed = await fetchOpenRouterTokenPrices({ fetch: fetchImpl });
      if (!parsed.rows.length) throw new Error(parsed.warnings[0] || 'OpenRouter 没有可保存的型号价格');
      const saved = service.save(context?.job?.workspaceId || value.workspaceId, snapshot('openrouter', capturedAt, parsed));
      return { ok: true, sourceKey: 'openrouter', models: parsed.rows.length, ...saved };
    },
    async [GPU_RENT_JOB_TYPE](input, context) {
      const value = parseContract(jobInput, input || {});
      if (!service) throw new Error('缺少算力价格存储');
      const workspaceId = context?.job?.workspaceId || value.workspaceId;
      const capturedAt = now();
      const [runpod, vast] = await Promise.allSettled([
        fetchRunPodGpuRates({ fetch: fetchImpl }),
        fetchVastH100Rates({ fetch: fetchImpl }),
      ]);
      if (runpod.status === 'fulfilled') {
        for (const item of runpod.value.filtered || []) {
          console.log(`[compute-prices] 跳过 ${item.label} ${item.lane} ${item.usdPerHour || ''}：${item.reason}`);
        }
      }
      const saved = [];
      const errors = [];
      if (runpod.status === 'fulfilled' && runpod.value.rows.length) {
        saved.push(service.save(workspaceId, snapshot('runpod', capturedAt, runpod.value)));
      } else if (runpod.status === 'fulfilled') {
        errors.push(runpod.value.warnings[0] || 'RunPod 没有可保存的 GPU 小时价');
      }
      if (vast.status === 'fulfilled') saved.push(service.save(workspaceId, snapshot('vast', capturedAt, vast.value)));
      for (const item of [runpod, vast]) {
        if (item.status === 'rejected') errors.push(item.reason?.message || String(item.reason));
      }
      if (errors.length) throw new Error(errors.join('；'));
      return { ok: true, saved };
    },
  };
}
