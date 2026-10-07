import { randomUUID } from 'node:crypto';

export function createModelQuotaRepository(database, emitEvent) {
  return Object.freeze({
    reserve({ slots, model, at, requestsPerHour, requestsPerMinute, minIntervalMs, estimatedTokensPerMinute, estimatedTokens }) {
      return database.transaction(() => {
        const global = database.prepare('SELECT at FROM model_quota_reservations WHERE at>? ORDER BY at').all(at - 3600000);
        if (global.length >= requestsPerHour) return { admitted: false, retryAt: global[0].at + 3600000 };
        const latest = global.at(-1)?.at;
        if (latest !== undefined && at < latest + minIntervalMs) return { admitted: false, retryAt: latest + minIntervalMs };
        let retryAt = Number.POSITIVE_INFINITY, cooldownCount=0;
        for (const slot of slots) {
          const block = database.prepare('SELECT until_at FROM model_quota_cooldowns WHERE project=? AND model=?').get(slot.cooldownKey || slot.project, model);
          if (block?.until_at > at) { cooldownCount++;retryAt = Math.min(retryAt, block.until_at); continue; }
          const minute = database.prepare('SELECT at,estimated_tokens FROM model_quota_reservations WHERE project=? AND model=? AND at>? ORDER BY at').all(slot.project, model, at - 60000);
          if (minute.length >= requestsPerMinute || minute.reduce((n, r) => n + r.estimated_tokens, 0) + estimatedTokens > estimatedTokensPerMinute) {
            retryAt = Math.min(retryAt, minute.length ? minute[0].at + 60000 : at + 3600000); continue;
          }
          const id = randomUUID();
          database.prepare('INSERT INTO model_quota_reservations(id,project,model,at,estimated_tokens) VALUES(?,?,?,?,?)').run(id, slot.project, model, at, estimatedTokens);
          emitEvent('runtime.model-quota.reserved.v1', 'model-quota', id, { model, at }, 'local');
          return { admitted: true, id, project: slot.project, cooldownKey: slot.cooldownKey || slot.project, model, keyEnv: slot.keyEnv };
        }
        return { admitted: false, retryAt,quotaExhausted:cooldownCount===slots.length };
      }).immediate();
    },
    cooldown(project, model, untilAt) {
      database.transaction(() => {
        database.prepare('INSERT INTO model_quota_cooldowns(project,model,until_at) VALUES(?,?,?) ON CONFLICT(project,model) DO UPDATE SET until_at=MAX(until_at,excluded.until_at)').run(project, model, untilAt);
        emitEvent('runtime.model-quota.cooldown.v1', 'model-quota', model, { untilAt }, 'local');
      }).immediate();
    },
  });
}
