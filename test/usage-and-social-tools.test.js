import test from 'node:test';
import assert from 'node:assert/strict';
import {createStore} from '../packages/database/src/index.js';
import {createModelUsageService} from '../packages/domain/src/model-usage-service.js';
import {emptyTokenUsage} from '../packages/contracts/src/model-usage.js';
import {createLocalToolRegistry} from '../packages/runtime/src/local-tools.js';
import {resolveHarnessRunTools} from '../packages/harness/src/harness-agent-runtime.js';
import {createToolGateway} from '../packages/harness/src/tool-gateway.js';
import {buildRuntimeContext} from '../packages/runtime/src/runtime-context.js';
import {createFeedService} from '../packages/domain/src/feed-service.js';
import {createTreeMaterialPort} from '../packages/domain/src/information-tree-materials.js';
import {createInformationTreeService} from '../packages/domain/src/information-tree-service.js';
import {enqueueTreePreparation} from '../packages/runtime/src/information-tree-module.js';
import {createXJobHandlers} from '../packages/connectors/src/x/index.js';
import {createXueqiuJobHandlers} from '../packages/connectors/src/xueqiu/index.js';
import {loadInformationTreeSkills} from '../packages/runtime/src/information-tree/skills.js';

function usage(store,id,overrides={}){store.repositories.modelUsage.save({id,workspaceId:'local',kind:'request',jobId:'',jobAttempt:null,stage:'ask',applicationSessionId:'',harnessSessionId:'private',turn:1,step:1,attempt:1,provider:'private',model:'private',status:'succeeded',completeness:'complete',usage:{...emptyTokenUsage(),inputTokens:5,outputTokens:2,cacheReadTokens:3,totalTokens:10},occurredAt:100,supplierAmount:null,supplierCurrency:null,...overrides});}
test('maintenance postpones only queued jobs at expected availability and restores without overwriting newer scheduling',()=>{
 const store=createStore(':memory:');try{
  const job=store.createJob({type:'fixture.job',availableAt:Date.now()+100000,input:{}}),later=job.availableAt+100000;
  assert.deepEqual(store.rescheduleQueuedJobs('foreign',[{id:job.id,availableAt:later,expectedAvailableAt:job.availableAt}]),[]);
  assert.deepEqual(store.rescheduleQueuedJobs('local',[{id:job.id,availableAt:later,expectedAvailableAt:job.availableAt}]),[job.id]);
  assert.deepEqual(store.rescheduleQueuedJobs('local',[{id:job.id,availableAt:0,expectedAvailableAt:job.availableAt}]),[]);
  assert.deepEqual(store.rescheduleQueuedJobs('local',[{id:job.id,availableAt:0,expectedAvailableAt:later}]),[job.id]);
  store.claimNextJob('worker',['fixture.job']);assert.deepEqual(store.rescheduleQueuedJobs('local',[{id:job.id,availableAt:later,expectedAvailableAt:0}]),[]);
 }finally{store.close();}
});
test('usage summary counts requests and failed attempts once, scopes workspace/time and keeps unknown buckets',()=>{
 const store=createStore(':memory:');try{
  usage(store,'one');usage(store,'one');usage(store,'turn',{kind:'turn'});
  usage(store,'failed',{status:'failed',stage:'tree-information',occurredAt:200});
  usage(store,'unknown',{status:'pending',completeness:'missing',usage:emptyTokenUsage(),occurredAt:300});
  const service=createModelUsageService({repository:store.repositories.modelUsage}),data=service.summary();
  assert.equal(data.requestCount,3);assert.equal(data.tokens.totalTokens.reported,20);assert.equal(data.tokens.totalTokens.unknownRequests,1);
  assert.equal(data.statusCounts.failed,1);assert.equal(data.tokens.cacheReadTokens.reported,6);
  assert.equal(data.statusCounts.succeeded,1);assert.equal(data.statusCounts.pending,1);
  assert.equal(service.summary({startAt:200,endAt:300}).requestCount,1);assert.equal(service.summary({stage:'ask'}).requestCount,2);
  assert.equal(service.summary({jobId:'absent'}).requestCount,0);assert.throws(()=>service.summary({startAt:300,endAt:200}));
  assert.equal(createModelUsageService({repository:store.repositories.modelUsage,workspaceId:'foreign'}).summary().requestCount,0);
  assert.ok(!JSON.stringify(data).includes('private'));
 }finally{store.close();}
});
test('usage tool is in open Harness catalog and callable through Gateway; closed trees have no tools',async()=>{
 const store=createStore(':memory:');let gateway;try{
  usage(store,'one',{occurredAt:Date.parse('2026-10-07T00:00:00+08:00')});
  const tools=createLocalToolRegistry({contextService:{},feedService:{},knowledgeService:{},tradingService:{},modelUsageService:createModelUsageService({repository:store.repositories.modelUsage})});
  const open=resolveHarnessRunTools(tools,{closedContext:false});assert.ok(open.catalog.some(t=>t.id==='model.usage.get'));
  assert.deepEqual(resolveHarnessRunTools(tools,{closedContext:true}).catalog,[]);
  gateway=await createToolGateway({tools,allowedToolIds:['model.usage.get']});gateway.setContext({workspaceId:'local',runtimeContext:buildRuntimeContext(new Date('2026-10-07T09:00:00+08:00'),'Asia/Shanghai')});
  const response=await fetch(`${gateway.url}/tools/execute`,{method:'POST',headers:{authorization:`Bearer ${gateway.token}`,'content-type':'application/json'},body:JSON.stringify({id:'model_usage_get',input:{timeRange:'today'}})});
  assert.equal(response.status,200);const output=await response.json();assert.equal(output.result.data.requestCount,1);assert.equal(output.result.data.tokens.totalTokens.reported,10);
  await assert.rejects(()=>tools.execute('model.usage.get',{workspaceId:'foreign'},{workspaceId:'local'}));
 }finally{await gateway?.close();store.close();}
});
test('direct X and Xueqiu sync prepare approved original posts before translation and include them in hourly refs',async()=>{
 const store=createStore(':memory:'),hour=Math.floor(Date.now()/3600000)*3600000-3600000,seen=[];
 const snapshot=provider=>({mode:'live',items:[{externalId:`${provider}-1`,sourceUrl:`https://example.com/${provider}`,title:`${provider}原作者发布产品`,body:'原作者宣布新产品开放测试，并说明试用条件。',authorName:'原作者',publishedAt:hour+1000},{externalId:`${provider}-drop`,sourceUrl:`https://example.com/${provider}/drop`,title:'推广',body:'广告推广',publishedAt:hour+1000}]});
 const feed=createFeedService({legacyRepository:store,feedRepository:store.repositories.feed,sourcePort:{findByProvider:provider=>({id:`content.${provider}.home`}),persistence:id=>({providerId:id.split('.')[1],sourceAccount:{externalId:`${id}:test`}}),read:async id=>({data:snapshot(id.split('.')[1])})},
  translationPort:{translate:async()=>{throw Error('树准备不能等待翻译');}},feedFilter:{evaluate:async input=>input.item.externalId.endsWith('drop') ? {action:'skip',createContentItem:false} : {action:'keep',createContentItem:true,status:'ready'}},
  onContentReady:({workspaceId,sourceIds})=>enqueueTreePreparation(store,workspaceId,sourceIds)});
 try{
  for(const [provider,factory] of [['x',createXJobHandlers],['xueqiu',createXueqiuJobHandlers]]){
   const handlers=factory({syncFeed:(p,q,a)=>feed.getExternalFeed(p,q,a)});await handlers[`feed.${provider}.sync`]({feed:'following'},{job:{workspaceId:'local'},store});
  }
  const jobs=store.listOpenJobs('report.information.prepare');assert.equal(jobs.length,2);assert.equal(jobs.flatMap(j=>j.input.sourceIds).length,2);
  const port=createTreeMaterialPort({feedService:feed}),materials=await port.materials('local',jobs.flatMap(j=>j.input.sourceIds));assert.ok(materials.every(m=>m.kind==='social'));
  const service=createInformationTreeService({repository:store.repositories.informationTree,reportRepository:store.repositories.report,materialPort:port.materials,candidatePort:port.candidates,skills:loadInformationTreeSkills(),catalog:{tags:[{id:'ai',name:'AI'}]},agentRuntime:{run:async input=>{seen.push(input);const p=JSON.parse(input.message);return {answer:JSON.stringify(input.usageStage==='tree-information' ? {title:p.source.title,text:'原作者宣布新产品开放测试，并说明试用条件。',tagId:'ai'} : {modules:[{title:'原作者产品开放测试',text:'两位作者发布新产品测试消息。',tagId:p.tagId,inputIds:p.inputs.map(n=>n.id)}]})};}}});
  const prepared=await service.prepareInformation({materials});assert.equal(prepared.nodes.length,2);
  const edition=await service.generateHour({workspaceId:'local',hourStart:hour});assert.equal(edition.status,'ready');
  const sourceIds=edition.roots.flatMap(id=>store.repositories.informationTree.getNode('local',id).articleIds);assert.deepEqual(new Set(sourceIds),new Set(materials.map(m=>m.id)));
  assert.ok(seen.every(r=>r.closedContext));
 }finally{store.close();}
});
