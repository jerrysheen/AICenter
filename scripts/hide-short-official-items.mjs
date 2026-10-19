import { createStore } from '../packages/database/src/index.js';
import { hideShortOfficialItems } from '../packages/domain/src/source-author-sync.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import { isMain } from '../packages/runtime/src/is-main.js';

const invoked = isMain(import.meta.url);
if (invoked) {
  const dryRun = process.argv.includes('--dry-run');
  const workspaceIndex = process.argv.indexOf('--workspace');
  const workspaceId = workspaceIndex === -1 ? 'local' : (process.argv[workspaceIndex + 1] || 'local');
  const instance = resolveInstanceConfig({ repositoryRoot: process.cwd() });
  const store = createStore(instance.databasePath);
  try {
    const result = hideShortOfficialItems(store, { dryRun, workspaceId });
    console.log(`[official-body] ${JSON.stringify(result)}`);
  } finally {
    store.close();
  }
}
