import { createStore } from '../packages/database/src/index.js';
import { queueYoutubeChapterRerun } from '../packages/runtime/src/youtube-article-job.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import { isMain } from '../packages/runtime/src/is-main.js';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

if (isMain(import.meta.url)) {
  const dryRun = process.argv.includes('--dry-run');
  const all = process.argv.includes('--all');
  const videoId = arg('--video', '');
  const workspaceId = arg('--workspace', 'local') || 'local';
  if (!videoId && !all) {
    console.error('指定 --video <id> 重跑一集，或 --all 把已整理的集重新排队。可以加 --dry-run。');
    process.exitCode = 1;
  } else {
    const instance = resolveInstanceConfig({ repositoryRoot: process.cwd() });
    const store = createStore(instance.databasePath);
    try {
      const result = queueYoutubeChapterRerun({
        repository: store.repositories.youtubePodcasts,
        workspaceId,
        videoId,
        all,
        dryRun,
      });
      console.log(`[youtube-chapter-rerun] ${dryRun ? 'dry-run ' : ''}${JSON.stringify(result)}`);
      if (result.missing) {
        console.error(`[youtube-chapter-rerun] 没有已整理的单集 ${videoId}`);
        process.exitCode = 1;
      }
      console.log('[youtube-chapter-rerun] 不会在这条命令里调用模型。排队后由现有 youtube.podcasts.article 按每天名额重跑：各段写提炼正文，默认按章拼接。需要重启 Worker。');
    } finally {
      store.close();
    }
  }
}
