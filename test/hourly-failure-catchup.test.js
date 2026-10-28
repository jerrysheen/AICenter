import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createStore} from '../packages/database/src/index.js';
import {
  attemptRetryDue,
  dueFailedHourCatchupPlan,
  enqueueDueFailedHourRefreshes,
  hourHasNewMaterial,
  hourlyRetryLaneHourStarts,
} from '../packages/runtime/src/information-tree-module.js';
import {
  allowHourlyScheduleEnqueue,
  createReportJobHandlers,
  ensureHourlyDigestSchedule,
  ensureHourlyFailureCatchupSchedule,
  HOURLY_FAILURE_CATCHUP_JOB_TYPE,
  hourlyFailureCatchupLimit,
  hourlyFailureCatchupMinutes,
  hourlyNoCatchup,
  REPORT_HOURLY_JOB_TYPE,
} from '../packages/runtime/src/report-module.js';

const H = 3600000;
const at = Date.UTC(2026, 9, 21, 6, 20);
const latest = Math.floor(at / H) * H - H;
const disabled = {AI_CENTER_HOURLY_DISABLED: '1'};
const catchupOn = {AI_CENTER_HOURLY_NO_CATCHUP: '0'};

function failed(hour, retryAt = at - 1000, inputIds = [`node-${hour}`]) {
  return {
    status: 'failed',
    terminal: false,
    window: {startAt: hour, endAt: hour + H},
    inputIds,
    groupFailures: [{id: 'g', reason: 'budget-deferred', retryable: true, retryAt}],
    pending: [],
  };
}

function node(hour, id = `node-${hour}`) {
  return {id, sourceId: `src-${hour}`, sourceVersion: 'v1', window: {startAt: hour, endAt: hour + H}};
}

test('failure catch-up limits and interval stay inside their ranges', () => {
  assert.equal(hourlyFailureCatchupMinutes({}), 10);
  assert.equal(hourlyFailureCatchupMinutes({AI_CENTER_HOURLY_FAILURE_CATCHUP_MINUTES: '15'}), 15);
  assert.equal(hourlyFailureCatchupMinutes({AI_CENTER_HOURLY_FAILURE_CATCHUP_MINUTES: '1'}), 10);
  assert.equal(hourlyFailureCatchupLimit({}), 2);
  assert.equal(hourlyFailureCatchupLimit({AI_CENTER_HOURLY_FAILURE_CATCHUP_LIMIT: '4'}), 4);
  assert.equal(hourlyFailureCatchupLimit({AI_CENTER_HOURLY_FAILURE_CATCHUP_LIMIT: '0'}), 2);
});

test('a failed hour is due only when its saved retry time has arrived', () => {
  assert.equal(attemptRetryDue(failed(latest, at - 1), at), true);
  assert.equal(attemptRetryDue(failed(latest, at + 60_000), at), false);
  assert.equal(attemptRetryDue({...failed(latest), terminal: true, groupFailures: [{retryable: false, retryAt: null}]}, at), false);
  assert.equal(attemptRetryDue({...failed(latest), status: 'partial'}, at), false);
  assert.equal(attemptRetryDue({...failed(latest), status: 'ready'}, at), false);
  assert.equal(hourHasNewMaterial(failed(latest), [node(latest)]), false);
  assert.equal(hourHasNewMaterial(failed(latest), [node(latest), node(latest, 'extra')]), true);
  assert.equal(hourHasNewMaterial(failed(latest), []), false);
});

test('older failed hours fill the cap before the current hour', () => {
  const h10 = latest - 3 * H;
  const h11 = latest - 2 * H;
  const h12 = latest - H;
  const rows = [
    {hourStart: latest, attempt: failed(latest), hasNewMaterial: false},
    {hourStart: h12, attempt: failed(h12), hasNewMaterial: true},
    {hourStart: h11, attempt: failed(h11, at + 60_000), hasNewMaterial: false},
    {hourStart: h10, attempt: failed(h10), hasNewMaterial: false},
    {hourStart: latest - 4 * H, attempt: failed(latest - 4 * H), hasNewMaterial: false},
  ];
  const first = dueFailedHourCatchupPlan({at, rows, limit: 2});
  assert.deepEqual(first.map((item) => item.hourStart), [latest - 4 * H, h10]);
  assert.deepEqual(first.map((item) => item.priority), [-1, -1]);
  const open = new Set(first.map((item) => item.hourStart));
  const second = dueFailedHourCatchupPlan({at, rows, openHourStarts: open, limit: 2});
  assert.deepEqual(second, [{hourStart: h12, priority: -1}, {hourStart: latest, priority: 0}]);
  assert.deepEqual(dueFailedHourCatchupPlan({at, rows, openHourStarts: new Set([...open, h12, latest]), limit: 2}), []);
});

