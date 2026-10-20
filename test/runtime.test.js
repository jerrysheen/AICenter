import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createJsonProcessAdapter } from '../packages/connectors/src/process-json-adapter.js';
import { createStore } from '../packages/database/src/index.js';
import { getEventListeners } from 'node:events';
import { createJobRunner, resolveJobTypeConcurrency, shouldLogJobLoopDelay, wait } from '../packages/runtime/src/job-runner.js';
import { createAiCenterWorker } from '../apps/worker/src/worker.js';
import { latestSchemaVersion, runMigrations, unusedSchemaVersions } from '../packages/database/src/migrations.js';
import { computeFeedIdentityHash } from '../packages/domain/src/feed-identity.js';

function temporaryDatabase(prefix) {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    directory,
    path: path.join(directory, 'test.db'),
    remove: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test('migrations upgrade a v1 database without losing posts', () => {
  const temporary = temporaryDatabase('ai-center-migration-');
  const legacy = new Database(temporary.path);
  legacy.exec(`
    CREATE TABLE posts (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
      source_url TEXT NOT NULL DEFAULT '', tags_json TEXT NOT NULL DEFAULT '[]',
      created_by_device TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO posts VALUES ('legacy', '旧信息', '', '', '[]', NULL, 1, 1);
  `);
  legacy.close();

  const store = createStore(temporary.path);
  assert.equal(store.getPost('legacy').title, '旧信息');
  assert.equal(store.getRuntimeStatus().schemaVersion, latestSchemaVersion());
  store.close();

  const upgraded = new Database(temporary.path, { readonly: true });
  const columns = upgraded.prepare('PRAGMA table_info(posts)').all().map((column) => column.name);
  assert.ok(columns.includes('workspace_id'));
  const schemaRows = upgraded.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count;
  const schemaLatest = latestSchemaVersion();
  const expectedHoles = unusedSchemaVersions.filter((version) => version <= schemaLatest).length;
  assert.deepEqual(unusedSchemaVersions, [63, 79, 80, 82]);
  assert.equal(upgraded.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, schemaLatest);
  assert.equal(schemaLatest - schemaRows, expectedHoles, `schema rows ${schemaRows} latest ${schemaLatest}`);
  assert.equal(schemaLatest, 92);
  assert.equal(upgraded.prepare(`SELECT name FROM schema_migrations WHERE version = 89`).get().name, 'youtube_podcast_article');
  assert.equal(upgraded.prepare(`SELECT name FROM schema_migrations WHERE version = 90`).get().name, 'author_stats_published');
  assert.equal(upgraded.prepare(`SELECT name FROM schema_migrations WHERE version = 91`).get().name, 'hardware_price_snapshot_rows_observation');
  assert.equal(upgraded.prepare(`SELECT name FROM schema_migrations WHERE version = 92`).get().name, 'feed_translation_chunk_failures');
  assert.ok(upgraded.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'feed_translation_chunk_failures'`).get());
  assert.ok(upgraded.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'hardware_price_snapshot_rows_observation'`).get());
  assert.ok(upgraded.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'northbound_daily'`).get());
  assert.ok(upgraded.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'youtube_podcast_episodes'`).get());
  const episodeColumns = upgraded.prepare('PRAGMA table_info(youtube_podcast_episodes)').all().map((column) => column.name);
  assert.ok(episodeColumns.includes('source_transcript'));
  assert.ok(episodeColumns.includes('article_status'));
  assert.ok(episodeColumns.includes('article_state'));
  const channelColumns = upgraded.prepare('PRAGMA table_info(youtube_podcast_channels)').all().map((column) => column.name);
  assert.ok(channelColumns.includes('backfilled_at'));
  assert.ok(channelColumns.includes('backfill_attempts'));
  assert.ok(channelColumns.includes('backfill_failed_at'));
  assert.ok(upgraded.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_jobs_type_created'`).get());
  assert.ok(upgraded.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_captures_x_focus'`).get());
  assert.ok(upgraded.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_information_tree_heads_layer_start'`).get());
  assert.ok(upgraded.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'resource_taggings'`).get());
  const refColumns = upgraded.prepare('PRAGMA table_info(ai_run_context_refs)').all().map((column) => column.name);
  assert.ok(refColumns.includes('origin'));
  assert.ok(refColumns.includes('label'));
  assert.ok(upgraded.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'feed_identity_fingerprints'`).get());
  upgraded.close();
  temporary.remove();
});

test('v23 backfills feed identity fingerprints from existing captures', () => {
  const temporary = temporaryDatabase('ai-center-feed-identity-');
  const store = createStore(temporary.path);
  const feed = store.repositories.feed;
  const source = feed.upsertSourceAccount({
    workspaceId: 'local', provider: 'x', externalId: 'home', displayName: 'X',
  });
  const capture = feed.saveCapture({
    workspaceId: 'local', provider: 'x', externalId: 'old-tweet', sourceAccountId: source.id,
    sourceUrl: 'https://x.com/user/status/old-tweet', contentHash: 'sha256-old',
    metadata: { originalText: '旧推文', authorHandle: '@alice' },
  });
  feed.saveContentItem({
    workspaceId: 'local', captureId: capture.id, originType: 'subscription', contentType: 'post',
    title: '旧推文', body: '旧推文', sourceUrl: capture.sourceUrl, authorName: 'alice',
  });
  store.close();

  const broken = new Database(temporary.path);
  broken.exec('DROP TABLE feed_identity_fingerprints');
  broken.prepare('DELETE FROM schema_migrations WHERE version = 23').run();
  broken.close();

  const repaired = createStore(temporary.path);
  const fingerprint = repaired.repositories.feed.getIdentityFingerprint(
    'local',
    'x',
    computeFeedIdentityHash({
      provider: 'x',
      authorHandle: '@alice',
      authorName: 'alice',
      text: '旧推文',
      externalId: 'old-tweet',
    }),
  );
  assert.equal(fingerprint.externalId, 'old-tweet');
  repaired.close();
  temporary.remove();
});

test('v13 backfills missing knowledge revisions and fts', () => {
  const temporary = temporaryDatabase('ai-center-knowledge-repair-');
  const store = createStore(temporary.path);
  store.close();

  const broken = new Database(temporary.path);
  const now = Date.now();
  broken.prepare(`INSERT INTO knowledge_items
    (id, title, body, source, source_note_id, created_at, updated_at, workspace_id, status, current_revision, metadata_json)
    VALUES (?, ?, ?, 'inspiration', NULL, ?, ?, 'local', 'active', 1, '{}')`)
    .run('orphan-knowledge', '旧产能退出', '存储周期里 DDR3 可能受益于旧产能退出', now, now);
  broken.prepare('DELETE FROM schema_migrations WHERE version = 13').run();
  broken.close();

  const repaired = createStore(temporary.path);
  assert.equal(repaired.repositories.knowledge.search('local', 'DDR3')[0].knowledgeId, 'orphan-knowledge');
  assert.equal(repaired.repositories.knowledge.listRevisions('orphan-knowledge')[0].revision, 1);
  repaired.close();
  temporary.remove();
});

test('job runner claims, completes, and emits durable events', async () => {
  const temporary = temporaryDatabase('ai-center-runtime-');
  const store = createStore(temporary.path);
  const job = store.createJob({ type: 'test.echo', input: { value: 42 } });
  const runner = createJobRunner({
    store,
    workerId: 'test-worker',
    handlers: { 'test.echo': async (input) => ({ echoed: input.value }) },
  });

  const completed = await runner.runOnce();
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.output, { echoed: 42 });
  assert.equal(store.getJob(job.id).attemptCount, 1);
  const names = store.listEvents(0).map((event) => event.name);
  assert.ok(names.includes('job.queued'));
  assert.ok(names.includes('job.started'));
  assert.ok(names.includes('job.completed'));
  store.close();
  temporary.remove();
});

