import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {createStore} from '../packages/database/src/index.js';
import {createJobRunner, wait} from '../packages/runtime/src/job-runner.js';
import {
  HOURLY_FAILURE_CATCHUP_JOB_TYPE,
  REPORT_HOURLY_JOB_TYPE,
  createReportJobHandlers,
  ensureHourlyDigestSchedule,
  ensureHourlyFailureCatchupSchedule,
  hourlyNoCatchup,
  hourlyRunningSameVersion,
  releaseStaleHourlyQueue,
} from '../packages/runtime/src/report-module.js';

const H = 3_600_000;

function temporaryDatabase(prefix) {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    path: path.join(directory, 'test.db'),
    remove() { rmSync(directory, {recursive: true, force: true}); },
  };
}

test('a scheduled extract overlaps only another scheduled run, not a different hour', () => {
  assert.equal(hourlyRunningSameVersion([
    {id: 'job-a', status: 'running', workspaceId: 'local', input: {hourStart: 10}},
  ], {id: 'job-b', workspaceId: 'local', hourStart: 10}), true);
  assert.equal(hourlyRunningSameVersion([
    {id: 'job-a', status: 'running', workspaceId: 'local', input: {}},
  ], {id: 'job-b', workspaceId: 'local'}), true);
  assert.equal(hourlyRunningSameVersion([
    {id: 'job-a', status: 'running', workspaceId: 'local', input: {hourStart: 10}},
  ], {id: 'job-b', workspaceId: 'local'}), false);
  assert.equal(hourlyRunningSameVersion([
    {id: 'job-a', status: 'running', workspaceId: 'local', input: {}},
  ], {id: 'job-b', workspaceId: 'local', hourStart: 10}), false);
  assert.equal(hourlyRunningSameVersion([
    {id: 'job-a', status: 'running', workspaceId: 'local', input: {hourStart: 10}},
  ], {id: 'job-b', workspaceId: 'local', hourStart: 11}), false);
});

test('an open backfill hour does not skip the scheduled extract', async () => {
  const calls = [];
  const hour = 20 * H;
  const handlers = createReportJobHandlers({
    reportService: {generateDailyReport() {}},
    informationService: {async generateHourlyDigests(input) {
      calls.push(input.hourStart);
      return [{id: 'edition:1', status: 'ready', published: true, window: {startAt: hour, endAt: hour + H}, pendingIds: [], groupFailures: []}];
    }},
    treeService: {},
    env: {AI_CENTER_HOURLY_NO_CATCHUP: '0', AI_CENTER_HOURLY_SWEEP_HOURS: '0'},
  });
  const skipped = await handlers[REPORT_HOURLY_JOB_TYPE]({hourStart: hour, workspaceId: 'local'}, {
    job: {id: 'job-b'},
    store: {listOpenJobs: () => [{id: 'job-a', type: REPORT_HOURLY_JOB_TYPE, status: 'running', workspaceId: 'local', input: {hourStart: hour + H}}]},
  });
  assert.equal(skipped.reason, undefined);
  assert.deepEqual(calls, [hour]);
  const same = await handlers[REPORT_HOURLY_JOB_TYPE]({hourStart: hour, workspaceId: 'local'}, {
    job: {id: 'job-c'},
    store: {listOpenJobs: () => [{id: 'job-a', type: REPORT_HOURLY_JOB_TYPE, status: 'running', workspaceId: 'local', input: {hourStart: hour}}]},
  });
  assert.equal(same.reason, 'already-running');
  assert.deepEqual(calls, [hour]);
});

test('no-catchup scheduled extract asks only for the latest ended hour', async () => {
  const seen = [];
  const handlersFor = (env) => createReportJobHandlers({
    reportService: {generateDailyReport() {}},
    informationService: {async generateHourlyDigests(input) {
      seen.push(input.hourStart);
      const hourStart = input.hourStart;
      return [{id: 'edition:1', status: 'ready', published: true, window: {startAt: hourStart, endAt: hourStart + H}, pendingIds: [], groupFailures: []}];
    }},
    treeService: {},
    env: {...env, AI_CENTER_HOURLY_SWEEP_HOURS: '0'},
  });
  await handlersFor({})[REPORT_HOURLY_JOB_TYPE]({}, {store: {listOpenJobs: () => []}});
  const latest = Math.floor(Date.now() / H) * H - H;
  assert.equal(seen[0], latest);
  seen.length = 0;
  await handlersFor({AI_CENTER_HOURLY_NO_CATCHUP: '0'})[REPORT_HOURLY_JOB_TYPE]({}, {store: {listOpenJobs: () => []}});
  assert.equal(seen[0], undefined);
});

