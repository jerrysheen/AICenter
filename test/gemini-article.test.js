import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createStore} from '../packages/database/src/index.js';
import {resolveHarnessLlm} from '../packages/harness/src/llm-route.js';
import {createGeminiArticleAdmission,resolveGeminiArticlePolicy} from '../packages/runtime/src/gemini-article-admission.js';
import {ensureHourlyDigestSchedule,ensureDailyReportSchedule} from '../packages/runtime/src/report-module.js';
import {resolveDailyConfig} from '../packages/domain/src/daily-window.js';
import {treeFailure} from '../packages/domain/src/information-tree-policy.js';
import {createHarnessAgentRuntime} from '../packages/harness/src/harness-agent-runtime.js';
import {createToolRegistry} from '../packages/runtime/src/tool-registry.js';

test('Google route stays article-only and uses builtin native protocol without exposing credentials',()=>{
  const env={GEMINI_API_KEY:'fake-secret',AI_CENTER_HARNESS_ARTICLE_PROVIDER:'google'};
  const a=resolveHarnessLlm(env,{closedTask:'article-normalize'});
  assert.equal(a.provider,'google');assert.equal(a.protocol,'google-generative-ai');
  assert.match(a.settingsYaml,/google:\n\s+apiKeyEnv: "GEMINI_API_KEY"/);
  assert.doesNotMatch(a.settingsYaml,/fake-secret|api: google-generative-ai/);
  assert.match(a.settingsYaml,/reasoning: off/);assert.match(a.settingsYaml,/maxRetries: 0/);
  assert.notEqual(resolveHarnessLlm(env,{closedTask:'hourly-brief'}).provider,'google');
  assert.notEqual(resolveHarnessLlm(env).provider,'google');
});
test('three unknown-project keys share quotas, duplicates removed; invalid policy rejected',()=>{
  const p=resolveGeminiArticlePolicy({GEMINI_API_KEY:'one',GEMINI_API_KEY2:'two',GEMINI_API_KEY3:'two'});
  assert.equal(p.slots.length,2);assert.equal(p.slots[0].project,p.slots[1].project);
  assert.notEqual(p.slots[0].cooldownKey,p.slots[1].cooldownKey);
  assert.throws(()=>resolveGeminiArticlePolicy({GEMINI_API_KEY:'x',AI_CENTER_GEMINI_ARTICLE_MIN_INTERVAL_MS:'0'}));
});
test('persistent rolling hour admission, restart pacing and project cooldown cannot be bypassed by key rotation',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-quota-')),file=path.join(dir,'test.db');
  let store=createStore(file),at=1000000;
  const env={GEMINI_API_KEY:'one',GEMINI_API_KEY2:'two',GEMINI_API_KEY_PROJECT:'same',GEMINI_API_KEY2_PROJECT:'same',AI_CENTER_GEMINI_ARTICLE_REQUESTS_PER_HOUR:'2',AI_CENTER_GEMINI_ARTICLE_REQUESTS_PER_MINUTE:'1'};
  const make=()=>createGeminiArticleAdmission({repository:store.repositories.modelQuota,env,now:()=>at});
  const input={model:'gemini-test',inputBytes:100,maxTokens:4096};
  try {
    let admission=make(),ticket=admission.reserve(input);
    assert.throws(()=>admission.reserve(input),e=>e.code==='budget-deferred' && e.retryAt===at+10000);
    store.close();store=createStore(file);admission=make();at+=10000;
    assert.throws(()=>admission.reserve(input),e=>e.retryAt===1059999+1);
    admission.failed(ticket,new Error('429 RESOURCE_EXHAUSTED'));at+=50000;
    assert.throws(()=>admission.reserve(input),e=>e.code==='budget-deferred');
    at+=10000;admission.reserve(input);at+=60000;
    assert.throws(()=>admission.reserve(input),e=>e.retryAt===4600000);
    at=4600000;assert.ok(admission.reserve(input));
  } finally {store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('minute token reservation defers without consuming a request; retryAt survives domain projection',()=>{
  const store=createStore(':memory:');try {
    const admission=createGeminiArticleAdmission({repository:store.repositories.modelQuota,env:{GEMINI_API_KEY:'x',AI_CENTER_GEMINI_ARTICLE_ESTIMATED_TOKENS_PER_MINUTE:'100'},now:()=>1000});
    assert.throws(()=>admission.reserve({model:'g',inputBytes:100,maxTokens:6144}),e=>e.code==='budget-deferred');
    assert.equal(store.repositories.modelUsage.list('local').length,0);
    assert.equal(treeFailure({code:'budget-deferred',retryAt:45000},'x','v',1000).retryAt,45000);
  }finally{store.close();}
});
test('half-hour generation retains daily cutoff and chooses correct next hourly slot',()=>{
  const store={upsertJobSchedule:v=>v};
  const before=ensureHourlyDigestSchedule(store,29*60000,{minute:30});
  const after=ensureHourlyDigestSchedule(store,30*60000,{minute:30});
  assert.equal(before.nextRunAt,30*60000);assert.equal(after.nextRunAt,90*60000);
  const config=resolveDailyConfig({AI_CENTER_DAILY_CUTOFF:'08:00',AI_CENTER_DAILY_RUN_MINUTE:'30'});
  const daily=ensureDailyReportSchedule(store,config,Date.UTC(2026,9,7));
  assert.equal(daily.schedule.minute,30);assert.equal(daily.input.cutoffMinute,0);
  const persisted=createStore(':memory:');try {
    ensureHourlyDigestSchedule(persisted,0);
    assert.equal(ensureHourlyDigestSchedule(persisted,0,{minute:30}).nextRunAt,1800000);
    assert.equal(ensureHourlyDigestSchedule(persisted,2000000,{minute:30}).nextRunAt,1800000);
  }finally{persisted.close();}
});
test('escaped Google daily quota delay persists and defers future calls without retrying',()=>{
  const store=createStore(':memory:');try {
    let at=1000000;
    const admission=createGeminiArticleAdmission({repository:store.repositories.modelQuota,env:{GEMINI_API_KEY:'x'},now:()=>at});
    const input={model:'g',inputBytes:100,maxTokens:4096},ticket=admission.reserve(input);
    const error=new Error('429 GenerateRequestsPerDayPerProjectPerModel-FreeTier retryDelay\\\": \\\"64908s');
    admission.failed(ticket,error);assert.equal(error.retryAt,65908000);
    assert.equal(treeFailure(error,'x','v',at).retryAt,65908000);
    at+=120000;assert.throws(()=>admission.reserve(input),e=>e.code==='budget-deferred');
  }finally{store.close();}
});
test('quota fallback uses same Harness and global pacing; local minute limit never invokes paid fallback',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-fallback-')),store=createStore(':memory:');
  let at=1000000;const providers=[];
  const env={GEMINI_API_KEY:'test',ELUCID_GROK_API_KEY:'test-grok',AI_CENTER_HARNESS_ARTICLE_PROVIDER:'google',AI_CENTER_HARNESS_ARTICLE_FALLBACK:'elucid-grok'};
  const admission=createGeminiArticleAdmission({repository:store.repositories.modelQuota,env,now:()=>at});
  const runtime=createHarnessAgentRuntime({tools:createToolRegistry(),env,runtimeDirectory:dir,articleAdmission:admission,
    createClient:async launch=>({run:async()=>{providers.push(launch.provider);if(launch.provider==='google')throw new Error('429 PerDay retryDelay: 3600s');return {finalResponse:'{"title":"中文","tagId":null,"summary":"摘要","body":"正文"}',events:[]};},close:async()=>{}})});
  const input={message:'saved article',closedContext:true,closedTask:'article-normalize',usageStage:'tree-information'};
  try {
    await assert.rejects(runtime.run(input),e=>e.code==='budget-deferred' && e.retryAt===1010000);
    await assert.rejects(runtime.run(input),e=>e.code==='budget-deferred');
    assert.deepEqual(providers,['google']);
    at+=10000;const result=await runtime.run(input);assert.equal(result.providerId,'elucid-grok');
    assert.deepEqual(providers,['google','elucid-grok']);
    await assert.rejects(runtime.run(input),e=>e.code==='budget-deferred');assert.equal(providers.length,2);
  }finally{await runtime.close();store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('verified distinct projects admit another key after quota, keeping global interval',()=>{
  const store=createStore(':memory:');let at=1000000;
  const env={GEMINI_API_KEY:'one',GEMINI_API_KEY2:'two',GEMINI_API_KEY_PROJECT:'a',GEMINI_API_KEY2_PROJECT:'b'};
  const admission=createGeminiArticleAdmission({repository:store.repositories.modelQuota,env,now:()=>at});
  const input={model:'g',inputBytes:100,maxTokens:4096};
  try {const ticket=admission.reserve(input),error=new Error('429 PerDay retryDelay: 3600s');admission.failed(ticket,error);assert.equal(error.retryAt,1010000);at+=10000;assert.equal(admission.reserve(input).keyEnv,'GEMINI_API_KEY2');}finally{store.close();}
});

test('one unknown-project key exhaustion preserves the other two; only all cold permits fallback',()=>{
  const store=createStore(':memory:');let at=1000000;
  const env={GEMINI_API_KEY:'one',GEMINI_API_KEY2:'two',GEMINI_API_KEY3:'three',AI_CENTER_HARNESS_ARTICLE_FALLBACK:'elucid-grok'};
  const make=()=>createGeminiArticleAdmission({repository:store.repositories.modelQuota,env,now:()=>at});
  let admission=make();const input={model:'g',inputBytes:100,maxTokens:4096};
  try {
    for(const expected of ['GEMINI_API_KEY','GEMINI_API_KEY2','GEMINI_API_KEY3']) {
      const ticket=admission.reserve(input);assert.equal(ticket.keyEnv,expected);
      admission.failed(ticket,new Error('429 PerDay retryDelay: 3600s'));
      assert.throws(()=>admission.reserve(input),e=>e.code==='budget-deferred' && !e.quotaExhausted);
      at+=10000;admission=make();
    }
    assert.throws(()=>admission.reserve(input),e=>e.quotaExhausted===true);
    at+=3600000;assert.equal(admission.reserve(input).keyEnv,'GEMINI_API_KEY');
  }finally{store.close();}
});

test('unknown project keys still share minute request and token budget after one quota rejection',()=>{
  const store=createStore(':memory:');let at=1000000;
  const admission=createGeminiArticleAdmission({repository:store.repositories.modelQuota,env:{GEMINI_API_KEY:'one',GEMINI_API_KEY2:'two',AI_CENTER_GEMINI_ARTICLE_REQUESTS_PER_MINUTE:'1'},now:()=>at});
  const input={model:'g',inputBytes:100,maxTokens:4096};
  try {
    admission.failed(admission.reserve(input),new Error('429 PerDay retryDelay: 3600s'));at+=10000;
    assert.throws(()=>admission.reserve(input),e=>e.retryAt===1060000 && !e.quotaExhausted);
    at+=50000;assert.equal(admission.reserve(input).keyEnv,'GEMINI_API_KEY2');
  }finally{store.close();}
});

test('Harness uses key2 then key3 after key1 rejection before any Grok fallback',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-pool-')),store=createStore(':memory:');let at=1000000;
  const env={GEMINI_API_KEY:'one',GEMINI_API_KEY2:'two',GEMINI_API_KEY3:'three',ELUCID_GROK_API_KEY:'grok',AI_CENTER_HARNESS_ARTICLE_PROVIDER:'google',AI_CENTER_HARNESS_ARTICLE_FALLBACK:'elucid-grok'};
  const used=[];
  const runtime=createHarnessAgentRuntime({tools:createToolRegistry(),env,runtimeDirectory:dir,articleAdmission:createGeminiArticleAdmission({repository:store.repositories.modelQuota,env,now:()=>at}),createClient:async launch=>({run:async()=>{
    used.push([launch.provider,launch.llm.apiKeyEnv]);
    if(launch.provider==='google' && launch.llm.apiKeyEnv!=='GEMINI_API_KEY3')throw new Error('429 PerDay retryDelay: 3600s');
    return {finalResponse:'{"title":"中文","tagId":null,"summary":"摘要","body":"正文"}',events:[]};
  },close:async()=>{}})});
  const input={message:'article',closedContext:true,closedTask:'article-normalize',usageStage:'tree-information'};
  try {
    await assert.rejects(runtime.run(input),e=>e.code==='budget-deferred');at+=10000;
    await assert.rejects(runtime.run(input),e=>e.code==='budget-deferred');at+=10000;
    assert.equal((await runtime.run(input)).providerId,'google');
    assert.deepEqual(used,[['google','GEMINI_API_KEY'],['google','GEMINI_API_KEY2'],['google','GEMINI_API_KEY3']]);
  }finally{await runtime.close();store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
