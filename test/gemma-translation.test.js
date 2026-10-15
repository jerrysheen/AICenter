import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createStore } from '../packages/database/src/index.js';
import { createGemmaTranslationRouter, gemmaBackoffMs, gemmaIntervalMs, gemmaQuotaDay, gemmaRetryStatuses, gemmaTranslationPolicy, readGemmaStream, resolveGemmaTranslationSlots } from '../packages/connectors/src/translate/gemma.js';
import { translationAttemptCallLimit, withTranslationCallBudget } from '../packages/connectors/src/translate/call-budget.js';
import { nextDailyInstant, previousDailyInstant } from '../packages/domain/src/zoned-time.js';
import { createTranslateService, splitTranslationText } from '../packages/connectors/src/translate/index.js';
import { createFeedService } from '../packages/domain/src/feed-service.js';
import { createFeedTranslationJobHandlers, enqueueOriginalTranslations } from '../packages/runtime/src/feed-translation-module.js';
import { createJobRunner } from '../packages/runtime/src/job-runner.js';
import { FeedTranslationJobInputSchema } from '../packages/contracts/src/index.js';

const sse = (text, finishReason = 'STOP') => new Response([
  { candidates: [{ content: { parts: [{ thought: true, text: 'hidden' }, { text }] } }] },
  { candidates: [{ finishReason }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 30 } },
].map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const fixture = action => async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gemma-translation-'));
  const store = createStore(path.join(dir, 'test.db'));
  try { await action(store,dir); } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
};
const settings = store => {
 let at=Date.now();
 return { env: { AI_CENTER_GEMMA_TRANSLATION_KEY_ENV:'GEMINI_API_KEY5',GEMINI_API_KEY5: 'fake-key', GEMINI_API_KEY: 'must-not-use', ELUCID_GROK_API_KEY: 'must-not-use' }, quotaRepository: store.repositories.modelQuota,now:()=>at,sleep:async ms=>{at+=ms;} };
};

test('five translation accounts dispatch together, cross-model pacing survives router restart',fixture(async store=>{
 let at=Date.now();const calls=[],waiters=[];
 const env=Object.fromEntries(Array.from({length:5},(_,i)=>[i?'GEMINI_API_KEY'+(i+1):'GEMINI_API_KEY','fake-'+i]));
 const options={env,quotaRepository:store.repositories.modelQuota,now:()=>at,sleep:async ms=>{at+=ms;},fetch:async(url,init)=>{
  calls.push({key:init.headers['x-goog-api-key'],at});await new Promise(r=>waiters.push(r));return sse('完整译文');
 }};
  const router=createGemmaTranslationRouter(options);
  const jobs=Array.from({length:5},(_,i)=>router.generate({system:'翻译',prompt:'Original '+i}));
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(calls.length,5);assert.equal(new Set(calls.map(c=>c.key)).size,5);
 assert.equal(new Set(calls.map(c=>c.at)).size,1);
 waiters.splice(0).forEach(r=>r());await Promise.all(jobs);
 const next=createGemmaTranslationRouter({...options,fetch:async(url,init)=>{calls.push({key:init.headers['x-goog-api-key'],at});return sse('译文');}});
 await next.generate({system:'翻译',prompt:'After restart'});
 assert.equal(calls.at(-1).at-calls[0].at,2000);
 assert.equal(resolveGemmaTranslationSlots({...env,GEMINI_API_KEY2:env.GEMINI_API_KEY}).length,4);
}));

test('Worker executes five translations without increasing other job type concurrency',fixture(async store=>{
 let active=0,maximum=0,started;
 const allStarted=new Promise(resolve=>{started=resolve;});let release;
 const gate=new Promise(resolve=>{release=resolve;});
 const jobs=Array.from({length:5},()=>store.createJob({type:'feed.translation.run',input:{},maxAttempts:1}));
 const runner=createJobRunner({store,concurrency:{translationLimit:5},handlers:{'feed.translation.run':async()=>{
  active++;maximum=Math.max(maximum,active);if(active===5)started();await gate;active--;return {ok:true};
 }}});
 const running=runner.start();
 try {await allStarted;assert.equal(maximum,5);runner.stop();release();await running;
  assert.ok(jobs.every(j=>store.getJob(j.id).status==='completed'));
 }finally{runner.stop();release();await running;}
}));

test('same-project translation keys share pacing and no daily cap overrides supplier cooldown',fixture(async store=>{
 let at=Date.now();const times=[];
 const env={GEMINI_API_KEY:'one',GEMINI_API_KEY2:'two',GEMINI_API_KEY_PROJECT:'same',GEMINI_API_KEY2_PROJECT:'same',AI_CENTER_GEMMA_TRANSLATION_INTERVAL_MIN_MS:'2500',AI_CENTER_GEMMA_TRANSLATION_INTERVAL_MAX_MS:'2500'};
 const options={env,quotaRepository:store.repositories.modelQuota,now:()=>at,sleep:async ms=>{at+=ms;},fetch:async()=>{times.push(at);return sse('译文');}};
 const router=createGemmaTranslationRouter(options);
 await router.generate({system:'翻译',prompt:'One'});await router.generate({system:'翻译',prompt:'Two'});
 assert.equal(times[1]-times[0],2500);
 const slot=resolveGemmaTranslationSlots(env)[0];
 for(const model of ['gemma-4-31b-it','gemma-4-26b-a4b-it'])store.repositories.modelQuota.cooldown(slot.project,model,at+86400000);
 await assert.rejects(createGemmaTranslationRouter(options).generate({system:'翻译',prompt:'Blocked'}),e=>e.code==='budget-deferred'&&e.retryAt===at+86400000);
 assert.equal(times.length,2);
}));

