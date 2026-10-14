import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createStore } from '../packages/database/src/index.js';
import { createGemmaTranslationRouter, readGemmaStream,resolveGemmaTranslationSlots } from '../packages/connectors/src/translate/gemma.js';
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
 assert.ok(calls.at(-1).at-calls[0].at>=10000);
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
 const env={GEMINI_API_KEY:'one',GEMINI_API_KEY2:'two',GEMINI_API_KEY_PROJECT:'same',GEMINI_API_KEY2_PROJECT:'same'};
 const options={env,quotaRepository:store.repositories.modelQuota,now:()=>at,sleep:async ms=>{at+=ms;},fetch:async()=>{times.push(at);return sse('译文');}};
 const router=createGemmaTranslationRouter(options);
 await router.generate({system:'翻译',prompt:'One'});await router.generate({system:'翻译',prompt:'Two'});
 assert.equal(times[1]-times[0],10000);
 const slot=resolveGemmaTranslationSlots(env)[0];
 for(const model of ['gemma-4-31b-it','gemma-4-26b-a4b-it'])store.repositories.modelQuota.cooldown(slot.project,model,at+86400000);
 await assert.rejects(createGemmaTranslationRouter(options).generate({system:'翻译',prompt:'Blocked'}),e=>e.code==='budget-deferred'&&e.retryAt===at+86400000);
 assert.equal(times.length,2);
}));

test('translation continues beyond the former 14400-per-day local cap',fixture(async(store,dir)=>{
 const at=Date.parse('2026-10-07T15:00:00Z'),env={GEMINI_API_KEY:'fake'},slot=resolveGemmaTranslationSlots(env)[0];
 const db=new Database(path.join(dir,'test.db'));
 try {
  const insert=db.prepare('INSERT INTO model_quota_reservations(id,project,model,at,estimated_tokens) VALUES(?,?,?,?,?)');
  db.transaction(()=>{for(let n=0;n<14401;n++)insert.run('prior-'+n,slot.project,'gemma-4-31b-it',at-2*3600000,1);})();
 }finally{db.close();}
 let requests=0;
 const router=createGemmaTranslationRouter({env,models:['gemma-4-31b-it'],quotaRepository:store.repositories.modelQuota,now:()=>at,fetch:async()=>{requests++;return sse('译文');}});
 assert.equal((await router.generate({system:'翻译',prompt:'A new original.'})).engine,'gemma-4-31b-it');
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
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.dispatcher, undefined);
  }
  assert.equal(usage.filter(row => row.status === 'succeeded').length, 2);
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
}));

test('long input splits without dropping characters, batch cache preserves complete output and formatting', async () => {
  const source = 'English paragraph with conditions.\n\n'.repeat(180) + '😀 tail';
  const chunks = splitTranslationText(source);
  assert.equal(chunks.join(''), source); assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk=>chunk.length<=2400));
  const prompts = [];
  const service = createTranslateService({router:{generate:async({system,prompt})=>{
    assert.match(system,/任一条件/); prompts.push(prompt); return {text:'译文\n\n- 列表',engine:'gemma-4-31b-it'};
  }}});
  const result = await service.translate({text:source});
  assert.equal(prompts.join(''),source);
  assert.match(result.translatedText,/\n\n- 列表/);
  await service.translate({text:source}); assert.equal(prompts.length,chunks.length);
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
  await assert.rejects(router.generate({ system: '翻译', prompt: 'One' }), /500/);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /gemma-4-26b-a4b-it/);
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
        calls.push({ url, key: init.headers['x-goog-api-key'] });
        if (calls.length === 1) return new Response(JSON.stringify({ error: { code: 500, status: 'INTERNAL', message: 'Internal error encountered.' } }), { status: 500 });
        return sse('译文');
      },
    });
    const result = await router.generate({ system: '翻译', prompt: 'Sensor order is not confirmed.' });
    assert.equal(result.engine, 'gemma-4-26b-a4b-it');
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(call => call.key), ['key-one', 'key-two']);
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
  } finally { console.error = original; }
}));
