import { nextDailyInstant } from '../../domain/src/zoned-time.js';
import { ETF_WHALE_FUTURES_JOB, ETF_WHALE_MARKET_JOB, ETF_WHALE_SYNC_JOB } from './etf-whale-sync.js';

export const ETF_WHALE_SCHEDULE_KEY = 'etf.whale.sync';
export const DEFAULT_SHARE_AT = '09:00,12:00,16:30,18:30,20:30';
export const DEFAULT_MARKET_AT = '15:30';
export const DEFAULT_FUTURES_AT = '17:00';
const SHARE_SLOTS = 8;

function parseClock(value, label) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error(`${label} 需要 HH:MM`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`${label} 需要 HH:MM`);
  return { hour, minute };
}

export function parseClockList(value, fallback, label) {
  const parts = String(value || fallback).split(',').map((item) => item.trim()).filter(Boolean);
  if (!parts.length) throw new Error(`${label} 需要 HH:MM`);
  return parts.map((part) => parseClock(part, label));
}

export function etfWhaleScheduleConfig(env = process.env) {
  return {
    enabled: String(env.AI_CENTER_ETF_WHALE_SYNC ?? '1') !== '0',
    timeZone: String(env.AI_CENTER_ETF_WHALE_TIMEZONE || 'Asia/Shanghai').trim() || 'Asia/Shanghai',
    shareClocks: parseClockList(env.AI_CENTER_ETF_WHALE_SHARE_AT, DEFAULT_SHARE_AT, 'AI_CENTER_ETF_WHALE_SHARE_AT'),
    marketClock: parseClock(env.AI_CENTER_ETF_WHALE_MARKET_AT || DEFAULT_MARKET_AT, 'AI_CENTER_ETF_WHALE_MARKET_AT'),
    futuresClock: parseClock(env.AI_CENTER_ETF_WHALE_FUTURES_AT || DEFAULT_FUTURES_AT, 'AI_CENTER_ETF_WHALE_FUTURES_AT'),
  };
}

function putSchedule(store, { key, jobType, enabled, hour, minute, input, timeZone, now }) {
  return store.upsertJobSchedule({
    workspaceId: 'local',
    key,
    jobType,
    enabled,
    schedule: { kind: 'daily', timezone: timeZone, hour, minute },
    input,
    priority: 0,
    maxAttempts: 3,
    nextRunAt: nextDailyInstant(now - 1, { timeZone, hour, minute }),
  });
}

export function ensureEtfWhaleSchedule(store, env = process.env, now = Date.now()) {
  const config = etfWhaleScheduleConfig(env);
  const saved = [];
  saved.push(putSchedule(store, {
    key: ETF_WHALE_SCHEDULE_KEY,
    jobType: ETF_WHALE_SYNC_JOB,
    enabled: false,
    hour: 18,
    minute: 30,
    input: { task: 'shares', retired: true },
    timeZone: config.timeZone,
    now,
  }));
  for (let index = 0; index < SHARE_SLOTS; index += 1) {
    const clock = config.shareClocks[index];
    saved.push(putSchedule(store, {
      key: `etf.whale.shares.${index + 1}`,
      jobType: ETF_WHALE_SYNC_JOB,
      enabled: Boolean(config.enabled && clock),
      hour: clock?.hour ?? 9,
      minute: clock?.minute ?? 0,
      input: { task: 'shares' },
      timeZone: config.timeZone,
      now,
    }));
  }
  saved.push(putSchedule(store, {
    key: 'etf.whale.market',
    jobType: ETF_WHALE_MARKET_JOB,
    enabled: config.enabled,
    hour: config.marketClock.hour,
    minute: config.marketClock.minute,
    input: { task: 'market' },
    timeZone: config.timeZone,
    now,
  }));
  saved.push(putSchedule(store, {
    key: 'etf.whale.futures',
    jobType: ETF_WHALE_FUTURES_JOB,
    enabled: config.enabled,
    hour: config.futuresClock.hour,
    minute: config.futuresClock.minute,
    input: { task: 'futures' },
    timeZone: config.timeZone,
    now,
  }));
  store.repositories?.etfWhale?.supersedeStackOverflowFetches?.();
  return saved;
}