test('each translation key stays within 14400 requests per Pacific day',fixture(async(store,dir)=>{
 const at=Date.parse('2026-10-07T15:00:00Z'),env={GEMINI_API_KEY:'fake'},slot=resolveGemmaTranslationSlots(env)[0];
 const pacific={timeZone:'America/Los_Angeles',hour:0,minute:0};
 assert.equal(gemmaQuotaDay(at).dayStart,previousDailyInstant(at,pacific));
 assert.equal(gemmaQuotaDay(at).dayEnd,nextDailyInstant(at,pacific));
 const db=new Database(path.join(dir,'test.db'));
 try {
  const insert=db.prepare('INSERT INTO model_quota_reservations(id,project,model,at,estimated_tokens) VALUES(?,?,?,?,?)');
  db.transaction(()=>{for(let n=0;n<14399;n++)insert.run('prior-'+n,slot.project,'gemma-4-31b-it',at-2*3600000,1);})();
 }finally{db.close();}
 let requests=0;
 const router=createGemmaTranslationRouter({env,models:['gemma-4-31b-it'],quotaRepository:store.repositories.modelQuota,now:()=>at,fetch:async()=>{requests++;return sse('译文');}});
 assert.equal((await router.generate({system:'翻译',prompt:'A new original.'})).engine,'gemma-4-31b-it');
 assert.equal(requests,1);
 await assert.rejects(router.generate({system:'翻译',prompt:'Over the daily cap.'}),error=>error.code==='budget-deferred'&&/等待配额窗口/.test(error.message)&&!/上游 500/.test(error.message));
 assert.equal(requests,1);
}));

test('Gemma pool uses only official streaming endpoints, rotates models and persists quota and usage', fixture(async store => {
  const calls = [], usage = [];
  const router = createGemmaTranslationRouter({ ...settings(store), usageObserver: row => usage.push(structuredClone(row)),
    fetch: async (url, init) => { calls.push([url, init]); return sse('完整译文'); } });
  const first = await router.generate({ system: '翻译', prompt: 'Report one' });
  const second = await router.generate({ system: '翻译', prompt: 'Report two' });
  assert.equal(first.engine, 'gemma-4-26b-a4b-it'); assert.equal(second.engine, 'gemma-4-26b-a4b-it');
  for (const [url, init] of calls) {
    assert.equal(new URL(url).origin, 'https://generativelanguage.googleapis.com');
    assert.match(url, /gemma-4-26b-a4b-it:streamGenerateContent\?alt=sse$/);
    assert.equal(init.headers['x-goog-api-key'], 'fake-key');
    assert.equal(JSON.parse(init.body).generationConfig.thinkingConfig.thinkingLevel, 'minimal');
    assert.equal(JSON.parse(init.body).generationConfig.maxOutputTokens, 4096);
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.dispatcher, undefined);
  }
  assert.equal(usage.filter(row => row.status === 'succeeded').length, 2);
  const succeeded = usage.find(row => row.status === 'succeeded');
  assert.equal(succeeded.keySuffix, '-key');
  store.repositories.modelUsage.save({ ...succeeded, itemId: 'media:ms' });
  const stored = store.repositories.modelUsage.list('local', { jobId: '' }).find(row => row.itemId === 'media:ms');
  assert.equal(stored.itemId, 'media:ms');
  assert.equal(stored.keySuffix, '-key');
  assert.equal(usage.filter(row => row.status === 'succeeded').every(row => row.httpStatus === 200), true);
  assert.equal(usage.at(-1).usage.totalTokens, 30);
  assert.doesNotMatch(JSON.stringify(usage), /fake-key|hidden|完整译文/);
}));

test('Gemma HTTP errors never fall back to other APIs, 429 cooldown persists across router instances', fixture(async store => {
  let calls = 0;
  const env = { GEMINI_API_KEY: 'key-one', GEMINI_API_KEY2: 'key-two' };
  const options = { env, quotaRepository: store.repositories.modelQuota, fetch: async (url, init) => {
    calls++;
    assert.match(url, /gemma-4-26b-a4b-it/);
    assert.doesNotMatch(url, /gemini-|deepseek|elucid|deepl/i);
    if (init.headers['x-goog-api-key'] === 'key-one') return new Response(JSON.stringify({error:{code:429,status:'RESOURCE_EXHAUSTED',message:'daily quota exceeded'}}), { status:429 });
    return sse('译文');
  } };
  await assert.rejects(createGemmaTranslationRouter(options).generate({ system:'翻译',prompt:'One' }), /429/);
  assert.equal(calls, 1);
  assert.ok(store.repositories.modelQuota.listCooldowns(Date.now()).some(row => row.model === 'gemma-4-26b-a4b-it'));
  assert.equal((await createGemmaTranslationRouter(options).generate({system:'翻译',prompt:'Two'})).engine,'gemma-4-26b-a4b-it');
  assert.equal(calls,2);
}));

