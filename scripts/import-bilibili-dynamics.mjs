import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { DEFAULT_WORKSPACE_ID } from '../packages/database/src/migrations.js';
import { createStore } from '../packages/database/src/index.js';
import { ingestBilibiliDynamics, resolveDynamicsWorkspace } from '../packages/domain/src/bilibili-dynamics.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import { isMain } from '../packages/runtime/src/is-main.js';

export const DYNAMICS_IMPORT_BATCH = 500;

export async function forEachJsonlBatch(file, onBatch, { batchSize = DYNAMICS_IMPORT_BATCH } = {}) {
  const lines = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let batch = [];
  let batches = 0;
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    batch.push(JSON.parse(trimmed));
    if (batch.length >= batchSize) {
      batches += 1;
      await onBatch(batch, batches);
      batch = [];
    }
  }
  if (batch.length) {
    batches += 1;
    await onBatch(batch, batches);
  }
  return { batches };
}

export function importBilibiliDynamics(feedRepository, workspaceId, records) {
  return ingestBilibiliDynamics(feedRepository, workspaceId, records);
}

export async function importBilibiliDynamicsFile(store, workspaceId, file, { batchSize = DYNAMICS_IMPORT_BATCH } = {}) {
  let added = 0;
  let skipped = 0;
  let transactions = 0;
  await forEachJsonlBatch(file, async (batch) => {
    const result = store.transaction(() => importBilibiliDynamics(store.repositories.feed, workspaceId, batch));
    added += result.added;
    skipped += result.skipped;
    transactions += 1;
  }, { batchSize });
  return { added, skipped, transactions };
}

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

const invoked = isMain(import.meta.url);
if (invoked) {
  const file = arg('--file', '');
  if (!file) {
    console.error('用法: node scripts/import-bilibili-dynamics.mjs --file <dynamics.jsonl>');
    process.exitCode = 1;
  } else {
    const instance = resolveInstanceConfig({ repositoryRoot: process.cwd() });
    const workspaceId = resolveDynamicsWorkspace({
      instanceId: instance.instanceId,
      legacyLayout: instance.legacyLayout,
      env: process.env,
      argv: process.argv,
      fallback: DEFAULT_WORKSPACE_ID,
    });
    const store = createStore(instance.databasePath);
    try {
      const result = await importBilibiliDynamicsFile(store, workspaceId, file);
      console.log(`[authors] bilibili dynamics added=${result.added} skipped=${result.skipped} batches=${result.transactions}`);
    } finally {
      store.close();
    }
  }
}
