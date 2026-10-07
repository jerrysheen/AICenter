import { FeedItemsEnrichJobInputSchema, FeedSubscriptionsSyncJobInputSchema, parseContract } from '../../contracts/src/index.js';
import { defaultAutoRefreshProjections } from '../../source/src/content/definitions.js';
import {enqueueTreePreparation} from './information-tree-module.js';

export const FEED_SUBSCRIPTIONS_SYNC_JOB_TYPE = 'feed.subscriptions.sync';
export const FEED_ITEMS_ENRICH_JOB_TYPE = 'feed.items.enrich';
export const FEED_SUBSCRIPTION_SYNC_SCHEDULE_KEY = 'feed.subscriptions.sync.default';

const SYNC_LEASE_MS = 10 * 60_000;
const SYNC_RETRY_MS = 5 * 60_000;
const SYNC_CLAIM_LIMIT = 50;
export const FEED_SYNC_MAX_RUNTIME_MS = SYNC_LEASE_MS;

const SUPERSEDED_MESSAGE = '新的订阅同步开始，上一轮仍未结束';

export const feedAutomationManifest = Object.freeze({
  id: 'feed.automation',
  version: '1.0.0',
  capabilities: ['feed.subscriptions.sync', 'feed.items.enrich'],
  jobTypes: [FEED_SUBSCRIPTIONS_SYNC_JOB_TYPE, FEED_ITEMS_ENRICH_JOB_TYPE],
});

function replayMetadata(account) {
  const metadata = account?.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  return metadata;
}

export function createFeedAutomationJobHandlers({ feedService, feedRepository, taggingService,articleNormalizePort=null,treeEnabled=false }) {
  if (!feedService?.refreshPersistedSource || (!articleNormalizePort && !feedService?.localizeContentItems)) {
    throw new Error('feed automation jobs require feedService');
  }
  if (!feedRepository?.claimDueSubscriptions) throw new Error('feed automation jobs require feedRepository');
  if (!articleNormalizePort && !taggingService?.analyzeItems) throw new Error('feed automation jobs require taggingService');

  function ownsCurrentRun(context) {
    if (!context?.job?.id || !context?.store?.getJob) return true;
    const current = context.store.getJob(context.job.id);
    return !current || current.status === 'running';
  }

  return {
    [FEED_SUBSCRIPTIONS_SYNC_JOB_TYPE]: async (rawInput, context) => {
      const input = parseContract(FeedSubscriptionsSyncJobInputSchema, rawInput || {});
      const now = Date.now();
      const claimed = feedRepository.claimDueSubscriptions(now, input.limit || SYNC_CLAIM_LIMIT, SYNC_LEASE_MS);
      const subscriptions = [];
      let succeeded = 0;
      let failed = 0;
      let deferred = 0;
      let added = 0;

      for (const subscription of claimed) {
        if (!ownsCurrentRun(context)) {
          return {
            due: claimed.length,
            succeeded,
            failed,
            deferred,
            added,
            superseded: true,
            subscriptions,
          };
        }
        const account = feedRepository.getSourceAccount?.(subscription.sourceAccountId) || null;
        const metadata = replayMetadata(account);
        try {
          if (metadata.autoRefresh !== true) {
            feedRepository.deferSubscriptionSync(
              subscription.id,
              now,
              subscription.refreshIntervalMinutes * 60_000,
            );
            deferred += 1;
            subscriptions.push({
              subscriptionId: subscription.id,
              sourceId: metadata.sourceId || '',
              status: 'skipped',
              added: 0,
              reason: 'autoRefresh',
            });
            continue;
          }
          if (!metadata.sourceId || !metadata.sourceInput || typeof metadata.sourceInput !== 'object') {
            throw new Error('source account metadata 缺少可重放参数');
          }
          const stats = await feedService.refreshPersistedSource({
            workspaceId: subscription.workspaceId,
            sourceId: metadata.sourceId,
            sourceInput: metadata.sourceInput,
          });
          if (!ownsCurrentRun(context)) {
            return {
              due: claimed.length,
              succeeded,
              failed,
              deferred,
              added,
              superseded: true,
              subscriptions,
            };
          }
          if(stats?.mediaExternalIds?.length && context?.store?.createJob)context.store.createJob({type:'media.index.enrich',workspaceId:subscription.workspaceId,maxAttempts:2,input:{workspaceId:subscription.workspaceId,externalIds:stats.mediaExternalIds}});
          const addedItemIds = stats?.addedItemIds || [];
          if(treeEnabled && !articleNormalizePort)enqueueTreePreparation(context?.store,subscription.workspaceId,[...addedItemIds.map(id=>`feed:${id}`),...(stats?.mediaExternalIds || []).map(id=>`media:${id}`)]);
          if (!stats?.mediaExternalIds?.length && addedItemIds.length && context?.store?.createJob) {
            context.store.createJob({
              type: FEED_ITEMS_ENRICH_JOB_TYPE,
              workspaceId: subscription.workspaceId,
              maxAttempts: 2,
              input: {
                workspaceId: subscription.workspaceId,
                resourceIds: addedItemIds,
              },
            });
          }
          const completed = feedRepository.completeSubscriptionSync(subscription.id, Date.now());
          succeeded += 1;
          added += Number(stats?.added) || 0;
          subscriptions.push({
            subscriptionId: subscription.id,
            sourceId: metadata.sourceId,
            status: 'succeeded',
            added: Number(stats?.added) || 0,
            nextSyncAt: completed?.nextSyncAt || null,
          });
        } catch (error) {
          if (!ownsCurrentRun(context)) {
            return {
              due: claimed.length,
              succeeded,
              failed,
              deferred,
              added,
              superseded: true,
              subscriptions,
            };
          }
          const failedRow = feedRepository.failSubscriptionSync(subscription.id, Date.now(), SYNC_RETRY_MS);
          failed += 1;
          subscriptions.push({
            subscriptionId: subscription.id,
            sourceId: metadata.sourceId || '',
            status: 'failed',
            added: 0,
            error: String(error?.message || error),
            nextSyncAt: failedRow?.nextSyncAt || null,
          });
        }
      }

      return {
        due: claimed.length,
        succeeded,
        failed,
        deferred,
        added,
        subscriptions,
      };
    },

    [FEED_ITEMS_ENRICH_JOB_TYPE]: async (rawInput,context) => {
      const input = parseContract(FeedItemsEnrichJobInputSchema, rawInput || {});
      const resourceIds = input.resourceIds || [];
      if(treeEnabled && !articleNormalizePort)enqueueTreePreparation(context?.store,input.workspaceId,resourceIds.map(id=>`feed:${id}`));
      if (!resourceIds.length) {
        return {
          workspaceId: input.workspaceId,
          resourceIds: [],
          translated: 0,
          tagged: 0,
          skippedTagging: 0,
        };
      }
      if(articleNormalizePort)return articleNormalizePort.prepareInformation({workspaceId:input.workspaceId,sourceIds:resourceIds.map(id=>`feed:${id}`)});
      const localization = await feedService.localizeContentItems(input.workspaceId, resourceIds);
      const items = feedService.listTaggableItems(input.workspaceId, {
        ids: resourceIds,
        limit: resourceIds.length,
      });
      const tagging = await taggingService.analyzeItems({
        workspaceId: input.workspaceId,
        resourceType: 'content-item',
        items,
        force: false,
      });
      if (tagging.missingItemIds?.length) {
        throw new Error(`还有 ${tagging.missingItemIds.length} 条内容没有完成打标`);
      }
      if (localization.pendingIds?.length) throw new Error(`还有 ${localization.pendingIds.length} 条内容没有完成翻译；成功标签已保留`);
      return {
        workspaceId: input.workspaceId,
        resourceIds,
        translated: localization.translated || 0,
        tagged: tagging.saved?.length || 0,
        skippedTagging: tagging.skipped || 0,
      };
    },
  };
}