test('truncated or error streams cannot become saved translations; hidden thoughts excluded', fixture(async store => {
  assert.equal((await readGemmaStream(sse('中文'))).candidates[0].content.parts[0].text, '中文');
  await assert.rejects(readGemmaStream(new Response('data: {"error":{"code":500}}\n\n')), /流内错误/);
  for (const finish of ['MAX_TOKENS', '']) {
    const service = createTranslateService({ ...settings(store), fetch:async()=>sse('未完成',finish) });
    await assert.rejects(service.translate({text:'A report with unfinished translation.'}), /未完整结束/);
  }
  const thoughtOnly = new Response([
    { candidates: [{ content: { parts: [{ thought: true, text: '只在思考里出现的译文' }] }, finishReason: 'STOP' }] },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  const hidden = createTranslateService({ ...settings(store), fetch: async () => thoughtOnly });
  await assert.rejects(hidden.translate({ text: 'A short English headline that must stay visible.' }), /可见文本=0/);
  const headline = 'Microsoft denies cloud leadership asked suppliers to cut prices this week after the earnings call';
  const saved = createTranslateService({ ...settings(store), fetch: async () => sse('微软否认云业务领导层曾要求供应商降价') });
  const translated = await saved.translate({ id: 'media:ms', text: headline });
  assert.equal(translated.translatedText, '微软否认云业务领导层曾要求供应商降价');
}));

test('long input splits without dropping characters, batch cache preserves complete output and formatting', async () => {
  const source = 'English paragraph with conditions.\n\n'.repeat(180) + '😀 tail';
  const chunks = splitTranslationText(source);
  assert.equal(chunks.join(''), source); assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk=>chunk.length<=1500));
  const prompts = [];
  const service = createTranslateService({router:{generate:async({system,prompt})=>{
    assert.match(system,/任一条件/); prompts.push(prompt); return {text:`译文\n\n- 列表${'。'.repeat(520)}`,engine:'gemma-4-31b-it'};
  }}});
  const result = await service.translate({text:source});
  assert.ok(chunks.every((chunk) => prompts.includes(chunk)));
  assert.ok(prompts.every((prompt) => prompt.length <= 1500));
  assert.match(result.translatedText,/\n\n- 列表/);
  const sent = prompts.length;
  await service.translate({text:source}); assert.equal(prompts.length, sent);
});

test('translation worker persists full source hash and output, reuses stored originals and emits events', fixture(async store => {
  let calls = 0;
  const service = createFeedService({legacyRepository:store,feedRepository:store.repositories.feed,sourcePort:{},
    translationPort:createTranslateService({...settings(store),fetch:async()=>{calls++;return sse('设备价格为680,000韩元。\n\n- 任一条件不满足则保持人工检查。');}})});
  const units=[{id:'media:test-block',text:'The equipment costs KRW 680,000.\n\n- Keep manual checks if either condition fails.'}];
  const jobs=await enqueueOriginalTranslations({store,feedService:service,workspaceId:'local',units});
  const again=await enqueueOriginalTranslations({store,feedService:service,workspaceId:'local',units});
  assert.equal(jobs[0].id,again[0].id);
  await createJobRunner({store,handlers:createFeedTranslationJobHandlers({feedService:service})}).runOnce();
  assert.equal(store.getJob(jobs[0].id).status,'completed');
  const saved=store.repositories.feed.listTranslations('local',['media:test-block']);
  assert.equal(saved.length,1); assert.match(saved[0].translatedText,/\n\n- /);
  assert.equal(saved[0].engine,'gemma-4-26b-a4b-it');
  assert.deepEqual(await enqueueOriginalTranslations({store,feedService:service,workspaceId:'local',units}),[]);
  assert.equal(calls,1);
}));

test('translation job contract refuses duplicate IDs, extra commands and oversized inputs', () => {
  assert.equal(FeedTranslationJobInputSchema.safeParse({items:[{id:'a',text:'hello'}]}).success,true);
  assert.equal(FeedTranslationJobInputSchema.safeParse({items:[{id:'long',text:'a'.repeat(20001)}]}).success,true);
  for (const value of [{items:[{id:'a',text:'hello'},{id:'a',text:'world'}]}, {items:[{id:'a',text:'hello'}],command:'bash'}, {items:[{id:'a',text:'a'.repeat(200_001)}]}]) {
    assert.equal(FeedTranslationJobInputSchema.safeParse(value).success,false);
  }
});

test('SSE daily quota errors preserve supplier cooldown and do not become complete output', fixture(async store => {
  const env = { GEMINI_API_KEY: 'key-one', GEMINI_API_KEY2: 'key-two' };
  const quota = () => new Response('data: '+JSON.stringify({error:{code:429,status:'RESOURCE_EXHAUSTED',message:'daily quota exceeded',details:[{retryDelay:'1s'}]}})+'\n\n');
  const router=createGemmaTranslationRouter({env,quotaRepository:store.repositories.modelQuota,fetch:async()=>quota()});
  await assert.rejects(router.generate({system:'翻译',prompt:'First'}),/流内错误/);
  const next=createGemmaTranslationRouter({env,quotaRepository:store.repositories.modelQuota,fetch:async (url, init)=>{
    assert.match(url,/gemma-4-26b-a4b-it/);
    assert.equal(init.headers['x-goog-api-key'], 'key-two');
    return sse('译文');
  }});
  assert.equal((await next.generate({system:'翻译',prompt:'Second'})).engine,'gemma-4-26b-a4b-it');
}));

