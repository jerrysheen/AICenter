import { MEDIA_ENRICH_JOB_TYPE } from '../../connectors/src/media/index.js';
import { mediaResourceId } from '../../domain/src/media-ingestion-service.js';
import { mediaTranslationBatches } from '../../domain/src/media-translation.js';
import {enqueueTreePreparation} from './information-tree-module.js';

export function createMediaEnrichJobHandlers({ mediaService, feedService, taggingService, briefPort, articleNormalizePort=null, treeEnabled=false }) {
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
      const candidates = input.externalIds?.length ? input.externalIds : selected.length ? selected.map(r => r.externalId) : mediaService.listBodyCandidates(workspaceId);
      // Forty is a request batch size, not a quota for the enrichment job.
      const bodies = { ok: true, fetched: [], stats: {} };
      for (let offset = 0; offset < candidates.length; offset += 40) {
        const batch = await mediaService.fetchBodies({
          workspaceId,
          externalIds: candidates.slice(offset, offset + 40),
          repair: input.repair === true,
          selectedReasons: Object.fromEntries(selected.map(r => [r.externalId,r.reason])),
        });
        bodies.fetched.push(...(batch.fetched || []));
        if(treeEnabled && !articleNormalizePort)enqueueTreePreparation(context?.store,workspaceId,candidates.slice(offset,offset+40).map(id=>`media:${id}`));
        if (batch.health) bodies.health = batch.health;
        for (const [key, value] of Object.entries(batch.stats || {})) bodies.stats[key] = (bodies.stats[key] || 0) + value;
      }
      const explicit = input.externalIds?.length ? new Set(input.externalIds) : null;
      if(treeEnabled && !articleNormalizePort)enqueueTreePreparation(context?.store,workspaceId,[...new Set([...candidates,...bodies.fetched.map(row=>row.externalId)])].map(id=>`media:${id}`));
      const items = mediaService.listEnrichmentItems(workspaceId, 120, candidates).filter(item => !explicit || explicit.has(item.externalId));
      if(articleNormalizePort)return articleNormalizePort.prepareInformation({workspaceId,sourceIds:items.map(item=>`media:${item.externalId}`)});
      const briefIds = explicit ? [...explicit] : [...new Set([...candidates, ...items.map(i => i.externalId)])];
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
