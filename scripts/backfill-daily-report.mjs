import {createStore} from '../packages/database/src/index.js';
import {resolveInstanceConfig} from '../packages/instance/src/index.js';
import {createRuntimeService} from '../packages/domain/src/runtime-service.js';
import {resolveDailyConfig} from '../packages/domain/src/daily-window.js';

const dateFlag = process.argv.indexOf('--date');
const date = dateFlag >= 0 ? process.argv[dateFlag + 1] : '';
if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
  console.log('用法: node --env-file=.env scripts/backfill-daily-report.mjs --date YYYY-MM-DD');
  console.log('把指定日期的日报生成放进队列。Worker 执行模型调用；本命令只入队。');
  console.log('例: node --env-file=.env scripts/backfill-daily-report.mjs --date 2026-10-12');
  process.exit(dateFlag >= 0 ? 1 : 0);
}

const instance = resolveInstanceConfig({repositoryRoot: process.cwd()});
const store = createStore(instance.databasePath);
try {
  const service = createRuntimeService({
    runtimeRepository: store,
    dailyConfig: resolveDailyConfig(process.env),
  });
  const job = service.requestDailyReport({reportDate: date, workspaceId: 'local'});
  console.log(JSON.stringify({
    queued: job.status === 'queued' || job.status === 'running',
    jobId: job.id,
    status: job.status,
    reportDate: date,
  }));
} finally {
  store.close();
}
