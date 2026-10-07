import {createGeminiArticleAdmission} from '../packages/runtime/src/gemini-article-admission.js';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {loadInstanceEnvironment,resolveInstanceConfig} from '../packages/instance/src/index.js';
import {createDomainRepositories} from '../packages/database/src/repositories/index.js';
import {createStore} from '../packages/database/src/index.js';
import {createInformationTreeService} from '../packages/domain/src/information-tree-service.js';
import {loadArticleNormalizeSkills} from '../packages/runtime/src/information-tree/skills.js';
import {createToolRegistry} from '../packages/runtime/src/tool-registry.js';
import {createHarnessAgentRuntime,resolveHarnessLlm} from '../packages/harness/src/index.js';
import {withModelUsageContext} from '../packages/runtime/src/model-usage-context.js';
import {buildHarnessPrompt} from '../packages/harness/src/prompt.js';
const args=process.argv.slice(2),arg=(n,d)=>args.includes(n) ? args[args.indexOf(n)+1] : d;
if(!args.includes('--run')){console.log('node scripts/article-normalize-pilot.mjs --run --source-root <repository> --output <frozen-manifest-directory> [--stability]');process.exit(0);}
const root=path.resolve(arg('--source-root',process.cwd()));loadInstanceEnvironment({repositoryRoot:root});
const source=resolveInstanceConfig({repositoryRoot:root}),dir=path.resolve(arg('--output','.ai-data/article-normalize-pilot/run'));
if(dir===root || dir===path.dirname(source.databasePath) || path.resolve(dir,'ai-center.db')===source.databasePath)throw new Error('拒绝生产目录');
const manifest=JSON.parse(fs.readFileSync(path.join(dir,'sample-manifest.json'),'utf8'));
if(args.includes('--sample-id'))manifest.samples=manifest.samples.filter(s=>s.sampleId===arg('--sample-id',''));
const write=(name,v)=>fs.writeFileSync(path.join(dir,name),JSON.stringify(v,null,2));
const sourceDb=new Database(source.databasePath,{readonly:true,fileMustExist:true});
try{
 const r=createDomainRepositories(sourceDb,()=>{throw new Error('source read only');});
 for(const s of (args.includes('--stability-only') ? [] : manifest.samples)){const m=s.material,ref=m.sourceRefs[0];const node=r.informationTree.informationHead('local',m.id)?.node || null;
  s.baseline={node:node?.sourceVersion===m.version ? node : null,alignment:node ? node.sourceVersion===m.version ? 'same-source-version' : 'different-source-version-excluded' : 'absent',translations:ref?.type==='content-item' ? r.feed.listTranslations('local',[ref.id]) : [],tags:r.tagging.listTaggings('local',ref?.type==='media-body' ? 'media-index' : 'content-item',[ref?.id || ''])};
  s.oldProductExists=Boolean(node || s.baseline.translations.length || s.baseline.tags.length);
 }
 write('sample-manifest.json',manifest);
}finally{sourceDb.close();}
const store=createStore(path.join(dir,'ai-center.db')),skills=loadArticleNormalizeSkills();
const llm=resolveHarnessLlm(process.env,{closedTask:'article-normalize'});
const execution={provider:llm.provider,model:llm.model,...llm.execution,settingsHash:(await import('node:crypto')).createHash('sha256').update(llm.settingsYaml).digest('hex')};
const limit=12,requests=new Set(store.repositories.modelUsage.list('local',{limit:10000}).filter(r=>r.kind==='request').map(r=>r.id));
let active,calls=0;
const runtime=createHarnessAgentRuntime({tools:createToolRegistry(),env:process.env,runtimeDirectory:path.join(dir,'harness'),articleAdmission:llm.provider==='google' ? createGeminiArticleAdmission({repository:store.repositories.modelQuota,env:process.env}) : null,usageLedger:{record(v){store.repositories.modelUsage.save(v);if(v.kind==='request')requests.add(v.id);if(requests.size>limit)active?.abort(new Error('supplier request limit'));}}});
const invocations=fs.existsSync(path.join(dir,'invocations.json')) ? JSON.parse(fs.readFileSync(path.join(dir,'invocations.json'),'utf8')) : [];
const bounded={supportsExecutionAdmission:runtime.supportsExecutionAdmission,async run(input){
 if(requests.size>=limit || calls>=limit)throw Object.assign(new Error('累计真实请求达到12次上限'),{code:'budget-deferred'});
 if(calls && Number(arg('--pace-ms',0))>0)await new Promise(r=>setTimeout(r,Math.min(60000,Number(arg('--pace-ms',0)))));
 calls++;active=new AbortController();const started=Date.now(),prompt=buildHarnessPrompt({closedContext:true,taskInstruction:input.taskInstruction,message:input.message});
 const record={applicationCall:calls,inputCharacters:prompt.length,inputBytes:Buffer.byteLength(prompt),execution,stage:input.usageStage,messageHash:(await import('node:crypto')).createHash('sha256').update(prompt).digest('hex')};invocations.push(record);
 console.log(JSON.stringify({call:calls,requests:requests.size,bytes:record.inputBytes}));
 try{const result=await runtime.run({...input,signal:AbortSignal.any([input.signal,active.signal])});record.answer=result.answer;record.outputCharacters=result.answer?.length;return result;}catch(e){record.error=String(e.message);throw e;}finally{record.elapsedMs=Date.now()-started;active=null;write('invocations.json',invocations);}
}};
const make=(cacheNamespace='')=>createInformationTreeService({repository:store.repositories.informationTree,reportRepository:store.repositories.report,agentRuntime:bounded,skills,catalog:manifest.catalog,articleStrategy:true,cacheNamespace,generationConfig:{information:execution},budget:{maxCalls:12,timeoutMs:180000,totalMs:8*60000}});
const service=make(),results={productionEnabled:false,realModelReplay:true,execution,skillHash:skills.information.version,first:[],repeat:[],stability:[],requestLimit:limit};
const old=fs.existsSync(path.join(dir,'results.json')) ? JSON.parse(fs.readFileSync(path.join(dir,'results.json'),'utf8')) : null;
if(old && args.includes('--stability-only')){results.first=old.first;results.repeat=old.repeat;results.stability=old.stability;results.priorApplicationCalls=old.invocations || 0;}
if(old)results.previousRun={first:old.first,repeat:old.repeat,stability:old.stability};
const preview=()=>{
 const escape=s=>String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const html='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>信息层整理隔离试跑</title><style>body{font:17px/1.8 system-ui;margin:0;background:#f4f5f8;color:#202532}main{max-width:850px;margin:auto;padding:24px 16px}article{background:white;border:1px solid #dde0e6;border-radius:14px;padding:24px;margin:24px 0}h1{font-size:26px}h2{font-size:22px}small{color:#647084}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}summary{cursor:pointer;font-weight:600}p{overflow-wrap:anywhere} @media(max-width:500px){article{padding:16px}main{padding:16px 10px}}</style><main><h1>一次原文，两种阅读尺度</h1><p>隔离原型 · 生产未启用 · 原始材料和既有历史保留</p>'+manifest.samples.map(s=>{const r=results.first.find(r=>r.sampleId===s.sampleId),n=r?.readback;return '<article><small>'+escape(s.sampleId+' · '+s.type)+'</small><p>来源：'+escape(s.material.title)+'</p>'+(n ? '<h2>'+escape(n.title)+'</h2><small>Tag：'+escape(manifest.catalog.tags.find(t=>t.id===n.tagId)?.name || '未分类')+'</small><p>'+escape(n.text)+'</p>'+(n.body===n.text ? '' : '<details open><summary>中文洗练正文</summary><pre>'+escape(n.body)+'</pre></details>') : '<p>'+escape(r?.result.pending?.[0]?.reason || '尚未完成')+'</p>')+'<details><summary>原始材料对照（保存范围）</summary><pre>'+escape(s.material.paragraphs.filter(p=>p.role!=='comment').map(p=>p.text).join('\n\n'))+'</pre></details></article>';}).join('')+'<h2>独立命名空间复跑（保留首稿）</h2>'+results.stability.filter(r=>r.cacheNamespace).map(r=>{const n=r.result.nodes[0];return n ? '<article><details><summary>'+escape(r.sampleId+' · '+n.title)+'</summary><p>'+escape(n.text)+'</p><pre>'+escape(n.body)+'</pre></details></article>' : '<article>'+escape(r.sampleId+' 复跑未完成')+'</article>';}).join('')+'</main></html>';
 fs.writeFileSync(path.join(dir,'preview.html'),html);
};
const save=()=>{results.invocations=calls;results.supplierRequests=requests.size;write('results.json',results);write('usage.json',store.repositories.modelUsage.list('local',{limit:10000}));preview();};
const run=(s,phase)=>withModelUsageContext({workspaceId:'local',jobId:`article-pilot-${phase}-${s.sampleId}`},()=>service.prepareInformation({materials:[s.material]}));
try{
 for(const s of (args.includes('--stability-only') ? [] : manifest.samples)){const before=requests.size,result=await run(s,'first');results.first.push({sampleId:s.sampleId,result,newRequests:requests.size-before,readback:result.nodes[0] ? store.repositories.informationTree.getNode('local',result.nodes[0].id) : null});save();}
 for(const s of (args.includes('--stability-only') ? [] : manifest.samples)){const before=requests.size,result=await run(s,'repeat');results.repeat.push({sampleId:s.sampleId,result,newRequests:requests.size-before});save();}
 if(args.includes('--stability') || args.includes('--stability-only'))for(const s of manifest.samples.filter(s=>['S4','S5'].includes(s.sampleId))){
   // Explicit experimental cache namespace bypasses article and model-stage caches once.
   const before=requests.size,result=await withModelUsageContext({workspaceId:'local',jobId:`article-pilot-stability-${s.sampleId}`},()=>make(`stability-v1-${s.sampleId}`).prepareInformation({materials:[s.material]}));results.stability.push({sampleId:s.sampleId,cacheNamespace:`stability-v1-${s.sampleId}`,result,newRequests:requests.size-before});save();
 }
}finally{save();await runtime.close();store.close();}
console.log(JSON.stringify({done:true,requests:requests.size,first:results.first.map(r=>({id:r.sampleId,ready:Boolean(r.readback),pending:r.result.pending})),repeatNewRequests:results.repeat.reduce((n,r)=>n+r.newRequests,0)}));
