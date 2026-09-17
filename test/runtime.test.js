import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createJsonProcessAdapter } from '../packages/connectors/src/process-json-adapter.js';
import { createStore } from '../packages/database/src/index.js';
import { getEventListeners } from 'node:events';
import { createJobRunner, wait } from '../packages/runtime/src/job-runner.js';
import { createAiCenterWorker } from '../apps/worker/src/worker.js';
import { latestSchemaVersion } from '../packages/database/src/migrations.js';

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
  assert.equal(upgraded.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, latestSchemaVersion());
  assert.ok(upgraded.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'resource_taggings'`).get());
  const refColumns = upgraded.prepare('PRAGMA table_info(ai_run_context_refs)').all().map((column) => column.name);
  assert.ok(refColumns.includes('origin'));
  assert.ok(refColumns.includes('label'));
  upgraded.close();
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

test('process connector accepts JSON stdout without using a shell', async () => {
  const adapter = createJsonProcessAdapter({
    command: process.execPath,
    args: ['-e', 'process.stdout.write(JSON.stringify({ ok: true, source: "child" }))'],
    timeoutMs: 5_000,
  });
  assert.deepEqual(await adapter(), { ok: true, source: 'child' });
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
