import { createStore } from '../packages/database/src/index.js';
import { createXLinkService } from '../packages/domain/src/x-link-service.js';
import { xLinkArticleDay } from '../packages/domain/src/x-link-articles.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import { isMain } from '../packages/runtime/src/is-main.js';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

export function backfillXLinkArticles({
  store,
  workspaceId = 'local',
  since = 0,
  tweetIds = [],
  dryRun = false,
  now = Date.now,
} = {}) {
  const service = createXLinkService({
    repository: store.repositories.xLinks,
    feedRepository: store.repositories.feed,
    store,
    env: process.env,
    now,
  });
  return service.backfill(workspaceId, { since, dryRun, tweetIds });
}

if (isMain(import.meta.url)) {
  const dryRun = process.argv.includes('--dry-run');
  const workspaceId = arg('--workspace', 'local') || 'local';
  const days = Math.max(1, Math.min(Number(arg('--days', '14')) || 14, 60));
  const tweetIds = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === '--tweet' && process.argv[index + 1]) tweetIds.push(process.argv[index + 1]);
  }
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const instance = resolveInstanceConfig({ repositoryRoot: process.cwd() });
  const store = createStore(instance.databasePath);
  try {
    const result = backfillXLinkArticles({ store, workspaceId, since, tweetIds, dryRun });
    console.log(`[x-link-backfill] day=${xLinkArticleDay()} dryRun=${dryRun} ${JSON.stringify(result)}`);
  } catch (error) {
    console.error(`[x-link-backfill] ${error instanceof Error ? error.message : '补跑失败'}`);
    process.exitCode = 1;
  } finally {
    store.close();
  }
}
