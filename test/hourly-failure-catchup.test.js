import test from 'node:test';
import assert from 'node:assert/strict';
import {createStore} from '../packages/database/src/index.js';
import {
  attemptRetryDue,
  dueFailedHourCatchupPlan,
  enqueueDueFailedHourRefreshes,
  hourHasNewMaterial,
} from '../packages/runtime/src/information-tree-module.js';
import {
  createReportJobHandlers,
  ensureHourlyFailureCatchupSchedule,
  HOURLY_FAILURE_CATCHUP_JOB_TYPE,
  hourlyFailureCatchupLimit,
  hourlyFailureCatchupMinutes,
} from '../packages/runtime/src/report-module.js';

const H = 3600000;
const at = Date.UTC(2026, 9, 21, 6, 20);
const latest = Math.floor(at / H) * H - H;
const disabled = {AI_CENTER_HOURLY_DISABLED: '1'};

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
  assert.deepEqual(second, [{hourStart: latest, priority: 0}]);
  assert.deepEqual(dueFailedHourCatchupPlan({at, rows, openHourStarts: new Set([...open, latest]), limit: 2}), []);
});

test('the scheduled check requeues still-failed hours without new material and does not repeat them', () => {
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
    const jobs = enqueueDueFailedHourRefreshes(store, service, 'local', at, {limit: 2});
    assert.deepEqual(jobs.map((job) => job.input.hourStart), [h10, h11]);
    assert.deepEqual(jobs.map((job) => job.priority), [-1, -1]);
    assert.equal(jobs[0].availableAt, at);
    const again = enqueueDueFailedHourRefreshes(store, service, 'local', at, {limit: 2});
    assert.deepEqual(again.map((job) => job.input.hourStart), [latest]);
    assert.equal(again[0].priority, 0);
    assert.equal(enqueueDueFailedHourRefreshes(store, service, 'local', at, {limit: 2}).length, 0);
    assert.equal(store.listOpenJobs('report.hourly.extract').length, 3);
  } finally {
    store.close();
  }
});

test('failure catch-up schedule scans on an interval and the handler enqueues the due hours', async () => {
  const empty = createStore(':memory:');
  try {
    assert.equal(ensureHourlyFailureCatchupSchedule(empty, at, {env: disabled}), null);
  } finally { empty.close(); }
  const store = createStore(':memory:');
  try {
    const created = ensureHourlyFailureCatchupSchedule(store, at, {});
    assert.equal(created.jobType, HOURLY_FAILURE_CATCHUP_JOB_TYPE);
    assert.equal(created.schedule.intervalMinutes, 10);
    assert.equal(created.nextRunAt, at);
    const kept = ensureHourlyFailureCatchupSchedule(store, at + 5 * 60_000, {});
    assert.equal(kept.nextRunAt, at);
    const now = Date.now();
    const ended = Math.floor(now / H) * H - H;
    const h10 = ended - 2 * H;
    const h11 = ended - H;
    const information = [node(h10), node(h11)];
    const handlers = createReportJobHandlers({
      reportService: {generateDailyReport() {}},
      informationService: {
        list() {
          return {
            hours: [h10, h11].map((hour) => ({attempt: failed(hour, now - 1000), edition: null})),
            information,
          };
        },
        node(_workspace, id) { return information.find((item) => item.id === id) || null; },
      },
    });
    const result = await handlers[HOURLY_FAILURE_CATCHUP_JOB_TYPE]({}, {store});
    assert.equal(result.status, 'catchup');
    assert.deepEqual(result.hours, [h10, h11]);
    assert.equal(store.listOpenJobs('report.hourly.extract').length, 2);
  } finally {
    store.close();
  }
});
