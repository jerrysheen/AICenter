import { ImportedMediaArticleSchema } from '../../contracts/src/hardware-prices.js';
const articleInput = item => ImportedMediaArticleSchema.parse({externalId:item.externalId,title:item.title || '',summary:item.summary || '',body:item.body || '',sourceUrl:item.sourceUrl,
  publishedAt:item.publishedAt || null,articleKind:item.articleKind || (item.externalId.startsWith('research:')?'report-intro':'article'),
  contentLevel:item.contentLevel || 'summary_only',extractorVersion:item.extractorVersion || '',paragraphs:item.paragraphs || [],...(item.observedAt!=null?{observedAt:item.observedAt}:{})});
export function createContentRoutingService({mediaService,hardwarePrices,feedRepository,legacyPricePort}) {
  const pending=new Map();
  function serialize(workspaceId,work) {const prior=pending.get(workspaceId) || Promise.resolve();const task=prior.catch(()=>{}).then(work);pending.set(workspaceId,task);task.finally(()=>{if(pending.get(workspaceId)===task)pending.delete(workspaceId);}).catch(()=>{});return task;}
  return {
    ingest(workspaceId,snapshot) {return serialize(workspaceId,async()=>{
      // Persist quotes independently; retries reuse already saved snapshots and observations.
      for(const price of snapshot.priceSnapshots || [])hardwarePrices.ingest(workspaceId,price);
      const result=await mediaService.ingestArticles(workspaceId,(snapshot.items || []).filter(i=>!i.externalId.startsWith('price:')).map(articleInput));
      return {...result,skipped:0};
    });},
    migrate(workspaceId) {return serialize(workspaceId,async()=>{
      const rows=feedRepository.listLegacyProviderItems(workspaceId,'trendforce');let snapshots=0,articles=0;
      for(const row of rows) {
        if(row.externalId==='price:dram' || row.externalId==='price:flash') {
          if(hardwarePrices.legacySnapshot(workspaceId,row.externalId))continue;
          const s=hardwarePrices.ingest(workspaceId,legacyPricePort(row,row.capturedAt || row.createdAt));
          hardwarePrices.linkLegacy(workspaceId,row.externalId,row.id,s.id);snapshots++;
        } else {
          const legacyLevel=row.captureMetadata?.contentLevel || 'partial';
          const contentLevel=legacyLevel==='full' && !row.captureMetadata?.extractorVersion?'partial':legacyLevel;
          const result=await mediaService.ingestArticles(workspaceId,[articleInput({...row,observedAt:row.capturedAt || row.createdAt,contentLevel:row.externalId.startsWith('research:')?'summary_only':contentLevel,extractorVersion:row.captureMetadata?.extractorVersion || '',
            articleKind:row.externalId.startsWith('research:')?'report-intro':'article',paragraphs:row.externalId.startsWith('research:')?[]:(row.body || '').split(/\n\s*\n/).filter(Boolean).map((text,i)=>({id:`p${String(i+1).padStart(4,'0')}`,text,kind:'paragraph'}))})],'trendforce',{preserveLegacyGate:true});articles+=result.added;
        }
      }
      return {snapshots,articles};
    });},
    knownFullArticleIds(workspaceId) {return mediaService.verifiedTrendforceExternalIds(workspaceId);},
    routedItemIds(workspaceId) {return [...mediaService.legacyItemIds(workspaceId),...hardwarePrices.legacyItemIds(workspaceId)];},
    legacySnapshot: (...args)=>hardwarePrices.legacySnapshot(...args),
    isRouted(workspaceId,id) {return mediaService.isLegacyRouted(workspaceId,id) || Boolean(hardwarePrices.legacySnapshot(workspaceId,id));},
  };
}
