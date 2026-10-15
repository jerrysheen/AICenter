import { createStore } from '../packages/database/src/index.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import { shanghaiToday } from '../packages/domain/src/etf-whale/fetch-policy.js';
import { recomputeEtfWhale, syncEtfWhale } from '../packages/runtime/src/etf-whale-sync.js';
import { syncEtfWhaleFutures, syncEtfWhaleMarket } from '../packages/runtime/src/etf-whale-market.js';

const command = process.argv[2];
const startDate = arg('--start');
const endDate = arg('--end', shanghaiToday());
const root = process.cwd();
const instance = resolveInstanceConfig({ repositoryRoot: root });
const store = createStore(instance.databasePath);
const repository = store.repositories.etfWhale;

try {
  if (command === 'supersede-stack-errors') {
    const changed = repository.supersedeStackOverflowFetches();
    console.log(`superseded ${changed}`);
  } else if (command === 'shares') {
    requireRange();
    const fetched = await syncEtfWhale({
      repository,
      dataDirectory: instance.dataDirectory,
      startDate,
      endDate,
      task: 'shares',
      onProgress: (line) => console.log(line),
    });
    const computed = recomputeEtfWhale(repository);
    console.log(`shares probes=${fetched.probes.length} daily=${computed.rowCount}`);
  } else if (command === 'index-daily') {
    requireRange();
    const result = await syncEtfWhaleMarket({
      repository,
      dataDirectory: instance.dataDirectory,
      startDate,
      endDate,
      parts: ['index'],
      onProgress: (line) => console.log(line),
    });
    console.log(`index-daily probes=${result.probes.length}`);
  } else if (command === 'turnover') {
    requireRange();
    const result = await syncEtfWhaleMarket({
      repository,
      dataDirectory: instance.dataDirectory,
      startDate,
      endDate,
      parts: ['turnover'],
      onProgress: (line) => console.log(line),
    });
    console.log(`turnover probes=${result.probes.length}`);
  } else if (command === 'futures') {
    requireRange();
    const result = await syncEtfWhaleFutures({
      repository,
      startDate,
      endDate,
      onProgress: (line) => console.log(line),
    });
    console.log(`futures saved=${result.saved} party=${result.citicPartyId}`);
  } else {
    console.error('用法: shares | index-daily | turnover | futures | supersede-stack-errors');
    process.exitCode = 1;
  }
} finally {
  store.close();
}

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  return process.argv[index + 1] || fallback;
}

function requireRange() {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    throw new Error('需要 --start YYYY-MM-DD --end YYYY-MM-DD');
  }
  if (startDate > endDate) throw new Error('start 不能晚于 end');
}
