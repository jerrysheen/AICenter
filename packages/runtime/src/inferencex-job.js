import { z } from 'zod';
import { parseContract } from '../../contracts/src/index.js';
import {
  INFERENCEX_PARSER_VERSION,
  createInferenceRequestGate,
  defaultBenchmarkModels,
  fetchInferenceAvailability,
  fetchInferenceBenchmarks,
} from '../../connectors/src/inferencex.js';
import { createInferencexService } from '../../domain/src/inferencex-service.js';
import { formatYmd, nextDailyInstant, zonedParts } from '../../domain/src/zoned-time.js';

export const INFERENCE_AVAILABILITY_JOB = 'market.inferencex.availability';
export const INFERENCE_BENCHMARK_JOB = 'market.inferencex.benchmarks';
const AVAILABILITY_KEY = 'market.inferencex.availability';
const BENCHMARK_KEY = 'market.inferencex.benchmarks';

export const inferencexManifest = Object.freeze({
  id: 'market.inferencex',
  version: '1.0.0',
  capabilities: [INFERENCE_AVAILABILITY_JOB, INFERENCE_BENCHMARK_JOB],
  jobTypes: [INFERENCE_AVAILABILITY_JOB, INFERENCE_BENCHMARK_JOB],
});

const jobInput = z.object({
  workspaceId: z.string().min(1).default('local'),
  scheduleKey: z.string().max(128).optional(),
  scheduledFor: z.number().optional(),
}).strict();

function enabledFlag(value) {
  return value === '1' || value === 'true' || value === 'on';
}

function parseClock(value, fallback) {
  const match = String(value || fallback).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return { hour: 7, minute: 40 };
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return { hour: 7, minute: 40 };
  return { hour, minute };
}

export function inferencexScheduleConfig(env = process.env) {
  const clock = parseClock(env.AI_CENTER_INFERENCEX_AT, '07:40');
  const enabled = enabledFlag(String(env.AI_CENTER_INFERENCEX_SYNC || '').trim());
  const benchmarks = enabled && String(env.AI_CENTER_INFERENCEX_BENCHMARKS ?? '1').trim() !== '0';
  return {
    enabled,
    benchmarks,
    timeZone: String(env.AI_CENTER_INFERENCEX_TIMEZONE || 'Asia/Shanghai').trim() || 'Asia/Shanghai',
    hour: clock.hour,
    minute: clock.minute,
    models: defaultBenchmarkModels(env.AI_CENTER_INFERENCEX_BENCHMARK_MODELS),
  };
}

export function ensureInferencexSchedules(store, env = process.env, now = Date.now()) {
  const config = inferencexScheduleConfig(env);
  const availability = store.upsertJobSchedule({
    workspaceId: 'local',
    key: AVAILABILITY_KEY,
    jobType: INFERENCE_AVAILABILITY_JOB,
    enabled: config.enabled,
    schedule: { kind: 'daily', timezone: config.timeZone, hour: config.hour, minute: config.minute },
    input: {},
    priority: 0,
    maxAttempts: 2,
    nextRunAt: nextDailyInstant(now - 1, config),
  });
  const benchmarkClock = { ...config, minute: (config.minute + 10) % 60, hour: config.minute >= 50 ? (config.hour + 1) % 24 : config.hour };
  const benchmarks = store.upsertJobSchedule({
    workspaceId: 'local',
    key: BENCHMARK_KEY,
    jobType: INFERENCE_BENCHMARK_JOB,
    enabled: config.benchmarks,
    schedule: { kind: 'daily', timezone: config.timeZone, hour: benchmarkClock.hour, minute: benchmarkClock.minute },
    input: {},
    priority: 0,
    maxAttempts: 2,
    nextRunAt: nextDailyInstant(now - 1, benchmarkClock),
  });
  return [availability, benchmarks];
}

function quoteDate(at, timeZone) {
  return formatYmd(zonedParts(at, timeZone));
}

export function createInferencexJobHandlers({ repository, fetch: fetchImpl = fetch, lookupImpl, now = () => Date.now(), env = process.env, gate = null } = {}) {
  const service = repository ? createInferencexService({ repository }) : null;
  const requests = gate || createInferenceRequestGate();
  const config = () => inferencexScheduleConfig(env);
  return {
    async [INFERENCE_AVAILABILITY_JOB](input, context) {
      const value = parseContract(jobInput, input || {});
      if (!service) throw new Error('缺少 InferenceX 存储');
      const workspaceId = context?.job?.workspaceId || value.workspaceId;
      const capturedAt = now();
      const day = quoteDate(capturedAt, config().timeZone);
      const parsed = await fetchInferenceAvailability({ fetchImpl, lookupImpl, gate: requests });
      if (!parsed.ok) {
        service.reject(workspaceId, 'availability', {
          capturedAt, quoteDate: day, parserVersion: INFERENCEX_PARSER_VERSION, note: parsed.note || parsed.health || 'availability 失败',
        });
        throw new Error(parsed.note || parsed.health || 'InferenceX availability 失败');
      }
      const saved = service.saveAvailability(workspaceId, {
        capturedAt,
        quoteDate: day,
        parserVersion: INFERENCEX_PARSER_VERSION,
        sourceUrl: parsed.sourceUrl,
        rows: parsed.rows,
        note: parsed.note || '',
      });
      return { ok: true, sourceKey: 'availability', rowCount: saved.rowCount, rejected: parsed.rejected, unchanged: saved.unchanged };
    },
    async [INFERENCE_BENCHMARK_JOB](input, context) {
      const value = parseContract(jobInput, input || {});
      if (!service) throw new Error('缺少 InferenceX 存储');
      const workspaceId = context?.job?.workspaceId || value.workspaceId;
      const capturedAt = now();
      const settings = config();
      const day = quoteDate(capturedAt, settings.timeZone);
      const rows = [];
      const notes = [];
      let rejected = 0;
      let failed = 0;
      for (const model of settings.models) {
        const parsed = await fetchInferenceBenchmarks(model, { fetchImpl, lookupImpl, gate: requests });
        if (!parsed.ok) {
          failed += 1;
          notes.push(`${model}:${parsed.health || 'failed'}`);
          continue;
        }
        rows.push(...parsed.rows);
        rejected += parsed.rejected || 0;
        if (parsed.note) notes.push(`${model}:${parsed.note}`);
      }
      if (!rows.length && failed) {
        service.reject(workspaceId, 'benchmarks', {
          capturedAt, quoteDate: day, parserVersion: INFERENCEX_PARSER_VERSION, note: notes.join('; ').slice(0, 500) || 'benchmarks 失败',
        });
        throw new Error(notes.join('; ') || 'InferenceX benchmarks 失败');
      }
      const saved = service.saveBenchmarks(workspaceId, {
        capturedAt,
        quoteDate: day,
        parserVersion: INFERENCEX_PARSER_VERSION,
        sourceUrl: rows[0]?.sourceUrl || 'https://inferencex.semianalysis.com/api/v1/benchmarks',
        rows,
        note: notes.join('; ').slice(0, 500),
      });
      return { ok: true, sourceKey: 'benchmarks', rowCount: saved.rowCount, rejected, unchanged: saved.unchanged };
    },
  };
}
