import { createHash } from 'node:crypto';
import { FeedItemsEnrichJobInputSchema, FeedSubscriptionSyncJobInputSchema, FeedSubscriptionsSyncJobInputSchema, parseContract } from '../../contracts/src/index.js';
import { translationChunkChars } from '../../connectors/src/translate/index.js';
import { needsZhLocalization, translationLooksTruncated } from '../../domain/src/localize-texts.js';
import { defaultAutoRefreshProjections } from '../../source/src/content/definitions.js';
import {enqueueTreePreparation} from './information-tree-module.js';
import { TRANSLATION_BACKFILL_PRIORITY, enqueueOriginalTranslations } from './feed-translation-module.js';

export const FEED_SUBSCRIPTIONS_SYNC_JOB_TYPE = 'feed.subscriptions.sync';
export const FEED_SUBSCRIPTION_SYNC_JOB_TYPE = 'feed.subscription.sync';
export const FEED_ITEMS_ENRICH_JOB_TYPE = 'feed.items.enrich';
export const FEED_SUBSCRIPTION_SYNC_SCHEDULE_KEY = 'feed.subscriptions.sync.default';

const SYNC_LEASE_MS = 10 * 60_000;
const SYNC_RETRY_MS = 5 * 60_000;
const SYNC_CLAIM_LIMIT = 50;
const SOURCE_TIMEOUT_FALLBACK_MS = 180_000;
// Shared by the claim lease and recoverStaleJobs so the job wall clock stays
// strictly after the per-source AbortController.
export const FEED_SYNC_RECOVER_BUFFER_MS = 120_000;
export const FEED_SYNC_MAX_RUNTIME_MS = SYNC_LEASE_MS;

export function feedSyncSourceTimeoutMs(value = process.env.AI_CENTER_FEED_SYNC_SOURCE_TIMEOUT_MS) {
  const parsed = Number(value);
  const chosen = Number.isFinite(parsed) && parsed > 0 ? parsed : SOURCE_TIMEOUT_FALLBACK_MS;
  return Math.min(3 * 60_000, Math.max(15_000, Math.floor(chosen)));
}

export function feedSubscriptionSyncMaxRunningMs(value = process.env.AI_CENTER_FEED_SYNC_SOURCE_TIMEOUT_MS) {
  return feedSyncSourceTimeoutMs(value) + FEED_SYNC_RECOVER_BUFFER_MS;
}

export function feedPreprocessMergedEnabled(env = process.env) {
  const value = String(env?.AI_CENTER_FEED_PREPROCESS_MERGED ?? '').trim().toLowerCase();
  return value === '1' || value === 'true';
}

// Short means the text already fits in one translation chunk (default 1500).
// Longer items stay on the separate tag call and translation job.
export function feedPreprocessShortLimit(env = process.env) {
  return translationChunkChars(env?.AI_CENTER_TRANSLATION_CHUNK_CHARS);
}

export function feedPreprocessSourceText(item) {
  return String(item?.body || item?.summary || item?.title || '').trim();
}

function preprocessSourceHash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export const feedAutomationManifest = Object.freeze({
  id: 'feed.automation',
  version: '1.0.0',
  capabilities: ['feed.subscriptions.sync', 'feed.subscription.sync', 'feed.items.enrich'],
  jobTypes: [FEED_SUBSCRIPTIONS_SYNC_JOB_TYPE, FEED_SUBSCRIPTION_SYNC_JOB_TYPE, FEED_ITEMS_ENRICH_JOB_TYPE],
});

function replayMetadata(account) {
  const metadata = account?.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  return metadata;
}

