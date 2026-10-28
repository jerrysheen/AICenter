import {material,materialHash,paragraphs,socialParagraphs} from './daily-materials.js';
import { isFlashSource } from './flash-sources.js';
import { isAwesomeListUpdateNoise } from './awesome-list-noise.js';

const XUEQIU_LIVENEWS_ID = 'xueqiu:home:livenews';

export function isXueqiuLiveNewsRow(row) {
  const keys = [row?.sourceExternalId, row?.sourceKey, row?.sourceId, row?.externalId];
  if (keys.some((key) => String(key || '') === XUEQIU_LIVENEWS_ID)) return true;
  const names = [row?.sourceName, row?.publisher, row?.displayName];
  return names.some((name) => String(name || '').trim() === '雪球7x24');
}

function keepHourlyCandidate(row, flashSources, options = {}) {
  if (row.provider === 'youtube') return false;
  const flash = isFlashSource({
    id: row.id,
    sourceExternalId: row.sourceExternalId,
    sourceKey: row.sourceKey,
    publisher: row.sourceName || row.publisher,
    displayName: row.sourceName,
  }, flashSources);
  // 信息树仍整源排除快讯。类目小时报单独放行雪球 7x24，产业在线等其它快讯继续排除。
  if (flash && !(options.allowXueqiuLiveNews === true && isXueqiuLiveNewsRow(row))) return false;
  return !isAwesomeListUpdateNoise({
    title: row.title,
    sourceUrl: row.sourceUrl || row.canonicalUrl,
  });
}

export function createTreeMaterialPort({feedService,mediaService,flashSources=null}) {
  return {
    async candidates(workspaceId,window,options={}) {
      const rows=[];let cursor=null;
      while(true) {
        const page=feedService.listContentItemsInWindow(workspaceId,{...window,timeBasis:'ingested',metadataOnly:true,limit:500,cursor});rows.push(...page);
        if(page.length<500)break;
        const last=page.at(-1);cursor={id:last.id.slice(5),eventAt:last.eventAt};
      }
      const media=mediaService?.informationCandidates(workspaceId,window) || [];
      const visible=[...rows,...media].filter(row=>keepHourlyCandidate(row, flashSources, options));
      return typeof mediaService?.dedupeHourlyCandidates==='function'
        ? mediaService.dedupeHourlyCandidates(workspaceId, visible)
        : visible;
    },
    categoryCandidates(workspaceId,window) {
      return this.candidates(workspaceId,window,{allowXueqiuLiveNews:true});
    },
    async materials(workspaceId,sourceIds) {
      const feedIds=sourceIds.filter(id=>id.startsWith('feed:')).map(id=>id.slice(5));
      const approved=new Set(feedIds.length ? feedService.listTaggableItems(workspaceId,{ids:feedIds,limit:feedIds.length}).map(item=>item.id) : []);
      const sourceNames=new Map((feedService.listItemSources?.(workspaceId, feedIds) || []).map(row=>[row.id, row]));
      const feeds=feedIds.filter(id=>approved.has(id)).map(id=>feedService.getContentItem(workspaceId,id)).filter(item=>item && item.provider!=='youtube').map(item=>{
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
