import test from 'node:test';
import assert from 'node:assert/strict';
import {createStore} from '../packages/database/src/index.js';
import {createInformationTreeService} from '../packages/domain/src/information-tree-service.js';
import {loadInformationTreeSkills} from '../packages/runtime/src/information-tree/skills.js';
import {createInformationTreeJobHandlers,enqueueTreePreparation,TREE_PREPARE_JOB_TYPE,informationTreeManifest,enqueuePreparedHourRefreshes,prioritizeRecentTreePreparation,editionCoversMaterials} from '../packages/runtime/src/information-tree-module.js';
import {createCapabilityRegistry} from '../packages/runtime/src/capability-registry.js';
import {createTreeMaterialPort} from '../packages/domain/src/information-tree-materials.js';
import {createFeedService} from '../packages/domain/src/feed-service.js';
const H=3600000,start=10*H;
const material=(id,text='公司宣布新产品已开放测试。')=>({id,title:text.slice(0,80),publishedAt:start+1,updatedAt:start+2,version:'1',contentLevel:'full',paragraphs:[{role:'body',text}],sourceRefs:[]});
function fixture(extra={}){
  const store=createStore(':memory:'),calls=[],skills=loadInformationTreeSkills();
  const runtime={async run(input){calls.push(input);const p=JSON.parse(input.message);return {answer:JSON.stringify(input.usageStage==='tree-information' ? {title:p.source.title,text:p.source.paragraphs.map(p=>p.text).join(''),tagId:p.tags[0]?.id ?? null} : input.usageStage==='tree-classification' ? {tagId:p.tags[0]?.id ?? null} : {modules:p.inputs.map(n=>({title:n.title,text:n.text,tagId:p.tagId,inputIds:[n.id]}))})};}};
  const options={repository:store.repositories.informationTree,reportRepository:store.repositories.report,agentRuntime:runtime,skills,...extra};
  return {store,calls,runtime,skills,options,service:createInformationTreeService(options)};
}
test('complete title-equals-body bulletin and explicit discovery excerpt pass; third-party comments excluded',async()=>{
  const f=fixture();try{
    const first=material('bulletin'),second={...material('excerpt'),contentLevel:'discovery',paragraphs:[{role:'summary',text:'公司明确宣布开放测试。'},{role:'comment',text:'旁观者声称已盈利。'}]};
    const result=await f.service.prepareInformation({materials:[first,second]});assert.equal(result.nodes.length,2);
    assert.equal(result.nodes.find(n=>n.sourceId==='excerpt').inputScope,'excerpt');
    assert.equal(f.calls.some(c=>c.message.includes('旁观者声称')),false);
    assert.equal(result.nodes.find(n=>n.sourceId==='bulletin').text,first.title);
  }finally{f.store.close();}
});
test('prepared information immediately readable; regular hourly path never reads original or invokes information',async()=>{
  const m=material('ready'),f=fixture({candidatePort:async()=>[{id:m.id,version:m.version}],materialPort:async()=>{throw new Error('normal hour must not read bodies');}});try{
    await f.service.prepareInformation({materials:[m]});assert.equal(f.service.list('local',{startAt:start,endAt:start+H}).information.length,1);
    assert.equal(f.service.list('local',{startAt:start,endAt:start+H}).hours.length,0);
    const before=f.calls.length,h=await f.service.generateHour({hourStart:start});assert.equal(h.status,'ready');assert.equal(f.calls.length,before);
  }finally{f.store.close();}
});
test('empty legacy tags do not erase valid model classification; parent-child groups deduplicate and null stays separate',async()=>{
  const catalog={tags:[{id:'macro_commodity',name:'商品',parent_id:'macro',description:'商品供需价格'},{id:'macro',name:'宏观'}],reading:{version:'v1',groupByTag:{macro_commodity:'macro',macro:'macro'}}};
  const f=fixture({catalog,primaryTag:()=>null,tagHints:()=>[]});try{
    await f.service.prepareInformation({materials:[material('a')]});assert.equal(f.service.list('local',{startAt:start,endAt:start+H}).information[0].tagId,'macro_commodity');
    const h=await f.service.generateHour({hourStart:start});assert.equal(f.service.node('local',h.roots[0]).tagId,'macro');assert.equal(h.inputIds.length,1);
    f.runtime.run=async input=>{f.calls.push(input);const p=JSON.parse(input.message);return {answer:JSON.stringify(input.usageStage==='tree-information' ? {title:p.source.title,text:'内容足够长，不能直接走便宜路径。'.repeat(8),tagId:null} : {modules:p.inputs.map(n=>({title:n.title,text:'不同主题分别保留。',tagId:null,inputIds:[n.id]}))})};};
    const unrelated=await f.service.generateHour({hourStart:start+H,materials:[{...material('culture'),publishedAt:start+H+1},{...material('telecom'),publishedAt:start+H+1}]});
    assert.equal(unrelated.status,'ready');assert.equal(unrelated.roots.length,2);assert.equal(f.calls.filter(c=>c.usageStage==='tree-hourly').length,1);
  }finally{f.store.close();}
});
test('daily model and reading-map changes reuse information text; catalog description change classifies saved text only',async()=>{
  const catalog={tags:[{id:'macro',name:'宏观'}]},f=fixture({catalog});try{
    const m=material('a'),old=await f.service.prepareInformation({materials:[m]});
    const routes=createInformationTreeService({...f.options,generationConfig:{daily:{model:'different-daily'}}});
    await routes.prepareInformation({materials:[m]});assert.equal(f.calls.length,1);
    const mapping=createInformationTreeService({...f.options,catalog:{...catalog,reading:{version:'v2',groupByTag:{macro:'macro'}}}});
    await mapping.prepareInformation({materials:[m]});assert.equal(f.calls.length,1);
    const changed=createInformationTreeService({...f.options,catalog:{tags:[{id:'macro',name:'宏观',description:'经济政策和商品供需'}]}});
    const result=await changed.prepareInformation({materials:[m]});assert.equal(f.calls.length,2);assert.equal(f.calls[1].usageStage,'tree-classification');assert.ok(!f.calls[1].message.includes('paragraphs'));assert.equal(result.nodes[0].text,old.nodes[0].text);
  }finally{f.store.close();}
});
test('negative cache is version-specific; changed version without changed text retries once',async()=>{
  const f=fixture();try{
    let count=0;f.runtime.run=async()=>{count++;return {answer:'{"status":"needs_content"}'};};
    const m=material('a');await f.service.prepareInformation({materials:[m]});await f.service.prepareInformation({materials:[m]});assert.equal(count,1);
    await f.service.prepareInformation({materials:[{...m,version:'2'}]});assert.equal(count,2);
  }finally{f.store.close();}
});
test('source metadata revision reuses text and advances ready head version',async()=>{
  const f=fixture();try{
    const m=material('a');await f.service.prepareInformation({materials:[m]});
    const result=await f.service.prepareInformation({materials:[{...m,version:'2',updatedAt:start+3}]});assert.equal(f.calls.length,1);assert.equal(result.nodes[0].sourceVersion,'2');assert.equal(f.store.repositories.informationTree.informationHead('local','a').sourceVersion,'2');
  }finally{f.store.close();}
});
test('preparation job is registered, deduplicated, and needs-content completes without retry jobs',async()=>{
  const f=fixture();try{
    const registry=createCapabilityRegistry();registry.register({manifest:informationTreeManifest,jobHandlers:{}});
    assert.equal(enqueueTreePreparation(f.store,'local',['a','a']).length,1);assert.equal(enqueueTreePreparation(f.store,'local',['a']).length,0);
    f.store.claimNextJob('fixture-worker',[TREE_PREPARE_JOB_TYPE]);
    assert.equal(enqueueTreePreparation(f.store,'local',['a']).length,1);assert.equal(enqueueTreePreparation(f.store,'local',['a']).length,0);
    let retries=0;const handlers=createInformationTreeJobHandlers({prepareInformation:async()=>({nodes:[],pending:[{id:'a',reason:'needs-content',retryable:false,retryAt:null}],calls:1,cacheHits:0})});
    const result=await handlers[TREE_PREPARE_JOB_TYPE]({sourceIds:['a']},{store:{createJob:()=>retries++}});assert.equal(result.pending[0].retryable,false);assert.equal(retries,0);
  }finally{f.store.close();}
});
test('old in-flight policy cannot install information or publish over newer policy',async()=>{
  const f=fixture();try{
    const newer=createInformationTreeService({...f.options,generationConfig:{information:{model:'new-policy'}}});
    const result=await f.service.prepareInformation({materials:[material('old')]});assert.equal(result.nodes.length,0);assert.equal(result.pending[0].reason,'stale-policy');
    const fresh=await newer.generateHour({hourStart:start,materials:[material('new')]});assert.equal(fresh.published,true);
    const old=await f.service.generateHour({hourStart:start,materials:[material('old')]});assert.equal(old.published,false);assert.equal(f.service.list('local',{startAt:start,endAt:start+H}).hours[0].edition.id,fresh.id);
  }finally{f.store.close();}
});
test('successful groups remain visible when another group fails; failed group cooling prevents repeat model fee',async()=>{
  const catalog={tags:[{id:'A',name:'一'},{id:'B',name:'二'}]},f=fixture({catalog,primaryTag:(_w,m)=>({locked:true,tagId:m.id==='b' ? 'B' : 'A'})});try{
    const run=f.runtime.run;f.runtime.run=async input=>{if(input.usageStage==='tree-hourly' && JSON.parse(input.message).tagId==='B'){f.calls.push(input);throw new Error('temporary upstream failure');}return run(input);};
    const materials=[material('a','正文长一些。'.repeat(25)),material('b','另一正文也长一些。'.repeat(25))];
    const h=await f.service.generateHour({hourStart:start,materials});assert.equal(h.status,'failed');assert.equal(h.roots.length,1);assert.equal(h.published,false);assert.equal(h.groupFailures[0].reason,'retryable-model-error');
    const before=f.calls.length;await f.service.generateHour({hourStart:start,materials});assert.equal(f.calls.length,before);
  }finally{f.store.close();}
});
test('queue and execution timeouts persist distinct business-stage timing and cooldown',async()=>{
  for(const executing of [false,true]){
    const f=fixture({budget:{queueTimeoutMs:10,timeoutMs:10,totalMs:100}});try{
      f.runtime.supportsExecutionAdmission=true;
      f.runtime.run=async input=>{if(executing)input.onExecutionStart();return new Promise((_resolve,reject)=>input.signal.addEventListener('abort',()=>reject(input.signal.reason)));};
      const result=await f.service.prepareInformation({materials:[material('a')]});assert.equal(result.pending[0].reason,executing ? 'execution-timeout' : 'queue-timeout');assert.ok(result.pending[0].retryAt>Date.now());assert.ok(result.pending[0].queueMs>=0);assert.ok(result.pending[0].executionMs>=0);
    }finally{f.store.close();}
  }
});
test('invalid completed model cache is locally repaired while unrelated draft remains cached',async()=>{
  const f=fixture();try{
    await f.service.prepareInformation({materials:[material('cached')]});
    const get=f.options.reportRepository.getAnalysisStage;let injected=false;
    f.options.reportRepository.getAnalysisStage=(...args)=>{if(args[1]==='tree-cache' && !injected){injected=true;return {status:'completed',output:{bad:'format'}};}return get(...args);};
    const result=await f.service.prepareInformation({materials:[material('new')]});assert.equal(result.nodes.length,1);assert.equal(f.calls.length,2);
    await f.service.prepareInformation({materials:[material('cached')]});assert.equal(f.calls.length,2);
  }finally{f.store.close();}
});
test('publication checks expected head even under the same active policy',async()=>{
  const f=fixture();try{
    const first=await f.service.generateHour({hourStart:start,materials:[material('a')]}),expected=first.id;
    const second=await f.service.generateHour({hourStart:start,materials:[material('a'),material('b')]});
    const {published:_published,stale:_stale,...value}=first;
    const replay=f.store.repositories.informationTree.publish('local',value,{expectedHead:expected});assert.equal(replay.published,false);assert.equal(replay.stale,true);assert.equal(f.service.list('local',{startAt:start,endAt:start+H}).hours[0].edition.id,second.id);
  }finally{f.store.close();}
});
test('real SQLite metadata port matches saved feed material version without body reads',async()=>{
  const f=fixture();try{
    const r=f.store.repositories.feed;
    const source=r.upsertSourceAccount({workspaceId:'local',provider:'x',externalId:'fixture-source',displayName:'来源'});
    const capture=r.saveCapture({workspaceId:'local',provider:'x',externalId:'fixture-post',sourceAccountId:source.id,sourceUrl:'https://example.com/post',contentHash:'fixture-hash'});
    const item=r.saveContentItem({workspaceId:'local',captureId:capture.id,originType:'subscription',contentType:'post',title:'简讯',body:'作者完整内容。\n评论：\n普通评论不作为作者事实。',publishedAt:start+1});
    const feed=createFeedService({legacyRepository:{},feedRepository:r,sourcePort:{read:async()=>{throw new Error('no network');}}});
    const port=createTreeMaterialPort({feedService:feed});
    const ingestedHour=Math.floor(item.createdAt/H)*H;
    const candidates=await port.candidates('local',{startAt:ingestedHour,endAt:ingestedHour+H});assert.equal(candidates[0].id,`feed:${item.id}`);assert.equal(candidates[0].eventAt,item.createdAt);assert.ok(!Object.hasOwn(candidates[0],'body'));
    const saved=await port.materials('local',[candidates[0].id]);assert.equal(saved[0].version,candidates[0].version);assert.equal(saved[0].contentLevel,'full');assert.ok(saved[0].paragraphs.some(p=>p.role==='comment'));
    assert.deepEqual(f.store.repositories.media.informationCandidates('local',{startAt:start,endAt:start+H,extractorVersion:'fixture'}),[]);
  }finally{f.store.close();}
});
test('changed information policy leaves explicit pending instead of silently using old draft or rereading originals',async()=>{
  const m=material('a'),f=fixture({candidatePort:async()=>[{id:m.id,version:m.version}]});try{
    await f.service.prepareInformation({materials:[m]});
    const skills={...f.skills,information:{...f.skills.information,version:'f'.repeat(64),compatiblePromptHashes:[]}};
    const changed=createInformationTreeService({...f.options,skills,materialPort:async()=>{throw new Error('no original fallback');}});
    const before=f.calls.length,h=await changed.generateHour({hourStart:start});assert.equal(h.status,'partial');assert.equal(h.pending[0].reason,'information-not-ready');assert.equal(h.inputIds.length,0);assert.equal(f.calls.length,before);
  }finally{f.store.close();}
});

