import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseContract, QuantRunOptionsSchema, ValidationError, parseWorkerJobConcurrency } from '../packages/contracts/src/index.js';
import { createQuantLabService } from '../packages/domain/src/quant-lab-service.js';
import { buildQuantCommand } from '../packages/runtime/src/quant-module.js';
import { resolveJobTypeConcurrency as runnerConcurrency } from '../packages/runtime/src/job-runner.js';
import { createStore } from '../packages/database/src/index.js';

test('quant run options only accept the baseline knobs', () => {
  assert.deepEqual(parseContract(QuantRunOptionsSchema, {}), { topk: 5, nDrop: 1 });
  assert.throws(() => parseContract(QuantRunOptionsSchema, { topk: 5, nDrop: 5 }), ValidationError);
  assert.throws(() => parseContract(QuantRunOptionsSchema, { topk: 5, nDrop: 1, python: 'os.system' }), ValidationError);
});

test('quant command is an argument array and does not carry a token', () => {
  const command = buildQuantCommand({
    repositoryRoot: 'C:\\repo',
    quantRoot: 'C:\\repo\\data\\quant',
    command: 'run',
    experimentId: '11111111-1111-4111-8111-111111111111',
    topk: 5,
    nDrop: 1,
  });
  assert.equal(command.shell, false);
  assert.deepEqual(command.args.slice(1, 4), ['aicenter_quant', 'run', '--root']);
  assert.equal(command.args.includes('TUSHARE_TOKEN'), false);
  assert.equal(JSON.stringify(command).includes('.yaml'), false);
});

test('quant jobs share a single concurrency slot', () => {
  assert.equal(parseWorkerJobConcurrency({}).quantLabLimit, 1);
  assert.equal(runnerConcurrency('quant.lab.run', {}), 1);
  assert.equal(runnerConcurrency('quant.lab.prepare', {}), 1);
  assert.throws(() => parseWorkerJobConcurrency({ quantLabLimit: 2 }), ValidationError);
});

test('report path stays inside the experiment directory', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'quant-lab-'));
  const id = '11111111-1111-4111-8111-111111111111';
  const folder = path.join(root, 'experiments', id);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, 'report.html'), '<p>report</p>');
  writeFileSync(path.join(folder, 'summary.json'), JSON.stringify({
    status: 'completed', topk: 5, n_drop: 1, prediction_rows: 3, position_days: 2, metrics: [],
    graph_errors: ['模型表现图未能导入'],
  }));
  const service = createQuantLabService({ quantRoot: root });
  assert.equal(path.basename(service.reportPath(id)), 'report.html');
  assert.equal(service.reportPath('../secrets'), null);
  assert.equal(service.reportPath('..\\..\\windows'), null);
  const listed = service.list();
  assert.equal(listed.experiments[0].experimentId, id);
  assert.deepEqual(listed.experiments[0].graphErrors, ['模型表现图未能导入']);
  mkdirSync(path.join(folder, 'export'), { recursive: true });
  writeFileSync(path.join(folder, 'export', 'predictions.csv'), 'date,instrument,score,rank,label\n2023-01-05,SH600000,1,1,\n2023-01-06,SH600000,0,1,\n');
  writeFileSync(path.join(folder, 'export', 'positions.csv'), 'date,instrument,amount,weight\n2023-01-06,SH600000,10,1\n');
  const day = service.day(id, '2023-01-06');
  assert.equal(day.signalDate, '2023-01-05');
  assert.equal(day.scores[0].score, 1);
  assert.equal(day.holdings[0].amount, 10);
  rmSync(root, { recursive: true, force: true });
});

test('a restarted worker fails a running quant job instead of retrying it', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'quant-job-'));
  const store = createStore(path.join(directory, 'test.db'));
  const job = store.createJob({
    type: 'quant.lab.run',
    maxAttempts: 1,
    input: { experimentId: '11111111-1111-4111-8111-111111111111', topk: 5, nDrop: 1 },
  });
  store.claimNextJob('worker-a', ['quant.lab.run']);
  const abandoned = store.abandonRunningJobs(['quant.lab.run'], 'Worker 已重启，未完成的量化任务不会自动重跑');
  const failed = store.getJob(job.id);
  assert.equal(abandoned, 1);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error.message, /不会自动重跑/);
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
