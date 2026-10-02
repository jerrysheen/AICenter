import { MEDIA_ENRICH_JOB_TYPE } from '../../connectors/src/media/index.js';
import { mediaResourceId } from '../../domain/src/media-ingestion-service.js';
import { mediaTranslationBatches } from '../../domain/src/media-translation.js';

export function createMediaEnrichJobHandlers({ mediaService, feedService, taggingService, briefPort }) {
  if (!mediaService?.fetchBodies || !mediaService?.listBodyCandidates || !mediaService?.listEnrichmentItems) {
    throw new Error('media enrich jobs require mediaService');
  }
  if (!feedService?.localizeTexts) throw new Error('media enrich jobs require feedService');
  if (!taggingService?.analyzeItems) throw new Error('media enrich jobs require taggingService');

  return {
    [MEDIA_ENRICH_JOB_TYPE]: async (input = {}) => {
      const workspaceId = input.workspaceId || 'local';
      const discovery = mediaService.discoverOriginals?.(workspaceId) || {added:0};
      const selected = mediaService.selectBodyCandidates?.(workspaceId) || [];
      const candidates = input.externalIds?.length ? input.externalIds : selected.length ? selected.map(r => r.externalId) : mediaService.listBodyCandidates(workspaceId);
      const bodies = candidates.length
        ? await mediaService.fetchBodies({
          workspaceId,
          externalIds: candidates,
          repair: input.repair === true,
          selectedReasons: Object.fromEntries(selected.map(r => [r.externalId,r.reason])),
        })
        : { ok: true, fetched: [] };
      const explicit = input.externalIds?.length ? new Set(input.externalIds) : null;
      const briefIds = explicit ? [...explicit] : [...new Set([...candidates, ...mediaService.listEnrichmentItems(workspaceId).map(i => i.externalId)])];
      const items = mediaService.listEnrichmentItems(workspaceId).filter(item => !explicit || explicit.has(item.externalId));
      const units = items.filter(item => item.contentLevel !== 'full').map((item) => ({
        id: item.resourceId,
        localizationId: item.resourceId,
        text: item.text,
      }));
      const fullUnits = mediaService.listArticleTranslationUnits?.(workspaceId,items.map(item=>item.externalId)) || [];
      let pendingIds = [];
      let translated = 0;
      for (const batch of mediaTranslationBatches([...units,...fullUnits])) {
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
      const tagging = stableItems.length
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
      // Reading, full translation and the shared X tag flow take priority over optional summaries.
      const briefs = await mediaService.generateBodyBriefs?.({ workspaceId, externalIds: briefIds, briefPort, retryFailed: Boolean(explicit) }) || [];
      const fetched = bodies.fetched || [];
      return {
        workspaceId,
        health: pendingIds.length || briefs.some(b => ['failed','unavailable'].includes(b.status)) ? 'partial' : bodies.health || 'ready',
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
        skippedTagging: tagging.skipped || 0,
      };
    },
  };
}