export function createFeedAutomationJobHandlers({ feedService, feedRepository, taggingService,articleNormalizePort=null,treeEnabled=false, sourceTimeoutMs=null, env=process.env, log=console.log }) {
  if (!feedService?.refreshPersistedSource || (!articleNormalizePort && !feedService?.localizeContentItems)) {
    throw new Error('feed automation jobs require feedService');
  }
  if (!feedRepository?.claimDueSubscriptions) throw new Error('feed automation jobs require feedRepository');
  if (!articleNormalizePort && !taggingService?.analyzeItems) throw new Error('feed automation jobs require taggingService');

  async function tagContentItems(workspaceId, items) {
    if (!items.length) return { saved: [], skipped: 0, missingItemIds: [] };
    if (!taggingService?.analyzeItems) throw new Error('feed automation jobs require taggingService');
    const tagging = await taggingService.analyzeItems({
      workspaceId,
      resourceType: 'content-item',
      items,
      force: false,
    });
    if (tagging.missingItemIds?.length) {
      throw new Error(`还有 ${tagging.missingItemIds.length} 条内容没有完成打标`);
    }
    return tagging;
  }

  function translationComplete(workspaceId, itemId, source) {
    const rows = feedRepository?.listTranslations?.(workspaceId, [itemId], 'zh') || [];
    const row = rows.find((entry) => entry.itemId === itemId);
    if (!row?.translatedText || row.sourceHash !== preprocessSourceHash(source)) return false;
    return !translationLooksTruncated(source, String(row.translatedText).length, row.translatedText);
  }

  function taggingPresent(workspaceId, itemId) {
    return Boolean(taggingService?.getTagging?.(workspaceId, 'content-item', itemId));
  }

  async function mergeEligibleShortItems(workspaceId, resourceIds) {
    const done = new Set();
    if (!feedPreprocessMergedEnabled(env) || !taggingService?.preprocessShortItem || !resourceIds.length) return done;
    const limit = feedPreprocessShortLimit(env);
    const rows = feedService.listTaggableItems?.(workspaceId, { ids: resourceIds, limit: resourceIds.length }) || [];
    for (const row of rows) {
      const source = feedPreprocessSourceText(row);
      if (!source || source.length > limit || !needsZhLocalization(source)) continue;
      if (translationComplete(workspaceId, row.id, source) || taggingPresent(workspaceId, row.id)) continue;
      try {
        const result = await taggingService.preprocessShortItem({
          workspaceId,
          item: row,
          originalText: source,
        });
        if (!feedService?.persistItemTranslations) throw new Error('feed enrich 缺少译文保存');
        feedService.persistItemTranslations([{
          id: result.resourceId,
          sourceText: result.sourceText,
          translatedText: result.translatedText,
          targetLang: 'zh',
          engine: result.engine,
        }], { workspaceId });
        if (!translationComplete(workspaceId, row.id, source)) throw new Error('合并预处理译文没有写入');
        done.add(row.id);
      } catch (error) {
        const failure = tagFailure(error, 1);
        const id = String(row.id || '').replace(/[\s=]/g, '').slice(0, 80) || '-';
        log(`[worker] feed-enrich preprocess failed id=${id} category=${failure.category}`);
      }
    }
    return done;
  }

  function tagFailure(error, itemCount) {
    const message = String(error?.message || '');
    const incomplete = message.match(/还有 (\d+) 条内容没有完成打标/);
    const status = Number(error?.upstreamStatus);
    let category = 'tagging';
    if (error?.code === 'budget-deferred') category = 'budget-deferred';
    else if (status === 429 || /429|RESOURCE_EXHAUSTED|配额/.test(message)) category = 'rate-limit';
    else if ((status >= 500 && status <= 599) || /（5\d\d）|\b5\d\d\b|上游/.test(message)) category = 'upstream';
    else if (incomplete) category = 'incomplete';
    return { count: incomplete ? Number(incomplete[1]) : itemCount, category };
  }

  function timeoutMs() {
    if (sourceTimeoutMs != null) {
      const parsed = Number(sourceTimeoutMs);
      if (Number.isFinite(parsed) && parsed > 0) return Math.min(3 * 60_000, Math.floor(parsed));
    }
    return feedSyncSourceTimeoutMs();
  }

  function feedOf(metadata) {
    const value = metadata?.sourceInput?.feed ?? metadata?.sourceInput?.channel ?? '';
    return typeof value === 'string' ? value : '';
  }

  function logSync(fields) {
    const body = Object.entries(fields).map(([key, value]) => `${key}=${value}`).join(' ');
    log(`[worker] feed-sync ${body}`);
  }

  function openSourceIds(store) {
    const jobs = store?.listOpenJobs?.(FEED_SUBSCRIPTION_SYNC_JOB_TYPE) || [];
    return new Set(jobs.map((job) => String(job.input?.subscriptionId || '')).filter(Boolean));
  }

  async function syncOneSubscription(subscription, context, startedAt) {
    const account = feedRepository.getSourceAccount?.(subscription.sourceAccountId) || null;
    const metadata = replayMetadata(account);
    const sourceId = typeof metadata.sourceId === 'string' ? metadata.sourceId.trim() : '';
    const feed = feedOf(metadata);
    const finish = (status, extra = {}) => {
      const row = {
        subscriptionId: subscription.id,
        sourceId,
        feed,
        status,
        added: Number(extra.added) || 0,
        durationMs: Date.now() - startedAt,
        ...extra,
      };
      logSync({
        source: sourceId || '-',
        feed: feed || '-',
        subscription: subscription.id,
        status,
        durationMs: row.durationMs,
        added: row.added,
        ...(extra.reason ? { reason: extra.reason } : {}),
      });
      return row;
    };
    const leaseUntil = subscription.leaseUntil;
    if (context?.signal?.aborted) {
      return finish('interrupted', { reason: 'signal' });
    }
    if (metadata.autoRefresh !== true) {
      const linkOnly = metadata.sourceId === 'content.bilibili.import';
      const parked = linkOnly
        ? feedRepository.completeSubscriptionSync(subscription.id, Date.now(), leaseUntil)
        : feedRepository.deferSubscriptionSync(subscription.id, Date.now(), subscription.refreshIntervalMinutes * 60_000, leaseUntil);
      return finish(parked ? 'skipped' : 'stale-lease', { reason: linkOnly ? 'bilibili-link-only' : 'autoRefresh', nextSyncAt: parked?.nextSyncAt || null });
    }
    if (!sourceId) {
      const parked = feedRepository.deferSubscriptionSync(subscription.id, Date.now(), subscription.refreshIntervalMinutes * 60_000, leaseUntil);
      return finish(parked ? 'skipped' : 'stale-lease', { reason: 'empty-source-id', nextSyncAt: parked?.nextSyncAt || null });
    }
    if (!metadata.sourceInput || typeof metadata.sourceInput !== 'object') {
      const failedRow = feedRepository.failSubscriptionSync(subscription.id, Date.now(), SYNC_RETRY_MS, leaseUntil);
      return finish(failedRow ? 'failed' : 'stale-lease', { error: 'source account metadata 缺少可重放参数', nextSyncAt: failedRow?.nextSyncAt || null });
    }
    const limit = timeoutMs();
    const deadlineAt = startedAt + limit;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limit);
    const onParentAbort = () => controller.abort();
    context?.signal?.addEventListener('abort', onParentAbort, { once: true });
    try {
      const stats = await feedService.refreshPersistedSource({
        workspaceId: subscription.workspaceId,
        sourceId,
        sourceInput: metadata.sourceInput,
        signal: controller.signal,
        deadlineAt,
      });
      if (stats?.mediaExternalIds?.length && context?.store?.createJob) {
        context.store.createJob({
          type: 'media.index.enrich',
          workspaceId: subscription.workspaceId,
          maxAttempts: 2,
          input: { workspaceId: subscription.workspaceId, externalIds: stats.mediaExternalIds },
        });
      }
      const addedItemIds = stats?.addedItemIds || [];
      if (treeEnabled && !articleNormalizePort) {
        enqueueTreePreparation(context?.store, subscription.workspaceId, [
          ...addedItemIds.map((id) => `feed:${id}`),
          ...(stats?.mediaExternalIds || []).map((id) => `media:${id}`),
        ]);
      }
      if (!stats?.mediaExternalIds?.length && addedItemIds.length && context?.store?.createJob) {
        context.store.createJob({
          type: FEED_ITEMS_ENRICH_JOB_TYPE,
          workspaceId: subscription.workspaceId,
          maxAttempts: 2,
          input: { workspaceId: subscription.workspaceId, resourceIds: addedItemIds },
        });
      }
      if (context?.signal?.aborted) {
        return finish('interrupted', { added: Number(stats?.added) || 0, reason: 'signal' });
      }
      const added = Number(stats?.added) || 0;
      if (stats?.deadline && added <= 0) {
        const retryRow = feedRepository.failSubscriptionSync(subscription.id, Date.now(), SYNC_RETRY_MS, leaseUntil);
        return finish(retryRow ? 'deadline' : 'stale-lease', {
          added: 0,
          reason: 'deadline',
          nextSyncAt: retryRow?.nextSyncAt || null,
        });
      }
      const completed = feedRepository.completeSubscriptionSync(subscription.id, Date.now(), leaseUntil);
      return finish(completed ? (stats?.deadline ? 'deadline' : 'succeeded') : 'stale-lease', {
        added,
        nextSyncAt: completed?.nextSyncAt || null,
      });
    } catch (error) {
      const message = String(error?.message || error).slice(0, 300);
      if (context?.signal?.aborted) {
        return finish('interrupted', { reason: 'signal', error: message });
      }
      const deadlineStop = controller.signal.aborted || error?.deadline === true || error?.code === 'deadline';
      if (deadlineStop) {
        const retryRow = feedRepository.failSubscriptionSync(subscription.id, Date.now(), SYNC_RETRY_MS, leaseUntil);
        return finish(retryRow ? 'deadline' : 'stale-lease', {
          added: 0,
          reason: 'deadline',
          error: message,
          nextSyncAt: retryRow?.nextSyncAt || null,
        });
      }
      const failedRow = feedRepository.failSubscriptionSync(subscription.id, Date.now(), SYNC_RETRY_MS, leaseUntil);
      return finish(failedRow ? 'failed' : 'stale-lease', {
        error: message,
        nextSyncAt: failedRow?.nextSyncAt || null,
      });
    } finally {
      clearTimeout(timer);
      context?.signal?.removeEventListener('abort', onParentAbort);
    }
  }

  return {
    [FEED_SUBSCRIPTIONS_SYNC_JOB_TYPE]: async (rawInput, context) => {
      const input = parseContract(FeedSubscriptionsSyncJobInputSchema, rawInput || {});
      const now = Date.now();
      const due = feedRepository.listDueSubscriptions(now, input.limit || SYNC_CLAIM_LIMIT);
      const open = openSourceIds(context?.store);
      const subscriptions = [];
      let enqueued = 0;
      for (const subscription of due) {
        if (open.has(subscription.id)) {
          subscriptions.push({ subscriptionId: subscription.id, status: 'already-running' });
          continue;
        }
        if (!context?.store?.createJob) throw new Error('feed subscription sync requires a job store');
        context.store.createJob({
          type: FEED_SUBSCRIPTION_SYNC_JOB_TYPE,
          workspaceId: subscription.workspaceId,
          maxAttempts: 2,
          input: { workspaceId: subscription.workspaceId, subscriptionId: subscription.id },
        });
        open.add(subscription.id);
        enqueued += 1;
        subscriptions.push({ subscriptionId: subscription.id, status: 'enqueued' });
      }
      logSync({ status: 'dispatch', due: due.length, enqueued, alreadyRunning: due.length - enqueued });
      return { due: due.length, enqueued, subscriptions };
    },

    [FEED_SUBSCRIPTION_SYNC_JOB_TYPE]: async (rawInput, context) => {
      const input = parseContract(FeedSubscriptionSyncJobInputSchema, rawInput || {});
      const startedAt = Date.now();
      const leaseMs = timeoutMs() + FEED_SYNC_RECOVER_BUFFER_MS;
      const subscription = feedRepository.claimSubscription?.(input.subscriptionId, startedAt, leaseMs) || null;
      if (!subscription) {
        logSync({ source: '-', feed: '-', subscription: input.subscriptionId, status: 'skipped', durationMs: 0, added: 0, reason: 'not-due' });
        return { subscriptionId: input.subscriptionId, status: 'skipped', reason: 'not-due', added: 0, durationMs: 0 };
      }
      return syncOneSubscription(subscription, context, startedAt);
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
      const merged = await mergeEligibleShortItems(input.workspaceId, resourceIds);
      if(articleNormalizePort) {
        const rows = feedService.listTaggableItems?.(input.workspaceId, { ids: resourceIds, limit: resourceIds.length }) || [];
        const pendingRows = merged.size ? rows.filter((row) => !merged.has(row.id)) : rows;
        // Article normalize writes a tree tagId. It does not write resource_taggings.
        // Short-post tags still go through the Gemma tagging service before the tree job is queued.
        // A tagging failure must not stop the tree job.
        let tagging = { saved: [], skipped: 0 };
        let taggingError = '';
        let taggingFailed = 0;
        try {
          tagging = await tagContentItems(input.workspaceId, pendingRows);
        } catch (error) {
          const failure = tagFailure(error, pendingRows.length);
          taggingError = failure.category;
          taggingFailed = failure.count;
          log(`[worker] feed-enrich tagging failed count=${taggingFailed} category=${taggingError}`);
        }
        const units = rows.map(row => ({ id: row.id, text: row.body || row.summary || row.title || '' })).filter(row => row.text);
        await enqueueOriginalTranslations({
          store: context?.store, feedService, workspaceId: input.workspaceId, units, priority: TRANSLATION_BACKFILL_PRIORITY,
        });
        const prepared = await articleNormalizePort.prepareInformation({workspaceId:input.workspaceId,sourceIds:resourceIds.map(id=>`feed:${id}`)});
        return {
          ...(prepared && typeof prepared === 'object' ? prepared : {}),
          workspaceId: input.workspaceId,
          resourceIds,
          tagged: taggingError ? merged.size : (tagging.saved?.length || 0) + merged.size,
          skippedTagging: taggingError ? 0 : (tagging.skipped || 0),
          ...(taggingError ? { taggingFailed, taggingError } : {}),
        };
      }
      const localizationIds = merged.size ? resourceIds.filter((id) => !merged.has(id)) : resourceIds;
      const localization = await feedService.localizeContentItems(input.workspaceId, localizationIds);
      const items = feedService.listTaggableItems(input.workspaceId, {
        ids: resourceIds,
        limit: resourceIds.length,
      });
      const pendingItems = merged.size ? items.filter((row) => !merged.has(row.id)) : items;
      const tagging = await tagContentItems(input.workspaceId, pendingItems);
      if (localization.pendingIds?.length) throw new Error(`还有 ${localization.pendingIds.length} 条内容没有完成翻译；成功标签已保留`);
      return {
        workspaceId: input.workspaceId,
        resourceIds,
        translated: (localization.translated || 0) + merged.size,
        tagged: (tagging.saved?.length || 0) + merged.size,
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

export function prepareFeedSyncEnqueue(store) {
  const open = store.listOpenJobs?.(FEED_SUBSCRIPTIONS_SYNC_JOB_TYPE) || [];
  // A dispatcher that is still enqueueing keeps its place. It does not cancel
  // source jobs or release leases those jobs already claimed.
  if (open.length) return false;
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
