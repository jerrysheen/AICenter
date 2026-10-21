import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHarnessAgentRuntime} from '../packages/harness/src/index.js';
import {createToolRegistry} from '../packages/runtime/src/tool-registry.js';
import {runBounded} from '../packages/domain/src/daily-analysis.js';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture() {
 const directory=mkdtempSync(path.join(os.tmpdir(),'model-admission-')),first=deferred(),release=deferred(),calls=[];let closed=0;
 const runtime=createHarnessAgentRuntime({tools:createToolRegistry(),runtimeDirectory:directory,env:{DEEPSEEK_API_KEY:'test-key'},
  createClient:async()=>({run:async prompt=>{calls.push(prompt);if(calls.length===1){first.resolve();await release.promise;}return {finalResponse:'ok',events:[]};},close:async()=>{closed++;}})});
 const input={message:'first',closedContext:true};
 return {runtime,first,release,calls,input,get closed(){return closed;},async close(){release.resolve();await runtime.close();rmSync(directory,{recursive:true,force:true});}};
}
test('queue wait does not consume the model execution deadline',async()=>{
 const f=fixture(),observed=[];try {
  const first=f.runtime.run(f.input);await f.first.promise;
  const second=runBounded(f.runtime,{...f.input,message:'second'},200,()=>{},50,{queueTimeoutMs:2000,onTiming:t=>observed.push(t)});
  await new Promise(r=>setTimeout(r,300));f.release.resolve();await first;assert.equal((await second).answer,'ok');
  assert.ok(observed.some(t=>t.phase==='executing' && t.queueMs>=200));assert.equal(observed.at(-1).finishReason,'completed');assert.equal(f.calls.length,2);
 }finally{await f.close();}
});
test('expired queue entries never run and never dispose the active Harness engine',async()=>{
 const f=fixture(),observed=[];try {
  const first=f.runtime.run(f.input);await f.first.promise;
  await assert.rejects(runBounded(f.runtime,{...f.input,message:'expired'},1000,()=>{},50,{queueTimeoutMs:60,onTiming:t=>observed.push(t)}),{name:'ModelQueueTimeout'});
  assert.equal(f.calls.length,1);assert.equal(f.closed,0);assert.equal(observed.at(-1).executionMs,0);
  const next=f.runtime.run({...f.input,message:'next'});f.release.resolve();await first;await next;
  assert.equal(f.calls.length,2);assert.ok(!f.calls.some(p=>p.includes('expired')));
 }finally{await f.close();}
});
test('latest-hour admission outranks queued backfill without running models in parallel',async()=>{
 const f=fixture();try {
  const first=f.runtime.run(f.input);await f.first.promise;
  const low=f.runtime.run({...f.input,message:'backfill',executionPriority:-10});
  const high=f.runtime.run({...f.input,message:'latest-hour',executionPriority:10});
  assert.equal(f.calls.length,1);f.release.resolve();await Promise.all([first,low,high]);
  assert.match(f.calls[1],/latest-hour/);assert.match(f.calls[2],/backfill/);
 }finally{await f.close();}
});
test('execution and total-wall timeouts have separate reasons and renew waiting leases',async()=>{
 let renewals=0;
 const fake={run:()=>new Promise(()=>{})};
 await assert.rejects(runBounded(fake,{},30,()=>{renewals++;},10),{name:'ModelExecutionTimeout'});assert.ok(renewals>0);
 const waiting={supportsExecutionAdmission:true,run:()=>new Promise(()=>{})};
 await assert.rejects(runBounded(waiting,{},1000,()=>{},10,{queueTimeoutMs:1000,totalTimeoutMs:30}),{name:'StageBudgetTimeout'});
});

