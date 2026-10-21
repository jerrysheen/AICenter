import { BambooDailyUsageDaySchema } from '../../contracts/src/model-usage.js';
import { parseContract } from '../../contracts/src/errors.js';
import { listBambooDailyUsage } from './bamboo-usage.js';
import { resolveBambooDailyMax } from './feed-filter.js';

// Page service for the admission counter. It does not take a slot or change classification.
export function createBambooUsageView({ directory = null, env = process.env, now = () => Date.now(), days = 14 } = {}) {
  return Object.freeze({
    listDays() {
      const limit = resolveBambooDailyMax(env);
      return listBambooDailyUsage({ directory, at: now(), days, limit })
        .map((row) => parseContract(BambooDailyUsageDaySchema, row));
    },
  });
}