test('short qualified hourly module passes to daily even when its information child was long; fixed-input repeat is free',async()=>{
  const f=fixture({catalog:{tags:[{id:'software',name:'软件'}]}});try{
    f.runtime.run=async input=>{f.calls.push(input);const p=JSON.parse(input.message);return {answer:JSON.stringify(input.usageStage==='tree-information' ? {title:'Claude动态视频：预览纠错后封装Skill',text:'作者使用Claude制作动态视频，先预览并修正画面，最终把规则和关键操作封装成可复用Skill。'.repeat(3),tagId:'software'} : {modules:[{title:'Claude动态视频：预览纠错后封装Skill',text:'作者用Claude制作动态视频，预览纠错后封装为可复用Skill。',tagId:'software',inputIds:p.inputs.map(n=>n.id)}]})};};
    const prepared=await f.service.prepareInformation({materials:[material('tutorial')]});assert.equal(prepared.nodes[0].safePassthrough,false);
    const hour=await f.service.generateHour({hourStart:start,materials:[material('tutorial')]});assert.equal(f.calls.filter(c=>c.usageStage==='tree-hourly').length,1);
    const afterHour=f.calls.length,daily=await f.service.generateDaily({window:{startAt:start,endAt:start+H},hours:[hour]});assert.equal(f.calls.length,afterHour);
    const parent=f.service.node('local',daily.roots[0]);assert.deepEqual(parent.children,hour.roots);assert.equal(parent.text,f.service.node('local',hour.roots[0]).text);
    const repeat=await f.service.generateHour({hourStart:start,materials:[material('tutorial')]});const repeatDaily=await f.service.generateDaily({window:{startAt:start,endAt:start+H},hours:[repeat]});assert.equal(f.calls.length,afterHour);assert.equal(repeatDaily.id,daily.id);
  }finally{f.store.close();}
});