test('failed 26B attempt backs off persistently and the next worker attempt stays on 26B', fixture(async store => {
  const calls = [];
  const service = createFeedService({legacyRepository:store,feedRepository:store.repositories.feed,sourcePort:{},
    translationPort:createTranslateService({...settings(store),fetch:async url=>{
      calls.push(url);
      return calls.length===1 ? new Response('{"error":{"code":500,"status":"INTERNAL"}}',{status:500}) : sse('完整译文');
    }})});
  const job=store.createJob({type:'feed.translation.run',input:{items:[{id:'fallback-one',text:'A sensor purchase has not yet been confirmed.'}]},maxAttempts:2});
  const runner=createJobRunner({store,handlers:createFeedTranslationJobHandlers({feedService:service})});
  await runner.runOnce(); assert.equal(store.getJob(job.id).status,'queued');
  assert.equal(store.repositories.feed.listTranslations('local',['fallback-one']).length,0);
  await new Promise(resolve=>setTimeout(resolve,1100));
  await runner.runOnce(); assert.equal(store.getJob(job.id).status,'completed');
  assert.equal(calls.length,2); assert.match(calls[0],/gemma-4-26b-a4b-it/);assert.match(calls[1],/gemma-4-26b-a4b-it/);
  assert.equal(store.repositories.feed.listTranslations('local',['fallback-one'])[0].engine,'gemma-4-26b-a4b-it');
}));

test('single-key HTTP 500 does not wait out same-key pacing for the other Gemma model', fixture(async store => {
  const calls = [];
  const router = createGemmaTranslationRouter({ ...settings(store), fetch: async url => {
    calls.push(url);
    return new Response('{"error":{"code":500,"status":"INTERNAL"}}', { status: 500 });
  }});
  await assert.rejects(router.generate({ system: '翻译', prompt: 'One' }), error => /500/.test(error.message) && !/等待配额窗口/.test(error.message));
  assert.equal(calls.length, 1);
  assert.match(calls[0], /gemma-4-26b-a4b-it/);
  assert.equal(store.repositories.modelQuota.listCooldowns(0).length, 0);
}));

test('Gemma HTTP 500 retries another key and logs length, key, latency and concurrency', fixture(async store => {
  let at = Date.now();
  const calls = [], usage = [], lines = [];
  const original = console.error;
  console.error = (...args) => { lines.push(args.join(' ')); };
  try {
    const router = createGemmaTranslationRouter({
      env: { GEMINI_API_KEY: 'key-one', GEMINI_API_KEY2: 'key-two' },
      quotaRepository: store.repositories.modelQuota, now: () => at, sleep: async ms => { at += ms; },
      usageObserver: row => usage.push(structuredClone(row)),
      fetch: async (url, init) => {
        calls.push({ url, key: init.headers['x-goog-api-key'], at });
        if (calls.length === 1) return new Response(JSON.stringify({ error: { code: 500, status: 'INTERNAL', message: 'Internal error encountered.' } }), { status: 500 });
        return sse('译文');
      },
    });
    const result = await router.generate({ system: '翻译', prompt: 'Sensor order is not confirmed.' });
    assert.equal(result.engine, 'gemma-4-26b-a4b-it');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].at, calls[0].at);
    assert.deepEqual(calls.map(call => call.key), ['key-one', 'key-two']);
    assert.equal(store.repositories.modelQuota.listCooldowns(0).length, 0);
    assert.equal(lines.some(line => line.includes('上游 500 退避')), true);
    assert.equal(lines.some(line => line.includes('等待配额窗口')), false);
    assert.match(calls[0].url, /gemma-4-26b-a4b-it/);
    assert.match(calls[1].url, /gemma-4-26b-a4b-it/);
    const logged = lines.find(line => line.includes('inputBytes='));
    assert.match(logged, /status=500/);
    assert.match(logged, /model=gemma-4-26b-a4b-it/);
    assert.match(logged, /key=KEY /);
    assert.match(logged, /inputBytes=\d+/);
    assert.match(logged, /latencyMs=\d+/);
    assert.match(logged, /concurrency=1/);
    assert.match(logged, /Internal error encountered/);
    assert.doesNotMatch(logged, /key-one|key-two/);
    assert.equal(usage.some(row => row.status === 'failed' && row.httpStatus === 500), true);
    assert.equal(usage.some(row => row.status === 'succeeded' && row.httpStatus === 200), true);
  } finally { console.error = original; }
}));

test('Gemma timeout retries another key without leaving the Gemma pool', fixture(async store => {
  let at = Date.now();
  const calls = [];
  const router = createGemmaTranslationRouter({
    env: { GEMINI_API_KEY: 'key-one', GEMINI_API_KEY2: 'key-two' },
    quotaRepository: store.repositories.modelQuota, now: () => at, sleep: async ms => { at += ms; },
    fetch: async (url, init) => {
      calls.push({ url, key: init.headers['x-goog-api-key'] });
      if (calls.length === 1) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      return sse('译文');
    },
  });
  assert.equal((await router.generate({ system: '翻译', prompt: 'Timeout then another key.' })).engine, 'gemma-4-26b-a4b-it');
  assert.deepEqual(calls.map(call => call.key), ['key-one', 'key-two']);
  assert.match(calls[0].url, /gemma-4-26b-a4b-it/);
  assert.match(calls[1].url, /gemma-4-26b-a4b-it/);
}));