test('hours with no saved head fill the slots left after due failures', () => {
  const gap = latest - 23 * H;
  const due = latest - 2 * H;
  assert.deepEqual(dueFailedHourCatchupPlan({
    at,
    rows: [
      {hourStart: due, attempt: failed(due)},
      {hourStart: gap, missing: true},
      {hourStart: latest, missing: true},
    ],
    limit: 2,
  }), [{hourStart: due, priority: -1}, {hourStart: gap, priority: -1}]);
  assert.deepEqual(dueFailedHourCatchupPlan({
    at,
    rows: [{hourStart: gap, missing: true}, {hourStart: latest, missing: true}],
    limit: 2,
  }), [{hourStart: gap, priority: -1}, {hourStart: latest, priority: 0}]);
  const ready = latest - H;
  const service = {
    list() {
      return {hours: [{edition: {status: 'ready', window: {startAt: ready, endAt: ready + H}}, attempt: null}]};
    },
  };
  const store = createStore(':memory:');
  try {
    const jobs = enqueueDueFailedHourRefreshes(store, service, 'local', at, {limit: 2, env: catchupOn});
    assert.equal(jobs.some((job) => job.input.hourStart === ready), false);
    assert.deepEqual(jobs.map((job) => job.input.hourStart), [gap, gap + H]);
  } finally {
    store.close();
  }
});

test('a due failed hour is still selected when the attempt missed a node', () => {
  const hour = latest - 2 * H;
  assert.deepEqual(dueFailedHourCatchupPlan({
    at,
    rows: [{hourStart: hour, attempt: failed(hour), hasNewMaterial: true}],
    limit: 2,
  }), [{hourStart: hour, priority: -1}]);
});

test('the scheduled check requeues a due failure even when a newer node is uncovered', () => {
  const h10 = latest - 3 * H;
  const h11 = latest - 2 * H;
  const fresh = latest - H;
  const hours = [h10, h11, fresh, latest];
  const information = [
    node(h10),
    node(h11),
    node(fresh),
    {...node(fresh, 'fresh-node'), sourceId: 'src-fresh-new', sourceVersion: 'v2'},
    node(latest),
  ];
  const service = {
    list() {
      return {
        hours: hours.map((hour) => ({attempt: failed(hour), edition: null})),
        information,
      };
    },
    node(_workspace, id) {
      return information.find((item) => item.id === id) || null;
    },
  };
  const store = createStore(':memory:');
  try {
    assert.deepEqual(enqueueDueFailedHourRefreshes(store, service, 'local', at, {env: disabled}), []);
    const jobs = enqueueDueFailedHourRefreshes(store, service, 'local', at, {limit: 2, env: catchupOn});
    assert.deepEqual(jobs.map((job) => job.input.hourStart), [h10, h11]);
    assert.deepEqual(jobs.map((job) => job.priority), [-1, -1]);
    assert.equal(jobs[0].availableAt, at);
    const again = enqueueDueFailedHourRefreshes(store, service, 'local', at, {limit: 2, env: catchupOn});
    assert.deepEqual(again.map((job) => job.input.hourStart), [fresh, latest]);
    assert.deepEqual(again.map((job) => job.priority), [-1, 0]);
    const holes = enqueueDueFailedHourRefreshes(store, service, 'local', at, {limit: 2, env: catchupOn});
    assert.deepEqual(holes.map((job) => job.input.hourStart), [latest - 23 * H, latest - 22 * H]);
    assert.deepEqual(holes.map((job) => job.priority), [-1, -1]);
    assert.equal(store.listOpenJobs('report.hourly.extract').length, 6);
  } finally {
    store.close();
  }
});