test('catalog extension reclassifies only affected saved drafts without changing text or reading original',async()=>{
  const old={tags:[{id:'software',name:'软件'}]},f=fixture({catalog:old});try{
    const before=await f.service.prepareInformation({materials:[material('telecom','卫星网络通过海缆连接远端数据中心。'),material('unrelated','软件产品已开放测试。')]});
    const priorVersion=before.nodes[0].catalogVersion;
    const next={tags:[...old.tags,{id:'communications',name:'通信与网络'}],reading:{version:'2',groupByTag:{communications:'communications'},reclassification:{fromVersion:priorVersion,keywords:['卫星','海缆','数据中心']}}};
    const calls=f.calls.length;let originals=0;
    const service=createInformationTreeService({...f.options,catalog:next,candidatePort:async()=>before.nodes.map(n=>({id:n.sourceId,version:n.sourceVersion})),materialPort:async()=>{originals++;throw new Error('must not read originals');}});
    f.runtime.run=async input=>{f.calls.push(input);const p=JSON.parse(input.message);return {answer:JSON.stringify(input.usageStage==='tree-classification' ? {tagId:'communications'} : {modules:p.inputs.map(n=>({...n,inputIds:[n.id]}))})};};
    const edition=await service.generateHour({hourStart:start});assert.equal(edition.status,'ready');assert.equal(originals,0);
    const added=f.calls.slice(calls);assert.equal(added.filter(c=>c.usageStage==='tree-classification').length,1);assert.equal(added.filter(c=>c.usageStage==='tree-information').length,0);
    const updated=service.list('local',{startAt:start,endAt:start+H}).information;assert.equal(updated.find(n=>n.sourceId==='telecom').tagId,'communications');assert.equal(updated.find(n=>n.sourceId==='unrelated').tagId,'software');for(const n of updated)assert.equal(n.text,before.nodes.find(b=>b.sourceId===n.sourceId).text);
    const after=f.calls.length;await service.generateHour({hourStart:start});assert.equal(f.calls.length,after);
  }finally{f.store.close();}
});

