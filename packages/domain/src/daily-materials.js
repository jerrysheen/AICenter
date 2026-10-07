import {createHash} from 'node:crypto';
import {DailyMaterialSchema} from '../../contracts/src/report.js';

export const materialHash = value => createHash('sha256').update(typeof value==='string' ? value : JSON.stringify(value)).digest('hex');
const clip=(v,n)=>String(v || '').slice(0,n);

export function material(value) {
  const v={author:'',publisher:'',sourceUrl:'',originUrl:'',publishedAt:null,updatedAt:null,capturedAt:null,
    contentLevel:'metadata',version:'1',missing:[],sourceRefs:[],...value};
  if(!v.evidenceGroup) v.evidenceGroup=v.originUrl || materialHash(v.paragraphs.filter(p=>p.role!=='comment').map(p=>p.text).join('\n'));
  v.paragraphCount=v.paragraphs.length;
  v.hash=materialHash({...v,hash:undefined});
  return DailyMaterialSchema.parse(v);
}

// Keep complete text; split oversized paragraphs into stable consecutive fragments.
export function paragraphs(text,role='body') {
  const pieces=[];
  for(const [index,line] of String(text || '').split(/\n\s*\n/).entries()) {
    for(let offset=0;offset<line.length;offset+=2000) pieces.push({id:`p${index+1}-${offset}`,text:line.slice(offset,offset+2000),role});
  }
  return pieces;
}

export function socialParagraphs(text) {
  const match=String(text || '').match(/\n(?:\n)?(?:【)?(?:评论|热门评论|可见评论|Comments)(?:】)?[:：]?/i);
  if(!match) return paragraphs(text);
  return [...paragraphs(text.slice(0,match.index)),...paragraphs(text.slice(match.index),'comment').map(p=>({...p,id:`comment-${p.id}`}))];
}