test('category is written before the tree call and is not repeated when the tree throws', async () => {
  const order = [];
  const handlers = createReportJobHandlers({
    reportService: {generateDailyReport() {}},
    informationService: {async generateHourlyDigests() { order.push('tree'); throw new Error('tree down'); }},
    treeService: {},
    hourlyCategory: {async generateHour(input) { order.push(`category:${input.hourStart}`); return {id: 'hcat', status: 'ready'}; }},
    env: {AI_CENTER_HOURLY_CATEGORY: '1'},
  });
  await assert.rejects(handlers[REPORT_HOURLY_JOB_TYPE]({hourStart: 20 * H, workspaceId: 'local'}, {}), /tree down/);
  assert.deepEqual(order, [`category:${20 * H}`, 'tree']);
});

test('an aborted extract does not start another model call or follow-up', async () => {
  const calls = [];
  const jobs = [];
  const handlers = createReportJobHandlers({
    reportService: {generateDailyReport() {}},
    informationService: {async generateHourlyDigests() { calls.push('tree'); return []; }},
    treeService: {},
    hourlyCategory: {async generateHour() { calls.push('category'); return {id: 'hcat', status: 'ready'}; }},
    env: {AI_CENTER_HOURLY_CATEGORY: '1'},
  });
  const signal = AbortSignal.abort();
  const result = await handlers[REPORT_HOURLY_JOB_TYPE]({hourStart: 20 * H, workspaceId: 'local'}, {
    signal,
    store: {
      listOpenJobs: () => jobs,
      createJob(input) { jobs.push(input); return input; },
    },
  });
  assert.equal(result.reason, 'aborted');
  assert.deepEqual(calls, []);
  assert.equal(jobs.length, 0);
});

test('a retryable failure stays failed while catch-up is off and still retries when catch-up is restored', async () => {
  const digest = {
    id: 'edition:failed', status: 'failed', terminal: false, published: false,
    window: {startAt: 20 * H, endAt: 21 * H}, pendingIds: [],
    groupFailures: [{id: 'tree-hourly:1', reason: 'retryable-model-error', retryable: true, tagId: 'macro'}],
  };
  const handlersFor = (env) => createReportJobHandlers({
    reportService: {generateDailyReport() {}},
    informationService: {async generateHourlyDigests() { return [digest]; }},
    treeService: {},
    env,
  });
  const run = async (env) => {
    const store = createStore(':memory:');
    try {
      const created = store.createJob({type: REPORT_HOURLY_JOB_TYPE, input: {hourStart: 20 * H}, maxAttempts: 2});
      const runner = createJobRunner({store, handlers: handlersFor(env), pollIntervalMs: 200});
      await runner.runOnce();
      return store.getJob(created.id);
    } finally {
      store.close();
    }
  };
  const stopped = await run({});
  assert.equal(stopped.status, 'failed');
  assert.equal(stopped.error.code, 'retryable-model-error');
  const retried = await run({AI_CENTER_HOURLY_NO_CATCHUP: '0'});
  assert.equal(retried.status, 'queued');
  assert.equal(retried.attemptCount, 1);
});

