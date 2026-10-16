import { createStore } from '../packages/database/src/index.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import { createComputePriceService } from '../packages/domain/src/compute-price-service.js';
import { GPU_RENT_DAILY_SINCE, beijingDay } from '../packages/domain/src/gpu-rent-daily.js';

const sinceDay = arg('--since', GPU_RENT_DAILY_SINCE);
const throughDay = arg('--through', '');
const root = process.cwd();
const instance = resolveInstanceConfig({ repositoryRoot: root });
const store = createStore(instance.databasePath);
const service = createComputePriceService({ repository: store.repositories.computePrices });

try {
  const rolled = service.rollup('local', { sinceDay, throughDay: throughDay || undefined });
  console.log(`gpu-rent-daily since=${rolled.sinceDay} through=${rolled.throughDay} days=${rolled.days} rows=${rolled.rows} carried=${rolled.carried} today=${beijingDay(Date.now())}`);
} finally {
  store.close();
}

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}
