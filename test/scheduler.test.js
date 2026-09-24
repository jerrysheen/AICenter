import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { createStore } from '../packages/database/src/index.js';
import { resolveDueOccurrence } from '../packages/domain/src/schedule-clock.js';
import { resolveDailyWindow, resolveReportDate } from '../packages/domain/src/daily-window.js';
import { zonedLocalToUtc } from '../packages/domain/src/zoned-time.js';
import { createScheduler } from '../packages/runtime/src/scheduler.js';
import { createJobRunner } from '../packages/runtime/src/job-runner.js';

const SHANGHAI_EIGHT = Date.parse('2026-09-22T00:00:00.000Z');
const DAY_MS = 86_400_000;

function temporaryDatabase() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-schedule-'));
  return {
    path: path.join(directory, 'test.db'),
    remove: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function dailySchedule(nextRunAt, timezone = 'Asia/Shanghai') {
  return {
    workspaceId: 'local',
    key: 'report.daily.default',
    jobType: 'report.daily.generate',
    enabled: true,
    schedule: { kind: 'daily', timezone, hour: 8, minute: 0 },
    input: { timezone, cutoffHour: 8, cutoffMinute: 0 },
    nextRunAt,
    maxAttempts: 2,
  };
}

test('daily window is half-open and follows the configured timezone', () => {
  const shanghai = resolveDailyWindow({
    reportDate: '2026-09-22',
    timezone: 'Asia/Shanghai',
    cutoffHour: 8,
    cutoffMinute: 0,
  });
  assert.equal(shanghai.startAt, Date.parse('2026-09-21T00:00:00.000Z'));
  assert.equal(shanghai.endAt, SHANGHAI_EIGHT);
  assert.equal(shanghai.endAt, zonedLocalToUtc(2026, 9, 22, 8, 0, 'Asia/Shanghai'));
  const utc = resolveDailyWindow({
    reportDate: '2026-09-22',
    timezone: 'UTC',
    cutoffHour: 8,
    cutoffMinute: 0,
  });
  assert.equal(utc.startAt, Date.parse('2026-09-21T08:00:00.000Z'));
  assert.equal(utc.endAt, Date.parse('2026-09-22T08:00:00.000Z'));
  assert.notEqual(shanghai.endAt, utc.endAt);
  assert.equal(resolveReportDate(SHANGHAI_EIGHT, {
    timezone: 'Asia/Shanghai', cutoffHour: 8, cutoffMinute: 0,
  }), '2026-09-22');
  assert.equal(resolveReportDate(SHANGHAI_EIGHT - 1, {
    timezone: 'Asia/Shanghai', cutoffHour: 8, cutoffMinute: 0,
  }), '2026-09-21');
});

test('daily schedule creates one job at 08:00 and the next day, not at 07:59 or 08:01', () => {
  const temporary = temporaryDatabase();
  const store = createStore(temporary.path);
  try {
    const schedule = store.upsertJobSchedule(dailySchedule(SHANGHAI_EIGHT));
    assert.equal(store.enqueueDueSchedule(schedule.id, SHANGHAI_EIGHT - 60_000), null);
    assert.equal(store.listJobs().length, 0);

    const created = store.enqueueDueSchedule(schedule.id, SHANGHAI_EIGHT);
    assert.ok(created);
    const job = store.getJob(created.jobId);
    assert.equal(job.type, 'report.daily.generate');
    assert.equal(job.input.scheduledFor, SHANGHAI_EIGHT);
    assert.equal(created.schedule.lastEnqueuedAt, SHANGHAI_EIGHT);
    assert.equal(created.schedule.nextRunAt, SHANGHAI_EIGHT + DAY_MS);
    assert.equal(store.enqueueDueSchedule(schedule.id, SHANGHAI_EIGHT + 60_000), null);
    assert.equal(store.listJobs().filter((item) => item.type === 'report.daily.generate').length, 1);

    const nextDay = store.enqueueDueSchedule(schedule.id, SHANGHAI_EIGHT + DAY_MS);
    assert.ok(nextDay);
    assert.equal(nextDay.schedule.lastEnqueuedAt, SHANGHAI_EIGHT + DAY_MS);
    assert.equal(nextDay.schedule.nextRunAt, SHANGHAI_EIGHT + 2 * DAY_MS);
    assert.equal(store.listJobs().filter((item) => item.type === 'report.daily.generate').length, 2);
  } finally {
    store.close();
    temporary.remove();
  }
});

test('interval schedule advances by its own step', () => {
  const start = 1_700_000_000_000;
  const occurrence = resolveDueOccurrence({
    nextRunAt: start,
    schedule: { kind: 'interval', intervalMinutes: 30 },
  }, start + 100 * 60_000);
  assert.equal(occurrence.scheduledFor, start + 90 * 60_000);
  assert.equal(occurrence.nextRunAt, start + 120 * 60_000);

  const temporary = temporaryDatabase();
  const store = createStore(temporary.path);
  try {
    const schedule = store.upsertJobSchedule({
      workspaceId: 'local',
      key: 'health.interval',
      jobType: 'system.healthcheck',
      schedule: { kind: 'interval', intervalMinutes: 30 },
      input: {},
      nextRunAt: start,
    });
    const first = store.enqueueDueSchedule(schedule.id, start);
    assert.equal(first.schedule.nextRunAt, start + 30 * 60_000);
    const second = store.enqueueDueSchedule(schedule.id, start + 30 * 60_000);
    assert.equal(second.schedule.lastEnqueuedAt, start + 30 * 60_000);
    assert.equal(second.schedule.nextRunAt, start + 60 * 60_000);
  } finally {
    store.close();
    temporary.remove();
  }
});

test('schedule state survives reopening the database', () => {
  const temporary = temporaryDatabase();
  const store = createStore(temporary.path);
  const schedule = store.upsertJobSchedule(dailySchedule(SHANGHAI_EIGHT));
  store.enqueueDueSchedule(schedule.id, SHANGHAI_EIGHT);
  store.close();
  const reopened = createStore(temporary.path);
  try {
    const saved = reopened.getJobSchedule('local', 'report.daily.default');
    assert.equal(saved.lastEnqueuedAt, SHANGHAI_EIGHT);
    assert.equal(saved.nextRunAt, SHANGHAI_EIGHT + DAY_MS);
    assert.equal(reopened.listJobs().length, 1);
  } finally {
    reopened.close();
    temporary.remove();
  }
});

test('catch-up after three missed days enqueues only the latest slot', () => {
  const first = Date.parse('2026-09-19T00:00:00.000Z');
  const restartedAt = Date.parse('2026-09-22T02:00:00.000Z');
  const temporary = temporaryDatabase();
  const store = createStore(temporary.path);
  try {
    const schedule = store.upsertJobSchedule(dailySchedule(first));
    const created = store.enqueueDueSchedule(schedule.id, restartedAt);
    assert.equal(store.listJobs().length, 1);
    assert.equal(created.schedule.lastEnqueuedAt, Date.parse('2026-09-22T00:00:00.000Z'));
    assert.equal(created.schedule.nextRunAt, Date.parse('2026-09-23T00:00:00.000Z'));
    assert.equal(store.getJob(created.jobId).input.scheduledFor, Date.parse('2026-09-22T00:00:00.000Z'));
  } finally {
    store.close();
    temporary.remove();
  }
});

test('two schedulers scanning one database create one job', async () => {
  const temporary = temporaryDatabase();
  const store = createStore(temporary.path);
  const schedule = store.upsertJobSchedule(dailySchedule(SHANGHAI_EIGHT));
  const workerUrl = new URL('./support/enqueue-schedule-worker.mjs', import.meta.url);
  const run = () => new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, {
      workerData: { databasePath: temporary.path, scheduleId: schedule.id, now: SHANGHAI_EIGHT },
    });
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  try {
    const results = await Promise.all([run(), run()]);
    assert.equal(results.filter((result) => result.error).length, 0);
    assert.equal(results.filter((result) => result.created).length, 1);
    assert.equal(store.listJobs().length, 1);
  } finally {
    store.close();
    temporary.remove();
  }
});