test('explicit 31B rotation still starts on 31B but a 5xx retry stays on 26B and another key', fixture(async store => {
  let at = Date.now();
  const calls = [];
  const router = createGemmaTranslationRouter({
    env: { GEMINI_API_KEY: 'key-one', GEMINI_API_KEY2: 'key-two', AI_CENTER_GEMMA_TRANSLATION_MODELS: 'gemma-4-31b-it,gemma-4-26b-a4b-it' },
    quotaRepository: store.repositories.modelQuota, now: () => at, sleep: async ms => { at += ms; },
    fetch: async (url, init) => {
      calls.push({ url, key: init.headers['x-goog-api-key'], signal: init.signal });
      if (calls.length === 1) return new Response('{"error":{"code":500,"status":"INTERNAL"}}', { status: 500 });
      return sse('译文');
    },
  });
  assert.equal((await router.generate({ system: '翻译', prompt: 'Override still retries 26B.' })).engine, 'gemma-4-26b-a4b-it');
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /gemma-4-31b-it/);
  assert.match(calls[1].url, /gemma-4-26b-a4b-it/);
  assert.deepEqual(calls.map(call => call.key), ['key-one', 'key-two']);
  assert.ok(calls[0].signal instanceof AbortSignal);
}));

test('31B-only override retries another key on 31B', fixture(async store => {
  let at = Date.now();
  const calls = [];
  const router = createGemmaTranslationRouter({
    env: { GEMINI_API_KEY: 'key-one', GEMINI_API_KEY2: 'key-two' },
    models: ['gemma-4-31b-it'],
    quotaRepository: store.repositories.modelQuota, now: () => at, sleep: async ms => { at += ms; },
    fetch: async (url, init) => {
      calls.push({ url, key: init.headers['x-goog-api-key'] });
      if (calls.length === 1) return new Response('{"error":{"code":500,"status":"INTERNAL"}}', { status: 500 });
      return sse('译文');
    },
  });
  assert.equal((await router.generate({ system: '翻译', prompt: '31B only.' })).engine, 'gemma-4-31b-it');
  assert.deepEqual(calls.map(call => call.key), ['key-one', 'key-two']);
  assert.match(calls[0].url, /gemma-4-31b-it/);
  assert.match(calls[1].url, /gemma-4-31b-it/);
}));

test('Gemma connect timeout retries another 26B key and records HTTP 408', fixture(async store => {
  let at = Date.now();
  const calls = [], usage = [], lines = [];
  const original = console.error;
  console.error = (...args) => { lines.push(args.join(' ')); };
  try {
    const router = createGemmaTranslationRouter({
      env: { GEMINI_API_KEY: 'key-one', GEMINI_API_KEY2: 'key-two' },
      quotaRepository: store.repositories.modelQuota, now: () => at, sleep: async ms => { at += ms; },
      usageObserver: row => usage.push(structuredClone(row)),
      timeoutMs: 120000,
      fetch: async (url, init) => {
        calls.push({ url, key: init.headers['x-goog-api-key'], signal: init.signal });
        if (calls.length === 1) throw Object.assign(new Error('Connect Timeout Error (UND_ERR_CONNECT_TIMEOUT)'), { code: 'UND_ERR_CONNECT_TIMEOUT', name: 'ConnectTimeoutError' });
        return sse('译文');
      },
    });
    assert.equal((await router.generate({ system: '翻译', prompt: 'Connect timeout then another key.' })).engine, 'gemma-4-26b-a4b-it');
    assert.deepEqual(calls.map(call => call.key), ['key-one', 'key-two']);
    assert.match(calls[0].url, /gemma-4-26b-a4b-it/);
    assert.match(calls[1].url, /gemma-4-26b-a4b-it/);
    assert.ok(calls[0].signal instanceof AbortSignal);
    assert.match(lines.find(line => line.includes('inputBytes=')), /status=408/);
    assert.equal(usage.some(row => row.status === 'interrupted' && row.httpStatus === 408), true);
    assert.equal(usage.some(row => row.status === 'succeeded' && row.httpStatus === 200), true);
    assert.equal(store.repositories.modelQuota.listCooldowns(0).length, 0);
  } finally { console.error = original; }
}));

test('Gemma quota day follows Pacific midnight across daylight-saving changes', () => {
  const pacific = { timeZone: 'America/Los_Angeles', hour: 0, minute: 0 };
  for (const stamp of ['2026-10-07T15:00:00Z', '2026-10-07T07:00:00Z', '2026-03-08T09:30:00Z', '2026-11-01T08:30:00Z']) {
    const at = Date.parse(stamp);
    assert.equal(gemmaQuotaDay(at).dayStart, previousDailyInstant(at, pacific));
    assert.equal(gemmaQuotaDay(at).dayEnd, nextDailyInstant(at, pacific));
  }
});

test('HTTP 502, 503 and 408 retry the next key and do not cool it', fixture(async store => {
  for (const status of [502, 503, 408]) {
    let at = Date.parse('2026-10-14T16:00:00Z');
    const calls = [];
    const router = createGemmaTranslationRouter({
      env: { GEMINI_API_KEY: `key-a-${status}`, GEMINI_API_KEY2: `key-b-${status}` },
      quotaRepository: store.repositories.modelQuota, now: () => at, sleep: async ms => { at += ms; },
      fetch: async (url, init) => {
        calls.push(init.headers['x-goog-api-key']);
        if (calls.length === 1) return new Response('{"error":{"code":' + status + '}}', { status });
        return sse('译文');
      },
    });
    assert.equal((await router.generate({ system: '翻译', prompt: 'Gateway ' + status })).engine, 'gemma-4-26b-a4b-it');
    assert.deepEqual(calls, [`key-a-${status}`, `key-b-${status}`]);
  }
  assert.equal(store.repositories.modelQuota.listCooldowns(0).length, 0);
}));

