import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createStore} from '../packages/database/src/index.js';
import {createGeminiArticleAdmission} from '../packages/runtime/src/gemini-article-admission.js';
import {nextGeminiDailyReset} from '../packages/connectors/src/gemini-grok-task.js';
import {createHarnessExecutionRuntime} from '../packages/harness/src/article-execution-pool.js';
import {createToolRegistry} from '../packages/runtime/src/tool-registry.js';
import {createJobRunner,resolveJobTypeConcurrency} from '../packages/runtime/src/job-runner.js';

const keys={GEMINI_API_KEY:'one',GEMINI_API_KEY2:'two',GEMINI_API_KEY3:'three',GEMINI_API_KEY4:'four',GEMINI_API_KEY5:'five'};
const env={...keys,AI_CENTER_GEMINI_ARTICLE_POOL_CONCURRENCY:'5',AI_CENTER_HARNESS_ARTICLE_PROVIDER:'google'};
const input={model:'gemini-test',inputBytes:100,maxTokens:6144};

test('five distinct keys admit at the same time; restart retains leases and release respects owner',()=>{
 const store=createStore(':memory:');let at=Date.parse('2026-10-07T08:00:00Z');
 const make=()=>createGeminiArticleAdmission({repository:store.repositories.modelQuota,env,now:()=>at});
 try {
  let a=make();const tickets=Array.from({length:5},()=>a.reserve(input));assert.equal(new Set(tickets.map(t=>t.keyEnv)).size,5);
  a=make();assert.throws(()=>a.reserve(input),e=>e.code==='budget-deferred'&&!e.quotaExhausted);
  a.release({...tickets[0],id:'wrong-owner'});assert.throws(()=>a.reserve(input));
  at+=3000;a.release(tickets[0]);assert.equal(a.reserve(input).keyEnv,tickets[0].keyEnv);
  at+=240001;assert.ok(a.reserve(input));
 }finally{store.close();}
});

test('per account minute and daily bounds, pool daily cap, Pacific reset survive admission recreation',()=>{
 const store=createStore(':memory:');let at=Date.parse('2026-10-07T08:00:00Z');
 const dailyEnv={...env,AI_CENTER_GEMINI_ARTICLE_KEY_REQUESTS_PER_DAY:'2',AI_CENTER_GEMINI_ARTICLE_REQUESTS_PER_DAY:'10'};
 const make=()=>createGeminiArticleAdmission({repository:store.repositories.modelQuota,env:dailyEnv,now:()=>at});
 try {
  for(let i=0;i<10;i++){const a=make(),t=a.reserve(input);a.release(t);at+=3000;}
  assert.throws(()=>make().reserve(input),e=>e.retryAt===Date.parse('2026-10-08T07:00:00Z')&&!e.quotaExhausted);
  at=Date.parse('2026-10-08T07:00:00Z');assert.ok(make().reserve(input));
 }finally{store.close();}
 const minute=createStore(':memory:');at=Date.parse('2026-10-07T08:00:00Z');const start=at;
 try {
  const a=createGeminiArticleAdmission({repository:minute.repositories.modelQuota,env:{...env,AI_CENTER_GEMINI_KEY_ENVS:'GEMINI_API_KEY',AI_CENTER_GEMINI_ARTICLE_MIN_INTERVAL_MS:'1',AI_CENTER_GEMINI_ARTICLE_ESTIMATED_TOKENS_PER_MINUTE:'1000000'},now:()=>at});
  for(let i=0;i<20;i++){const t=a.reserve(input);a.release(t);at++;}
  assert.throws(()=>a.reserve(input),e=>e.retryAt===start+60000&&!e.quotaExhausted);
  const other=a.reserve({...input,model:'gemini-other'});assert.equal(other.keyEnv,'GEMINI_API_KEY');a.release(other);
  at=start+60000;assert.ok(a.reserve(input));
 }finally{minute.close();}
});

