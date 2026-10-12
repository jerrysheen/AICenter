import { nextDailyInstant } from '../../domain/src/zoned-time.js';
import { TRENDFORCE_PRICE_JOB_TYPE } from '../../connectors/src/trendforce.js';

export { TRENDFORCE_PRICE_JOB_TYPE };
const SLOT_COUNT = 4;

export function parseTrendForcePriceClocks(value = '10:30,17:30') {
  const parts = String(value || '10:30,17:30').split(',').map((item) => item.trim()).filter(Boolean);
  if (!parts.length) throw new Error('AI_CENTER_TRENDFORCE_PRICE_AT 需要 HH:MM');
  return parts.slice(0, SLOT_COUNT).map((part) => {
    const match = part.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) throw new Error('AI_CENTER_TRENDFORCE_PRICE_AT 需要 HH:MM');
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) throw new Error('AI_CENTER_TRENDFORCE_PRICE_AT 需要 HH:MM');
    return { hour, minute };
  });
}

export function trendForcePriceScheduleConfig(env = process.env) {
  return {
    enabled: String(env.AI_CENTER_TRENDFORCE_PRICE_SYNC ?? '1') !== '0',
    timeZone: String(env.AI_CENTER_TRENDFORCE_PRICE_TIMEZONE || 'Asia/Shanghai').trim() || 'Asia/Shanghai',
    clocks: parseTrendForcePriceClocks(env.AI_CENTER_TRENDFORCE_PRICE_AT || '10:30,17:30'),
  };
}

export function ensureTrendForcePriceSchedules(store, env = process.env, now = Date.now()) {
  const config = trendForcePriceScheduleConfig(env);
  const saved = [];
  for (let index = 0; index < SLOT_COUNT; index += 1) {
    const clock = config.clocks[index];
    const enabled = Boolean(config.enabled && clock);
    const hour = clock?.hour ?? 10;
    const minute = clock?.minute ?? 30;
    const nextRunAt = nextDailyInstant(now - 1, { timeZone: config.timeZone, hour, minute });
    saved.push(store.upsertJobSchedule({
      workspaceId: 'local',
      key: `feed.trendforce.prices.${index + 1}`,
      jobType: TRENDFORCE_PRICE_JOB_TYPE,
      enabled,
      schedule: { kind: 'daily', timezone: config.timeZone, hour, minute },
      input: {},
      priority: 0,
      maxAttempts: 2,
      nextRunAt,
    }));
  }
  return saved;
}