test('job runner recovers stale leases on an interval and does not reset fresh jobs at start', async () => {
  const recoveredAt = [];
  const store = {
    recoverStaleJobs() {
      recoveredAt.push(Date.now());
      return 0;
    },
    claimNextJob() { return null; },
  };
  const runner = createJobRunner({
    store,
    workerId: 'recover-worker',
    handlers: { 'test.echo': async () => ({}) },
    pollIntervalMs: 100,
    staleAfterMs: 5_000,
    recoverEveryMs: 100,
  });
  const running = runner.start();
  await wait(280);
  runner.stop();
  await running;
  assert.ok(recoveredAt.length >= 2, `expected periodic recover, got ${recoveredAt.length}`);
});

test('claim errors fail the queued job and the loop keeps claiming', async () => {
  const errors = [];
  const failed = [];
  let calls = 0;
  const store = {
    recoverStaleJobs() {},
    claimNextJob() {
      calls += 1;
      if (calls === 1) {
        const error = new Error('UNIQUE constraint failed: job_attempts.job_id, attempt_number');
        error.jobId = 'job-poison';
        throw error;
      }
      return null;
    },
    failQueuedJob(id, error) {
      failed.push({ id, message: error.message });
      return { id, status: 'failed' };
    },
  };
  const runner = createJobRunner({
    store,
    workerId: 'claim-worker',
    handlers: { 'test.echo': async () => ({}) },
    pollIntervalMs: 100,
    watchdogMs: 60_000,
    onClaimError(error) { errors.push(String(error?.message || error)); },
  });
  const running = runner.start();
  await wait(280);
  runner.stop();
  await running;
  assert.equal(failed.length, 1);
  assert.equal(failed[0].id, 'job-poison');
  assert.match(failed[0].message, /UNIQUE constraint failed/);
  assert.ok(calls >= 2, `expected another claim after the error, got ${calls}`);
  assert.ok(errors.length >= 1);
});

