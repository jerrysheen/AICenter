import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os, { hostname } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createStore } from '../packages/database/src/index.js';
import { createJobRunner, deadLocalWorkerLock, formatStartupStep, wait } from '../packages/runtime/src/job-runner.js';
import { createAiCenterWorker } from '../apps/worker/src/worker.js';
import { http2StreamErrorSinkInstalled } from '../packages/connectors/src/http2-stream-error-sink.js';

function removeTemporaryDirectory(directory) {
  rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function temporaryDatabase(prefix) {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    directory,
    path: path.join(directory, 'test.db'),
    remove: () => removeTemporaryDirectory(directory),
  };
}

async function releaseWorkerHarness(resources, removeDirectory = removeTemporaryDirectory) {
  const errors = [];
  const run = async (fn) => {
    if (typeof fn !== 'function') return;
    try {
      await fn();
    } catch (error) {
      errors.push(error);
    }
  };
  await run(resources.restore);
  await run(() => resources.worker?.runner?.stop?.());
  await run(() => resources.worker?.scheduler?.stop?.());
  await run(() => resources.worker?.close?.());
  await run(() => resources.store?.close?.());
  if (resources.directory) await run(() => removeDirectory(resources.directory));
  return errors[0] || null;
}

function insertJob(database, row) {
  database.prepare(`INSERT INTO jobs (
    id, workspace_id, type, status, input_json, priority, attempt_count, max_attempts,
    available_at, locked_by, locked_at, created_at, updated_at
  ) VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.id,
    row.type,
    row.status,
    row.input || '{}',
    row.priority || 0,
    row.attemptCount || 0,
    row.maxAttempts || 3,
    row.availableAt || 0,
    row.lockedBy || null,
    row.lockedAt || null,
    row.createdAt,
    row.createdAt,
  );
}

test('startup step log names the step and the elapsed milliseconds', () => {
  assert.equal(formatStartupStep('runner-ready', 12.4), '[worker] startup runner-ready 12ms');
  assert.equal(formatStartupStep('first-claim', 0), '[worker] startup first-claim 0ms');
});

test('a dead local worker lock is taken over and a live one is kept', () => {
  const host = hostname();
  assert.equal(deadLocalWorkerLock(`${host}-${process.pid}`), false);
  assert.equal(deadLocalWorkerLock(`${host}-2147483646`, { isAlive: () => false }), true);
  assert.equal(deadLocalWorkerLock(`${host}-2147483646`, { isAlive: () => true }), false);
  assert.equal(deadLocalWorkerLock('other-host-2147483646', { isAlive: () => false }), false);
  assert.equal(deadLocalWorkerLock('worker-1', { isAlive: () => false }), false);
});

test('open jobs stay on the status index and skip completed history', () => {
  const temporary = temporaryDatabase('ai-center-open-jobs-');
  const store = createStore(temporary.path);
  const database = new Database(temporary.path);
  try {
    const blob = JSON.stringify({ items: [{ id: 'history', text: 'x'.repeat(3000) }] });
    const now = Date.now();
    const insert = database.prepare(`INSERT INTO jobs (
      id, workspace_id, type, status, input_json, priority, attempt_count, max_attempts,
      available_at, created_at, updated_at
    ) VALUES (?, 'local', 'feed.translation.run', 'completed', ?, 0, 1, 4, 0, ?, ?)`);
    const write = database.transaction((count) => {
      for (let index = 0; index < count; index += 1) insert.run(`done-${index}`, blob, now + index, now + index);
    });
    write(4000);
    insertJob(database, {
      id: 'queued-open', type: 'feed.translation.run', status: 'queued', input: '{"items":[]}',
      createdAt: now + 5000,
    });
    insertJob(database, {
      id: 'running-open', type: 'feed.translation.run', status: 'running', input: '{"items":[]}',
      lockedBy: 'old-worker', lockedAt: now, createdAt: now + 4000,
    });
    insertJob(database, {
      id: 'other-type', type: 'system.healthcheck', status: 'queued', createdAt: now + 3000,
    });
    const plan = database.prepare(`EXPLAIN QUERY PLAN SELECT * FROM jobs INDEXED BY idx_jobs_claim
      WHERE status = ? AND type = ?
      ORDER BY created_at ASC, id ASC`).all('queued', 'feed.translation.run')
      .map((row) => row.detail).join(' ');
    assert.match(plan, /idx_jobs_claim/);
    assert.equal(plan.includes('idx_jobs_type_created'), false);
    const started = Date.now();
    const open = store.listOpenJobs('feed.translation.run');
    const elapsed = Date.now() - started;
    assert.deepEqual(open.map((job) => job.id), ['running-open', 'queued-open']);
    assert.ok(elapsed < 250, `listOpenJobs took ${elapsed}ms`);
  } finally {
    database.close();
    store.close();
    temporary.remove();
  }
});

test('a restart takes over a fresh lock left by a dead local worker', () => {
  const temporary = temporaryDatabase('ai-center-takeover-');
  const store = createStore(temporary.path);
  const database = new Database(temporary.path);
  try {
    const job = store.createJob({
      type: 'feed.translation.run',
      workspaceId: 'local',
      maxAttempts: 4,
      input: { items: [{ id: 'takeover-1', text: 'Interior Department notice about public lands.' }] },
    });
    const claimed = store.claimNextJob('old-worker', ['feed.translation.run']);
    const deadLock = `${hostname()}-2147483646`;
    database.prepare('UPDATE jobs SET locked_by = ?, locked_at = ? WHERE id = ?')
      .run(deadLock, Date.now(), job.id);
    assert.equal(store.recoverStaleJobs(10 * 60_000, Date.now(), {
      ownerStale: (lockedBy) => deadLocalWorkerLock(lockedBy, { isAlive: () => false }),
    }), 1);
    const recovered = store.getJob(job.id);
    assert.equal(recovered.status, 'queued');
    assert.equal(recovered.attemptCount, 1);
    assert.equal(recovered.maxAttempts, 5);
    assert.equal(recovered.error.name, 'WorkerLeaseExpired');
    assert.equal(claimed.id, job.id);

    const live = store.createJob({
      type: 'system.healthcheck', workspaceId: 'local', maxAttempts: 1, input: { source: 'live' },
    });
    store.claimNextJob(`${hostname()}-${process.pid}`, ['system.healthcheck']);
    assert.equal(store.recoverStaleJobs(10 * 60_000, Date.now(), {
      ownerStale: (lockedBy) => deadLocalWorkerLock(lockedBy, { isAlive: () => false }),
    }), 0);
    assert.equal(store.getJob(live.id).status, 'running');
  } finally {
    database.close();
    store.close();
    temporary.remove();
  }
});

test('claiming skips a backlog of exhausted jobs and still takes the next one', () => {
  const temporary = temporaryDatabase('ai-center-claim-sweep-');
  const store = createStore(temporary.path);
  const database = new Database(temporary.path);
  try {
    const now = Date.now();
    for (let index = 0; index < 45; index += 1) {
      insertJob(database, {
        id: `spent-${index}`,
        type: 'system.healthcheck',
        status: 'queued',
        priority: 100,
        attemptCount: 3,
        maxAttempts: 3,
        availableAt: 0,
        createdAt: now + index,
      });
    }
    const fresh = store.createJob({
      type: 'system.healthcheck', workspaceId: 'local', maxAttempts: 1, input: { source: 'fresh' },
    });
    const started = Date.now();
    const claimed = store.claimNextJob('worker-now', ['system.healthcheck']);
    const elapsed = Date.now() - started;
    assert.equal(claimed.id, fresh.id);
    assert.ok(elapsed < 250, `claim took ${elapsed}ms`);
    const failed = database.prepare(`SELECT COUNT(*) AS count FROM jobs
      WHERE type = 'system.healthcheck' AND status = 'failed'`).get().count;
    assert.equal(failed, 40);
    const stillQueued = database.prepare(`SELECT COUNT(*) AS count FROM jobs
      WHERE type = 'system.healthcheck' AND status = 'queued' AND attempt_count >= max_attempts`).get().count;
    assert.equal(stillQueued, 5);
  } finally {
    database.close();
    store.close();
    temporary.remove();
  }
});

test('the runner logs ready and the first claim before later maintenance', { timeout: 5_000 }, async (t) => {
  const temporary = temporaryDatabase('ai-center-runner-log-');
  const store = createStore(temporary.path);
  const lines = [];
  store.createJob({ type: 'system.healthcheck', input: { source: 'log' }, maxAttempts: 1 });
  const runner = createJobRunner({
    store,
    workerId: 'log-worker',
    pollIntervalMs: 200,
    handlers: { 'system.healthcheck': async () => ({ ok: true }) },
    log: (line) => { lines.push(line); },
  });
  let running;
  let failure = null;
  t.after(async () => {
    const cleanup = await releaseWorkerHarness({
      worker: {
        runner,
        scheduler: { stop() {} },
        async close() { if (running) await running; },
      },
      store,
      directory: temporary.directory,
    });
    if (!failure && cleanup) throw cleanup;
  });
  try {
    running = runner.start();
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && !lines.some((line) => line.includes('startup first-claim'))) await wait(20);
    const ready = lines.findIndex((line) => line.includes('startup runner-ready'));
    const claim = lines.findIndex((line) => line.includes('startup first-claim'));
    assert.ok(ready >= 0);
    assert.ok(claim > ready);
  } catch (error) {
    failure = error;
    throw error;
  }
});

test('worker start claims a job before translation maintenance', { timeout: 30_000 }, async (t) => {
  const temporary = temporaryDatabase('ai-center-worker-start-');
  const store = createStore(temporary.path);
  store.createJob({ type: 'system.healthcheck', input: { source: 'startup' }, maxAttempts: 1 });
  const lines = [];
  const original = console.log;
  let worker = null;
  let failure = null;
  t.after(async () => {
    const cleanup = await releaseWorkerHarness({
      worker,
      store,
      directory: temporary.directory,
      restore() { console.log = original; },
    });
    if (!failure && cleanup) throw cleanup;
  }, { timeout: 10_000 });
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    worker = createAiCenterWorker({
      store,
      workerId: 'startup-worker',
      enableDefaultSchedules: false,
      browserRuntime: {
        async health() {
          return { available: false, daemonConnected: false, browserConnected: false, browsers: 0 };
        },
      },
      env: { AI_CENTER_AGENT_RUNTIME: 'local' },
    });
    worker.start();
    assert.equal(http2StreamErrorSinkInstalled(), true);
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && !lines.some((line) => line.includes('ellipsis-lead bodies='))) await wait(20);
    const claim = lines.findIndex((line) => line.includes('startup first-claim'));
    const retire = lines.findIndex((line) => line.includes('youtube-translation retired='));
    const demote = lines.findIndex((line) => line.includes('translation-flood demoted='));
    assert.ok(claim >= 0, lines.filter((line) => line.includes('startup')).join('\n'));
    assert.ok(retire > claim);
    assert.ok(demote > retire);
    let job;
    const statusDeadline = Date.now() + 2_000;
    do {
      job = store.listJobs(10).find((item) => item.type === 'system.healthcheck');
      if (job?.status === 'completed') break;
      await wait(20);
    } while (Date.now() < statusDeadline);
    assert.equal(job?.status, 'completed', job?.status || 'missing');
    await worker.close();
    assert.equal(worker.runner.running, false);
    assert.equal(worker.scheduler.running, false);
    await worker.close();
  } catch (error) {
    failure = error;
    throw error;
  }
});

test('startup cleanup stops the worker before removing the directory', async () => {
  const temporary = temporaryDatabase('ai-center-worker-cleanup-');
  const events = [];
  const cleanup = await releaseWorkerHarness({
    worker: {
      runner: { stop() { events.push('runner.stop'); } },
      scheduler: { stop() { events.push('scheduler.stop'); } },
      async close() { events.push('close'); },
    },
    store: { close() { events.push('store.close'); } },
    restore() { events.push('console'); },
    directory: temporary.directory,
  });
  assert.equal(cleanup, null);
  assert.deepEqual(events, ['console', 'runner.stop', 'scheduler.stop', 'close', 'store.close']);
  assert.equal(existsSync(temporary.directory), false);
});

test('directory cleanup does not replace an assertion failure', async () => {
  const assertion = new assert.AssertionError({
    message: 'job status',
    actual: 'running',
    expected: 'completed',
    operator: 'strictEqual',
  });
  const events = [];
  let reported = null;
  try {
    throw assertion;
  } catch (error) {
    reported = error;
    const cleanup = await releaseWorkerHarness({
      worker: {
        runner: { stop() { events.push('stop'); } },
        scheduler: { stop() {} },
        async close() { events.push('close'); },
      },
      store: { close() { events.push('store'); } },
      directory: 'locked',
    }, () => {
      events.push('remove');
      const busy = new Error('EBUSY: resource busy or locked');
      busy.code = 'EBUSY';
      throw busy;
    });
    assert.equal(reported, assertion);
    assert.equal(cleanup?.code, 'EBUSY');
    assert.deepEqual(events, ['stop', 'close', 'store', 'remove']);
  }
});