test('title-only prompt revision accepts explicitly compatible completed information without rewriting text',async()=>{
  const f=fixture();try{
    const prepared=await f.service.prepareInformation({materials:[material('a')]});
    const nextSkills={...f.skills,information:{...f.skills.information,version:'new-title-guidance',compatiblePromptHashes:[f.skills.information.version]}};
    const service=createInformationTreeService({...f.options,skills:nextSkills,candidatePort:async()=>[{id:'a',version:'1'}]});const before=f.calls.length;
    const again=await service.prepareInformation({materials:[material('a')]});assert.equal(again.cacheHits,1);assert.equal(again.nodes[0].text,prepared.nodes[0].text);
    const edition=await service.generateHour({hourStart:start});assert.equal(edition.status,'ready');assert.equal(f.calls.length,before);
  }finally{f.store.close();}
});

test('queued priority promotion preserves running and other workspace jobs and creates no duplicate',()=>{
  const s=createStore(':memory:');try{
    const running=s.createJob({type:'report.information.prepare',workspaceId:'local',input:{sourceIds:['a']}});s.claimNextJob('worker',['report.information.prepare']);
    const queued=s.createJob({type:'report.information.prepare',workspaceId:'local',input:{sourceIds:['b']}}),other=s.createJob({type:'report.information.prepare',workspaceId:'local',input:{sourceIds:['c']}});
    assert.deepEqual(s.prioritizeQueuedJobs('other',[other.id],40),[]);
    assert.deepEqual(s.prioritizeQueuedJobs('local',[running.id,queued.id,queued.id],40),[queued.id]);assert.equal(s.getJob(running.id).status,'running');assert.equal(s.getJob(running.id).priority,0);assert.equal(s.getJob(other.id).priority,0);assert.equal(s.claimNextJob('second',['report.information.prepare']).id,queued.id);assert.equal(s.listJobs(20).length,3);
  }finally{s.close();}
});

test('future hour cannot become a ready empty report or trigger a model',async()=>{
  const f=fixture();try{const at=Math.ceil(Date.now()/H)*H+H;await assert.rejects(f.service.generateHour({hourStart:at}),/尚未开始/);assert.equal(f.calls.length,0);assert.equal(f.service.list('local',{startAt:at,endAt:at+H}).hours.length,0);}finally{f.store.close();}
});