test('job loop watchdog logs once while claim has not returned', async () => {
  const lines = [];
  let release = () => {};
  let hung = false;
  const store = {
    recoverStaleJobs() {},
    claimNextJob() {
      if (!hung) {
        hung = true;
        return new Promise((resolve) => { release = () => resolve(null); });
      }
      return null;
    },
  };
  const runner = createJobRunner({
    store,
    workerId: 'watchdog-worker',
    handlers: { 'test.echo': async () => ({}) },
    pollIntervalMs: 20,
    watchdogMs: 30,
    onWatchdog(line) { lines.push(line); },
  });
  const running = runner.start();
  await wait(140);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[worker\] job loop has not ticked for \d+s$/);
  release();
  await wait(50);
  runner.stop();
  await running;
  assert.equal(lines.length, 1);
});

test('job runner lets a new run replace a subscription sync that exceeded its budget', async () => {
  const temporary = temporaryDatabase('ai-center-supersede-');
  const store = createStore(temporary.path);
  let releaseHang = () => {};
  const started = [];
  const runner = createJobRunner({
    store,
    workerId: 'supersede-worker',
    pollIntervalMs: 20,
    supersedeAfterMs: { 'feed.subscriptions.sync': 60 },
    handlers: {
      'feed.subscriptions.sync': (input) => {
        started.push(input.n);
        if (input.n === 1) return new Promise((resolve) => { releaseHang = resolve; });
        return { n: input.n };
      },
    },
  });
  store.createJob({ type: 'feed.subscriptions.sync', input: { n: 1 }, maxAttempts: 1 });
  const running = runner.start();
  const claimedDeadline = Date.now() + 1_000;
  while (!started.includes(1) && Date.now() < claimedDeadline) await wait(20);
  store.createJob({ type: 'feed.subscriptions.sync', input: { n: 2 }, maxAttempts: 1 });
  const replacedDeadline = Date.now() + 1_000;
  while (!started.includes(2) && Date.now() < replacedDeadline) await wait(20);
  assert.deepEqual(started, [1, 2]);
  const jobs = store.listJobs(10);
  assert.equal(jobs.find((job) => job.input.n === 1).status, 'failed');
  assert.match(jobs.find((job) => job.input.n === 1).error.message, /上一轮仍未结束/);
  releaseHang({ superseded: true });
  const doneDeadline = Date.now() + 1_000;
  while (jobs.find((job) => job.input.n === 2) && store.getJob(jobs.find((job) => job.input.n === 2).id).status !== 'completed' && Date.now() < doneDeadline) {
    await wait(20);
  }
  assert.equal(store.getJob(jobs.find((job) => job.input.n === 2).id).status, 'completed');
  runner.stop();
  await running;
  store.close();
  temporary.remove();
});

