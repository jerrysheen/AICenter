import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {resolveInstanceConfig} from '../packages/instance/src/index.js';
import {createStore} from '../packages/database/src/index.js';
import {createDomainRepositories} from '../packages/database/src/repositories/index.js';
import {createFeedService} from '../packages/domain/src/feed-service.js';
import {createMediaIngestionService,mediaResourceId} from '../packages/domain/src/media-ingestion-service.js';
import {createFeedFilterFromEnv} from '../packages/domain/src/feed-filter.js';
import {prepareDailyMaterials} from '../packages/domain/src/daily-materials.js';
import {createInformationTreeService} from '../packages/domain/src/information-tree-service.js';
import {loadInformationTreeSkills} from '../packages/runtime/src/information-tree/skills.js';
import {readTagCatalogFile} from '../packages/runtime/src/tagging-module.js';
import {createToolRegistry} from '../packages/runtime/src/tool-registry.js';
import {createHarnessAgentRuntime,resolveHarnessLlm} from '../packages/harness/src/index.js';
import {withModelUsageContext} from '../packages/runtime/src/model-usage-context.js';

const args=process.argv.slice(2),arg=name=>args.includes(name) ? args[args.indexOf(name)+1] : undefined;
if(!args.includes('--run')) {console.log('npm run tree:replay -- --run [--output .ai-data/tree-replay/run] [--limit 24] [--hourStart milliseconds]');process.exit(0);}
const instance=resolveInstanceConfig({repositoryRoot:process.cwd()});
const dir=path.resolve(arg('--output') || path.join(instance.runtimeDirectory,'tree-replay',String(Date.now())));
if(dir===path.dirname(instance.databasePath))throw new Error('回放目录不能是生产数据目录');
fs.mkdirSync(dir,{recursive:true});
const inputFile=path.join(dir,'sample-manifest.json');
let sample;
if(fs.existsSync(inputFile))sample=JSON.parse(fs.readFileSync(inputFile,'utf8'));
else {
  const db=new Database(instance.databasePath,{readonly:true,fileMustExist:true});
  try {
    const repositories=createDomainRepositories(db,()=>{throw new Error('回放禁止写入来源数据库');});
    const filter=createFeedFilterFromEnv({env:process.env});
    const media=createMediaIngestionService({mediaRepository:repositories.media,feedRepository:repositories.feed,taggingRepository:repositories.tagging,feedFilter:filter});
    const feed=createFeedService({legacyRepository:{},feedRepository:repositories.feed,sourcePort:{read:async()=>{throw new Error('隔离回放禁止外部采集');}},mediaPort:media,feedFilter:filter});
    const end=Math.floor(Date.now()/3600000)*3600000,requested=Number(arg('--hourStart'));
    const candidates=Number.isFinite(requested) ? [{hour:requested}] : db.prepare(`SELECT hour,count(*) count FROM (
      SELECT CAST(coalesce(published_at,created_at)/3600000 AS INTEGER)*3600000 hour FROM content_items WHERE workspace_id='local'
      UNION ALL SELECT CAST(coalesce(published_at,observed_at)/3600000 AS INTEGER)*3600000 hour FROM media_index_entries WHERE workspace_id='local'
    ) WHERE hour>=? AND hour<? GROUP BY hour ORDER BY count DESC,hour DESC LIMIT 100`).all(end-7*86400000,end-3600000);
    const limit=Math.min(40,Math.max(2,Number(arg('--limit')) || 24));
    let best=null;
    for(const {hour} of candidates) {
      const groups=[];
      for(const startAt of [hour,hour+3600000]) {
        const window={startAt,endAt:startAt+3600000};
        const frozen=await prepareDailyMaterials({feedService:feed,mediaPort:media,workspaceId:'local',time:{contentWindow:window},frozenAt:Date.now()});
        const ready=frozen.materials.filter(m=>!['metadata','discovery'].includes(m.contentLevel) && m.paragraphs.some(p=>p.text.trim() && p.text.trim()!==m.title.trim()));
        ready.sort((a,b)=>Number(b.contentLevel==='full')-Number(a.contentLevel==='full') || a.id.localeCompare(b.id));
        groups.push({window,materials:ready.slice(0,Math.ceil(limit/2)),available:ready.length});
      }
      const count=groups.reduce((n,h)=>n+h.materials.length,0);
      if(groups.every(g=>g.materials.length) && (!best || count>best.count))best={count,groups};
      if(count>=Math.min(20,limit) && groups.every(g=>g.materials.length))break;
    }
    if(!best)throw new Error('最近七日未找到两个相邻已结束小时的可用保存材料');
    sample={realSavedMaterials:true,selection:'最近七日相邻完整小时，优先正文完整，材料ID排序；每小时最多limit/2，隔离样本不代表全天',selectedAt:Date.now(),hours:best.groups};
    fs.writeFileSync(inputFile,JSON.stringify(sample,null,2));
  } finally {db.close();}
}
const store=createStore(path.join(dir,'ai-center.db'));
const tagManifest=path.join(dir,'primary-tags.json');let primaryTags;
if(fs.existsSync(tagManifest))primaryTags=JSON.parse(fs.readFileSync(tagManifest,'utf8'));
else {
  const source=new Database(instance.databasePath,{readonly:true,fileMustExist:true});
  try {
    const tagging=createDomainRepositories(source,()=>{throw new Error('只读标签快照');}).tagging;primaryTags={};
    for(const m of sample.hours.flatMap(h=>h.materials)) {
      const ref=m.sourceRefs.find(r=>r.type==='media-body' || r.type==='content-item');if(!ref)continue;
      const row=tagging.listTaggings('local',ref.type==='media-body' ? 'media-index' : 'content-item',[ref.type==='media-body' ? mediaResourceId(ref.id) : ref.id])[0];
      if(row)primaryTags[m.id]=row.tags[0] ?? null;
    }
    fs.writeFileSync(tagManifest,JSON.stringify(primaryTags,null,2));
  }finally{source.close();}
}
const runtime=createHarnessAgentRuntime({tools:createToolRegistry(),env:process.env,runtimeDirectory:path.join(dir,'harness'),usageLedger:{record:v=>store.repositories.modelUsage.save(v)}});
const generationConfig=Object.fromEntries(['hourly-brief','daily-analysis'].map(task=>{const r=resolveHarnessLlm(process.env,{closedTask:task});return [task,{provider:r.provider,model:r.model}];}));
const service=createInformationTreeService({repository:store.repositories.informationTree,reportRepository:store.repositories.report,agentRuntime:runtime,skills:loadInformationTreeSkills(),
  catalog:readTagCatalogFile(fs.existsSync(instance.tagCatalogPath) ? instance.tagCatalogPath : 'config/tags.default.json'),primaryTag:(_workspace,m)=>primaryTags[m.id],generationConfig,budget:{maxCalls:80,totalMs:20*60000,...(args.includes('--assemble-only') ? {informationMs:1,maxCalls:30,totalMs:8*60000} : {})}});