test('stale scheduled hours are cancelled and old foreground hours leave the latest lane', () => {
  const now = Date.UTC(2026, 9, 30, 12, 30);
  const latest = Math.floor(now / H) * H - H;
  const store = createStore(':memory:');
  try {
    const stale = store.createJob({
      type: REPORT_HOURLY_JOB_TYPE,
      workspaceId: 'local',
      priority: 0,
      input: {workspaceId: 'local', scheduleKey: 'report.hourly.default', scheduledFor: now - 2 * H},
    });
    const current = store.createJob({
      type: REPORT_HOURLY_JOB_TYPE,
      workspaceId: 'local',
      priority: 0,
      input: {workspaceId: 'local', scheduleKey: 'report.hourly.default', scheduledFor: now - 20 * 60_000},
    });
    const oldForeground = store.createJob({
      type: REPORT_HOURLY_JOB_TYPE,
      workspaceId: 'local',
      priority: 10,
      input: {workspaceId: 'local', hourStart: latest - 2 * H},
    });
    const latestHour = store.createJob({
      type: REPORT_HOURLY_JOB_TYPE,
      workspaceId: 'local',
      priority: 10,
      input: {workspaceId: 'local', hourStart: latest},
    });
    const retryLane = store.createJob({
      type: REPORT_HOURLY_JOB_TYPE,
      workspaceId: 'local',
      priority: -1,
      input: {workspaceId: 'local', hourStart: latest - 3 * H},
    });
    const released = releaseStaleHourlyQueue(store, now, {env: {}});
    assert.equal(released.cancelled, 1);
    assert.equal(released.demoted, 1);
    assert.equal(store.getJob(stale.id).status, 'cancelled');
    assert.equal(store.getJob(stale.id).output.reason, 'superseded-by-newer-hour');
    assert.equal(store.getJob(current.id).status, 'queued');
    assert.equal(store.getJob(oldForeground.id).priority, -5);
    assert.equal(store.getJob(latestHour.id).priority, 10);
    assert.equal(store.getJob(retryLane.id).priority, -1);
    assert.equal(store.claimNextJob('worker', [REPORT_HOURLY_JOB_TYPE], {minPriority: 0}).id, latestHour.id);
    assert.equal(store.listOpenJobs(REPORT_HOURLY_JOB_TYPE).some((job) => job.type === HOURLY_FAILURE_CATCHUP_JOB_TYPE), false);
    const again = releaseStaleHourlyQueue(store, now, {env: {}});
    assert.deepEqual(again, {cancelled: 0, demoted: 0});
  } finally {
    store.close();
  }
});

test('hourly lease refund stops at one extra attempt and an old hour drops off the foreground', () => {
  const hourStart = Math.floor(Date.now() / H) * H - 3 * H;
  const store = createStore(':memory:');
  try {
    const job = store.createJob({
      type: REPORT_HOURLY_JOB_TYPE,
      workspaceId: 'local',
      priority: 10,
      maxAttempts: 2,
      input: {workspaceId: 'local', hourStart},
    });
    const claimed = store.claimNextJob('worker-1', [REPORT_HOURLY_JOB_TYPE]);
    assert.equal(store.recoverStaleJobs(1, claimed.lockedAt + 5), 1);
    const once = store.getJob(job.id);
    assert.equal(once.status, 'queued');
    assert.equal(once.maxAttempts, 3);
    assert.equal(once.priority, -5);
    assert.equal(once.error.name, 'WorkerLeaseExpired');
    const again = store.claimNextJob('worker-2', [REPORT_HOURLY_JOB_TYPE]);
    assert.equal(store.recoverStaleJobs(1, again.lockedAt + 5), 1);
    const twice = store.getJob(job.id);
    assert.equal(twice.status, 'queued');
    assert.equal(twice.maxAttempts, 3);
    const third = store.claimNextJob('worker-3', [REPORT_HOURLY_JOB_TYPE]);
    assert.equal(third.attemptCount, 3);
    assert.equal(store.recoverStaleJobs(1, third.lockedAt + 5), 1);
    const closed = store.getJob(job.id);
    assert.equal(closed.status, 'failed');
    assert.equal(closed.error.name, 'WorkerLeaseExpired');
    assert.equal(closed.maxAttempts, 3);
    const newer = store.createJob({
      type: REPORT_HOURLY_JOB_TYPE,
      workspaceId: 'local',
      priority: 0,
      input: {workspaceId: 'local', hourStart: hourStart + 3 * H},
    });
    assert.equal(store.claimNextJob('worker-4', [REPORT_HOURLY_JOB_TYPE]).id, newer.id);
  } finally {
    store.close();
  }
});

