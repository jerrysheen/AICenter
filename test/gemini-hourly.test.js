import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveHarnessLlm,resolveGoogleHourlyModelPool} from '../packages/harness/src/llm-route.js';
import {createGeminiArticleAdmission} from '../packages/runtime/src/gemini-article-admission.js';
import {createStore} from '../packages/database/src/index.js';
import {createRuntimeService} from '../packages/domain/src/runtime-service.js';
import {createHarnessAgentRuntime} from '../packages/harness/src/harness-agent-runtime.js';
import {createToolRegistry} from '../packages/runtime/src/tool-registry.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('hourly Google route is independent, bounded and has no paid fallback',()=>{
 const env={GEMINI_API_KEY:'fake',AI_CENTER_HARNESS_HOURLY_PROVIDER:'google',AI_CENTER_HARNESS_ARTICLE_PROVIDER:'google',AI_CENTER_HARNESS_ARTICLE_MODEL:'gemini-other'};
 const hourly=resolveHarnessLlm(env,{closedTask:'hourly-brief'});
 assert.equal(hourly.provider,'google');assert.equal(hourly.model,'gemini-3.1-flash-lite');
 assert.equal(hourly.execution.maxTokens,4096);assert.equal(hourly.execution.fallback,'none');
 assert.match(hourly.settingsYaml,/maxRetries: 0/);
 assert.equal(resolveHarnessLlm(env,{closedTask:'article-normalize'}).model,'gemini-other');
 assert.equal(resolveHarnessLlm(env,{closedTask:'daily-analysis'}).provider,'google');
 assert.equal(resolveHarnessLlm(env,{closedTask:'daily-analysis'}).model,'gemini-3.1-flash-lite');
 assert.throws(()=>resolveGoogleHourlyModelPool({...env,AI_CENTER_GEMINI_HOURLY_MODEL_POOL:'unlisted'}));
 assert.throws(()=>resolveHarnessLlm({...env,AI_CENTER_HARNESS_HOURLY_MAX_TOKENS:'1'},{closedTask:'hourly-brief'}));
});

test('daily analysis follows the hourly Google model and can override it',()=>{
 const base={GEMINI_API_KEY:'fake',AI_CENTER_HARNESS_HOURLY_PROVIDER:'google',AI_CENTER_HARNESS_PROVIDER:'elucid-grok',ELUCID_GROK_API_KEY:'grok-key'};
 const daily=resolveHarnessLlm(base,{closedTask:'daily-analysis'});
 assert.equal(daily.provider,'google');
 assert.equal(daily.model,'gemini-3.1-flash-lite');
 assert.equal(daily.execution.maxTokens,4096);
 assert.equal(daily.execution.fallback,'none');
 assert.equal(daily.execution.reasoning,'off');
 const inherited=resolveHarnessLlm({...base,AI_CENTER_HARNESS_HOURLY_MODEL:'gemini-3.5-flash-lite'},{closedTask:'daily-analysis'});
 assert.equal(inherited.model,'gemini-3.5-flash-lite');
 assert.equal(resolveHarnessLlm({...base,AI_CENTER_HARNESS_HOURLY_MODEL:'gemini-3.5-flash-lite'},{closedTask:'hourly-brief'}).model,'gemini-3.5-flash-lite');
 const pinned=resolveHarnessLlm({...base,AI_CENTER_HARNESS_DAILY_MODEL:'gemini-daily-test'},{closedTask:'daily-analysis'});
 assert.equal(pinned.model,'gemini-daily-test');
 assert.equal(resolveHarnessLlm({...base,AI_CENTER_HARNESS_DAILY_MODEL:'gemini-daily-test'},{closedTask:'hourly-brief'}).model,'gemini-3.1-flash-lite');
 const elucid=resolveHarnessLlm({...base,AI_CENTER_HARNESS_DAILY_PROVIDER:'elucid-grok'},{closedTask:'daily-analysis'});
 assert.equal(elucid.provider,'elucid-grok');
 assert.equal(elucid.model,'grok-4.7');
 assert.equal(resolveHarnessLlm({...base,AI_CENTER_HARNESS_DAILY_PROVIDER:'elucid-grok'},{closedTask:'hourly-brief'}).provider,'google');
 const plain=resolveHarnessLlm({AI_CENTER_HARNESS_PROVIDER:'deepseek-official',AI_CENTER_HARNESS_MODEL:'deepseek-v4-flash',DEEPSEEK_API_KEY:'x'},{closedTask:'daily-analysis'});
 assert.equal(plain.provider,'deepseek-official');
 assert.equal(plain.model,'deepseek-v4-flash');
 assert.equal(plain.execution,undefined);
 assert.throws(()=>resolveHarnessLlm({AI_CENTER_HARNESS_DAILY_PROVIDER:'openai'},{closedTask:'daily-analysis'}));
 assert.throws(()=>resolveHarnessLlm({...base,AI_CENTER_HARNESS_DAILY_MAX_TOKENS:'1'},{closedTask:'daily-analysis'}));
});