const PREVIOUS_X_REFRESH_MINUTES = 60;

export function ensureDefaultContentSubscriptions(feedRepository, workspaceId = 'local') {
  if (!feedRepository?.upsertSourceAccount || !feedRepository?.ensureSubscription) return [];
  const saved = [];
  for (const projection of defaultAutoRefreshProjections()) {
    const source = projection.sourceAccount;
    const account = feedRepository.upsertSourceAccount({
      workspaceId,
      provider: projection.providerId,
      externalId: source.externalId,
      displayName: source.displayName,
      profileUrl: source.profileUrl,
      authMode: source.authMode,
      metadata: source.metadata,
    });
    const interval = projection.refreshIntervalMinutes || 30;
    let subscription = feedRepository.ensureSubscription({
      workspaceId,
      sourceAccountId: account.id,
      enabled: true,
      refreshIntervalMinutes: interval,
    });
    if (subscription.refreshIntervalMinutes === PREVIOUS_X_REFRESH_MINUTES && interval === 30) {
      subscription = feedRepository.setSubscriptionRefreshInterval(subscription.id, interval) || subscription;
    }
    saved.push(subscription);
  }
  return saved;
}

export function prepareFeedSyncEnqueue(store, now = Date.now()) {
  const open = store.listOpenJobs?.(FEED_SUBSCRIPTIONS_SYNC_JOB_TYPE) || [];
  if (open.some((job) => job.status === 'queued')) return false;
  const running = open.filter((job) => job.status === 'running');
  const fresh = running.some((job) => !job.startedAt || now - job.startedAt < FEED_SYNC_MAX_RUNTIME_MS);
  if (fresh) return false;
  if (running.length) {
    store.abandonRunningJobs?.([FEED_SUBSCRIPTIONS_SYNC_JOB_TYPE], SUPERSEDED_MESSAGE, now);
    store.repositories?.feed?.releaseOpenSubscriptionLeases?.(now, FEED_SYNC_MAX_RUNTIME_MS);
  }
  return true;
}

export function ensureFeedSubscriptionSyncSchedule(store, now = Date.now()) {
  return store.upsertJobSchedule({
    workspaceId: 'local',
    key: FEED_SUBSCRIPTION_SYNC_SCHEDULE_KEY,
    jobType: FEED_SUBSCRIPTIONS_SYNC_JOB_TYPE,
    enabled: true,
    schedule: {
      kind: 'interval',
      intervalMinutes: 1,
    },
    input: {},
    priority: 0,
    maxAttempts: 2,
    nextRunAt: now,
  });
}
