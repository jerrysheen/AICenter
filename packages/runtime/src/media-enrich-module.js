import { MEDIA_ENRICH_JOB_TYPE } from '../../connectors/src/media/index.js';
import { mediaResourceId } from '../../domain/src/media-ingestion-service.js';
import { mediaTranslationBatches } from '../../domain/src/media-translation.js';
import {enqueueTreePreparation} from './information-tree-module.js';
import { translationTitleBatchLimit } from '../../domain/src/feed-ai-batch.js';
import { TRANSLATION_BACKFILL_PRIORITY, TRANSLATION_INTERACTIVE_PRIORITY, enqueueOriginalTranslations } from './feed-translation-module.js';

const MEDIA_ENRICH_BUDGET_FALLBACK_MS = 4 * 60_000;

export function mediaEnrichBudgetMs(value = process.env.AI_CENTER_MEDIA_ENRICH_BUDGET_MS) {
  const parsed = Number(value);
  const chosen = Number.isFinite(parsed) && parsed > 0 ? parsed : MEDIA_ENRICH_BUDGET_FALLBACK_MS;
  return Math.min(6 * 60_000, Math.max(30_000, Math.floor(chosen)));
}

function enrichPastBudget(signal, deadlineAt) {
  return Boolean(signal?.aborted) || Date.now() >= deadlineAt;
}