test('Harness turn errors retain their actual cause and aborted partial answers cannot be published',async()=>{
 const directory=mkdtempSync(path.join(os.tmpdir(),'model-terminal-'));
 let reason={kind:'error',error:{code:'PI_AI_ERROR',message:'Request could not be completed.'}};
 const runtime=createHarnessAgentRuntime({tools:createToolRegistry(),runtimeDirectory:directory,env:{DEEPSEEK_API_KEY:'test-key'},
  createClient:async()=>({run:async()=>({finalResponse:'partial answer',events:[{type:'turn/end',data:{reason}}]}),close:async()=>{}})});
 try {
  const timings=[];
  await assert.rejects(runBounded(runtime,{closedContext:true,message:'frozen materials'},1000,()=>{},50,{onTiming:t=>timings.push(t)}),error=>{
    assert.equal(error.name,'HarnessModelError');assert.match(error.message,/PI_AI_ERROR/);return true;
  });
  assert.equal(timings.at(-1).finishReason,'HarnessModelError');
  reason={kind:'aborted',reason:{kind:'disposed'}};
  await assert.rejects(runtime.run({closedContext:true,message:'retry'}),{name:'AbortError'});
  reason={kind:'completed'};
  assert.equal((await runtime.run({closedContext:true,message:'completed'})).answer,'partial answer');
 }finally{await runtime.close();rmSync(directory,{recursive:true,force:true});}
});

async function untilCalls(calls, count) {
  for (let turn = 0; turn < 50 && calls.length < count; turn += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls.length, count);
}

test('hourly backfill takes the next closed slot after one latest-hour cut-in', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'model-backfill-'));
  const releases = [];
  const calls = [];
  const runtime = createHarnessAgentRuntime({
    tools: createToolRegistry(), runtimeDirectory: directory, env: { DEEPSEEK_API_KEY: 'test-key' },
    createClient: async () => ({
      run: async (prompt) => {
        calls.push(prompt);
        const gate = deferred();
        releases.push(gate);
        await gate.promise;
        return { finalResponse: 'ok', events: [] };
      },
      close: async () => {},
    }),
  });
  const brief = { closedContext: true, closedTask: 'hourly-brief' };
  try {
    const current = runtime.run({ ...brief, message: 'current-hour' });
    await untilCalls(calls, 1);
    const backfill = runtime.run({ ...brief, message: 'aged-backfill', executionPriority: -10 });
    const latest = runtime.run({ ...brief, message: 'latest-hour', executionPriority: 10 });
    releases[0].resolve();
    await untilCalls(calls, 2);
    assert.match(calls[1], /latest-hour/);
    const again = runtime.run({ ...brief, message: 'latest-again', executionPriority: 10 });
    releases[1].resolve();
    await untilCalls(calls, 3);
    assert.match(calls[2], /aged-backfill/);
    releases[2].resolve();
    await untilCalls(calls, 4);
    assert.match(calls[3], /latest-again/);
    releases[3].resolve();
    await Promise.all([current, backfill, latest, again]);
  } finally {
    for (const gate of releases) gate.resolve();
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Ask still starts before an aged hourly backfill', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'model-ask-'));
  const releases = [];
  const calls = [];
  const runtime = createHarnessAgentRuntime({
    tools: createToolRegistry(), runtimeDirectory: directory, env: { DEEPSEEK_API_KEY: 'test-key' },
    createClient: async () => ({
      run: async (prompt) => {
        calls.push(prompt);
        const gate = deferred();
        releases.push(gate);
        await gate.promise;
        return { finalResponse: 'ok', events: [] };
      },
      close: async () => {},
    }),
  });
  const brief = { closedContext: true, closedTask: 'hourly-brief' };
  try {
    const current = runtime.run({ ...brief, message: 'current-hour' });
    await untilCalls(calls, 1);
    const backfill = runtime.run({ ...brief, message: 'aged-backfill', executionPriority: -10 });
    const latest = runtime.run({ ...brief, message: 'latest-hour', executionPriority: 10 });
    releases[0].resolve();
    await untilCalls(calls, 2);
    const ask = runtime.run({ message: 'interactive-ask' });
    releases[1].resolve();
    await untilCalls(calls, 3);
    assert.match(calls[2], /interactive-ask/);
    releases[2].resolve();
    await untilCalls(calls, 4);
    assert.match(calls[3], /aged-backfill/);
    releases[3].resolve();
    await Promise.all([current, backfill, latest, ask]);
  } finally {
    for (const gate of releases) gate.resolve();
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