test('a due failed hour parked below the retry lane is promoted instead of left queued', () => {
  const hour = latest - 3 * H;
  const service = {
    list() {
      return {hours: [{attempt: failed(hour), edition: null}], information: [node(hour)]};
    },
  };
  const store = createStore(':memory:');
  try {
    const parked = store.createJob({
      type: 'report.hourly.extract',
      workspaceId: 'local',
      priority: -5,
      maxAttempts: 2,
      availableAt: at + 30 * 60_000,
      input: {workspaceId: 'local', hourStart: hour},
    });
    const running = {
      status: 'running',
      priority: -5,
      input: {hourStart: hour + H},
    };
    assert.deepEqual([...hourlyRetryLaneHourStarts([parked, running])], [hour + H]);
    const jobs = enqueueDueFailedHourRefreshes(store, service, 'local', at, {limit: 2, env: catchupOn});
    assert.equal(jobs[0].id, parked.id);
    assert.equal(jobs[0].priority, -1);
    assert.equal(jobs[0].availableAt, at);
    assert.equal(jobs.length, 2);
    assert.equal(jobs[1].input.hourStart, latest - 23 * H);
    assert.equal(jobs[1].priority, -1);
    const open = store.listOpenJobs('report.hourly.extract');
    assert.equal(open.length, 2);
    assert.equal(open.find((job) => job.id === parked.id).priority, -1);
    assert.equal(open.find((job) => job.id === parked.id).availableAt, at);
    const next = enqueueDueFailedHourRefreshes(store, service, 'local', at, {limit: 2, env: catchupOn});
    assert.deepEqual(next.map((job) => job.input.hourStart), [latest - 22 * H, latest - 21 * H]);
    assert.deepEqual(next.map((job) => job.priority), [-1, -1]);
  } finally {
    store.close();
  }
});

