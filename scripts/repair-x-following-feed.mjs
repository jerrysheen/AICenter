import { createStore } from '../packages/database/src/index.js';
import { repairXFollowingFeed } from '../packages/domain/src/x-video-feed.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import { isMain } from '../packages/runtime/src/is-main.js';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

export function repairFollowingFeed({
  store,
  workspaceId = 'local',
  dryRun = false,
  limit = 40,
} = {}) {
  const feedRepository = store.repositories.feed;
  if (dryRun) {
    return repairXFollowingFeed({ feedRepository, workspaceId, dryRun: true, limit });
  }
  let moved = 0;
  let last = null;
  for (let round = 0; round < 200; round += 1) {
    last = repairXFollowingFeed({ feedRepository, workspaceId, dryRun: false, limit });
    moved += last.moved || 0;
    if (!last.moved) break;
  }
  return {
    status: moved ? 'moved' : (last?.status || 'done'),
    count: moved,
    moved,
    examples: last?.examples || [],
    sourceAccountId: last?.sourceAccountId || '',
  };
}

if (isMain(import.meta.url)) {
  const dryRun = process.argv.includes('--dry-run');
  const workspaceId = arg('--workspace', 'local') || 'local';
  const instance = resolveInstanceConfig({ repositoryRoot: process.cwd() });
  const store = createStore(instance.databasePath);
  try {
    const result = repairFollowingFeed({ store, workspaceId, dryRun, limit: dryRun ? 8 : 40 });
    console.log(`[x-following] ${JSON.stringify(result)}`);
  } catch (error) {
    console.error(`[x-following] ${error instanceof Error ? error.message : '补挂失败'}`);
    process.exitCode = 1;
  } finally {
    store.close();
  }
}