test('a running translation is not reclaimed when its lease expires in this process', async () => {
  const temporary = temporaryDatabase('ai-center-lease-live-');
  const store = createStore(temporary.path);
  let calls = 0;
  let release = () => {};
  const runner = createJobRunner({
    store,
    workerId: 'same-worker',
    pollIntervalMs: 15,
    staleAfterMs: 20,
    recoverEveryMs: 30,
    handlers: {
      'feed.translation.run': async () => {
        calls += 1;
        await new Promise((resolve) => { release = resolve; });
        return { ok: true };
      },
    },
  });
  const job = store.createJob({
    type: 'feed.translation.run', workspaceId: 'local', maxAttempts: 4,
    input: { items: [{ id: 'live', text: 'Interior Department notice about public lands.' }] },
  });
  const running = runner.start();
  try {
    const deadline = Date.now() + 1_000;
    while (calls < 1 && Date.now() < deadline) await wait(10);
    await wait(180);
    assert.equal(calls, 1);
    assert.equal(store.getJob(job.id).status, 'running');
    assert.equal(store.getJob(job.id).attemptCount, 1);
    release();
    const done = Date.now() + 1_000;
    while (store.getJob(job.id).status !== 'completed' && Date.now() < done) await wait(10);
    assert.equal(store.getJob(job.id).status, 'completed');
  } finally {
    release();
    runner.stop();
    await running;
    store.close();
    temporary.remove();
  }
});

test('superseding a hung sync aborts the old execution', async () => {
  const temporary = temporaryDatabase('ai-center-supersede-abort-');
  const store = createStore(temporary.path);
  let aborted = false;
  const started = [];
  const runner = createJobRunner({
    store,
    workerId: 'supersede-abort',
    pollIntervalMs: 20,
    supersedeAfterMs: { 'feed.subscriptions.sync': 40 },
    handlers: {
      'feed.subscriptions.sync': (input, context) => {
        started.push(input.n);
        if (input.n !== 1) return { n: input.n };
        return new Promise((resolve) => {
          if (context.signal.aborted) {
            aborted = true;
            resolve({ stopped: true });
            return;
          }
          context.signal.addEventListener('abort', () => {
            aborted = true;
            resolve({ stopped: true });
          }, { once: true });
        });
      },
    },
  });
  const first = store.createJob({ type: 'feed.subscriptions.sync', input: { n: 1 }, maxAttempts: 1 });
  const running = runner.start();
  try {
    const claimedDeadline = Date.now() + 1_000;
    while (!started.includes(1) && Date.now() < claimedDeadline) await wait(20);
    store.createJob({ type: 'feed.subscriptions.sync', input: { n: 2 }, maxAttempts: 1 });
    const replacedDeadline = Date.now() + 1_000;
    while ((!started.includes(2) || !aborted) && Date.now() < replacedDeadline) await wait(20);
    assert.equal(aborted, true);
    assert.deepEqual(started, [1, 2]);
    assert.equal(store.getJob(first.id).status, 'failed');
    const second = store.listJobs(10).find((job) => job.input.n === 2);
    const doneDeadline = Date.now() + 1_000;
    while (store.getJob(second.id).status !== 'completed' && Date.now() < doneDeadline) await wait(20);
    assert.equal(store.getJob(second.id).status, 'completed');
    assert.equal(store.getJob(first.id).status, 'failed');
  } finally {
    runner.stop();
    await running;
    store.close();
    temporary.remove();
  }
});

test('runMigrations does not throw when the other process already inserted the version', () => {
  const temporary = temporaryDatabase('ai-center-migration-race-');
  const database = new Database(temporary.path);
  try {
    runMigrations(database);
    const latest = latestSchemaVersion();
    database.prepare('DELETE FROM schema_migrations WHERE version = ?').run(latest);
    let outerRead = false;
    let planted = false;
    const wrapped = {
      exec(sql) {
        if (sql === 'BEGIN IMMEDIATE' && !planted) {
          planted = true;
          database.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(latest, 'other-process', 1);
        }
        return database.exec(sql);
      },
      pragma(value) { return database.pragma(value); },
      prepare(sql) {
        const statement = database.prepare(sql);
        if (sql.includes('FROM schema_migrations') && !sql.includes('WHERE')) {
          return {
            all(...args) {
              const rows = statement.all(...args);
              if (!outerRead) {
                outerRead = true;
                return rows.filter((row) => row.version !== latest);
              }
              return rows;
            },
          };
        }
        return statement;
      },
    };
    assert.doesNotThrow(() => runMigrations(wrapped));
    const count = database.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = ?').get(latest).n;
    assert.equal(count, 1);
    assert.equal(outerRead, true);
    assert.equal(planted, true);
  } finally {
    database.close();
    temporary.remove();
  }
});