test('explicit same project keys share budget and in-flight lease; quota removes only known account',()=>{
 const store=createStore(':memory:');let at=Date.parse('2026-10-07T08:00:00Z');
 try {
  const a=createGeminiArticleAdmission({repository:store.repositories.modelQuota,env:{...env,GEMINI_API_KEY_PROJECT:'same',GEMINI_API_KEY2_PROJECT:'same'},now:()=>at});
  const tickets=Array.from({length:4},()=>a.reserve(input));assert.equal(new Set(tickets.map(t=>t.project)).size,4);
  assert.throws(()=>a.reserve(input));a.failed(tickets[0],new Error('429 PerDay retryDelay: 3600s'));a.release(tickets[0]);at+=3000;
  assert.throws(()=>a.reserve(input),e=>!e.quotaExhausted);
  a.release(tickets[1]);assert.ok(a.reserve(input));
 }finally{store.close();}
});

test('frozen Harness executes five closed articles simultaneously with isolated homes, keys and answers',async()=>{
 const store=createStore(':memory:'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-parallel-')),launched=[],waiters=[];
 let active=0,maxActive=0;
 const admission=createGeminiArticleAdmission({repository:store.repositories.modelQuota,env});
 const runtime=createHarnessExecutionRuntime({tools:createToolRegistry(),env,articleAdmission:admission,runtimeDirectory:dir,createClient:async launch=>({run:async()=>{
  active++;maxActive=Math.max(maxActive,active);launched.push({key:launch.llm.apiKeyEnv,home:launch.dshHome});
  await new Promise(r=>{waiters.push(r);if(waiters.length===5)waiters.forEach(fn=>fn());});active--;
  return {finalResponse:launch.llm.apiKeyEnv,events:[]};
 },close:async()=>{}})});
 try {
  const results=await Promise.all(Array.from({length:5},()=>runtime.run({message:'saved article',closedContext:true,closedTask:'article-normalize',usageStage:'tree-information'})));
  assert.equal(maxActive,5);assert.equal(new Set(launched.map(l=>l.key)).size,5);assert.equal(new Set(launched.map(l=>l.home)).size,5);
  assert.equal(new Set(results.map(r=>r.answer)).size,5);
  assert.ok(admission.nextReadyAt(input.model)<=Date.now()+3000);
 }finally{await runtime.close();store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('JobRunner leaves queued work intact while pool budget is closed, then executes once',async()=>{
 const store=createStore(':memory:');let ready=Infinity,runs=0;
 const job=store.createJob({type:'report.information.prepare',workspaceId:'local',input:{sourceIds:['a']}});
 const runner=createJobRunner({store,handlers:{'report.information.prepare':async()=>{runs++;return {ok:true};}},readyAt:{'report.information.prepare':()=>ready},concurrency:{informationPreparationLimit:5}});
 try {
  for(let i=0;i<100;i++)assert.equal(await runner.runOnce(),null);
  assert.equal(store.getJob(job.id).status,'queued');assert.equal(store.getJob(job.id).attemptCount,0);assert.equal(runs,0);
  ready=0;await runner.runOnce();assert.equal(runs,1);assert.equal(store.getJob(job.id).status,'completed');
  assert.equal(resolveJobTypeConcurrency('report.information.prepare',{informationPreparationLimit:5}),5);
  assert.equal(resolveJobTypeConcurrency('ai.agent.run',{informationPreparationLimit:5}),1);
 }finally{runner.stop();store.close();}
});

test('one account can run different models concurrently with separate minute, day, hour and cooldown buckets',async()=>{
 const store=createStore(':memory:'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-model-pool-'));
 let at=Date.parse('2026-10-07T08:00:00Z'),active=0,maxActive=0;const waiting=[],launched=[];
 const config={...env,AI_CENTER_GEMINI_KEY_ENVS:'GEMINI_API_KEY',AI_CENTER_GEMINI_ARTICLE_MODELS:'gemini-a,gemini-b',AI_CENTER_GEMINI_ARTICLE_REQUESTS_PER_HOUR:'1',AI_CENTER_GEMINI_ARTICLE_REQUESTS_PER_DAY:'1',AI_CENTER_GEMINI_ARTICLE_KEY_REQUESTS_PER_DAY:'1'};
 const admission=createGeminiArticleAdmission({repository:store.repositories.modelQuota,env:config,now:()=>at});
 const runtime=createHarnessExecutionRuntime({tools:createToolRegistry(),env:config,articleAdmission:admission,runtimeDirectory:dir,createClient:async launch=>({run:async()=>{
  active++;maxActive=Math.max(maxActive,active);launched.push([launch.llm.apiKeyEnv,launch.llm.model]);
  await new Promise(r=>{waiting.push(r);if(waiting.length===2)waiting.forEach(fn=>fn());});active--;
  return {finalResponse:launch.llm.model,events:[]};
 },close:async()=>{}})});
 try {
  const base={message:'saved article',closedContext:true,closedTask:'article-normalize',googleKeyEnv:'GEMINI_API_KEY'};
  const result=await Promise.all(['gemini-a','gemini-b'].map(googleModel=>runtime.run({...base,googleModel})));
  assert.equal(maxActive,2);assert.deepEqual(new Set(launched.map(l=>l[0])),new Set(['GEMINI_API_KEY']));
  assert.deepEqual(new Set(result.map(r=>r.answer)),new Set(['gemini-a','gemini-b']));
  at+=3600000;
  for(const model of ['gemini-a','gemini-b'])assert.throws(()=>admission.reserve({...input,model}),e=>e.code==='budget-deferred'&&!e.quotaExhausted);
  assert.ok(admission.reserve({...input,model:'gemini-c'}));
 }finally{waiting.forEach(fn=>fn());await runtime.close();store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('main article model pool alternates actual Harness models and explicit selection remains pinned',async()=>{
 const store=createStore(':memory:'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-main-models-'));let at=Date.parse('2026-10-07T08:00:00Z');const launched=[];
 const config={...env,AI_CENTER_GEMINI_KEY_ENVS:'GEMINI_API_KEY',AI_CENTER_HARNESS_ARTICLE_MODEL:'gemini-a',AI_CENTER_GEMINI_ARTICLE_MODELS:'gemini-a,gemini-b',AI_CENTER_GEMINI_ARTICLE_MODEL_POOL:'gemini-a,gemini-b'};
 const admission=createGeminiArticleAdmission({repository:store.repositories.modelQuota,env:config,now:()=>at});
 const runtime=createHarnessExecutionRuntime({tools:createToolRegistry(),env:config,articleAdmission:admission,runtimeDirectory:dir,createClient:async launch=>({run:async()=>{launched.push(launch.llm.model);return {finalResponse:launch.llm.model,events:[]};},close:async()=>{}})});
 try {
  const task={message:'saved article',closedContext:true,closedTask:'article-normalize'};
  for(const expected of ['gemini-a','gemini-b','gemini-a','gemini-b']){const r=await runtime.run(task);assert.equal(r.answer,expected);assert.equal(r.modelId,expected);at+=3000;}
  assert.equal((await runtime.run({...task,googleModel:'gemini-a'})).modelId,'gemini-a');
  assert.deepEqual(launched,['gemini-a','gemini-b','gemini-a','gemini-b','gemini-a']);
 }finally{await runtime.close();store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('main pool uses a second model after first-model quota and only all models cold permit fallback',()=>{
 const store=createStore(':memory:');let at=Date.parse('2026-10-07T08:00:00Z');
 const config={...env,AI_CENTER_GEMINI_KEY_ENVS:'GEMINI_API_KEY',AI_CENTER_HARNESS_ARTICLE_MODEL:'gemini-a',AI_CENTER_GEMINI_ARTICLE_MODELS:'gemini-a,gemini-b',AI_CENTER_GEMINI_ARTICLE_MODEL_POOL:'gemini-a,gemini-b'};
 const a=createGeminiArticleAdmission({repository:store.repositories.modelQuota,env:config,now:()=>at});
 try {
  const first=a.reserve({...input,model:'gemini-a',useModelPool:true});a.failed(first,new Error('429 PerDay retryDelay: 3600s'));a.release(first);
  assert.equal(a.nextReadyAt('gemini-a'),at);
  const second=a.reserve({...input,model:'gemini-a',useModelPool:true});assert.equal(second.model,'gemini-b');
  assert.throws(()=>a.reserve({...input,model:'gemini-a',useModelPool:true}),e=>!e.quotaExhausted);
  a.failed(second,new Error('429 PerDay retryDelay: 3600s'));a.release(second);
  assert.throws(()=>a.reserve({...input,model:'gemini-a',useModelPool:true}),e=>e.quotaExhausted);
  assert.equal(a.nextReadyAt('gemini-a'),nextGeminiDailyReset(at));
 }finally{store.close();}
 assert.throws(()=>createGeminiArticleAdmission({repository:{reserve(){}},env:{...config,AI_CENTER_GEMINI_ARTICLE_MODEL_POOL:'not-allowed'}}),/not configured/);
});
