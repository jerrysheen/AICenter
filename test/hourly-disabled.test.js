import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createStore} from '../packages/database/src/index.js';
import {createRuntimeService} from '../packages/domain/src/runtime-service.js';
import {createInformationTreeJobHandlers, enqueuePreparedHourRefreshes} from '../packages/runtime/src/information-tree-module.js';
import {createJobRunner} from '../packages/runtime/src/job-runner.js';
import {createScheduler} from '../packages/runtime/src/scheduler.js';
import {
  allowHourlyScheduleEnqueue,
  createReportJobHandlers,
  ensureHourlyDigestSchedule,
  releaseOpenHourlyJobs,
  REPORT_HOURLY_JOB_TYPE,
} from '../packages/runtime/src/report-module.js';

const H = 3600000;
const disabled = {AI_CENTER_HOURLY_DISABLED: '1'};

test('disabled hourly schedule is not created or rewritten', () => {
  const empty = createStore(':memory:');
  try {
    assert.equal(ensureHourlyDigestSchedule(empty, 10 * H, {minute: 30, env: disabled}), null);
    assert.equal(empty.getJobSchedule('local', 'report.hourly.default'), null);
  } finally { empty.close(); }

  const store = createStore(':memory:');
  try {
    const enabled = ensureHourlyDigestSchedule(store, 0, {minute: 0, env: {}});
    assert.equal(enabled.enabled, true);
    const kept = ensureHourlyDigestSchedule(store, 5 * H, {minute: 30, env: disabled});
    assert.equal(kept.enabled, true);
    assert.equal(kept.nextRunAt, enabled.nextRunAt);
    assert.equal(store.getJobSchedule('local', 'report.hourly.default').updatedAt, enabled.updatedAt);
    const turnedOff = store.upsertJobSchedule({
      workspaceId: 'local', key: 'report.hourly.default', jobType: REPORT_HOURLY_JOB_TYPE,
      enabled: false, schedule: {kind: 'interval', intervalMinutes: 60}, input: {},
      priority: 0, maxAttempts: 2, nextRunAt: enabled.nextRunAt,
    });
    const off = ensureHourlyDigestSchedule(store, 8 * H, {minute: 15, env: disabled});
    assert.equal(off.enabled, false);
    assert.equal(off.nextRunAt, turnedOff.nextRunAt);
    assert.equal(off.updatedAt, turnedOff.updatedAt);
  } finally { store.close(); }
});

test('enabled schedule does not enqueue while the switch is on', async () => {
  const store = createStore(':memory:');
  try {
    const schedule = ensureHourlyDigestSchedule(store, 10 * H, {env: {}});
    const scheduler = createScheduler({
      store,
      allowedJobTypes: [REPORT_HOURLY_JOB_TYPE],
      beforeEnqueue: (item) => allowHourlyScheduleEnqueue(item, disabled),
    });
    await scheduler.tick(10 * H + 3 * H + 1000);
    assert.equal(store.listOpenJobs(REPORT_HOURLY_JOB_TYPE).length, 0);
    assert.equal(store.getJobSchedule('local', schedule.key).enabled, true);
    assert.equal(store.getJobSchedule('local', schedule.key).nextRunAt, schedule.nextRunAt);
    assert.equal(allowHourlyScheduleEnqueue({jobType: 'report.daily.generate'}, disabled), true);
  } finally { store.close(); }
});

test('preparation, backfill and manual hourly enqueue do nothing', async () => {
  const store = createStore(':memory:');
  try {
    const latest = Math.floor(Date.now() / H) * H - H;
    const nodes = [{id: 'n1', window: {startAt: latest}}, {id: 'n2', window: {startAt: latest - H}}];
    const service = {list: () => ({hours: [{}]})};
    assert.deepEqual(enqueuePreparedHourRefreshes(store, service, 'local', nodes, Date.now(), {env: disabled}), []);
    assert.equal(store.listOpenJobs(REPORT_HOURLY_JOB_TYPE).length, 0);
    const handlers = createInformationTreeJobHandlers({
      ...service,
      prepareInformation: async () => ({nodes, pending: [], calls: 0, cacheHits: 0}),
    }, {env: disabled});
    await handlers['report.information.prepare']({sourceIds: ['a']}, {store});
    assert.equal(store.listOpenJobs(REPORT_HOURLY_JOB_TYPE).length, 0);
    const runtime = createRuntimeService({runtimeRepository: store, env: disabled});
    assert.deepEqual(runtime.requestHourlyDigest({hourStart: latest}), {status: 'skipped', reason: 'hourly-disabled'});
    assert.equal(store.listOpenJobs(REPORT_HOURLY_JOB_TYPE).length, 0);
  } finally { store.close(); }
});

test('open hourly jobs are cancelled and a claimed job skips the model', async () => {
  const store = createStore(':memory:');
  try {
    const queued = store.createJob({type: REPORT_HOURLY_JOB_TYPE, input: {hourStart: H, backfill: true}, maxAttempts: 2});
    const running = store.createJob({type: REPORT_HOURLY_JOB_TYPE, input: {hourStart: 2 * H}, maxAttempts: 2});
    store.claimNextJob('worker', [REPORT_HOURLY_JOB_TYPE]);
    const daily = store.createJob({type: 'report.daily.generate', input: {}, maxAttempts: 1});
    assert.equal(releaseOpenHourlyJobs(store, {}), 0);
    assert.equal(releaseOpenHourlyJobs(store, disabled), 2);
    assert.equal(store.getJob(queued.id).status, 'cancelled');
    assert.equal(store.getJob(running.id).status, 'cancelled');
    assert.equal(store.getJob(running.id).output.reason, 'hourly-disabled');
    assert.equal(store.getJob(daily.id).status, 'queued');
  } finally { store.close(); }

  const runnerStore = createStore(':memory:');
  try {
    let calls = 0;
    const handlers = createReportJobHandlers({
      reportService: {generateDailyReport() {}},
      informationService: {async generateHourlyDigests() { calls += 1; return []; }},
      env: disabled,
    });
    const job = runnerStore.createJob({type: REPORT_HOURLY_JOB_TYPE, input: {hourStart: 3 * H}, maxAttempts: 2});
    const runner = createJobRunner({store: runnerStore, handlers, pollIntervalMs: 20});
    await runner.runOnce();
    runner.stop();
    assert.equal(calls, 0);
    assert.equal(runnerStore.getJob(job.id).status, 'completed');
    assert.equal(runnerStore.getJob(job.id).output.reason, 'hourly-disabled');
  } finally { runnerStore.close(); }
});

test('worker logs the hourly stop once at startup', () => {
  const source = readFileSync(new URL('../apps/worker/src/worker.js', import.meta.url), 'utf8');
  assert.equal(source.split('小时报已停用（AI_CENTER_HOURLY_DISABLED=1）').length - 1, 1);
  assert.match(source, /ensureHourlyDigestSchedule\(store,Date\.now\(\),\{minute:articleStrategy \? 30 : 0,env\}\)/);
  assert.match(source, /allowHourlyScheduleEnqueue\(schedule, env\)/);
});
