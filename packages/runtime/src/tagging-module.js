import { existsSync, readFileSync } from 'node:fs';
import { parseContract, TagAnalyzeJobInputSchema } from '../../contracts/src/index.js';
import { loadTagCatalog } from '../../domain/src/tag-catalog.js';

export const TAGGING_RESCAN_JOB_TYPE = 'tagging.rescan';
export const TAGGING_RESCAN_SCHEDULE_KEY = 'tagging.rescan.untagged';

export const taggingManifest = Object.freeze({
  id: 'tagging.analyze',
  version: '1.0.0',
  capabilities: ['tagging.analyze'],
  jobTypes: ['tagging.analyze', TAGGING_RESCAN_JOB_TYPE],
});

export function readTagCatalogFile(filePath) {
  if (!filePath || !existsSync(filePath)) {
    throw new Error(`找不到 tag catalog：${filePath || ''}`);
  }
  return loadTagCatalog(readFileSync(filePath, 'utf8'));
}

function collectItems({ input, feedService, knowledgeService }) {
  const workspaceId = input.workspaceId || 'local';
  if (input.resourceType === 'content-item') {
    return feedService.listTaggableItems(workspaceId, {
      limit: input.limit,
      ids: input.resourceIds,
    });
  }
  return knowledgeService.listTaggableItems(workspaceId, input.resourceType, {
    limit: input.limit,
    ids: input.resourceIds,
  });
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function tagRescanPlan(env = process.env, now = Date.now()) {
  const hours = boundedInt(env.AI_CENTER_TAG_RESCAN_HOURS, 48, 1, 24 * 14);
  const limit = boundedInt(env.AI_CENTER_TAG_RESCAN_LIMIT, 20, 1, 100);
  return { since: now - hours * 3600000, limit, hours };
}

function tagFailureCategory(error) {
  const message = String(error?.message || '');
  if (error?.code === 'budget-deferred') return 'budget-deferred';
  if (Number(error?.upstreamStatus) === 429 || Number(error?.status) === 429 || /429|RESOURCE_EXHAUSTED|配额/.test(message)) return 'rate-limit';
  const status = Number(error?.status);
  if ((status >= 500 && status <= 599) || /（5xx）|上游/.test(message)) return 'upstream';
  return 'tagging';
}

export function ensureTagRescanSchedule(store, now = Date.now(), env = process.env) {
  const intervalMinutes = boundedInt(env.AI_CENTER_TAG_RESCAN_INTERVAL_MINUTES, 15, 5, 180);
  return store.upsertJobSchedule({
    workspaceId: 'local',
    key: TAGGING_RESCAN_SCHEDULE_KEY,
    jobType: TAGGING_RESCAN_JOB_TYPE,
    enabled: true,
    schedule: { kind: 'interval', intervalMinutes },
    input: {},
    priority: -5,
    maxAttempts: 2,
    nextRunAt: now,
  });
}

export function createTaggingJobHandlers({ taggingService, feedService, knowledgeService, log = console.error, env = process.env, now = () => Date.now() }) {
  if (!taggingService) throw new Error('tagging jobs require taggingService');
  return {
    [TAGGING_RESCAN_JOB_TYPE]: async () => {
      const plan = tagRescanPlan(env, now());
      const ids = feedService.listUntaggedContentIds?.('local', plan) || [];
      if (!ids.length) return { scanned: 0, tagged: 0 };
      const items = feedService.listTaggableItems?.('local', { ids, limit: ids.length }) || [];
      try {
        const result = await taggingService.analyzeItems({
          workspaceId: 'local',
          resourceType: 'content-item',
          items,
          recordEmptyWhenUnlabeled: true,
        });
        return { scanned: ids.length, tagged: result?.saved?.length || 0, skipped: result?.skipped || 0 };
      } catch (error) {
        const category = tagFailureCategory(error);
        log(`[worker] tag-rescan failed count=${ids.length} category=${category}`);
        return { scanned: ids.length, tagged: 0, taggingFailed: ids.length, taggingError: category };
      }
    },
    'tagging.analyze': async (rawInput) => {
      const input = parseContract(TagAnalyzeJobInputSchema, rawInput || {});
      const items = collectItems({ input, feedService, knowledgeService });
      return taggingService.analyzeItems({
        workspaceId: input.workspaceId,
        resourceType: input.resourceType,
        items,
        force: input.force,
      });
    },
  };
}