test('same-key upstream 500 backs off 10s, 20s, then 40s without a quota cooldown', fixture(async store => {
  let at = Date.parse('2026-10-14T16:00:00Z');
  const calls = [], lines = [];
  const original = console.error;
  console.error = (...args) => { lines.push(args.join(' ')); };
  try {
    const router = createGemmaTranslationRouter({
      env: { GEMINI_API_KEY: 'only-key' },
      quotaRepository: store.repositories.modelQuota, now: () => at, sleep: async ms => { at += ms; },
      fetch: async () => {
        calls.push(at);
        return new Response('{"error":{"code":500,"status":"INTERNAL"}}', { status: 500 });
      },
    });
    for (const gap of [0, 10_000, 20_000, 40_000, 40_000]) {
      const before = calls.at(-1);
      await assert.rejects(router.generate({ system: '翻译', prompt: 'Again' }), error => /500/.test(error.message) && !/等待配额窗口/.test(error.message));
      assert.equal(calls.at(-1) - (before ?? calls.at(-1)), gap);
    }
    assert.equal(calls.length, 5);
    assert.equal(store.repositories.modelQuota.listCooldowns(0).length, 0);
    assert.equal(lines.some(line => line.includes('上游 500 退避') && line.includes('waitMs=10000')), true);
    assert.equal(lines.some(line => line.includes('waitMs=20000')), true);
    assert.equal(lines.some(line => line.includes('waitMs=40000')), true);
    assert.equal(lines.some(line => line.includes('等待配额窗口')), false);
  } finally { console.error = original; }
}));

test('a successful response clears same-key upstream backoff and records actual token usage', fixture(async (store, dir) => {
  let at = Date.parse('2026-10-14T16:00:00Z');
  let fail = true;
  const calls = [];
  const router = createGemmaTranslationRouter({
    env: { GEMINI_API_KEY: 'usage-key' },
    random: () => 0,
    quotaRepository: store.repositories.modelQuota, now: () => at, sleep: async ms => { at += ms; },
    fetch: async () => {
      calls.push(at);
      if (fail) return new Response('{"error":{"code":500,"status":"INTERNAL"}}', { status: 500 });
      return sse('译文');
    },
  });
  await assert.rejects(router.generate({ system: '翻译', prompt: 'Usage' }), /500/);
  fail = false;
  assert.equal((await router.generate({ system: '翻译', prompt: 'Usage' })).text, '译文');
  assert.equal(calls[1] - calls[0], 10_000);
  fail = true;
  await assert.rejects(router.generate({ system: '翻译', prompt: 'Usage' }), /500/);
  assert.equal(calls[2] - calls[1], 2000);
  await assert.rejects(router.generate({ system: '翻译', prompt: 'Usage' }), /500/);
  assert.equal(calls[3] - calls[2], 10_000);
  const db = new Database(path.join(dir, 'test.db'), { readonly: true });
  try {
    const rows = db.prepare('SELECT estimated_tokens FROM model_quota_reservations ORDER BY at').all();
    assert.deepEqual(rows.map(row => row.estimated_tokens), [0, 30, 0, 0]);
  } finally { db.close(); }
}));