test('a heartbeating hourly extract past its runtime is released and the next hour can be claimed', () => {
  const temporary = temporaryDatabase('ai-center-hourly-runtime-');
  const store = createStore(temporary.path);
  const side = new Database(temporary.path);
  const released = [];
  try {
    const stuck = store.createJob({type: REPORT_HOURLY_JOB_TYPE, input: {hourStart: 4 * H}, maxAttempts: 2});
    assert.equal(store.claimNextJob('worker-a', [REPORT_HOURLY_JOB_TYPE]).id, stuck.id);
    side.prepare('UPDATE job_attempts SET started_at = ? WHERE job_id = ?').run(Date.now() - 120_000, stuck.id);
    assert.equal(store.touchJob(stuck.id, 'worker-a'), true);
    assert.equal(store.recoverStaleJobs(10 * 60_000, Date.now(), {
      maxRunningMsByType: {[REPORT_HOURLY_JOB_TYPE]: 30_000},
      onRelease(info) { released.push(info); },
    }), 1);
    const failed = store.getJob(stuck.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error.name, 'WorkerRunTimeout');
    assert.equal(failed.maxAttempts, 2);
    assert.equal(released[0].errorName, 'WorkerRunTimeout');
    assert.equal(released[0].hourStart, 4 * H);
    const next = store.createJob({type: REPORT_HOURLY_JOB_TYPE, input: {hourStart: 5 * H}, maxAttempts: 1});
    assert.equal(store.claimNextJob('worker-b', [REPORT_HOURLY_JOB_TYPE]).id, next.id);
  } finally {
    side.close();
    store.close();
    temporary.remove();
  }
});

test('the job runner frees a timed-out hourly extract so the next one starts', async () => {
  const temporary = temporaryDatabase('ai-center-hourly-runner-');
  const store = createStore(temporary.path);
  const side = new Database(temporary.path);
  const started = [];
  const runner = createJobRunner({
    store,
    pollIntervalMs: 20,
    staleAfterMs: 60_000,
    recoverEveryMs: 30,
    maxRunningMsByType: {[REPORT_HOURLY_JOB_TYPE]: 1000},
    handlers: {
      [REPORT_HOURLY_JOB_TYPE]: (input) => {
        started.push(input.hourStart);
        if (input.hourStart === 1) return new Promise(() => {});
        return {hourStart: input.hourStart};
      },
    },
  });
  store.createJob({type: REPORT_HOURLY_JOB_TYPE, input: {hourStart: 1}, maxAttempts: 3});
  const running = runner.start();
  try {
    const claimed = Date.now() + 1000;
    while (!started.includes(1) && Date.now() < claimed) await wait(20);
    const stuck = store.listJobs(5).find((job) => job.input.hourStart === 1);
    side.prepare('UPDATE job_attempts SET started_at = ? WHERE job_id = ?').run(Date.now() - 5000, stuck.id);
    store.createJob({type: REPORT_HOURLY_JOB_TYPE, input: {hourStart: 2}, maxAttempts: 1});
    const continued = Date.now() + 2000;
    while (!started.includes(2) && Date.now() < continued) await wait(20);
    assert.deepEqual(started, [1, 2]);
    assert.equal(store.getJob(stuck.id).status, 'failed');
    assert.equal(store.getJob(stuck.id).error.name, 'WorkerRunTimeout');
  } finally {
    runner.stop();
    await running;
    side.close();
    store.close();
    temporary.remove();
  }
});

test('failure catch-up stays off and the clock-hour schedule stays on', () => {
  assert.equal(hourlyNoCatchup({}), true);
  assert.equal(hourlyNoCatchup({AI_CENTER_HOURLY_NO_CATCHUP: '0'}), false);
  const store = createStore(':memory:');
  try {
    const at = Date.UTC(2026, 9, 30, 12, 0);
    assert.equal(ensureHourlyFailureCatchupSchedule(store, at, {env: {}}).enabled, false);
    const hourly = ensureHourlyDigestSchedule(store, at, {minute: 0, env: {}});
    assert.equal(hourly.enabled, true);
    assert.equal(hourly.key, 'report.hourly.default');
    assert.equal(releaseStaleHourlyQueue(store, at, {env: {AI_CENTER_HOURLY_DISABLED: '1'}}).cancelled, 0);
  } finally {
    store.close();
  }
  const worker = readFileSync(new URL('../apps/worker/src/worker.js', import.meta.url), 'utf8');
  assert.match(worker, /releaseStaleHourlyQueue\(store, Date\.now\(\), \{env\}\)/);
  assert.match(worker, /schedule\.key === 'report\.hourly\.default'/);
  assert.match(worker, /AI_CENTER_HOURLY_NO_CATCHUP=0/);
});
