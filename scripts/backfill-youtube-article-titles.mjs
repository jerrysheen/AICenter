import { createStore } from '../packages/database/src/index.js';
import { backfillYoutubeArticleTitles } from '../packages/runtime/src/youtube-article-job.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import { isMain } from '../packages/runtime/src/is-main.js';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

if (isMain(import.meta.url)) {
  const dryRun = process.argv.includes('--dry-run');
  const workspaceId = arg('--workspace', 'local') || 'local';
  const limit = Number(arg('--limit', '500')) || 500;
  const instance = resolveInstanceConfig({ repositoryRoot: process.cwd() });
  const store = createStore(instance.databasePath);
  try {
    const result = await backfillYoutubeArticleTitles({
      repository: store.repositories.youtubePodcasts,
      feedRepository: store.repositories.feed,
      quotaRepository: store.repositories.modelQuota,
      workspaceId,
      env: process.env,
      dryRun,
      limit,
      onItem(item) {
        console.log(`[youtube-article-title] ${JSON.stringify(item)}`);
      },
    });
    console.log(`[youtube-article-title] done ${JSON.stringify(result)}`);
  } finally {
    store.close();
  }
}