test('scheduler only enqueues registered job types and the runner executes that job', async () => {
  const temporary = temporaryDatabase();
  const store = createStore(temporary.path);
  const seen = [];
  try {
    store.upsertJobSchedule({
      ...dailySchedule(SHANGHAI_EIGHT),
      key: 'shell.blocked',
      jobType: 'system.healthcheck',
    });
    const scheduler = createScheduler({
      store,
      allowedJobTypes: ['report.daily.generate'],
      now: () => SHANGHAI_EIGHT,
    });
    assert.deepEqual(await scheduler.tick(), []);
    assert.equal(store.listJobs().length, 0);

    store.upsertJobSchedule(dailySchedule(SHANGHAI_EIGHT));
    const allowed = createScheduler({
      store,
      allowedJobTypes: ['report.daily.generate'],
      now: () => SHANGHAI_EIGHT,
    });
    const created = await allowed.tick();
    assert.equal(created.length, 1);
    const runner = createJobRunner({
      store,
      handlers: {
        'report.daily.generate': async (input) => {
          seen.push(input.scheduledFor);
          return { ok: true };
        },
      },
    });
    const completed = await runner.runOnce();
    assert.equal(completed.status, 'completed');
    assert.deepEqual(seen, [SHANGHAI_EIGHT]);
  } finally {
    store.close();
    temporary.remove();
  }
});

test('utc and shanghai daily slots are different instants', () => {
  const shanghai = resolveDueOccurrence({
    nextRunAt: SHANGHAI_EIGHT,
    schedule: { kind: 'daily', timezone: 'Asia/Shanghai', hour: 8, minute: 0 },
  }, SHANGHAI_EIGHT);
  const utc = resolveDueOccurrence({
    nextRunAt: Date.parse('2026-09-22T08:00:00.000Z'),
    schedule: { kind: 'daily', timezone: 'UTC', hour: 8, minute: 0 },
  }, Date.parse('2026-09-22T08:00:00.000Z'));
  assert.equal(shanghai.scheduledFor, Date.parse('2026-09-22T00:00:00.000Z'));
  assert.equal(utc.scheduledFor, Date.parse('2026-09-22T08:00:00.000Z'));
  assert.equal(shanghai.nextRunAt, Date.parse('2026-09-23T00:00:00.000Z'));
  assert.equal(utc.nextRunAt, Date.parse('2026-09-23T08:00:00.000Z'));
});