test('missing usageMetadata records zero tokens instead of a byte estimate', fixture(async (store, dir) => {
  const router = createGemmaTranslationRouter({
    ...settings(store),
    fetch: async () => new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '译文' }] }, finishReason: 'STOP' }] })}\r\n\r\n`),
  });
  await router.generate({ system: '翻译', prompt: 'a'.repeat(60_000) });
  const db = new Database(path.join(dir, 'test.db'), { readonly: true });
  try {
    const row = db.prepare('SELECT estimated_tokens FROM model_quota_reservations').get();
    assert.equal(row.estimated_tokens, 0);
  } finally { db.close(); }
}));

test('translation limits come from env and clamp into the documented range', fixture(async store => {
  const run = async (envExtra, gap, random = () => 0) => {
    let at = Date.parse('2026-10-14T18:00:00Z') + gap;
    const times = [];
    const router = createGemmaTranslationRouter({
      env: { GEMINI_API_KEY: 'pace-' + gap + '-' + Math.random(), ...envExtra },
      random,
      quotaRepository: store.repositories.modelQuota, now: () => at, sleep: async ms => { at += ms; },
      fetch: async () => { times.push(at); return sse('译文'); },
    });
    await router.generate({ system: '翻译', prompt: 'One' });
    await router.generate({ system: '翻译', prompt: 'Two' });
    assert.equal(times[1] - times[0], gap);
  };
  await run({}, 2000);
  await run({ AI_CENTER_GEMMA_TRANSLATION_INTERVAL_MIN_MS: 'nope', AI_CENTER_GEMMA_TRANSLATION_INTERVAL_MAX_MS: 'nope' }, 2000);
  await run({ AI_CENTER_GEMMA_TRANSLATION_INTERVAL_MIN_MS: '2000', AI_CENTER_GEMMA_TRANSLATION_INTERVAL_MAX_MS: '3000' }, 3000, () => 1);
  await run({ AI_CENTER_GEMMA_TRANSLATION_INTERVAL_MIN_MS: '4000', AI_CENTER_GEMMA_TRANSLATION_INTERVAL_MAX_MS: '1000' }, 4000);
  let at = Date.parse('2026-10-14T19:00:00Z');
  let requests = 0;
  const capped = createGemmaTranslationRouter({
    env: { GEMINI_API_KEY: 'daily-cap', AI_CENTER_GEMMA_TRANSLATION_REQUESTS_PER_DAY: '2', AI_CENTER_GEMMA_TRANSLATION_INTERVAL_MIN_MS: '0', AI_CENTER_GEMMA_TRANSLATION_INTERVAL_MAX_MS: '0' },
    quotaRepository: store.repositories.modelQuota, now: () => at, sleep: async ms => { at += ms; },
    fetch: async () => { requests += 1; return sse('译文'); },
  });
  await capped.generate({ system: '翻译', prompt: 'One' });
  await capped.generate({ system: '翻译', prompt: 'Two' });
  await assert.rejects(capped.generate({ system: '翻译', prompt: 'Three' }), error => error.code === 'budget-deferred' && /等待配额窗口/.test(error.message));
  assert.equal(requests, 2);
}));

test('same-key spacing is a random gap between the configured bounds', () => {
  assert.equal(gemmaIntervalMs(2000, 3000, () => 0), 2000);
  assert.equal(gemmaIntervalMs(2000, 3000, () => 0.5), 2500);
  assert.equal(gemmaIntervalMs(2000, 3000, () => 1), 3000);
  assert.equal(gemmaIntervalMs(3000, 2000, () => 0.2), 3000);
  assert.equal(gemmaBackoffMs(1, 10_000, 40_000), 10_000);
  assert.equal(gemmaBackoffMs(2, 10_000, 40_000), 20_000);
  assert.equal(gemmaBackoffMs(3, 10_000, 40_000), 40_000);
  assert.equal(gemmaBackoffMs(6, 10_000, 40_000), 40_000);
  assert.equal(gemmaBackoffMs(1, 0, 40_000), 0);
  assert.deepEqual(gemmaRetryStatuses(undefined), [500, 502, 503, 408]);
  assert.deepEqual(gemmaRetryStatuses('504, 500, no, 504'), [504, 500]);
  assert.deepEqual(gemmaRetryStatuses('nope'), [500, 502, 503, 408]);
  const policy = gemmaTranslationPolicy({
    AI_CENTER_GEMMA_TRANSLATION_REQUESTS_PER_MINUTE: '25',
    AI_CENTER_GEMMA_TRANSLATION_MAX_RETRIES: '4',
    AI_CENTER_GEMMA_TRANSLATION_BACKOFF_BASE_MS: '1000',
    AI_CENTER_GEMMA_TRANSLATION_BACKOFF_CAP_MS: '100',
    AI_CENTER_GEMMA_TRANSLATION_RETRY_STATUSES: '500,502',
  });
  assert.equal(policy.requestsPerMinute, 25);
  assert.equal(policy.maxRetries, 4);
  assert.equal(policy.backoffBaseMs, 1000);
  assert.equal(policy.backoffCapMs, 1000);
  assert.deepEqual(policy.retryStatuses, [500, 502]);
});

test('HTTP 504 does not switch keys unless it is configured as retryable', fixture(async store => {
  let at = Date.parse('2026-10-14T20:00:00Z');
  const blocked = [];
  const router = createGemmaTranslationRouter({
    env: { GEMINI_API_KEY: 'key-a', GEMINI_API_KEY2: 'key-b' },
    quotaRepository: store.repositories.modelQuota, now: () => at, sleep: async ms => { at += ms; },
    fetch: async (url, init) => { blocked.push(init.headers['x-goog-api-key']); return new Response('{"error":{"code":504}}', { status: 504 }); },
  });
  await assert.rejects(router.generate({ system: '翻译', prompt: 'Gateway 504' }), /504/);
  assert.deepEqual(blocked, ['key-a']);
  const calls = [];
  const allowed = createGemmaTranslationRouter({
    env: { GEMINI_API_KEY: 'key-c', GEMINI_API_KEY2: 'key-d', AI_CENTER_GEMMA_TRANSLATION_RETRY_STATUSES: '504' },
    quotaRepository: store.repositories.modelQuota, now: () => at, sleep: async ms => { at += ms; },
    fetch: async (url, init) => {
      calls.push(init.headers['x-goog-api-key']);
      if (calls.length === 1) return new Response('{"error":{"code":504}}', { status: 504 });
      return sse('译文');
    },
  });
  assert.equal((await allowed.generate({ system: '翻译', prompt: 'Gateway 504' })).text, '译文');
  assert.deepEqual(calls, ['key-c', 'key-d']);
  assert.equal(calls.length === 2 && at === Date.parse('2026-10-14T20:00:00Z'), true);
}));

test('max retries and per-key request rate come from env', fixture(async store => {
  let at = Date.parse('2026-10-14T21:00:00Z');
  const calls = [];
  const router = createGemmaTranslationRouter({
    env: {
      GEMINI_API_KEY: 'rate-a', GEMINI_API_KEY2: 'rate-b', GEMINI_API_KEY3: 'rate-c',
      AI_CENTER_GEMMA_TRANSLATION_MAX_RETRIES: '1',
      AI_CENTER_GEMMA_TRANSLATION_INTERVAL_MIN_MS: '0', AI_CENTER_GEMMA_TRANSLATION_INTERVAL_MAX_MS: '0',
    },
    quotaRepository: store.repositories.modelQuota, now: () => at, sleep: async ms => { at += ms; },
    fetch: async (url, init) => { calls.push(init.headers['x-goog-api-key']); return new Response('{"error":{"code":500}}', { status: 500 }); },
  });
  await assert.rejects(router.generate({ system: '翻译', prompt: 'Stop after one retry' }), /500/);
  assert.deepEqual(calls, ['rate-a', 'rate-b']);
  let pacedAt = Date.parse('2026-10-14T21:30:00Z');
  const times = [];
  const paced = createGemmaTranslationRouter({
    env: {
      GEMINI_API_KEY: 'rpm-key',
      AI_CENTER_GEMMA_TRANSLATION_REQUESTS_PER_MINUTE: '2',
      AI_CENTER_GEMMA_TRANSLATION_INTERVAL_MIN_MS: '0', AI_CENTER_GEMMA_TRANSLATION_INTERVAL_MAX_MS: '0',
    },
    quotaRepository: store.repositories.modelQuota, now: () => pacedAt, sleep: async ms => { pacedAt += ms; },
    fetch: async () => { times.push(pacedAt); return sse('译文'); },
  });
  await paced.generate({ system: '翻译', prompt: 'One' });
  await paced.generate({ system: '翻译', prompt: 'Two' });
  await paced.generate({ system: '翻译', prompt: 'Three' });
  assert.equal(times[1] - times[0], 0);
  assert.equal(times[2] - times[0], 60_000);
}));

test('configured backoff base and cap replace the 10s 20s 40s ladder', fixture(async store => {
  let at = Date.parse('2026-10-14T22:00:00Z');
  const calls = [];
  const router = createGemmaTranslationRouter({
    env: {
      GEMINI_API_KEY: 'backoff-key',
      AI_CENTER_GEMMA_TRANSLATION_BACKOFF_BASE_MS: '1000',
      AI_CENTER_GEMMA_TRANSLATION_BACKOFF_CAP_MS: '2000',
      AI_CENTER_GEMMA_TRANSLATION_MAX_RETRIES: '0',
      AI_CENTER_GEMMA_TRANSLATION_INTERVAL_MIN_MS: '0',
      AI_CENTER_GEMMA_TRANSLATION_INTERVAL_MAX_MS: '0',
    },
    quotaRepository: store.repositories.modelQuota, now: () => at, sleep: async ms => { at += ms; },
    fetch: async () => { calls.push(at); return new Response('{"error":{"code":500}}', { status: 500 }); },
  });
  for (const gap of [0, 1000, 2000, 2000]) {
    const before = calls.at(-1);
    await assert.rejects(router.generate({ system: '翻译', prompt: 'Ladder' }), /500/);
    assert.equal(calls.at(-1) - (before ?? calls.at(-1)), gap);
  }
}));

test('a job attempt stops once the call cap is spent', fixture(async store => {
  assert.equal(translationAttemptCallLimit({ itemCount: 1, keyCount: 5, maxRetries: 2 }), 7);
  assert.equal(translationAttemptCallLimit({ itemCount: 1, keyCount: 5, maxRetries: 2, configured: '4' }), 4);
  assert.equal(translationAttemptCallLimit({ itemCount: 18, keyCount: 5, maxRetries: 2, configured: '0' }), 126);
  let calls = 0;
  const router = createGemmaTranslationRouter({
    env: {
      GEMINI_API_KEY: 'cap-key',
      AI_CENTER_GEMMA_TRANSLATION_MAX_RETRIES: '8',
      AI_CENTER_GEMMA_TRANSLATION_BACKOFF_BASE_MS: '0',
      AI_CENTER_GEMMA_TRANSLATION_BACKOFF_CAP_MS: '0',
      AI_CENTER_GEMMA_TRANSLATION_INTERVAL_MIN_MS: '0',
      AI_CENTER_GEMMA_TRANSLATION_INTERVAL_MAX_MS: '0',
    },
    quotaRepository: store.repositories.modelQuota,
    sleep: async () => {},
    fetch: async () => { calls += 1; return new Response('{"error":{"code":500}}', { status: 500 }); },
  });
  await assert.rejects(
    withTranslationCallBudget(3, () => router.generate({ system: '翻译', prompt: 'A short English title about chips' })),
    (error) => error.code === 'translation-call-cap' && calls === 3,
  );
}));

test('a failed response still records usageMetadata and ignores a missing one', fixture(async (store, dir) => {
  let at = Date.parse('2026-10-14T23:00:00Z');
  let mode = 'usage';
  const router = createGemmaTranslationRouter({
    env: { GEMINI_API_KEY: 'fail-usage', AI_CENTER_GEMMA_TRANSLATION_INTERVAL_MIN_MS: '0', AI_CENTER_GEMMA_TRANSLATION_INTERVAL_MAX_MS: '0' },
    quotaRepository: store.repositories.modelQuota, now: () => at, sleep: async ms => { at += ms; },
    fetch: async () => {
      if (mode === 'usage') return new Response(JSON.stringify({ error: { code: 500 }, usageMetadata: { totalTokenCount: 17 } }), { status: 500 });
      return new Response('{"error":{"code":500}}', { status: 500 });
    },
  });
  await assert.rejects(router.generate({ system: '翻译', prompt: 'With usage' }), /500/);
  mode = 'bare';
  await assert.rejects(router.generate({ system: '翻译', prompt: 'Without usage' }), /500/);
  const db = new Database(path.join(dir, 'test.db'), { readonly: true });
  try {
    const rows = db.prepare('SELECT estimated_tokens FROM model_quota_reservations ORDER BY at').all();
    assert.deepEqual(rows.map(row => row.estimated_tokens), [17, 0]);
  } finally { db.close(); }
}));
