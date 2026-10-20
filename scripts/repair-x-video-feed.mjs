import { createStore } from '../packages/database/src/index.js';
import { createXVideoService } from '../packages/domain/src/x-video-service.js';
import { parseXStatusId } from '../packages/domain/src/x-video-articles.js';
import { fetchXVideoMedia } from '../packages/connectors/src/x/video-media.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import { isMain } from '../packages/runtime/src/is-main.js';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

export async function repairXVideoFeed({
  store,
  workspaceId = 'local',
  tweetId,
  dryRun = false,
  loadMedia = fetchXVideoMedia,
} = {}) {
  const id = parseXStatusId(tweetId);
  if (!id) return { status: 'invalid' };
  const repository = store.repositories.xVideos;
  const existing = repository.articleForTweet(workspaceId, id);
  if (dryRun) {
    const capture = store.repositories.feed.getCapture?.(workspaceId, 'x', id) || null;
    const parsed = await loadMedia(id);
    return {
      status: 'dry-run',
      tweetId: id,
      hasArticle: Boolean(existing?.videoId),
      contentItemId: existing?.contentItemId || '',
      holdReason: (() => {
        try { return JSON.parse(existing?.articleState || '{}').holdReason || ''; } catch { return ''; }
      })(),
      author: parsed?.author || null,
      hasText: Boolean(String(parsed?.text || '').trim()),
      captureId: capture?.id || '',
    };
  }
  const service = createXVideoService({
    repository,
    feedRepository: store.repositories.feed,
    store,
    loadMedia,
    env: process.env,
  });
  return service.enqueue(workspaceId, { tweetId: id });
}

if (isMain(import.meta.url)) {
  const dryRun = process.argv.includes('--dry-run');
  const workspaceId = arg('--workspace', 'local') || 'local';
  const tweetId = arg('--tweet', '') || process.argv.find((item) => /^\d{5,25}$/.test(item)) || '';
  if (!parseXStatusId(tweetId)) {
    console.error('[x-video-feed] 需要 --tweet 帖子编号');
    process.exitCode = 1;
  } else {
    const instance = resolveInstanceConfig({ repositoryRoot: process.cwd() });
    const store = createStore(instance.databasePath);
    try {
      const result = await repairXVideoFeed({ store, workspaceId, tweetId, dryRun });
      console.log(`[x-video-feed] ${JSON.stringify(result)}`);
      if (result.status === 'invalid' || result.status === 'disabled') process.exitCode = 1;
      else if (!dryRun && !result.contentItemId) process.exitCode = 1;
    } catch (error) {
      console.error(`[x-video-feed] ${error instanceof Error ? error.message : '补录失败'}`);
      process.exitCode = 1;
    } finally {
      store.close();
    }
  }
}
