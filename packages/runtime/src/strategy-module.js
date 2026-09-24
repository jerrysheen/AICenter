import { parseContract, StrategySnapshotJobInputSchema } from '../../contracts/src/index.js';
import { dailySlotOnInstant } from '../../domain/src/zoned-time.js';
import {
  DIVIDEND_STRATEGY_HOUR,
  DIVIDEND_STRATEGY_MINUTE,
  DIVIDEND_STRATEGY_TIMEZONE,
} from '../../domain/src/trading-strategies/strategy-service.js';

export const STRATEGY_SNAPSHOT_JOB_TYPE = 'strategy.cn-dividend.snapshot';
export const DIVIDEND_STRATEGY_SCHEDULE_KEY = 'strategy.cn-dividend.snapshot';

export const strategySnapshotManifest = Object.freeze({
  id: 'strategy.cn-dividend',
  version: '1.0.0',
  capabilities: ['strategy.cn-dividend.snapshot'],
  jobTypes: [STRATEGY_SNAPSHOT_JOB_TYPE],
});

export function createStrategyJobHandlers({ strategyService }) {
  if (!strategyService?.captureDividendSnapshot) throw new Error('dividend strategy jobs require strategyService');
  return {
    [STRATEGY_SNAPSHOT_JOB_TYPE]: async (rawInput) => {
      const input = parseContract(StrategySnapshotJobInputSchema, rawInput || {});
      const snapshot = await strategyService.captureDividendSnapshot(input);
      return {
        snapshotId: snapshot.id,
        strategyKey: snapshot.strategyKey,
        asOf: snapshot.asOf,
        regime: snapshot.factors.regime,
        status: snapshot.status,
      };
    },
  };
}

export function ensureDividendStrategySchedule(store, now = Date.now()) {
  const nextRunAt = dailySlotOnInstant(now, {
    timeZone: DIVIDEND_STRATEGY_TIMEZONE,
    hour: DIVIDEND_STRATEGY_HOUR,
    minute: DIVIDEND_STRATEGY_MINUTE,
  });
  return store.upsertJobSchedule({
    workspaceId: 'local',
    key: DIVIDEND_STRATEGY_SCHEDULE_KEY,
    jobType: STRATEGY_SNAPSHOT_JOB_TYPE,
    enabled: true,
    schedule: {
      kind: 'daily',
      timezone: DIVIDEND_STRATEGY_TIMEZONE,
      hour: DIVIDEND_STRATEGY_HOUR,
      minute: DIVIDEND_STRATEGY_MINUTE,
    },
    input: {},
    priority: 0,
    maxAttempts: 2,
    nextRunAt,
  });
}