export async function prepareDailyMaterials({feedService,mediaPort,workspaceId,time,frozenAt,perSourceLimit=3000,maxBytes=12*1024*1024}) {
  const window=time.contentWindow;
  const sources=feedService.listWindowSources?.(workspaceId,window) || [{sourceId:null,provider:'local',available:0}];
  const feedSources=sources.filter(s=>s.provider!=='media');
  let mediaSources=[];
  const warnings=[];
  try { mediaSources=mediaPort?.dailySources?.(workspaceId,window) || []; }
  catch { warnings.push('媒体来源目录读取失败'); }
  // Read each channel separately. Reserve a fair share of the snapshot byte budget for every source.
  const allSources=[...feedSources,...mediaSources];
  const activeCount=Math.max(1,allSources.filter(s=>s.available>0).length);
  const baseBytes=Math.min(128*1024,Math.floor(maxBytes/activeCount));
  const availableTotal=allSources.reduce((sum,s)=>sum+(s.available || 0),0) || 1;
  const sharedBytes=Math.max(0,maxBytes-baseBytes*activeCount);
  const materials=[],coverage=[];
  async function collect(source,read,convert) {
    const sourceBytes=baseBytes+Math.floor(sharedBytes*(source.available || 0)/availableTotal);
    let cursor=null,used=0,included=0,full=0,summaryOnly=0,failed=0;
    try {
      while(included<perSourceLimit) {
        const pageLimit=Math.min(100,perSourceLimit-included);
        const rows=await read({...window,sourceId:source.sourceId,cursor,limit:pageLimit});
        if(!rows.length) break;
        for(const row of rows) {
          const value=convert(row);
          const bytes=Buffer.byteLength(JSON.stringify(value));
          if(used+bytes>sourceBytes) {cursor='budget';break;}
          used+=bytes; materials.push(value);included++;
          if(value.contentLevel==='full') full++; else summaryOnly++;
        }
        if(cursor==='budget') break;
        const last=rows.at(-1); cursor={eventAt:last.eventAt,id:last.id || last.externalId};
        if(rows.length<pageLimit) break;
      }
    } catch(error) { failed=1;warnings.push(`${source.sourceId || 'local'} 材料读取失败：${clip(error.message,300)}`); }
    const available=source.available || included;
    coverage.push({sourceId:source.sourceId || 'local',sourceName:source.sourceName || source.sourceId || '本地信息',group:source.group,available,included,full,summaryOnly,
      omitted:Math.max(0,available-included),failed,status:failed ? 'failed' : source.status || 'cached',lastSyncAt:source.lastSyncAt ?? null,
      note:clip(source.note || (available>included ? '达到单源材料预算，未覆盖全窗口' : '读取已保存材料；同步状态不代表实时完整性'),1000)});
  }
  for(const source of feedSources) {
    const social=['x','twitter','xueqiu'].includes(source.provider);
    await collect({...source,group:social ? 'social' : 'other'},q=>feedService.listContentItemsInWindow(workspaceId,q),item=>material({
      id:`feed:${item.id}`,sourceId:item.sourceId || 'local',group:social ? 'social' : 'other',kind:social ? 'social' : 'other',
      title:clip(item.title,1000),author:clip(item.authorName,512),publisher:clip(item.sourceName,512),sourceUrl:clip(item.sourceUrl,2048),
      eventAt:item.eventAt,publishedAt:item.publishedAt ?? null,updatedAt:item.updatedAt ?? null,capturedAt:item.capturedAt ?? null,
      obtainedAt:Math.max(item.capturedAt || item.createdAt,item.updatedAt || 0),late:Math.max(item.capturedAt || item.createdAt,item.updatedAt || 0)>=window.endAt,
      contentLevel:social ? (item.body ? 'full' : 'summary_only') : ['full','partial','summary_only','discovery','metadata'].includes(item.captureMetadata?.contentLevel) ? item.captureMetadata.contentLevel : 'summary_only',version:String(item.updatedAt || item.createdAt),
      bodyHash:materialHash(item.body || item.summary || item.title),
      paragraphs:social ? (item.body ? socialParagraphs(item.body) : paragraphs(item.summary || item.title,'summary')) : paragraphs(item.body || item.summary || item.title,item.captureMetadata?.contentLevel==='full' || item.captureMetadata?.contentLevel==='partial' ? 'body' : 'summary'),
      missing:social ? ['仅已采集时间线样本；图片、附件和完整线程上下文未读取'] : [],
      sourceRefs:[{type:'content-item',id:item.id,at:item.eventAt}],
    }));
  }
  for(const source of mediaSources) {
    await collect({...source,group:source.channel==='tech' ? 'tech' : 'macro'},q=>mediaPort.dailyMaterials(workspaceId,q),row=>{
      const body=row.body;
      return material({id:`media:${row.externalId}`,sourceId:source.sourceId,group:row.channel==='tech' ? 'tech' : 'macro',
        kind:mediaPort.catalog?.().find(s=>s.sourceKey===source.sourceId)?.sourceId?.startsWith('policy.') ? 'official' : 'news',
        title:clip(row.title,1000),author:clip(row.authorName || body?.article?.author,512),publisher:clip(row.publisherName || row.publisherKey,512),
        sourceUrl:clip(row.canonicalUrl,2048),originUrl:clip(row.originUrl,2048),eventAt:row.eventAt,publishedAt:row.publishedAt,
        updatedAt:row.updatedAt,capturedAt:row.observedAt,obtainedAt:Math.max(body?.observedAt || row.observedAt,row.updatedAt || 0),late:Math.max(body?.observedAt || row.observedAt,row.updatedAt || 0)>=window.endAt,
        contentLevel:row.effectiveLevel,version:`index:${row.revision}/body:${body?.revision || 0}`,
        bodyHash:body?.bodyHash || row.contentHash,
        paragraphs:body?.article?.paragraphs?.length ? body.article.paragraphs.flatMap(p=>{
          if(p.text.length<=2000) return [{id:p.id,text:p.text,role:'body'}];
          return paragraphs(p.text).map(part=>({...part,id:`${p.id}-${part.id}`}));
        }) : paragraphs(row.summary || row.title,'summary'),
        missing:[...(row.bodyReason ? [row.bodyReason] : []),...(body?.truncated ? ['正文截断'] : [])],
        sourceRefs:[{type:'media-body',id:row.externalId,at:body?.observedAt || row.observedAt}],
      });
    });
  }
  return {materials,coverage,warnings,frozenAt};
}

export function contextMaterials(content) {
  const make=(id,kind,title,data,at,sourceRefs,sourceUrl='')=>material({id,kind,title,sourceId:kind,group:'context',
    eventAt:at || content.window.endAt,obtainedAt:content.frozenAt || content.generatedAt,late:false,
    paragraphs:paragraphs(JSON.stringify(data),'metadata'),sourceRefs,sourceUrl});
  const rows=[];
  for(const [key,value] of Object.entries(content.market || {})) rows.push(make(`market:${key}`,'market',`${key} 行情`,value,value.asOf,[{type:'market-snapshot',id:key,at:value.asOf}]));
  for(const e of content.upcoming || []) rows.push(make(`schedule:${e.eventId}`,'schedule',e.title,e,e.scheduledAt,[{type:'scheduled-event',id:e.eventId,at:e.scheduledAt}],e.sourceUrl));
  for(const r of content.officialReleases || []) rows.push(make(`official:${r.releaseId}`,'official',r.title,r,r.publishedAt,[{type:'official-release',id:r.releaseId,at:r.publishedAt}],r.sourceUrl));
  if(content.strategy) rows.push(make('strategy:current','strategy',content.strategy.strategyKey,content.strategy,content.strategy.asOf,[]));
  return rows;
}
