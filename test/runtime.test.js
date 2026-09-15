import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createJsonProcessAdapter } from '../packages/connectors/src/process-json-adapter.js';
import { createStore } from '../packages/database/src/index.js';
import { createJobRunner } from '../packages/runtime/src/job-runner.js';
import { createAiCenterWorker } from '../apps/worker/src/worker.js';

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
  assert.equal(store.getRuntimeStatus().schemaVersion, 4);
  store.close();

  const upgraded = new Database(temporary.path, { readonly: true });
  const columns = upgraded.prepare('PRAGMA table_info(posts)').all().map((column) => column.name);
  assert.ok(columns.includes('workspace_id'));
  assert.equal(upgraded.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, 4);
  upgraded.close();
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
  assert.equal(webStore.getRuntimeStatus().providers[0].providerId, 'worker');

  await worker.close();
  webStore.close();
  temporary.remove();
});