test('unfinished hour refuses official publication without model calls',async()=>{
  const f=fixture({now:()=>start+H-1});try{
    await assert.rejects(f.service.generateHour({hourStart:start}),/尚未结束/);
    assert.equal(f.calls.length,0);assert.equal(f.service.list('local',{startAt:start,endAt:start+H}).hours.length,0);
  }finally{f.store.close();}
});

test('premature ready empty edition can be corrected but completed empty ready remains protected',async()=>{
  const f=fixture({candidatePort:async()=>[{id:'pending',version:'1'}]});try{
    const r=f.store.repositories.informationTree;
    const old={id:'premature',layer:'hourly',window:{startAt:start,endAt:start+H},timezone:'Asia/Shanghai',status:'ready',roots:[],inputIds:[],pendingIds:[],pending:[],groupFailures:[],missingHours:[],generatedAt:start-1,policyHash:f.service.policyHash};
    r.publish('local',old);
    const fixed=await f.service.generateHour({hourStart:start});assert.equal(fixed.status,'partial');assert.equal(fixed.published,true);
    assert.equal(r.getEdition('local','premature').status,'ready');assert.equal(r.head('local','hourly',old.window),fixed.id);
    r.publish('local',{...old,id:'completed-empty',generatedAt:start+H});
    const sparse=await f.service.generateHour({hourStart:start});assert.equal(sparse.published,false);assert.equal(r.head('local','hourly',old.window),'completed-empty');
  }finally{f.store.close();}
});

test('prepared ended hours refresh once, retain running follow-up, skip published versions and stale/current windows',async()=>{
  const f=fixture();try{
    const prepared=await f.service.prepareInformation({materials:[material('a')]});
    const at=start+H+1000;
    const jobs=enqueuePreparedHourRefreshes(f.store,f.service,'local',prepared.nodes,at);assert.equal(jobs.length,1);assert.equal(jobs[0].input.hourStart,start);
    assert.equal(enqueuePreparedHourRefreshes(f.store,f.service,'local',prepared.nodes,at).length,0);
    assert.equal(enqueuePreparedHourRefreshes(f.store,f.service,'other',prepared.nodes,start+H-1).length,0);
    assert.equal(enqueuePreparedHourRefreshes(f.store,f.service,'other',prepared.nodes,start+25*H).length,0);
    // Claim without changing the future availableAt through the public CAS operation.
    f.store.rescheduleQueuedJobs('local',[{id:jobs[0].id,expectedAvailableAt:jobs[0].availableAt,availableAt:1}]);
    f.store.claimNextJob('worker',['report.hourly.extract']);
    assert.equal(enqueuePreparedHourRefreshes(f.store,f.service,'local',prepared.nodes,at).length,1);
    await f.service.generateHour({hourStart:start});
    assert.equal(enqueuePreparedHourRefreshes(f.store,f.service,'local',prepared.nodes,at).length,0);
  }finally{f.store.close();}
});

test('latest preparation promotion uses metadata and preserves unrelated, running and other workspace jobs',async()=>{
  const f=fixture();try{
    const running=f.store.createJob({type:TREE_PREPARE_JOB_TYPE,input:{sourceIds:['recent']}});f.store.claimNextJob('worker',[TREE_PREPARE_JOB_TYPE]);
    const old=f.store.createJob({type:TREE_PREPARE_JOB_TYPE,input:{sourceIds:['old']}}),recent=f.store.createJob({type:TREE_PREPARE_JOB_TYPE,input:{sourceIds:['recent']}});
    const other={...recent,id:'other-workspace',workspaceId:'other'};
    const scopedStore={...f.store,listOpenJobs:type=>[...f.store.listOpenJobs(type),other]};
    const candidates=async(workspace,window)=>{assert.equal(workspace,'local');assert.deepEqual(window,{startAt:start-H,endAt:start+H});return [{id:'recent'}];};
    assert.deepEqual(await prioritizeRecentTreePreparation(scopedStore,candidates,'local',start+1),[recent.id]);
    assert.equal(f.store.getJob(old.id).priority,0);assert.equal(other.priority,0);assert.equal(f.store.getJob(running.id).priority,0);
    assert.equal(f.store.claimNextJob('second',[TREE_PREPARE_JOB_TYPE]).id,recent.id);
    const aged=f.store.createJob({type:TREE_PREPARE_JOB_TYPE,priority:30,input:{sourceIds:['aged']}});
    const manual=f.store.createJob({type:TREE_PREPARE_JOB_TYPE,priority:80,input:{sourceIds:['manual']}});
    const next=f.store.createJob({type:TREE_PREPARE_JOB_TYPE,input:{sourceIds:['next']}});
    await prioritizeRecentTreePreparation(f.store,async()=>[{id:'next',eventAt:start+1}],'local',start+H+1);
    assert.equal(f.store.getJob(aged.id).priority,0);assert.equal(f.store.getJob(manual.id).priority,80);assert.equal(f.store.getJob(next.id).priority,30);
    assert.deepEqual(f.store.reprioritizeQueuedJobs('local',[{id:next.id,priority:0,expectedPriority:20}]),[]);
  }finally{f.store.close();}
});