test('failure catch-up stays off unless AI_CENTER_HOURLY_NO_CATCHUP=0', async () => {
  assert.equal(hourlyNoCatchup({}), true);
  assert.equal(hourlyNoCatchup({AI_CENTER_HOURLY_NO_CATCHUP: ''}), true);
  assert.equal(hourlyNoCatchup({AI_CENTER_HOURLY_NO_CATCHUP: '1'}), true);
  assert.equal(hourlyNoCatchup({AI_CENTER_HOURLY_NO_CATCHUP: '0'}), false);
  assert.equal(allowHourlyScheduleEnqueue({jobType: HOURLY_FAILURE_CATCHUP_JOB_TYPE}, {}), false);
  assert.equal(allowHourlyScheduleEnqueue({jobType: REPORT_HOURLY_JOB_TYPE}, {}), true);
  assert.equal(allowHourlyScheduleEnqueue({jobType: HOURLY_FAILURE_CATCHUP_JOB_TYPE}, catchupOn), true);
  const worker = readFileSync(new URL('../apps/worker/src/worker.js', import.meta.url), 'utf8');
  assert.match(worker, /AI_CENTER_HOURLY_NO_CATCHUP=0/);
  assert.match(worker, /ensureHourlyDigestSchedule\(store,Date\.now\(\),\{minute:articleStrategy \? 30 : 0,env\}\)/);
  assert.match(worker, /ensureHourlyFailureCatchupSchedule\(store, Date\.now\(\), \{env\}\)/);

  const empty = createStore(':memory:');
  try {
    assert.equal(ensureHourlyFailureCatchupSchedule(empty, at, {env: disabled}), null);
  } finally { empty.close(); }

  const store = createStore(':memory:');
  try {
    const created = ensureHourlyFailureCatchupSchedule(store, at, {env: {}});
    assert.equal(created.enabled, false);
    assert.equal(created.jobType, HOURLY_FAILURE_CATCHUP_JOB_TYPE);
    assert.equal(created.schedule.intervalMinutes, 10);
    const hourly = ensureHourlyDigestSchedule(store, at, {minute: 0, env: {}});
    assert.equal(hourly.enabled, true);
    assert.equal(hourly.key, 'report.hourly.default');
    const now = Date.now();
    const ended = Math.floor(now / H) * H - H;
    const h10 = ended - 2 * H;
    const h11 = ended - H;
    const information = [node(h10), node(h11)];
    const informationService = {
      list() {
        return {
          hours: [h10, h11].map((hour) => ({attempt: failed(hour, now - 1000), edition: null})),
          information,
        };
      },
      node(_workspace, id) { return information.find((item) => item.id === id) || null; },
    };
    assert.deepEqual(enqueueDueFailedHourRefreshes(store, informationService, 'local', now, {limit: 2, env: {}}), []);
    const blocked = createReportJobHandlers({
      reportService: {generateDailyReport() {}},
      informationService,
      env: {},
    });
    const skipped = await blocked[HOURLY_FAILURE_CATCHUP_JOB_TYPE]({}, {store});
    assert.equal(skipped.status, 'skipped');
    assert.equal(skipped.reason, 'no-catchup');
    assert.equal(skipped.enqueued, 0);
    assert.equal(store.listOpenJobs('report.hourly.extract').length, 0);

    const restored = ensureHourlyFailureCatchupSchedule(store, at, {env: catchupOn});
    assert.equal(restored.enabled, true);
    assert.equal(restored.nextRunAt, at);
    const kept = ensureHourlyFailureCatchupSchedule(store, at + 5 * 60_000, {env: catchupOn});
    assert.equal(kept.enabled, true);
    assert.equal(kept.nextRunAt, at);
    const handlers = createReportJobHandlers({
      reportService: {generateDailyReport() {}},
      informationService,
      env: catchupOn,
    });
    const result = await handlers[HOURLY_FAILURE_CATCHUP_JOB_TYPE]({}, {store});
    assert.equal(result.status, 'catchup');
    assert.deepEqual(result.hours, [h10, h11]);
    assert.equal(store.listOpenJobs('report.hourly.extract').length, 2);
    const turnedOff = ensureHourlyFailureCatchupSchedule(store, at + 6 * 60_000, {env: {}});
    assert.equal(turnedOff.enabled, false);
    assert.equal(turnedOff.nextRunAt, at);
  } finally {
    store.close();
  }
});

test('a retryable failed hour does not enqueue a reading-class follow-up while catch-up is off', async () => {
  const hour = 22 * H;
  const jobs = [];
  const store = {
    listOpenJobs() { return jobs.filter((job) => job.status === 'queued'); },
    createJob(input) {
      const job = {id: `job-${jobs.length}`, status: 'queued', type: input.type, workspaceId: input.workspaceId, input: input.input, availableAt: input.availableAt};
      jobs.push(job);
      return job;
    },
  };
  const digest = {
    id: 'edition:failed', status: 'failed', terminal: false, published: false,
    window: {startAt: hour, endAt: hour + H}, pendingIds: ['pending-1'],
    pending: [{id: 'pending-1', reason: 'information-not-ready', retryable: false}],
    groupFailures: [{id: 'g', reason: 'budget-deferred', retryable: true, retryAt: hour}],
  };
  const handlersFor = (env) => createReportJobHandlers({
    reportService: {generateDailyReport() {}},
    informationService: {async generateHourlyDigests() { return [digest]; }},
    treeService: {},
    readingHour: {enabled: true, async scoreWindow() {
      return {readingErrors: [], snapshot: {items: [{disposition: 'classification-failed'}]}};
    }},
    env,
  });
  await assert.rejects(handlersFor({})['report.hourly.extract']({hourStart: hour}, {store}), {message: '小时浓缩临时失败；成功分类及检查点已保留'});
  assert.equal(jobs.filter((job) => job.input?.followUp).length, 0);
  assert.equal(jobs.some((job) => job.type === 'report.information.prepare'), true);
  jobs.length = 0;
  await assert.rejects(handlersFor(catchupOn)['report.hourly.extract']({hourStart: hour}, {store}), {message: '小时浓缩临时失败；成功分类及检查点已保留'});
  assert.equal(jobs.filter((job) => job.input?.followUp === 'classification-deferred').length, 1);
});
