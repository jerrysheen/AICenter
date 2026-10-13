import {material,materialHash,paragraphs,socialParagraphs} from './daily-materials.js';
import { isFlashSource } from './flash-sources.js';

function keepHourlyCandidate(row, flashSources) {
  return !isFlashSource({
    id: row.id,
    sourceExternalId: row.sourceExternalId,
    sourceKey: row.sourceKey,
    publisher: row.sourceName || row.publisher,
    displayName: row.sourceName,
  }, flashSources);
}

export function createTreeMaterialPort({feedService,mediaService,flashSources=null}) {
  return {
    async candidates(workspaceId,window) {
      const rows=[];let cursor=null;
      while(true) {
        const page=feedService.listContentItemsInWindow(workspaceId,{...window,timeBasis:'ingested',metadataOnly:true,limit:500,cursor});rows.push(...page);
        if(page.length<500)break;
        const last=page.at(-1);cursor={id:last.id.slice(5),eventAt:last.eventAt};
      }
      const media=mediaService?.informationCandidates(workspaceId,window) || [];
      return [...rows,...media].filter(row=>keepHourlyCandidate(row, flashSources));
    },
    async materials(workspaceId,sourceIds) {
      const feedIds=sourceIds.filter(id=>id.startsWith('feed:')).map(id=>id.slice(5));
      const approved=new Set(feedIds.length ? feedService.listTaggableItems(workspaceId,{ids:feedIds,limit:feedIds.length}).map(item=>item.id) : []);
      const sourceNames=new Map((feedService.listItemSources?.(workspaceId, feedIds) || []).map(row=>[row.id, row]));
      const feeds=feedIds.filter(id=>approved.has(id)).map(id=>feedService.getContentItem(workspaceId,id)).filter(Boolean).map(item=>{
        const social=['x','twitter','xueqiu'].includes(item.provider),at=item.createdAt;
        const named=sourceNames.get(item.id);
        return material({id:`feed:${item.id}`,sourceId:item.sourceId || 'local',kind:social ? 'social' : 'other',group:social ? 'social' : 'other',title:item.title || '',author:item.authorName || '',publisher:named?.displayName || item.sourceName || '',
          publishedAt:item.publishedAt,eventAt:at,capturedAt:item.capturedAt || item.createdAt,updatedAt:item.updatedAt,obtainedAt:item.updatedAt || at,late:false,
          contentLevel:item.body ? (social ? 'full' : item.captureMetadata?.contentLevel || 'partial') : 'summary_only',version:String(item.updatedAt || item.createdAt),bodyHash:materialHash(item.body || item.summary || item.title),
          paragraphs:item.body ? socialParagraphs(item.body) : paragraphs(item.summary || item.title,'summary'),missing:!item.body && !item.summary ? ['title_only'] : [],sourceRefs:[{type:'content-item',id:item.id,at}]});
      });
      const externalIds=sourceIds.filter(id=>id.startsWith('media:')).map(id=>id.slice(6));
      const media=externalIds.length ? mediaService.dailyMaterials(workspaceId,{externalIds}) : [];
      return [...feeds,...media.map(row=>material({id:`media:${row.externalId}`,sourceId:row.sourceKey,kind:'news',group:row.channel==='tech' ? 'tech' : 'macro',title:row.title,author:row.authorName || row.body?.article?.author || '',publisher:row.publisherName || row.publisherKey,
        publishedAt:row.publishedAt,eventAt:row.createdAt,capturedAt:row.observedAt,updatedAt:row.updatedAt,obtainedAt:row.body?.observedAt || row.observedAt,late:false,contentLevel:row.effectiveLevel,
        version:`index:${row.revision}/body:${row.body?.revision || 0}`,bodyHash:row.body?.bodyHash || row.contentHash,
        paragraphs:row.body?.article?.paragraphs?.length ? row.body.article.paragraphs.flatMap(p=>paragraphs(p.text)) : paragraphs(row.summary || row.title,'summary'),missing:!row.body && !row.summary ? ['title_only'] : [],sourceRefs:[{type:'media-body',id:row.externalId,at:row.observedAt}]}))];
    },
  };
}
