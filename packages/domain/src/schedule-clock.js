import { nextDailyInstant, previousDailyInstant } from './zoned-time.js';

export function resolveDueOccurrence(schedule, now) {
  const nextRunAt = Number(schedule.nextRunAt);
  if (!Number.isFinite(nextRunAt) || nextRunAt > now) return null;
  const spec = schedule.schedule;
  if (spec.kind === 'interval') {
    const step = spec.intervalMinutes * 60_000;
    const steps = Math.floor((now - nextRunAt) / step);
    const scheduledFor = nextRunAt + steps * step;
    return { scheduledFor, nextRunAt: scheduledFor + step };
  }
  const daily = { timeZone: spec.timezone, hour: spec.hour, minute: spec.minute };
  const latest = previousDailyInstant(now, daily);
  const scheduledFor = Math.max(nextRunAt, latest);
  return {
    scheduledFor,
    nextRunAt: nextDailyInstant(scheduledFor, daily),
  };
}