try {
  const hours=[];
  for(const h of sample.hours) {
    console.log(JSON.stringify({stage:'hour-start',hourStart:h.window.startAt,materials:h.materials.length,assembleOnly:args.includes('--assemble-only')}));
    const result=await withModelUsageContext({workspaceId:'local',jobId:'isolated-tree-replay',observe:v=>store.repositories.modelUsage.save(v)},()=>service.generateHour({hourStart:h.window.startAt,materials:h.materials}));
    hours.push(result);console.log(JSON.stringify({stage:'hour-finished',status:result.status,modules:result.roots.length,pending:result.pendingIds.length}));
  }
  const window={startAt:sample.hours[0].window.startAt,endAt:sample.hours.at(-1).window.endAt};
  const daily=await withModelUsageContext({workspaceId:'local',jobId:'isolated-tree-replay'},()=>service.generateDaily({window,hours}));
  const nodes=new Map();
  const walk=id=>{if(nodes.has(id))return;const n=service.node('local',id);nodes.set(id,n);n.children.forEach(walk);};
  for(const h of hours){h.inputIds.forEach(walk);h.roots.forEach(walk);}daily.roots.forEach(walk);
  const usage=store.repositories.modelUsage.list('local',{limit:10000}),requests=usage.filter(r=>r.kind==='request');
  const stats=Object.fromEntries(['information','hourly','daily'].map(layer=>{const rows=[...nodes.values()].filter(n=>n.layer===layer);return [layer,{nodes:rows.length,characters:rows.reduce((sum,n)=>sum+Array.from(n.text).length,0)}];}));
  const result={realModelReplay:true,productionEnabled:false,scope:'two-hour daily-chain replay',sampleHours:sample.hours.map(h=>({window:h.window,inputCount:h.materials.length})),hours,daily,nodes:[...nodes.values()],stats,
    pendingCount:hours.reduce((n,h)=>n+h.pendingIds.length,0),usage:{requests:requests.length,records:usage.length,reportedInputTokens:requests.reduce((n,r)=>n+(r.usage.inputTokens ?? 0),0),reportedOutputTokens:requests.reduce((n,r)=>n+(r.usage.outputTokens ?? 0),0),reportedCacheReadTokens:requests.reduce((n,r)=>n+(r.usage.cacheReadTokens ?? 0),0),reportedTotalTokens:requests.reduce((n,r)=>n+(r.usage.totalTokens ?? 0),0),unknownUsageRequests:requests.filter(r=>r.completeness!=='complete').length,cost:null},generationConfig};
  fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));
  fs.writeFileSync(path.join(dir,'usage.json'),JSON.stringify(usage,null,2));
  console.log(JSON.stringify({output:path.relative(process.cwd(),dir),stats,pendingCount:result.pendingCount,dailyStatus:daily.status,usage:result.usage}));
} finally {await runtime.close();store.close();}
