import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createStore } from '../packages/database/src/index.js';
import { ingestBilibiliDynamics } from '../packages/domain/src/bilibili-dynamics.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';

export function readDynamicsJsonl(file) {
  const text = readFileSync(file, 'utf8');
  return text.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
}

export function importBilibiliDynamics(feedRepository, workspaceId, records) {
  return ingestBilibiliDynamics(feedRepository, workspaceId, records);
}

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invoked) {
  const file = arg('--file', '');
  if (!file) {
    console.error('用法: node scripts/import-bilibili-dynamics.mjs --file <dynamics.jsonl>');
    process.exitCode = 1;
  } else {
    const instance = resolveInstanceConfig({ repositoryRoot: process.cwd() });
    const store = createStore(instance.databasePath);
    try {
      const records = readDynamicsJsonl(file);
      const result = importBilibiliDynamics(store.repositories.feed, arg('--workspace', 'local'), records);
      console.log(`[authors] bilibili dynamics added=${result.added} skipped=${result.skipped}`);
    } finally {
      store.close();
    }
  }
}