test('idle job poll does not accumulate abort listeners', async () => {
  const controller = new AbortController();
  for (let index = 0; index < 40; index += 1) {
    await wait(1, controller.signal);
  }
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const pending = wait(1_000, controller.signal);
  controller.abort();
  await pending;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('job runner runs three work-package.dispatch jobs at once and keeps agent serial', async () => {
  const temporary = temporaryDatabase('ai-center-parallel-wp-');
  const store = createStore(temporary.path);
  const started = [];
  const releases = [];
  const hold = () => new Promise((resolve) => {
    releases.push(resolve);
  });
  const runner = createJobRunner({
    store,
    workerId: 'parallel-worker',
    pollIntervalMs: 20,
    handlers: {
      'work-package.dispatch': async (input) => {
        started.push(`wp:${input.n}`);
        await hold();
        return { n: input.n };
      },
      'ai.agent.run': async (input) => {
        started.push(`agent:${input.n}`);
        await hold();
        return { n: input.n };
      },
    },
  });
  assert.equal(resolveJobTypeConcurrency('work-package.dispatch'), 3);
  assert.equal(resolveJobTypeConcurrency('ai.agent.run'), 1);
  for (const n of [1, 2, 3, 4]) {
    store.createJob({ type: 'work-package.dispatch', input: { n }, workspaceId: 'local' });
  }
  store.createJob({ type: 'ai.agent.run', input: { n: 1 }, workspaceId: 'local' });
  store.createJob({ type: 'ai.agent.run', input: { n: 2 }, workspaceId: 'local' });

  const running = runner.start();
  const deadline = Date.now() + 2_000;
  while (started.length < 4 && Date.now() < deadline) {
    await wait(20);
  }
  const runningWorkPackages = store.listJobs(20).filter((job) => (
    job.type === 'work-package.dispatch' && job.status === 'running'
  ));
  const runningAgents = store.listJobs(20).filter((job) => (
    job.type === 'ai.agent.run' && job.status === 'running'
  ));
  assert.equal(runningWorkPackages.length, 3);
  assert.equal(runningAgents.length, 1);
  assert.equal(started.filter((item) => item.startsWith('wp:')).length, 3);
  assert.equal(started.filter((item) => item.startsWith('agent:')).length, 1);
  assert.equal(runner.inFlightCount, 4);

  releases.shift()?.();
  const afterDeadline = Date.now() + 2_000;
  while (started.filter((item) => item.startsWith('wp:')).length < 4 && Date.now() < afterDeadline) {
    await wait(20);
  }
  assert.equal(started.filter((item) => item.startsWith('wp:')).length, 4);
  const finishDeadline = Date.now() + 2_000;
  while (store.listJobs(20).some((job) => job.status !== 'completed') && Date.now() < finishDeadline) {
    while (releases.length) releases.shift()?.();
    await wait(20);
  }
  runner.stop();
  await running;
  assert.equal(store.listJobs(20).filter((job) => job.status === 'completed').length, 6);
  store.close();
  temporary.remove();
});

test('process connector accepts JSON stdout without using a shell', async () => {
  const adapter = createJsonProcessAdapter({
    command: process.execPath,
    args: ['-e', 'process.stdout.write(JSON.stringify({ ok: true, source: "child" }))'],
    timeoutMs: 5_000,
  });
  assert.deepEqual(await adapter(), { ok: true, source: 'child' });
});

test('job loop delay is logged only after 200ms', () => {
  assert.equal(shouldLogJobLoopDelay(200), false);
  assert.equal(shouldLogJobLoopDelay(201), true);
  assert.equal(shouldLogJobLoopDelay(0), false);
});

test('worker process boundary shares jobs and health through SQLite', async () => {
  const temporary = temporaryDatabase('ai-center-worker-');
  const webStore = createStore(temporary.path);
  const workerStore = createStore(temporary.path);
  const worker = createAiCenterWorker({ store: workerStore, workerId: 'integration-worker' });
  const job = webStore.createJob({ type: 'system.healthcheck', input: { source: 'test' }, maxAttempts: 1 });

  const completed = await worker.runner.runOnce();
  assert.equal(completed.id, job.id);
  assert.equal(webStore.getJob(job.id).status, 'completed');
  const providers = webStore.getRuntimeStatus().providers;
  assert.equal(providers.find((item) => item.providerId === 'worker')?.providerId, 'worker');
  assert.equal(providers.some((item) => item.providerId === 'browser'), true);

  await worker.close();
  webStore.close();
  temporary.remove();
});
