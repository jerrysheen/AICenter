import { createStore } from '../packages/database/src/index.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import { isMain } from '../packages/runtime/src/is-main.js';

const BATCH = 500;

export async function recomputeAuthorStats(repository, workspaceId = 'local', { after = '', sleepMs = 50 } = {}) {
  let cursor = String(after || '');
  let total = 0;
  for (;;) {
    const ids = repository.listAuthorIds(workspaceId, cursor, BATCH);
    for (const id of ids) repository.recomputeAuthor(workspaceId, id);
    total += ids.length;
    if (!ids.length || ids.length < BATCH) return { total, lastAuthorId: ids.at(-1) || cursor };
    cursor = ids.at(-1);
    if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }
}

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

const invoked = isMain(import.meta.url);
if (invoked) {
  const instance = resolveInstanceConfig({ repositoryRoot: process.cwd() });
  const store = createStore(instance.databasePath);
  try {
    const result = await recomputeAuthorStats(store.repositories.authors, arg('--workspace', 'local'), {
      after: arg('--after', ''),
      sleepMs: Number(arg('--sleep-ms', '50')) || 0,
    });
    console.log(`[authors] recompute total=${result.total} last=${result.lastAuthorId}`);
  } finally {
    store.close();
  }
}
