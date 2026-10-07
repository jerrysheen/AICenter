import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {resolveInstanceConfig} from '../packages/instance/src/index.js';
import {createStore} from '../packages/database/src/index.js';
import {createDomainRepositories} from '../packages/database/src/repositories/index.js';
import {createFeedService} from '../packages/domain/src/feed-service.js';
import {createMediaIngestionService} from '../packages/domain/src/media-ingestion-service.js';
import {createFeedFilterFromEnv} from '../packages/domain/src/feed-filter.js';
import {prepareDailyMaterials} from '../packages/domain/src/daily-materials.js';
import {createInformationTreeService} from '../packages/domain/src/information-tree-service.js';
import {loadInformationTreeSkills} from '../packages/runtime/src/information-tree/skills.js';
import {readTagCatalogFile} from '../packages/runtime/src/tagging-module.js';
import {createToolRegistry} from '../packages/runtime/src/tool-registry.js';
import {createHarnessAgentRuntime,resolveHarnessLlm} from '../packages/harness/src/index.js';
import {withModelUsageContext} from '../packages/runtime/src/model-usage-context.js';

const args=process.argv.slice(2),arg=(name,fallback)=>args.includes(name) ? args[args.indexOf(name)+1] : fallback;
if(!args.includes('--run')){console.log('node --env-file=.env scripts/replay-information-tree-next.mjs --run --output .ai-data/tree-next-2026-10-06/replay [--max-calls 80] [--minutes 45]');process.exit(0);}
const instance=resolveInstanceConfig({repositoryRoot:process.cwd()}),dir=path.resolve(arg('--output','.ai-data/tree-next-2026-10-06/replay'));
if(dir===path.dirname(instance.databasePath))throw new Error('回放不得使用生产目录');
fs.mkdirSync(dir,{recursive:true});
const write=(file,value)=>fs.writeFileSync(path.join(dir,file),JSON.stringify(value,null,2));
const baseline=JSON.parse(fs.readFileSync('.ai-data/tree-next-2026-10-06/baseline/result.json','utf8').replace(/^\uFEFF/,''));
const oldSample=JSON.parse(fs.readFileSync('.ai-data/tree-next-2026-10-06/baseline/sample-manifest.json','utf8').replace(/^\uFEFF/,''));
let sample;
if(fs.existsSync(path.join(dir,'sample-manifest.json')))sample=JSON.parse(fs.readFileSync(path.join(dir,'sample-manifest.json'),'utf8'));
else {
  const hours=oldSample.hours.map(h=>({...h,materials:h.materials.slice(0,5)}));
  const chosen=new Set(hours.flatMap(h=>h.materials.map(m=>m.id))),full=[];
  const db=new Database(instance.databasePath,{readonly:true,fileMustExist:true});
  try{
    const repositories=createDomainRepositories(db,()=>{throw new Error('来源只读');}),filter=createFeedFilterFromEnv({env:process.env});
    const media=createMediaIngestionService({mediaRepository:repositories.media,feedRepository:repositories.feed,taggingRepository:repositories.tagging,feedFilter:filter});
    const feed=createFeedService({legacyRepository:{},feedRepository:repositories.feed,sourcePort:{read:async()=>{throw new Error('禁止新增抓取');}},mediaPort:media,feedFilter:filter});
    const end=Math.floor(Date.now()/3600000)*3600000;
    const saved=await prepareDailyMaterials({feedService:feed,mediaPort:media,workspaceId:'local',time:{contentWindow:{startAt:end-7*86400000,endAt:end}},frozenAt:Date.now()});
    for(const m of saved.materials.filter(m=>m.contentLevel==='full').sort((a,b)=>a.id.localeCompare(b.id)))if(!chosen.has(m.id) && full.length<18){full.push(m);chosen.add(m.id);}
  }finally{db.close();}
  sample={realSavedMaterials:true,hours,full,selection:'固定旧样本每小时前5篇，另选最近七日已保存完整正文，ID排序最多18篇；不抓取网络'};write('sample-manifest.json',sample);
}
const store=createStore(path.join(dir,'ai-center.db')),started=Date.now(),maxCalls=Number(arg('--max-calls',80)),maxRequests=Number(arg('--max-requests',100)),minutes=Number(arg('--minutes',45));let calls=0,active;
// Fixed fixture workspaces isolate fresh repetitions without touching production or sharing chat history.
const fixtureDb=new Database(path.join(dir,'ai-center.db'));
try{fixtureDb.transaction(()=>{for(const id of ['semantic-guards',...Array.from({length:6},(_,i)=>`repeat-${Math.floor(i/2)}-${i%2+1}`)])fixtureDb.prepare('INSERT OR IGNORE INTO workspaces VALUES (?,?,?,?)').run(id,'隔离回放固定夹具',Date.now(),Date.now());})();}finally{fixtureDb.close();}
const seenRequests=new Set(['local','semantic-guards',...Array.from({length:6},(_,i)=>`repeat-${Math.floor(i/2)}-${i%2+1}`)].flatMap(w=>store.repositories.modelUsage.list(w,{limit:10000})).filter(v=>v.kind==='request').map(v=>v.id));
const runtime=createHarnessAgentRuntime({tools:createToolRegistry(),env:process.env,runtimeDirectory:path.join(dir,'harness'),usageLedger:{record:v=>{
  store.repositories.modelUsage.save(v);
  if(v.kind==='request'){seenRequests.add(v.id);if(seenRequests.size>=maxRequests)active?.abort(Object.assign(new Error('供应商请求总数达到回放上限'),{code:'budget-deferred'}));}
}}});
const bounded={supportsExecutionAdmission:runtime.supportsExecutionAdmission,async run(input){if(calls>=maxCalls || seenRequests.size>=maxRequests || Date.now()-started>minutes*60000)throw Object.assign(new Error('本轮全局回放上限'),{code:'budget-deferred'});calls++;active=new AbortController();console.log(JSON.stringify({run:calls,supplierRequests:seenRequests.size,stage:input.usageStage,workspace:input.workspaceId}));try{return await runtime.run({...input,signal:AbortSignal.any([input.signal,active.signal])});}catch(error){if(active.signal.aborted)throw active.signal.reason;throw error;}finally{active=null;}}};
const catalog=readTagCatalogFile(instance.tagCatalogPath),skills=loadInformationTreeSkills(),generationConfig=Object.fromEntries(['hourly-brief','daily-analysis'].map(task=>{const r=resolveHarnessLlm(process.env,{closedTask:task});return [task,{provider:r.provider,model:r.model}];}));
const oldTags=new Map(baseline.nodes.filter(n=>n.layer==='information').map(n=>[n.sourceId,n.tagId]));
const make=(extra={})=>createInformationTreeService({repository:store.repositories.informationTree,reportRepository:store.repositories.report,agentRuntime:bounded,skills,catalog,generationConfig,budget:{maxCalls:80,totalMs:minutes*60000},...extra});
const results={realModelReplay:true,productionEnabled:false,baselineRequestsNotRecounted:baseline.usage.requests,generationConfig,effectivePromptHashes:Object.fromEntries(Object.entries(skills).map(([stage,s])=>[stage,s.version])),limits:{maxCalls,maxRequests,minutes},B:[],C:[],full:[],repeats:[]};
const run=(label,fn)=>withModelUsageContext({workspaceId:'local',jobId:`tree-next-${label}`},fn);
const checkpoint=()=>{results.calls=calls;results.elapsedMs=Date.now()-started;write('result.json',results);const workspaces=['local','semantic-guards',...results.repeats.map((r,i)=>`repeat-${Math.floor(i/2)}-${i%2+1}`)];write('usage.json',workspaces.flatMap(w=>store.repositories.modelUsage.list(w,{limit:10000})));};
try{
  const b=make({catalog:{...catalog,reading:undefined},classificationOverrideForReplay:m=>oldTags.get(m.id) ?? null});
  for(const h of sample.hours){results.B.push(await run('B',()=>b.generateHour({hourStart:h.window.startAt,materials:h.materials})));checkpoint();}
  results.Bdaily=await run('B',()=>b.generateDaily({window:{startAt:sample.hours[0].window.startAt,endAt:sample.hours.at(-1).window.endAt},hours:results.B}));checkpoint();
  const c=make();
  for(const h of sample.hours){const preparation=await run('C',()=>c.prepareInformation({materials:h.materials}));results.C.push(await run('C',()=>c.generateHour({hourStart:h.window.startAt,materials:h.materials})));results.C.at(-1).preparation={calls:preparation.calls,cacheHits:preparation.cacheHits,pending:preparation.pending};checkpoint();}
  results.Cdaily=await run('C',()=>c.generateDaily({window:{startAt:sample.hours[0].window.startAt,endAt:sample.hours.at(-1).window.endAt},hours:results.C}));checkpoint();
  if(args.includes('--semantic-guards')){
    const inputs=[{id:'controlled:design-per-day',title:'实验设计规模预测',author:'渠道检查作者',text:'作者渠道检查称目前约8000设计/天，预计2026年年底约16000设计/天。指标是每天实验设计数量。增长预测取决于实验预算增加、设计命中有效和下游产能，尚未实现年底规模。'},{id:'controlled:cash-flow-plan',title:'公司公布现金流改善计划',author:'公司董事会',text:'甲公司董事会公布未来两年改善现金流计划，当前经营现金流仍为负。方案待股东审批；2027年目标不表示已经实现。'}].map(v=>({id:v.id,title:v.title,author:v.author,publishedAt:sample.hours[0].window.startAt+1,contentLevel:'full',version:'controlled-v1',paragraphs:[{role:'body',text:v.text}],sourceRefs:[]}));
    write('semantic-guard-inputs.json',{syntheticControlledInputs:true,notSavedNews:true,materials:inputs});
    results.guards=await withModelUsageContext({workspaceId:'semantic-guards',jobId:'tree-next-semantic-guard'},()=>c.prepareInformation({workspaceId:'semantic-guards',materials:inputs}));checkpoint();
  }
  for(const m of sample.full){const p=await run('full',()=>c.prepareInformation({materials:[m]}));results.full.push({sourceId:m.id,...p});checkpoint();}
  const representative=sample.hours.flatMap(h=>h.materials).filter(m=>m.contentLevel==='full').slice(0,3);
  for(const [index,m] of representative.entries())for(let repeat=1;repeat<=2;repeat++){
    // Workspace-isolated fresh run prevents cached responses from being misrepresented as repetition.
    const workspaceId=`repeat-${index}-${repeat}`;
    results.repeats.push({sourceId:m.id,repeat,...await withModelUsageContext({workspaceId,jobId:'tree-next-repeat'},()=>c.prepareInformation({workspaceId,materials:[m]}))});checkpoint();
  }
  results.nodes=store.repositories.informationTree.listInformation('local',{startAt:0,endAt:Date.now()+86400000});
  const workspaces=['local','semantic-guards',...results.repeats.map((r,i)=>`repeat-${Math.floor(i/2)}-${i%2+1}`)],usage=workspaces.flatMap(w=>store.repositories.modelUsage.list(w,{limit:10000}));
  const requests=usage.filter(v=>v.kind==='request');results.usage={requests:requests.length,byStage:Object.fromEntries([...new Set(requests.map(r=>r.stage))].map(stage=>[stage,requests.filter(r=>r.stage===stage).length])),reportedTotalTokens:requests.reduce((n,r)=>n+(r.usage.totalTokens || 0),0),unknownUsage:requests.filter(r=>r.completeness!=='complete').length,cost:null};
  results.calls=calls;results.elapsedMs=Date.now()-started;write('result.json',results);write('usage.json',usage);console.log(JSON.stringify({done:true,calls,usage:results.usage,full:results.full.length}));
}finally{checkpoint();await runtime.close();store.close();}