test('failed preparation becomes terminal after the attempt cap and is not counted as still pending',async()=>{
  let nowAt=start+2*H;
  const m=material('a');
  const f=fixture({now:()=>nowAt,prepAttemptCap:2,candidatePort:async()=>[{id:m.id,version:m.version,eventAt:start+1}]});
  try{
    let calls=0;
    f.runtime.run=async()=>{calls+=1;throw Object.assign(new Error('upstream'),{code:'retryable-model-error'});};
    const first=await f.service.prepareInformation({materials:[m]});
    assert.equal(first.pending[0].reason,'retryable-model-error');
    assert.equal(first.pending[0].attempts,1);
    assert.equal(first.pending[0].retryable,true);
    nowAt+=31*60*1000;
    const second=await f.service.prepareInformation({materials:[m]});
    assert.equal(second.pending[0].reason,'prep-exhausted');
    assert.equal(second.pending[0].retryable,false);
    assert.equal(second.pending[0].attempts,2);
    assert.equal(calls,2);
    nowAt+=31*60*1000;
    const cached=await f.service.prepareInformation({materials:[m]});
    assert.equal(cached.pending[0].reason,'prep-exhausted');
    assert.equal(calls,2);
    const hour=await f.service.generateHour({hourStart:start});
    assert.equal(hour.pending[0].reason,'prep-exhausted');
    assert.deepEqual(hour.pendingIds,[]);
    assert.equal(hour.status,'partial');
  }finally{f.store.close();}
});

test('a missing preparation stage stays information-not-ready and an article stage is not dropped',async()=>{
  const waiting=material('waiting'),failed=material('failed');
  const f=fixture({candidatePort:async()=>[waiting,failed].map(item=>({id:item.id,version:item.version,eventAt:start+1}))});
  try{
    f.store.repositories.report.saveAnalysisStage('local','tree-preparation',`article:${failed.id}`,'hash',{sourceId:failed.id,sourceVersion:failed.version},{pending:{id:failed.id,reason:'budget-deferred',retryable:true,retryAt:start+H,sourceVersion:failed.version,attempts:1}},'failed','budget-deferred');
    const hour=await f.service.generateHour({hourStart:start});
    assert.equal(hour.pending.find(item=>item.id===waiting.id).reason,'information-not-ready');
    assert.equal(hour.pending.find(item=>item.id===waiting.id).attempts,undefined);
    assert.equal(hour.pending.find(item=>item.id===failed.id).reason,'budget-deferred');
    assert.deepEqual(hour.pendingIds.slice().sort(),[failed.id,waiting.id].sort());
    f.runtime.run=async()=>({answer:'{"status":"needs_content"}'});
    await f.service.prepareInformation({materials:[waiting]});
    const settled=await f.service.generateHour({hourStart:start});
    assert.equal(settled.pending.find(item=>item.id===waiting.id).reason,'needs-content');
    assert.equal(settled.pendingIds.includes(waiting.id),false);
    assert.equal(settled.pendingIds.includes(failed.id),true);
  }finally{f.store.close();}
});

test('preparation queue keeps materials independently claimable without increasing concurrency',()=>{
  const f=fixture();try{
    const jobs=enqueueTreePreparation(f.store,'local',['older','latest','older']);assert.equal(jobs.length,2);
    assert.deepEqual(jobs.map(j=>j.input.sourceIds),[['older'],['latest']]);
    f.store.prioritizeQueuedJobs('local',[jobs[1].id],30);assert.equal(f.store.claimNextJob('worker',[TREE_PREPARE_JOB_TYPE]).id,jobs[1].id);
    assert.equal(enqueueTreePreparation(f.store,'local',['older']).length,0);
  }finally{f.store.close();}
});

test('legacy queued preparation split is atomic, idempotent and preserves inputs, scheduling, running and unrelated jobs',()=>{
  const f=fixture();try{
    const running=f.store.createJob({type:TREE_PREPARE_JOB_TYPE,input:{workspaceId:'local',sourceIds:['running-a','running-b']}});f.store.claimNextJob('worker',[TREE_PREPARE_JOB_TYPE]);
    const batch=f.store.createJob({type:TREE_PREPARE_JOB_TYPE,priority:30,availableAt:Date.now()+60000,maxAttempts:1,input:{workspaceId:'local',sourceIds:['a','b'],catchup:true,force:true}});
    const unrelated=f.store.createJob({type:'report.hourly.extract',input:{hourStart:start}});
    assert.deepEqual(f.store.splitQueuedInformationPreparation('other',[batch.id]),[]);
    const result=f.store.splitQueuedInformationPreparation('local',[running.id,batch.id,unrelated.id]);assert.equal(result.length,1);
    const old=f.store.getJob(batch.id);assert.equal(old.status,'cancelled');assert.deepEqual(old.input,batch.input);assert.equal(old.attemptCount,0);assert.equal(old.output.reason,'single-material-preparation');
    const children=result[0].jobIds.map(id=>f.store.getJob(id));assert.deepEqual(children.map(j=>j.input.sourceIds),[['a'],['b']]);
    for(const j of children){assert.equal(j.priority,30);assert.equal(j.availableAt,batch.availableAt);assert.equal(j.maxAttempts,1);assert.equal(j.input.force,true);assert.equal(j.input.catchup,true);}
    assert.equal(f.store.getJob(running.id).status,'running');assert.equal(f.store.getJob(unrelated.id).status,'queued');assert.deepEqual(f.store.splitQueuedInformationPreparation('local',[batch.id]),[]);
  }finally{f.store.close();}
});

