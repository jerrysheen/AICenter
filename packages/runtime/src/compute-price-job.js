import { z } from 'zod';
import { parseContract } from '../../contracts/src/index.js';
import {
  COMPUTE_PRICE_PARSER_VERSION,
  fetchOpenRouterTokenPrices,
  fetchRunPodGpuRates,
  fetchVastH100Rates,
} from '../../connectors/src/compute-prices.js';
import {
  BARGO_PARSER_VERSION,
  CCIR_PARSER_VERSION,
  fetchBargoGpuRates,
  fetchCcirGpuRates,
  fetchGpuEconomyRates,
  GPUECONOMY_PARSER_VERSION,
} from '../../connectors/src/gpu-price-sources.js';
import { fetchOrnnIndex } from '../../connectors/src/ornn-gpu.js';
import { createComputePriceService } from '../../domain/src/compute-price-service.js';
import { gpuRentNormalization } from '../../domain/src/gpu-rent-normalization.js';
import { nextDailyInstant } from '../../domain/src/zoned-time.js';

export const TOKEN_PRICE_JOB_TYPE = 'market.token-prices.snapshot';
export const GPU_RENT_JOB_TYPE = 'market.gpu-rent.snapshot';
export const CCIR_GPU_JOB_TYPE = 'market.ccir-gpu.snapshot';
export const GPUECONOMY_GPU_JOB_TYPE = 'market.gpueconomy-gpu.snapshot';
export const BARGO_GPU_JOB_TYPE = 'market.bargo-gpu.snapshot';
export const GPU_RENT_DAILY_JOB_TYPE = 'market.gpu-rent.daily';
export const ORNN_GPU_JOB_TYPE = 'market.ornn-gpu.snapshot';
const TOKEN_SCHEDULE_KEY = 'market.token-prices.snapshot';
const GPU_SCHEDULE_KEY = 'market.gpu-rent.snapshot';
const CCIR_SCHEDULE_KEY = 'market.ccir-gpu.snapshot';
const CCIR_RETRY_KEY = 'market.ccir-gpu.retry';
const GPUECONOMY_SCHEDULE_KEY = 'market.gpueconomy-gpu.snapshot';
const BARGO_SCHEDULE_KEY = 'market.bargo-gpu.snapshot';
const GPU_RENT_DAILY_KEY = 'market.gpu-rent.daily';
const ORNN_SCHEDULE_KEY = 'market.ornn-gpu.snapshot';
const ORNN_RETRY_KEY = 'market.ornn-gpu.retry';

export const computePriceManifest = Object.freeze({
  id: 'market.compute-prices',
  version: '1.2.0',
  capabilities: [
    'market.token-prices.snapshot',
    'market.gpu-rent.snapshot',
    'market.ccir-gpu.snapshot',
    'market.gpueconomy-gpu.snapshot',
    'market.bargo-gpu.snapshot',
    'market.gpu-rent.daily',
    'market.ornn-gpu.snapshot',
  ],
  jobTypes: [
    TOKEN_PRICE_JOB_TYPE,
    GPU_RENT_JOB_TYPE,
    CCIR_GPU_JOB_TYPE,
    GPUECONOMY_GPU_JOB_TYPE,
    BARGO_GPU_JOB_TYPE,
    GPU_RENT_DAILY_JOB_TYPE,
    ORNN_GPU_JOB_TYPE,
  ],
});

const jobInput = z.object({
  workspaceId: z.string().min(1).default('local'),
  scheduleKey: z.string().max(128).optional(),
  scheduledFor: z.number().optional(),
}).strict();

function parseClock(value, fallback, name) {
  const match = String(value || fallback).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error(`${name} 需要 HH:MM`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`${name} 需要 HH:MM`);
  return { hour, minute };
}

function intervalMinutes(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(1440, Math.max(60, Math.trunc(number)));
}

function enabled(value) {
  return String(value ?? '1') !== '0';
}

