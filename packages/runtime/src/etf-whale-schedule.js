import { nextDailyInstant } from '../../domain/src/zoned-time.js';
import { ETF_WHALE_SYNC_JOB } from './etf-whale-sync.js';

export const ETF_WHALE_SCHEDULE_KEY = 'etf.whale.sync';

function parseClock(value, fallback) {
  const match = String(value || fallback).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error('AI_CENTER_ETF_WHALE_AT 需要 HH:MM');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error('AI_CENTER_ETF_WHALE_AT 需要 HH:MM');
  return { hour, minute };
}

export function etfWhaleScheduleConfig(env = process.env) {
  const clock = parseClock(env.AI_CENTER_ETF_WHALE_AT, '18:30');
  return {
    enabled: String(env.AI_CENTER_ETF_WHALE_SYNC ?? '1') !== '0',
    timeZone: String(env.AI_CENTER_ETF_WHALE_TIMEZONE || 'Asia/Shanghai').trim() || 'Asia/Shanghai',
    hour: clock.hour,
    minute: clock.minute,
  };
}

export function ensureEtfWhaleSchedule(store, env = process.env, now = Date.now()) {
  const config = etfWhaleScheduleConfig(env);
  return store.upsertJobSchedule({
    workspaceId: 'local',
    key: ETF_WHALE_SCHEDULE_KEY,
    jobType: ETF_WHALE_SYNC_JOB,
    enabled: config.enabled,
    schedule: { kind: 'daily', timezone: config.timeZone, hour: config.hour, minute: config.minute },
    input: {},
    priority: 0,
    maxAttempts: 2,
    nextRunAt: nextDailyInstant(now - 1, config),
  });
}