test('invalid legacy batch rolls back all split children and original status changes',()=>{
  const f=fixture();try{
    const valid=f.store.createJob({type:TREE_PREPARE_JOB_TYPE,input:{sourceIds:['a','b']}}),bad=f.store.createJob({type:TREE_PREPARE_JOB_TYPE,input:{sourceIds:['c','d'],unexpected:true}});
    assert.throws(()=>f.store.splitQueuedInformationPreparation('local',[valid.id,bad.id]));
    assert.equal(f.store.getJob(valid.id).status,'queued');assert.equal(f.store.listOpenJobs(TREE_PREPARE_JOB_TYPE).length,2);
  }finally{f.store.close();}
});

test('mixed preparation schedules only the nearest affected ended hour',async()=>{
  const f=fixture();try{
    const prepared=await f.service.prepareInformation({materials:[material('a'),{...material('b'),publishedAt:start-H+1}]});
    const jobs=enqueuePreparedHourRefreshes(f.store,f.service,'local',prepared.nodes,start+H+1);
    assert.equal(jobs.length,1);assert.equal(jobs[0].input.hourStart,start);assert.equal(jobs[0].priority,10);assert.equal(jobs[0].availableAt,start+H+1+60000);
    const historical=enqueuePreparedHourRefreshes(f.store,f.service,'local',prepared.nodes.filter(n=>n.window.startAt===start-H),start+2*H+1);
    assert.equal(historical.length,1);assert.equal(historical[0].priority,-5); // regular scheduled priority 0 wins
  }finally{f.store.close();}
});

test('a prepare refresh after the hourly slot is available within a minute',async()=>{
  const late=fixture();try{
    const prepared=await late.service.prepareInformation({materials:[material('a')]});
    const at=start+H+30*60000+5000;
    const jobs=enqueuePreparedHourRefreshes(late.store,late.service,'local',prepared.nodes,at,{minute:30});
    assert.equal(jobs.length,1);
    assert.equal(jobs[0].availableAt,at+60000);
  }finally{late.store.close();}
  const early=fixture();try{
    const prepared=await early.service.prepareInformation({materials:[material('a')]});
    const jobs=enqueuePreparedHourRefreshes(early.store,early.service,'local',prepared.nodes,start+H+10*60000,{minute:30});
    assert.equal(jobs.length,1);
    assert.equal(jobs[0].availableAt,start+H+30*60000);
  }finally{early.store.close();}
});

test('explicit historical refresh uses low Harness priority while latest ended hour keeps foreground priority',async()=>{
  const f=fixture({now:()=>start+2*H,catalog:{tags:[{id:'macro',name:'宏观'}]}});try{
    const text='关于计划状态和适用条件的较长正文。'.repeat(12);
    await f.service.prepareInformation({materials:[material('a',text),{...material('b',text+'后一小时的新增消息。'),publishedAt:start+H+1}]});
    await f.service.generateHourlyDigests({hourStart:start});
    await f.service.generateHourlyDigests({hourStart:start+H});
    assert.deepEqual(f.calls.filter(c=>c.usageStage==='tree-hourly').map(c=>c.executionPriority),[-10,10]);
  }finally{f.store.close();}
});

test('registered preparation handler feeds its successful versions into an ended-hour refresh',async()=>{
  const hour=Math.floor(Date.now()/H)*H-H;
  const m={...material('handler-ready'),publishedAt:hour+1};
  const f=fixture({materialPort:async()=>[m]});try{
    const handler=createInformationTreeJobHandlers(f.service)[TREE_PREPARE_JOB_TYPE];
    const result=await handler({sourceIds:[m.id]},{store:f.store});assert.equal(result.prepared,1);
    const queued=f.store.listOpenJobs('report.hourly.extract');assert.equal(queued.length,1);assert.equal(queued[0].input.hourStart,hour);
    await handler({sourceIds:[m.id]},{store:f.store});assert.equal(f.store.listOpenJobs('report.hourly.extract').length,1);
    const published=await f.service.generateHour({hourStart:hour});assert.equal(published.published,true);assert.equal(published.inputIds.length,1);
    await handler({sourceIds:[m.id]},{store:f.store});assert.equal(f.calls.length,1);
  }finally{f.store.close();}
});

test('a published edition with the same material stamps is not refreshed again', () => {
  const hourNode = { id: 'new-node', sourceId: 'src', sourceVersion: 'v1', window: { startAt: start } };
  const published = { inputIds: ['old-node'] };
  const lookup = (id) => (id === 'old-node' ? { sourceId: 'src', sourceVersion: 'v1' } : null);
  assert.equal(editionCoversMaterials(published, [hourNode], lookup), true);
  assert.equal(editionCoversMaterials({ inputIds: ['old-node'] }, [{ ...hourNode, sourceVersion: 'v2' }], lookup), false);
  const store = {
    createJob() { throw new Error('should not enqueue'); },
    listOpenJobs() { return []; },
  };
  const service = {
    list() { return { hours: [{ edition: published, attempt: { inputIds: ['attempt-node'] } }] }; },
    node(_workspace, id) { return lookup(id) || (id === 'attempt-node' ? { sourceId: 'src', sourceVersion: 'v1' } : null); },
  };
  assert.deepEqual(enqueuePreparedHourRefreshes(store, service, 'local', [hourNode], start + H + 1000), []);
});

