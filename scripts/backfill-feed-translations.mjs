import { createStore } from '../packages/database/src/index.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import { createFeedService } from '../packages/domain/src/feed-service.js';
import { loadResolvedFlashSources } from '../packages/domain/src/flash-sources.js';
import { backfillUntranslatedFeedTranslations, TRANSLATION_BACKFILL_LIMIT } from '../packages/runtime/src/feed-translation-module.js';

const limitFlag = process.argv.indexOf('--limit');
const limit = limitFlag >= 0 ? Number(process.argv[limitFlag + 1]) : TRANSLATION_BACKFILL_LIMIT;
if (process.argv.includes('--help') || (limitFlag >= 0 && (!Number.isInteger(limit) || limit < 1 || limit > 200))) {
  console.log('用法: node --env-file=.env scripts/backfill-feed-translations.mjs [--limit 80]');
  console.log('把还没有中文译文、且原文需要翻译的社媒条目放进 feed.translation.run。');
  console.log('本命令只入队。Worker 执行翻译。已有未完成的相同任务不会重复创建。快讯来源跳过。');
  console.log('超过 20 万字的正文仍不入队。优先排入超过 2 万字的长文。');
  process.exit(process.argv.includes('--help') ? 0 : 1);
}

const instance = resolveInstanceConfig({ repositoryRoot: process.cwd() });
const store = createStore(instance.databasePath);
try {
  const flash = loadResolvedFlashSources({ configDirectory: instance.configDirectory, env: process.env });
  const feedService = createFeedService({
    legacyRepository: store,
    feedRepository: store.repositories.feed,
    sourcePort: {},
  });
  const jobs = await backfillUntranslatedFeedTranslations({
    store,
    feedService,
    workspaceId: 'local',
    limit,
    excludeSourceIds: [...flash.ids],
  });
  console.log(JSON.stringify({
    enqueued: jobs.length,
    jobIds: jobs.map((job) => job.id),
    limit,
  }));
} finally {
  store.close();
}
