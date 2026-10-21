import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveHarnessLlm,resolveGoogleHourlyModelPool,resolveGoogleHourlyAdmissionModels} from '../packages/harness/src/llm-route.js';
import {createGeminiArticleAdmission} from '../packages/runtime/src/gemini-article-admission.js';
import {createStore} from '../packages/database/src/index.js';
import {createRuntimeService} from '../packages/domain/src/runtime-service.js';
import {articleUsesGemmaFallback, createHarnessAgentRuntime, hourlyUsesGemmaFallback} from '../packages/harness/src/harness-agent-runtime.js';
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
 assert.notEqual(resolveHarnessLlm(env,{closedTask:'daily-analysis'}).provider,'google');
 assert.throws(()=>resolveGoogleHourlyModelPool({...env,AI_CENTER_GEMINI_HOURLY_MODEL_POOL:'unlisted'}));
 assert.deepEqual(resolveGoogleHourlyAdmissionModels({...env,AI_CENTER_HARNESS_HOURLY_MODEL:'gemini-3.1-flash-lite',AI_CENTER_GEMINI_HOURLY_MODELS:'gemini-3.5-flash-lite'}),['gemini-3.1-flash-lite','gemini-3.5-flash-lite']);
 assert.throws(()=>resolveGoogleHourlyAdmissionModels({...env,AI_CENTER_GEMINI_HOURLY_MODEL_POOL:'unlisted'}));
 assert.throws(()=>resolveHarnessLlm({...env,AI_CENTER_HARNESS_HOURLY_MAX_TOKENS:'1'},{closedTask:'hourly-brief'}));
});

test('hourly Flash Lite day cap falls back to Gemma and does not open the Flash client', async () => {
  const at = Date.parse('2026-10-21T04:30:00Z');
  const store = createStore(':memory:');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hourly-gemma-'));
  const env = {
    GEMINI_API_KEY: 'fake', GEMINI_API_KEY2: 'two',
    AI_CENTER_GEMINI_KEY_ENVS: 'GEMINI_API_KEY,GEMINI_API_KEY2',
    AI_CENTER_HARNESS_HOURLY_PROVIDER: 'google',
    AI_CENTER_GEMINI_ARTICLE_MIN_INTERVAL_MS: '1',
    AI_CENTER_GEMINI_ARTICLE_REQUESTS_PER_MINUTE: '100',
    AI_CENTER_GEMINI_ARTICLE_REQUESTS_PER_HOUR: '5000',
    AI_CENTER_GEMINI_ARTICLE_ESTIMATED_TOKENS_PER_MINUTE: '100000000',
  };
  const earlier = at - 5 * 60_000;
  for (const keyEnv of ['GEMINI_API_KEY', 'GEMINI_API_KEY2']) {
    for (const model of ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite']) {
      for (let index = 0; index < 480; index += 1) {
        store.repositories.modelQuota.recordProbeUse({ project: 'other', keyEnv, model, at: earlier });
      }
    }
  }
  const admission = createGeminiArticleAdmission({
    repository: store.repositories.modelQuota, env, now: () => at, models: ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'], allowFallback: false,
  });
  let fallback = 0;
  const runtime = createHarnessAgentRuntime({
    tools: createToolRegistry(), env, hourlyAdmission: admission, runtimeDirectory: dir,
    hourlyGemmaFallback: async () => {
      fallback += 1;
      return { answer: '{"modules":[]}', providerId: 'google', modelId: 'gemma-4-26b-a4b-it' };
    },
    createClient: async () => { throw new Error('flash client must not start'); },
  });
  try {
    const minute = Object.assign(new Error('minute'), { code: 'budget-deferred', quotaExhausted: false, flashHeadroom: 'rpm' });
    assert.equal(hourlyUsesGemmaFallback(minute), false);
    const result = await runtime.run({ message: 'saved summaries', closedContext: true, closedTask: 'hourly-brief', usageStage: 'tree-hourly' });
    assert.equal(fallback, 1);
    assert.equal(result.modelId, 'gemma-4-26b-a4b-it');
    assert.equal(result.answer, '{"modules":[]}');
  } finally {
    await runtime.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('merged Flash daily cap falls back to Gemma and does not open Grok', async () => {
  const at = Date.parse('2026-10-21T06:11:00Z');
  const store = createStore(':memory:');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hourly-merged-cap-'));
  const env = {
    GEMINI_API_KEY: 'fake', GEMINI_API_KEY2: 'two', ELUCID_GROK_API_KEY: 'grok',
    AI_CENTER_GEMINI_KEY_ENVS: 'GEMINI_API_KEY,GEMINI_API_KEY2',
    AI_CENTER_GEMINI_ARTICLE_POOL_CONCURRENCY: '2',
    AI_CENTER_HARNESS_HOURLY_PROVIDER: 'google',
    AI_CENTER_HARNESS_ARTICLE_PROVIDER: 'google',
    AI_CENTER_HARNESS_ARTICLE_FALLBACK: 'elucid-grok',
    AI_CENTER_GEMINI_ARTICLE_MIN_INTERVAL_MS: '1',
    AI_CENTER_GEMINI_ARTICLE_REQUESTS_PER_MINUTE: '100',
    AI_CENTER_GEMINI_ARTICLE_REQUESTS_PER_HOUR: '20000',
    AI_CENTER_GEMINI_ARTICLE_REQUESTS_PER_DAY: '2500',
    AI_CENTER_GEMINI_ARTICLE_KEY_REQUESTS_PER_DAY: '5000',
    AI_CENTER_GEMINI_ARTICLE_ESTIMATED_TOKENS_PER_MINUTE: '100000000',
  };
  const earlier = at - 5 * 60_000;
  for (const keyEnv of ['GEMINI_API_KEY', 'GEMINI_API_KEY2']) {
    for (let index = 0; index < 480; index += 1) {
      store.repositories.modelQuota.recordProbeUse({ project: 'other', keyEnv, model: 'gemini-3.1-flash-lite', at: earlier });
    }
  }
  for (let index = 0; index < 2500; index += 1) {
    store.repositories.modelQuota.recordProbeUse({
      project: 'other', keyEnv: index % 2 ? 'GEMINI_API_KEY2' : 'GEMINI_API_KEY', model: 'gemini-3.5-flash-lite', at: earlier,
    });
  }
  const admission = createGeminiArticleAdmission({
    repository: store.repositories.modelQuota, env, now: () => at,
    models: ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'], allowFallback: false, modelOrder: 'least-used',
  });
  let gemma = 0;
  const runtime = createHarnessAgentRuntime({
    tools: createToolRegistry(), env, hourlyAdmission: admission, runtimeDirectory: dir,
    hourlyGemmaFallback: async () => {
      gemma += 1;
      return { answer: '{"modules":[]}', providerId: 'google', modelId: 'gemma-4-26b-a4b-it' };
    },
    createClient: async () => { throw new Error('flash or grok client must not start'); },
  });
  try {
    assert.equal(articleUsesGemmaFallback(Object.assign(new Error('supplier'), { code: 'budget-deferred', quotaExhausted: true })), false);
    const result = await runtime.run({ message: 'saved summaries', closedContext: true, closedTask: 'hourly-brief', usageStage: 'tree-hourly' });
    assert.equal(gemma, 1);
    assert.equal(result.modelId, 'gemma-4-26b-a4b-it');
  } finally {
    await runtime.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