test('a non-terminal failed attempt with the same materials is queued again', () => {
  const hourNode = { id: 'new-node', sourceId: 'src', sourceVersion: 'v1', window: { startAt: start } };
  const service = {
    list() { return { hours: [{ edition: null, attempt: { inputIds: ['old-node'], terminal: false } }] }; },
    node(_workspace, id) { return id === 'old-node' ? { sourceId: 'src', sourceVersion: 'v1' } : null; },
  };
  const store = {
    createJob(job) { return { ...job, id: 'retry-hour' }; },
    listOpenJobs() { return []; },
  };
  const jobs = enqueuePreparedHourRefreshes(store, service, 'local', [hourNode], start + H + 1000);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].input.hourStart, start);
  const stopped = {
    list() { return { hours: [{ edition: null, attempt: { inputIds: ['old-node'], terminal: true } }] }; },
    node: service.node,
  };
  assert.deepEqual(enqueuePreparedHourRefreshes({
    createJob() { throw new Error('terminal attempt must not enqueue'); },
    listOpenJobs() { return []; },
  }, stopped, 'local', [hourNode], start + H + 1000), []);
});

test('truncated hourly output retries a larger model and is not cached as a failed stage', async () => {
  const f = fixture();
  const long = (id) => ({ ...material(id, '公司宣布新产品已开放测试。'.repeat(12)), publishedAt: start + 1 });
  let hourly = 0;
  f.runtime.run = async (input) => {
    f.calls.push(input);
    const payload = JSON.parse(input.message);
    if (input.usageStage !== 'tree-hourly') {
      return { answer: JSON.stringify({ title: payload.source.title, text: payload.source.paragraphs.map((row) => row.text).join(''), tagId: payload.tags[0]?.id ?? null }) };
    }
    hourly += 1;
    if (!input.googleModel) throw Object.assign(new Error('输出被截断'), { finishReason: 'MAX_TOKENS' });
    assert.equal(input.googleModel, 'gemini-3.5-flash-lite');
    assert.equal(input.hourlyMaxTokens, 8192);
    return { answer: JSON.stringify({ modules: payload.inputs.map((item) => ({ title: item.title, text: item.text, tagId: payload.tagId, inputIds: [item.id] })) }) };
  };
  try {
    const hour = await f.service.generateHour({ hourStart: start, materials: [long('a'), long('b')] });
    assert.equal(hour.status, 'ready');
    assert.equal(hourly, 2);
    const before = f.calls.length;
    const again = await f.service.generateHour({ hourStart: start });
    assert.equal(again.status, 'ready');
    assert.equal(f.calls.length, before);
  } finally { f.store.close(); }
});

test('a truncated single group is not reused as a cached whole-task failure', async () => {
  const f = fixture();
  const long = { ...material('only', '公司宣布新产品已开放测试。'.repeat(12)), publishedAt: start + 1 };
  let hourly = 0;
  f.runtime.run = async (input) => {
    f.calls.push(input);
    const payload = JSON.parse(input.message);
    if (input.usageStage !== 'tree-hourly') {
      return { answer: JSON.stringify({ title: payload.source.title, text: payload.source.paragraphs.map((row) => row.text).join(''), tagId: null }) };
    }
    hourly += 1;
    throw Object.assign(new Error('输出被截断'), { finishReason: 'MAX_TOKENS', code: 'truncated' });
  };
  try {
    const first = await f.service.generateHour({ hourStart: start, materials: [long] });
    assert.equal(first.status, 'failed');
    const seen = hourly;
    const second = await f.service.generateHour({ hourStart: start, materials: [long] });
    assert.equal(second.status, 'failed');
    assert.ok(hourly > seen);
  } finally { f.store.close(); }
});

test('truncated groups split at most three times and record the split count', async () => {
  const f = fixture();
  const lines = [];
  const previous = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); previous(...args); };
  const text = '公司宣布新产品已开放测试。'.repeat(6);
  f.runtime.run = async (input) => {
    f.calls.push(input);
    const payload = JSON.parse(input.message);
    if (input.usageStage !== 'tree-hourly') {
      return { answer: JSON.stringify({ title: payload.source.title, text: payload.source.paragraphs.map((row) => row.text).join(''), tagId: null }) };
    }
    const count = Array.isArray(payload.inputs) ? payload.inputs.length : 0;
    if (count === 1) throw new Error('depth cap should stop before a single row');
    throw Object.assign(new Error('输出被截断'), { finishReason: 'MAX_TOKENS' });
  };
  try {
    const hour = await f.service.generateHour({
      hourStart: start,
      materials: Array.from({ length: 16 }, (_, index) => ({ ...material(`n${index}`, text), publishedAt: start + 1 })),
    });
    assert.equal(hour.status, 'failed');
    assert.ok(lines.some((line) => line.includes('truncation-split') && line.includes('splits=3')), lines.join('\n'));
    const hourly = f.calls.filter((call) => call.usageStage === 'tree-hourly');
    assert.equal(JSON.parse(hourly.at(-1).message).inputs.length, 2);
  } finally {
    console.log = previous;
    f.store.close();
  }
});