export function computePriceScheduleConfig(env = process.env) {
  const clock = parseClock(env.AI_CENTER_TOKEN_PRICE_AT, '08:20', 'AI_CENTER_TOKEN_PRICE_AT');
  const ccir = parseClock(env.AI_CENTER_CCIR_GPU_AT, '20:30', 'AI_CENTER_CCIR_GPU_AT');
  const ccirRetry = parseClock(env.AI_CENTER_CCIR_GPU_RETRY_AT, '21:30', 'AI_CENTER_CCIR_GPU_RETRY_AT');
  const bargo = parseClock(env.AI_CENTER_BARGO_GPU_AT, '09:00', 'AI_CENTER_BARGO_GPU_AT');
  const daily = parseClock(env.AI_CENTER_GPU_RENT_DAILY_AT, '00:10', 'AI_CENTER_GPU_RENT_DAILY_AT');
  const ornn = parseClock(env.AI_CENTER_ORNN_GPU_AT, '06:00', 'AI_CENTER_ORNN_GPU_AT');
  const ornnRetry = parseClock(env.AI_CENTER_ORNN_GPU_RETRY_AT, '09:00', 'AI_CENTER_ORNN_GPU_RETRY_AT');
  return {
    tokenEnabled: enabled(env.AI_CENTER_TOKEN_PRICE_SYNC),
    gpuEnabled: enabled(env.AI_CENTER_GPU_RENT_SYNC),
    ccirEnabled: enabled(env.AI_CENTER_CCIR_GPU_SYNC),
    gpuEconomyEnabled: enabled(env.AI_CENTER_GPUECONOMY_SYNC),
    bargoEnabled: enabled(env.AI_CENTER_BARGO_GPU_SYNC),
    dailyEnabled: enabled(env.AI_CENTER_GPU_RENT_DAILY_SYNC),
    ornnEnabled: enabled(env.AI_CENTER_ORNN_GPU_SYNC),
    timeZone: String(env.AI_CENTER_TOKEN_PRICE_TIMEZONE || 'Asia/Shanghai').trim() || 'Asia/Shanghai',
    hour: clock.hour,
    minute: clock.minute,
    ccirHour: ccir.hour,
    ccirMinute: ccir.minute,
    ccirRetryHour: ccirRetry.hour,
    ccirRetryMinute: ccirRetry.minute,
    bargoHour: bargo.hour,
    bargoMinute: bargo.minute,
    dailyHour: daily.hour,
    dailyMinute: daily.minute,
    ornnHour: ornn.hour,
    ornnMinute: ornn.minute,
    ornnRetryHour: ornnRetry.hour,
    ornnRetryMinute: ornnRetry.minute,
    gpuIntervalMinutes: intervalMinutes(env.AI_CENTER_GPU_RENT_INTERVAL_MINUTES, 360),
    gpuEconomyIntervalMinutes: intervalMinutes(env.AI_CENTER_GPUECONOMY_INTERVAL_MINUTES, 120),
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
  const daily = (key, jobType, on, hour, minute) => store.upsertJobSchedule({
    workspaceId: 'local',
    key,
    jobType,
    enabled: on,
    schedule: { kind: 'daily', timezone: config.timeZone, hour, minute },
    input: {},
    priority: 0,
    maxAttempts: 2,
    nextRunAt: nextDailyInstant(now - 1, { timeZone: config.timeZone, hour, minute }),
  });
  const ccir = daily(CCIR_SCHEDULE_KEY, CCIR_GPU_JOB_TYPE, config.ccirEnabled, config.ccirHour, config.ccirMinute);
  const ccirRetry = daily(CCIR_RETRY_KEY, CCIR_GPU_JOB_TYPE, config.ccirEnabled, config.ccirRetryHour, config.ccirRetryMinute);
  const gpuEconomy = store.upsertJobSchedule({
    workspaceId: 'local',
    key: GPUECONOMY_SCHEDULE_KEY,
    jobType: GPUECONOMY_GPU_JOB_TYPE,
    enabled: config.gpuEconomyEnabled,
    schedule: { kind: 'interval', intervalMinutes: config.gpuEconomyIntervalMinutes },
    input: {},
    priority: 0,
    maxAttempts: 2,
    nextRunAt: Math.trunc(now),
  });
  const bargo = daily(BARGO_SCHEDULE_KEY, BARGO_GPU_JOB_TYPE, config.bargoEnabled, config.bargoHour, config.bargoMinute);
  const rentDaily = daily(GPU_RENT_DAILY_KEY, GPU_RENT_DAILY_JOB_TYPE, config.dailyEnabled, config.dailyHour, config.dailyMinute);
  const ornn = daily(ORNN_SCHEDULE_KEY, ORNN_GPU_JOB_TYPE, config.ornnEnabled, config.ornnHour, config.ornnMinute);
  const ornnRetry = daily(ORNN_RETRY_KEY, ORNN_GPU_JOB_TYPE, config.ornnEnabled, config.ornnRetryHour, config.ornnRetryMinute);
  return [token, gpu, ccir, ccirRetry, gpuEconomy, bargo, rentDaily, ornn, ornnRetry];
}

function snapshot(sourceKey, capturedAt, parsed, parserVersion = COMPUTE_PRICE_PARSER_VERSION) {
  const value = {
    sourceKey,
    capturedAt,
    parserVersion,
    warnings: parsed.warnings,
    tokens: parsed.rows.filter((row) => row.modelKey),
    gpus: parsed.rows.filter((row) => row.gpuKey),
  };
  if (parsed.quoteDate) value.quoteDate = parsed.quoteDate;
  return value;
}

function logFiltered(source, parsed) {
  for (const item of parsed?.filtered || []) {
    console.log(`[compute-prices] 跳过 ${source} ${item.label} ${item.lane} ${item.usdPerHour || ''}：${item.reason}`);
  }
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
      if (runpod.status === 'fulfilled') logFiltered('RunPod', runpod.value);
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
    async [CCIR_GPU_JOB_TYPE](input, context) {
      return saveParsedGpu(service, input, context, 'ccir', CCIR_PARSER_VERSION, fetchCcirGpuRates, fetchImpl, now);
    },
    async [GPUECONOMY_GPU_JOB_TYPE](input, context) {
      return saveParsedGpu(service, input, context, 'gpueconomy', GPUECONOMY_PARSER_VERSION, fetchGpuEconomyRates, fetchImpl, now);
    },
    async [BARGO_GPU_JOB_TYPE](input, context) {
      return saveParsedGpu(service, input, context, 'bargo', BARGO_PARSER_VERSION, fetchBargoGpuRates, fetchImpl, now);
    },
    async [GPU_RENT_DAILY_JOB_TYPE](input, context) {
      const value = parseContract(jobInput, input || {});
      if (!service) throw new Error('缺少算力价格存储');
      const rolled = service.rollup(context?.job?.workspaceId || value.workspaceId, { now: now() });
      return { ok: true, ...rolled };
    },
    async [ORNN_GPU_JOB_TYPE](input, context) {
      const value = parseContract(jobInput, input || {});
      if (!service) throw new Error('缺少算力价格存储');
      const workspaceId = context?.job?.workspaceId || value.workspaceId;
      const saved = [];
      const errors = [];
      for (const series of gpuRentNormalization().ornn) {
        try {
          const parsed = await fetchOrnnIndex({ fetch: fetchImpl, pathName: series.path });
          if (!parsed.points.length) {
            errors.push(parsed.warnings[0] || `Ornn ${series.path} 没有可保存的结算价`);
            continue;
          }
          const days = service.saveOrnnSeries(workspaceId, series, parsed.points);
          saved.push({ path: series.path, days });
        } catch (error) {
          errors.push(`${series.path}：${error?.message || error}`);
        }
      }
      if (errors.length) throw new Error(errors.join('；'));
      return { ok: true, saved };
    },
  };
}

async function saveParsedGpu(service, input, context, sourceKey, parserVersion, fetchRates, fetchImpl, now) {
  const value = parseContract(jobInput, input || {});
  if (!service) throw new Error('缺少算力价格存储');
  const parsed = await fetchRates({ fetch: fetchImpl });
  logFiltered(sourceKey, parsed);
  if (!parsed.rows.length) throw new Error(parsed.warnings[0] || `${sourceKey} 没有可保存的 GPU 小时价`);
  const saved = service.save(context?.job?.workspaceId || value.workspaceId, snapshot(sourceKey, now(), parsed, parserVersion));
  return { ok: true, sourceKey, rows: parsed.rows.length, ...saved };
}
