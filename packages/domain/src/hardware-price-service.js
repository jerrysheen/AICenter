import { HardwarePriceListQuerySchema, HardwarePriceSnapshotInputSchema, HardwarePriceListViewSchema, HardwarePriceDetailViewSchema, HardwarePriceSnapshotViewSchema } from '../../contracts/src/hardware-prices.js';
const verified = r => Boolean(r.currency && r.unit && r.period && r.quoteType!=='unknown' && r.periodStart!==null && r.periodEnd!==null);
const publicSnapshot = s => s && (({artifactPath:_path,...rest})=>rest)(s);
function project(row,history=[]) {
  const points=history.filter(r=>r.isCurrent && verified(r) && r.average!==null).sort((a,b)=>a.periodStart-b.periodStart);
  const position=points.findIndex(r=>r.id===row.id),previous=position>0?points[position-1]:null;
  const change=verified(row) && row.average!==null && previous && Number(previous.average)!==0 ? (Number(row.average)-Number(previous.average))/Math.abs(Number(previous.average))*100 : null;
  return {...row,verification:verified(row)?'verified':'pending',missing:[...(!row.currency?['币种']:[]),...(!row.unit?['计价单位']:[]),...(!row.period || row.periodStart===null || row.periodEnd===null?['报价期']:[]),...(row.quoteType==='unknown'?['报价类型']:[])],
    changePct:Number.isFinite(change)?change:null,computedChangeBasis:change!==null?'对上一报价期均价':null,
    history:history.filter(r=>r.isCurrent && r.period && r.periodStart!==null && r.periodEnd!==null && r.average!==null)
      .sort((a,b)=>a.periodStart-b.periodStart).map(r=>({at:r.periodStart,period:r.period,average:r.average}))};
}
export function createHardwarePriceService({repository,artifactStore}) {
  return {
    ingest(workspaceId,input) {const value=HardwarePriceSnapshotInputSchema.parse(input);return publicSnapshot(repository.save(workspaceId,value,artifactStore.save(value.raw,value.format)));},
    list(workspaceId,query={}) {
      const q=HardwarePriceListQuerySchema.parse(query);
      let rows=repository.list(workspaceId,{snapshotId:q.snapshotId,limit:500});
      if(!q.snapshotId) {
        // The market is a current board, not a union of every retired table and parser edition.
        // Old editions remain available through their exact snapshot and series links.
        const snapshots=repository.savedSnapshots(workspaceId).sort((a,b)=>Number(b.format==='html')-Number(a.format==='html') || b.capturedAt-a.capturedAt || b.parserVersion.localeCompare(a.parserVersion,undefined,{numeric:true}));
        const pages=new Set(),series=new Set();rows=[];
        for(const snapshot of snapshots) {
          const page=JSON.stringify([snapshot.sourceKey,snapshot.pageKey]);if(pages.has(page))continue;pages.add(page);
          for(const row of repository.list(workspaceId,{snapshotId:snapshot.id,limit:500})) {
            if(series.has(row.seriesKey))continue;series.add(row.seriesKey);
            rows.push(repository.list(workspaceId,{seriesKey:row.seriesKey,limit:1})[0] || row);
          }
        }
      }
      const items=rows.filter(r=>!q.category || r.category===q.category).slice(0,q.limit)
        .map(r=>project(r,repository.history(workspaceId,r.seriesKey)));
      return HardwarePriceListViewSchema.parse({items,snapshot:q.snapshotId?publicSnapshot(repository.getSnapshot(workspaceId,q.snapshotId)):null});
    },
    detail(workspaceId,seriesKey) {
      const revisions=repository.history(workspaceId,seriesKey);if(!revisions.length)return null;
      const observations=revisions.filter(r=>r.isCurrent).sort((a,b)=>(a.periodStart ?? -1)-(b.periodStart ?? -1) || a.capturedAt-b.capturedAt);
      const current=repository.list(workspaceId,{seriesKey,limit:1})[0];const datedPeriods=observations.filter(r=>r.period && r.periodStart!==null && r.periodEnd!==null);
      return HardwarePriceDetailViewSchema.parse({current:project(current,revisions),observations:observations.map(r=>project(r,revisions)),revisions:revisions.map(r=>project(r)),hasHistory:datedPeriods.length>1,
        snapshots:repository.seriesSnapshots(workspaceId,seriesKey).map(publicSnapshot)});
    },
    snapshot(workspaceId,id) {
      const s=repository.getSnapshot(workspaceId,id);if(!s)return null;
      return HardwarePriceSnapshotViewSchema.parse({...publicSnapshot(s),raw:artifactStore.read(s.artifactPath),items:this.list(workspaceId,{snapshotId:id}).items});
    },
    legacyItemIds: workspaceId=>repository.legacyItemIds(workspaceId),
    savedSnapshots: workspaceId=>repository.savedSnapshots(workspaceId).map(publicSnapshot),
    linkLegacy: (...args)=>repository.linkLegacy(...args),
    legacySnapshot: (...args)=>publicSnapshot(repository.legacySnapshot(...args)),
  };
}
