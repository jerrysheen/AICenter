import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../packages/database/src/index.js';
import { materialHash, materialHashYielding } from '../packages/domain/src/daily-materials.js';
import { createJobRunner } from '../packages/runtime/src/job-runner.js';
import { mainThreadWatchdogEnabled, startMainThreadWatchdog } from '../packages/runtime/src/main-thread-watchdog.js';
import { stampWorkerLogLine } from '../packages/runtime/src/worker-log.js';

test('yielding material hash matches the synchronous digest', async () => {
  const value = { title: '小时报', body: '甲'.repeat(40_000) };
  assert.equal(await materialHashYielding(value), materialHash(value));
  assert.equal(await materialHashYielding('short'), materialHash('short'));
});

test('worker log lines carry a timestamp and the running job id', () => {
  const at = new Date('2026-10-20T00:00:00.000Z');
  assert.equal(stampWorkerLogLine('claim failed\n', { at, jobId: 'job-1' }), '[worker] 2026-10-20T00:00:00.000Z job=job-1 claim failed\n');
  assert.equal(stampWorkerLogLine('idle', { at }), '[worker] 2026-10-20T00:00:00.000Z idle');
});

test('main thread watchdog stays off unless the env switch is 1', () => {
  assert.equal(mainThreadWatchdogEnabled({}), false);
  assert.equal(mainThreadWatchdogEnabled({ AI_CENTER_MAIN_THREAD_WATCHDOG: '0' }), false);
  assert.equal(mainThreadWatchdogEnabled({ AI_CENTER_MAIN_THREAD_WATCHDOG: '1' }), true);
  startMainThreadWatchdog({ enabled: false }).stop();
});

test('main thread watchdog records the stall time and running tasks', async () => {
  const lines = [];
  const watchdog = startMainThreadWatchdog({
    enabled: true,
    intervalMs: 30,
    blockMs: 120,
    tasks: () => [{ type: 'report.hourly.extract', id: 'hour-1' }],
    log: (line) => lines.push(line),
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    const until = Date.now() + 400;
    while (Date.now() < until) { /* block the event loop */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(lines.some((line) => /loop-blocked lagMs=\d+ tasks=report\.hourly\.extract:hour-1/.test(line)), lines.join('\n'));
  } finally {
    watchdog.stop();
  }
});

test('claim respects a priority ceiling', () => {
  const store = createStore(':memory:');
  try {
    store.createJob({ type: 'report.hourly.extract', workspaceId: 'local', priority: 10, input: { hourStart: 2 } });
    store.createJob({ type: 'report.hourly.extract', workspaceId: 'local', priority: -5, input: { hourStart: 1 } });
    assert.equal(store.claimNextJob('worker', ['report.hourly.extract'], { minPriority: 0 }).priority, 10);
    assert.equal(store.claimNextJob('worker', ['report.hourly.extract'], { maxPriority: -1 }).priority, -5);
    assert.equal(store.claimNextJob('worker', ['report.hourly.extract'], { maxPriority: -1 }), null);
  } finally {
    store.close();
  }
});

test('latest hour uses the foreground slot and catch-up uses another', async () => {
  const claims = [];
  const queued = [
    { id: 'old', type: 'report.hourly.extract', priority: -5, input: {} },
    { id: 'snap', type: 'test.echo', priority: 100, input: {} },
    { id: 'new', type: 'report.hourly.extract', priority: 10, input: {} },
  ];
  const store = {
    recoverStaleJobs() {},
    touchJob() {},
    completeJob(id) { return { id, status: 'completed', output: {} }; },
    claimNextJob(_worker, types, options = {}) {
      const min = options.minPriority;
      const max = options.maxPriority;
      const index = queued.findIndex((job) => types.includes(job.type)
        && (min == null || job.priority >= min)
        && (max == null || job.priority <= max));
      const job = index < 0 ? null : queued.splice(index, 1)[0];
      claims.push({ types: [...types], min, max, id: job?.id || '' });
      if (!job) return null;
      return { ...job, workspaceId: 'local', attemptCount: 1 };
    },
  };
  const started = [];
  const runner = createJobRunner({
    store,
    workerId: 'lane-worker',
    handlers: {
      'report.hourly.extract': async (_input, context) => { started.push(context.job.id); return {}; },
      'test.echo': async () => { started.push('snap'); return {}; },
    },
    pollIntervalMs: 30,
    watchdogMs: 60_000,
  });
  const running = runner.start();
  await new Promise((resolve) => setTimeout(resolve, 80));
  runner.stop();
  await running;
  assert.equal(claims[0].types[0], 'report.hourly.extract');
  assert.equal(claims[0].min, 0);
  assert.equal(claims[0].id, 'new');
  assert.ok(claims.some((claim) => claim.max === -1 && claim.id === 'old'));
  assert.equal(started[0], 'new');
  assert.ok(started.includes('old'));
});

test('a due failed hour is claimed before other queued work', async () => {
  const claims = [];
  const queued = [
    { id: 'echo', type: 'test.echo', priority: 100, input: {} },
    { id: 'due', type: 'report.hourly.extract', priority: -1, input: { hourStart: 1 } },
    { id: 'new', type: 'report.hourly.extract', priority: 10, input: { hourStart: 2 } },
  ];
  const store = {
    recoverStaleJobs() {},
    touchJob() {},
    completeJob(id) { return { id, status: 'completed', output: {} }; },
    claimNextJob(_worker, types, options = {}) {
      const min = options.minPriority;
      const max = options.maxPriority;
      const index = queued.findIndex((job) => types.includes(job.type)
        && (min == null || job.priority >= min)
        && (max == null || job.priority <= max));
      const job = index < 0 ? null : queued.splice(index, 1)[0];
      claims.push({ types: [...types], min, max, id: job?.id || '' });
      if (!job) return null;
      return { ...job, workspaceId: 'local', attemptCount: 1 };
    },
  };
  const started = [];
  const runner = createJobRunner({
    store,
    workerId: 'due-hour-worker',
    handlers: {
      'report.hourly.extract': async (_input, context) => { started.push(context.job.id); return {}; },
      'test.echo': async () => { started.push('echo'); return {}; },
    },
    pollIntervalMs: 30,
    watchdogMs: 60_000,
  });
  const running = runner.start();
  await new Promise((resolve) => setTimeout(resolve, 80));
  runner.stop();
  await running;
  const dueAt = claims.findIndex((claim) => claim.id === 'due');
  const echoAt = claims.findIndex((claim) => claim.id === 'echo');
  assert.ok(dueAt >= 0);
  assert.equal(claims[dueAt].min, -1);
  assert.equal(claims[dueAt].max, -1);
  assert.ok(echoAt === -1 || dueAt < echoAt);
  assert.ok(started.includes('due'));
  assert.equal(started[0], 'new');
});