function enqueueEnrichRemainder(store, workspaceId, externalIds) {
  const ids = [...new Set((externalIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length || !store?.createJob) return 0;
  store.createJob({
    type: MEDIA_ENRICH_JOB_TYPE,
    workspaceId,
    maxAttempts: 2,
    input: { workspaceId, externalIds: ids },
  });
  console.log(`[worker] media-enrich yield remaining=${ids.length}`);
  return ids.length;
}

export function createMediaEnrichJobHandlers({ mediaService, feedService, taggingService, briefPort, articleNormalizePort=null, treeEnabled=false, budgetMs=null }) {
  if (!mediaService?.fetchBodies || !mediaService?.listBodyCandidates || !mediaService?.listEnrichmentItems) {
    throw new Error('media enrich jobs require mediaService');
  }
  if (!articleNormalizePort && !feedService?.localizeTexts) throw new Error('media enrich jobs require feedService');
  if (!taggingService?.analyzeItems) taggingService={analyzeItems:async()=>{throw new Error('tagging unavailable');}};

  return {
    [MEDIA_ENRICH_JOB_TYPE]: async (input = {},context) => {
      const workspaceId = input.workspaceId || 'local';
      const discovery = mediaService.discoverOriginals?.(workspaceId) || {added:0};
      const selected = mediaService.selectBodyCandidates?.(workspaceId, 10_000) || [];
      const requested = input.externalIds?.length ? input.externalIds : selected.length ? selected.map(r => r.externalId) : mediaService.listBodyCandidates(workspaceId);
      const flashIds = new Set(mediaService.flashExternalIds?.(workspaceId, requested) || []);
      const candidates = requested.filter((id) => !flashIds.has(id));
      // Forty is a request batch size, not a quota for the enrichment job.
      // Flash rows are still fetched so the plain list can show them. Tree, translation and tagging stay on fuller articles.
      const bodies = { ok: true, fetched: [], stats: {} };
      const startedAt = Date.now();
      const deadlineAt = startedAt + (budgetMs == null ? mediaEnrichBudgetMs() : Math.max(0, Number(budgetMs) || 0));
      let cursor = 0;
      let yielded = 0;
      let stopped = false;
      while (cursor < requested.length) {
        if (enrichPastBudget(context?.signal, deadlineAt)) {
          yielded = enqueueEnrichRemainder(context?.store, workspaceId, requested.slice(cursor));
          stopped = true;
          break;
        }
        const slice = requested.slice(cursor, cursor + 40);
        const batchStarted = Date.now();
        const batch = await mediaService.fetchBodies({
          workspaceId,
          externalIds: slice,
          repair: input.repair === true,
          selectedReasons: Object.fromEntries(selected.map(r => [r.externalId,r.reason])),
          signal: context?.signal,
          deadlineAt,
        });
        const processed = Number.isInteger(batch.processed) ? batch.processed : slice.length;
        console.log(`[worker] media-enrich batch=${cursor} size=${slice.length} processed=${processed} durationMs=${Date.now() - batchStarted} stopped=${batch.stoppedEarly ? 1 : 0}`);
        bodies.fetched.push(...(batch.fetched || []));
        const handled = slice.slice(0, Math.max(0, processed));
        const treeIds = handled.filter((id) => !flashIds.has(id));
        if(treeEnabled && !articleNormalizePort && treeIds.length)enqueueTreePreparation(context?.store,workspaceId,treeIds.map(id=>`media:${id}`));
        if (batch.health) bodies.health = batch.health;
        for (const [key, value] of Object.entries(batch.stats || {})) bodies.stats[key] = (bodies.stats[key] || 0) + value;
        if (processed <= 0) {
          yielded = enqueueEnrichRemainder(context?.store, workspaceId, requested.slice(cursor));
          stopped = true;
          break;
        }
        cursor += processed;
        if (batch.stoppedEarly || cursor < requested.length && enrichPastBudget(context?.signal, deadlineAt)) {
          yielded = enqueueEnrichRemainder(context?.store, workspaceId, requested.slice(cursor));
          stopped = true;
          break;
        }
      }
      if (!stopped && requested.length && enrichPastBudget(context?.signal, deadlineAt)) {
        yielded = enqueueEnrichRemainder(context?.store, workspaceId, requested);
        stopped = true;
      }
      if (stopped) {
        return {
          workspaceId,
          health: 'partial',
          yielded: true,
          remaining: yielded,
          discovery,
          bodyStats: bodies.stats || {},
          bodiesFetched: (bodies.fetched || []).filter((item) => item.contentLevel === 'full' && !item.skipped).length,
          durationMs: Date.now() - startedAt,
        };
      }
      const explicit = input.externalIds?.length ? new Set(input.externalIds) : null;
      const fetchedForTree = bodies.fetched.map((row) => row.externalId).filter((id) => !flashIds.has(id));
      if(treeEnabled && !articleNormalizePort)enqueueTreePreparation(context?.store,workspaceId,[...new Set([...candidates,...fetchedForTree])].map(id=>`media:${id}`));
      const items = mediaService.listEnrichmentItems(workspaceId, 120, candidates).filter(item => !explicit || explicit.has(item.externalId));
      if(articleNormalizePort) {
        const canQueue = Boolean(context?.store?.createJob && feedService?.localizeTexts);
        const articleUnits = canQueue
          ? mediaService.listArticleTranslationUnits?.(workspaceId, items.map(item => item.externalId)) || []
          : [];
        const summaryUnits = canQueue
          ? items.filter(item => item.contentLevel !== 'full').map((item) => ({
            id: item.resourceId,
            localizationId: item.resourceId,
            text: item.text,
          })).filter(unit => unit.id && unit.text)
          : [];
        const titleUnits = articleUnits.filter((unit) => unit.kind === 'heading' || unit.paragraphId === 'title');
        const bodyUnits = articleUnits.filter((unit) => unit.kind !== 'heading' && unit.paragraphId !== 'title');
        await enqueueOriginalTranslations({
          store: context?.store, feedService, workspaceId, units: bodyUnits, priority: TRANSLATION_BACKFILL_PRIORITY,
        });
        await enqueueOriginalTranslations({
          store: context?.store, feedService, workspaceId, units: summaryUnits, priority: TRANSLATION_INTERACTIVE_PRIORITY,
        });
        await enqueueOriginalTranslations({
          store: context?.store, feedService, workspaceId, units: titleUnits, priority: TRANSLATION_INTERACTIVE_PRIORITY,
          unitLimit: translationTitleBatchLimit(process.env.AI_CENTER_TRANSLATION_TITLE_BATCH_LIMIT),
        });
        return articleNormalizePort.prepareInformation({workspaceId,sourceIds:items.map(item=>`media:${item.externalId}`)});
      }
      const briefIds = (explicit ? [...explicit] : [...new Set([...candidates, ...items.map(i => i.externalId)])]).filter((id) => !flashIds.has(id));
      const units = items.filter(item => item.contentLevel !== 'full').map((item) => ({
        id: item.resourceId,
        localizationId: item.resourceId,
        text: item.text,
      }));
      const fullUnits = mediaService.listArticleTranslationUnits?.(workspaceId,items.map(item=>item.externalId)) || [];
      let pendingIds = [];
      let translated = 0;
      for (const batch of mediaTranslationBatches([...fullUnits,...units])) {
        const localization = await feedService.localizeTexts(batch, { workspaceId });
        pendingIds.push(...(localization.pendingIds || []));
        translated += batch.length - (localization.pendingIds?.length || 0);
      }
      const freshIds = new Set((bodies.fetched || [])
        .filter((item) => item.contentLevel === 'full' && !item.skipped)
        .map((item) => mediaResourceId(item.externalId)));
      const priorTags = new Map((taggingService.listTaggings?.(workspaceId,'media-index',items.map(i=>i.resourceId)) || []).map(r=>[r.resourceId,r]));
      for (const item of items) {
        const saved=priorTags.get(item.resourceId);
        if (saved && item.bodyObservedAt > saved.analyzedAt) freshIds.add(item.resourceId);
      }
      const toTagItem = (item) => ({
        id: item.resourceId,
        source: item.source,
        author: item.author,
        title: item.title,
        summary: item.summary,
        body: item.body,
      });
      const stableItems=items.filter(item=>!freshIds.has(item.resourceId));
      let tagging={saved:[],skipped:0,missingItemIds:[]}, taggingError='';
      try {
      tagging = stableItems.length
        ? await taggingService.analyzeItems({
          workspaceId,
          resourceType: 'media-index',
          items: stableItems.map(toTagItem),
          force: false,
        })
        : { saved: [], skipped: 0, missingItemIds: [] };
      const freshItems = items.filter((item) => freshIds.has(item.resourceId));
      if (freshItems.length) {
        const refreshed = await taggingService.analyzeItems({
          workspaceId,
          resourceType: 'media-index',
          items: freshItems.map(toTagItem),
          force: true,
        });
        tagging.saved = [...(tagging.saved || []), ...(refreshed.saved || [])];
        tagging.missingItemIds = [...new Set([...(tagging.missingItemIds || []), ...(refreshed.missingItemIds || [])])];
      }
      if (tagging.missingItemIds?.length) {
        throw new Error(`还有 ${tagging.missingItemIds.length} 条媒体索引没有完成打标`);
      }
      } catch {
        taggingError='tagging_unavailable';
        const saved=new Set((tagging.saved || []).map(row=>row.resourceId));
        tagging.missingItemIds=items.filter(item=>!saved.has(item.resourceId)&&(!priorTags.has(item.resourceId)||freshIds.has(item.resourceId))).map(item=>item.resourceId);
      }
      // Reading, full translation and the shared X tag flow take priority over optional summaries.
      const briefs = treeEnabled ? [] : await mediaService.generateBodyBriefs?.({ workspaceId, externalIds: briefIds, briefPort, retryFailed: Boolean(explicit) }) || [];
      const fetched = bodies.fetched || [];
      return {
        workspaceId,
        health: taggingError || pendingIds.length || briefs.some(b => ['failed','unavailable'].includes(b.status)) ? 'partial' : bodies.health || 'ready',
        discovery,
        translationStats: {totalChunks: fullUnits.length, pendingChunks: pendingIds.filter(id=>fullUnits.some(u=>u.id===id)).length},
        bodyStats: bodies.stats || {},
        bodyFailures: fetched.filter(item => !['ready','not_modified'].includes(item.health)),
        bodiesFailed: bodies.stats?.failed || 0,
        bodiesPartial: bodies.stats?.partial || 0,
        briefs,
        considered: items.length,
        bodiesFetched: fetched.filter((item) => item.contentLevel === 'full' && !item.skipped).length,
        bodiesSkipped: fetched.filter((item) => item.skipped).length,
        bodiesDeferred: fetched.filter((item) => item.health === 'budget_deferred').length,
        translated,
        tagged: tagging.saved?.length || 0,
        taggingStatus: taggingError ? 'pending' : 'ready',
        taggingError,
        pendingTagIds: tagging.missingItemIds || [],
        skippedTagging: tagging.skipped || 0,
      };
    },
  };
}