test('explicit manual resume cannot be swallowed by a queued automatic hourly job',()=>{
 const store=createStore(':memory:'),service=createRuntimeService({runtimeRepository:store});
 try {
  const automatic=service.requestHourlyDigest({hourStart:3600000});
  const manual=service.requestHourlyDigest({hourStart:3600000,mode:'resume'});
  assert.notEqual(automatic.id,manual.id);
  assert.equal(service.requestHourlyDigest({hourStart:3600000}).id,automatic.id);
  assert.equal(service.requestHourlyDigest({hourStart:3600000,mode:'resume'}).id,manual.id);
 }finally{store.close();}
});

test('hourly Harness uses admitted Google key and model and releases lease after failure',async()=>{
 const store=createStore(':memory:'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'hourly-google-'));
 const env={GEMINI_API_KEY:'fake',AI_CENTER_GEMINI_KEY_ENVS:'GEMINI_API_KEY',AI_CENTER_HARNESS_HOURLY_PROVIDER:'google'};
 const admission=createGeminiArticleAdmission({repository:store.repositories.modelQuota,env,models:[],allowFallback:false});
 let launch;
 const runtime=createHarnessAgentRuntime({tools:createToolRegistry(),env,hourlyAdmission:admission,runtimeDirectory:dir,createClient:async options=>{launch=options;return {run:async()=>{throw Error('transport failed');},close:async()=>{}};}});
 try {
  await assert.rejects(runtime.run({message:'saved summaries',closedContext:true,closedTask:'hourly-brief',usageStage:'tree-hourly'}),/transport failed/);
  assert.equal(launch.llm.provider,'google');assert.equal(launch.llm.apiKeyEnv,'GEMINI_API_KEY');assert.equal(launch.llm.model,'gemini-3.1-flash-lite');
  // A leaked lease would defer until 240s instead of the ordinary pacing window.
  assert.ok(admission.nextReadyAt(launch.llm.model)<=Date.now()+10000);
 }finally{await runtime.close();store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('daily analysis admits through the same Google pool as hourly',async()=>{
 const store=createStore(':memory:'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'daily-google-'));
 const env={GEMINI_API_KEY:'fake',AI_CENTER_GEMINI_KEY_ENVS:'GEMINI_API_KEY',AI_CENTER_HARNESS_HOURLY_PROVIDER:'google'};
 const admission=createGeminiArticleAdmission({repository:store.repositories.modelQuota,env,models:[],allowFallback:false});
 let launch;
 const runtime=createHarnessAgentRuntime({tools:createToolRegistry(),env,hourlyAdmission:admission,runtimeDirectory:dir,createClient:async options=>{launch=options;return {run:async()=>{throw Error('transport failed');},close:async()=>{}};}});
 try {
  await assert.rejects(runtime.run({message:'saved daily modules',closedContext:true,closedTask:'daily-analysis',usageStage:'tree-daily'}),/transport failed/);
  assert.equal(launch.llm.provider,'google');
  assert.equal(launch.llm.apiKeyEnv,'GEMINI_API_KEY');
  assert.equal(launch.llm.model,'gemini-3.1-flash-lite');
  assert.equal(launch.llm.execution.maxTokens,4096);
  assert.ok(admission.nextReadyAt(launch.llm.model)<=Date.now()+10000);
 }finally{await runtime.close();store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('article and hourly share persistent account/model quota, hourly cannot use article fallback',()=>{
 const store=createStore(':memory:');let at=Date.now();
 const env={GEMINI_API_KEY:'fake',AI_CENTER_GEMINI_KEY_ENVS:'GEMINI_API_KEY',AI_CENTER_GEMINI_ARTICLE_POOL_CONCURRENCY:'5',AI_CENTER_HARNESS_ARTICLE_FALLBACK:'elucid-grok'};
 const options={repository:store.repositories.modelQuota,env,now:()=>at};
 const article=createGeminiArticleAdmission(options),hourly=createGeminiArticleAdmission({...options,models:[],allowFallback:false});
 const input={model:'gemini-test',inputBytes:100,maxTokens:4096};
 try {
  const ticket=article.reserve(input);
  assert.throws(()=>hourly.reserve(input),e=>e.code==='budget-deferred');
  article.release(ticket);at+=3000;
  const next=hourly.reserve(input);hourly.failed(next,new Error('429 daily quota'));hourly.release(next);at+=3000;
  assert.ok(hourly.nextReadyAt(input.model)>at);
  assert.throws(()=>hourly.reserve(input),e=>e.quotaExhausted===true);
 }finally{store.close();}
});
