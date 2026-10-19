import { createStore } from '../packages/database/src/index.js';
import { backfillOfficialBodies, officialDetailReader } from '../packages/domain/src/source-author-sync.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import { isMain } from '../packages/runtime/src/is-main.js';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

const invoked = isMain(import.meta.url);
if (invoked) {
  const dryRun = process.argv.includes('--dry-run');
  const workspaceIndex = process.argv.indexOf('--workspace');
  const workspaceId = workspaceIndex === -1 ? 'local' : (process.argv[workspaceIndex + 1] || 'local');
  const sleepMs = Number(arg('--sleep-ms', '200'));
  const limit = Number(arg('--limit', '0')) || 0;
  const instance = resolveInstanceConfig({ repositoryRoot: process.cwd() });
  const store = createStore(instance.databasePath);
  try {
    const result = await backfillOfficialBodies(store, {
      dryRun,
      workspaceId,
      sleepMs: Number.isFinite(sleepMs) ? sleepMs : 200,
      limit,
      readDetail: dryRun ? null : officialDetailReader(),
      onItem(item) {
        console.log(`[official-bodies] ${JSON.stringify(item)}`);
      },
    });
    console.log(`[official-bodies] done ${JSON.stringify(result)}`);
  } finally {
    store.close();
  }
}
