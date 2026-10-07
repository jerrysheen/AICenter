import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createStore } from '../packages/database/src/index.js';
import { createFeedInteractionService } from '../packages/domain/src/feed-interaction-service.js';
import { createXLikeBrowserPort, buildXLikeExpression } from '../packages/connectors/src/x/like-browser.js';
import { LikeContentInputSchema, LikeRequestSchema, LikeResultSchema, X_LIKE_JOB_TYPE } from '../packages/contracts/src/feed-interaction.js';
import { createFeedInteractionJobHandlers, feedInteractionManifest } from '../packages/runtime/src/feed-interaction-module.js';
import { createModuleRegistry } from '../packages/runtime/src/capability-registry.js';
import { createAiCenterServer } from '../apps/web/src/server.js';

const id = randomUUID();
const item = { id, provider: 'x', externalId: '123456789', sourceUrl: 'https://x.com/author/status/123456789' };
const result = status => ({ status, accountHandle: 'fixture', checkedAt: 1 });

test('like contracts reject arbitrary commands, IDs, credentials and unconfirmed writes', () => {
  assert.deepEqual(LikeContentInputSchema.parse({contentItemId:id}),{contentItemId:id});
  for (const input of [{contentItemId:'123'}, {contentItemId:id,url:'https://example.com'}, {contentItemId:id,browserId:'other'}]) assert.equal(LikeContentInputSchema.safeParse(input).success,false);
  assert.equal(LikeRequestSchema.safeParse({confirmed:false}).success,false);
  assert.equal(LikeRequestSchema.safeParse({confirmed:true,token:'private'}).success,false);
  assert.equal(LikeResultSchema.safeParse({...result('liked'),cookie:'private'}).success,false);
  assert.throws(()=>buildXLikeExpression('1); alert(1)'));
});

test('registered like job scopes repository target, deduplicates requests and projects only its result', async () => {
  const store = createStore(':memory:');
  const calls = [];
  const service = createFeedInteractionService({runtimeRepository:store,feedRepository:{getContentItem:(workspace, target)=>workspace==='local' && target===id ? item : null},likePort:{like:async target=>{calls.push(target);return result('liked');}}});
  try {
    assert.throws(()=>service.requestLike('other',{contentItemId:id}));
    const job=service.requestLike('local',{contentItemId:id});
    assert.equal(job.maxAttempts,1);
    assert.equal(service.requestLike('local',{contentItemId:id}).id,job.id);
    assert.equal(service.getLikeJob('other',id,job.id),null);
    assert.equal(service.getLikeJob('local',randomUUID(),job.id),null);
    const registry=createModuleRegistry();registry.register({manifest:feedInteractionManifest,jobHandlers:createFeedInteractionJobHandlers(service)});
    const claimed=store.claimNextJob('fixture',[X_LIKE_JOB_TYPE]);
    const output=await registry.createJobHandlers()[X_LIKE_JOB_TYPE](claimed.input,{job:claimed});
    store.completeJob(job.id,output,{workerId:'fixture',attemptCount:claimed.attemptCount});
    assert.deepEqual(calls,['123456789']);
    assert.deepEqual(service.getLikeJob('local',id,job.id),{id:job.id,status:'completed',result:result('liked')});
    const bad=createFeedInteractionService({runtimeRepository:store,feedRepository:{getContentItem:()=>({...item,sourceUrl:'https://x.com/author/status/987'})}});
    assert.throws(()=>bad.requestLike('local',{contentItemId:id}));
    const foreign=store.createJob({type:'system.healthcheck',input:{contentItemId:id}});
    assert.equal(service.getLikeJob('local',id,foreign.id),null);
  } finally { store.close(); }
});

function browserFixture(states, { failAfterClick=false }={}) {
  let clicks=0, reads=0, navigations=0;
  const session={navigate:async()=>{navigations++;},evaluate:async expression=>{
    if (expression.includes(', true,')) {clicks++;if(failAfterClick)throw Error('secret command');return result('unconfirmed');}
    return result(states[Math.min(reads++,states.length-1)]);
  }};
  const port=createXLikeBrowserPort({browserRuntime:{withSession:async(_,call)=>call(session)},delay:async()=>{}});
  return {port,counts:()=>({clicks,navigations})};
}

test('browser like verifies persistence, preserves existing likes and fails closed after uncertain click',async()=>{
  const success=browserFixture(['unconfirmed','already-liked','already-liked']);
  assert.equal((await success.port.like('123')).status,'liked');assert.deepEqual(success.counts(),{clicks:1,navigations:2});
  const rollback=browserFixture(['unconfirmed','already-liked','unconfirmed']);
  assert.equal((await rollback.port.like('123')).status,'unconfirmed');assert.equal(rollback.counts().clicks,1);
  for(const status of ['already-liked','login-required','blocked','not-found']) {
    const fixture=browserFixture([status]);assert.equal((await fixture.port.like('123')).status,status);assert.equal(fixture.counts().clicks,0);
  }
  const uncertain=browserFixture(['unconfirmed'],{failAfterClick:true});
  assert.equal((await uncertain.port.like('123')).status,'unconfirmed');assert.equal(uncertain.counts().clicks,1);
  const probe=browserFixture(['unconfirmed']);assert.equal((await probe.port.probe('123')).status,'unconfirmed');assert.equal(probe.counts().clicks,0);
});

test('HTTP like requires pairing, rejects command overrides and scopes job reads',async()=>{
  const store=createStore(':memory:');
  const app=createAiCenterServer({store,host:'127.0.0.1',port:0,feedFilter:null});
  // The test uses the real server service wiring for the commands below.
  const address=await app.listen(),base=address.localUrl,path=`/api/v1/content-items/${id}/x-like`;
  try {
    const anonymous=await fetch(`${base}${path}`,{method:'POST',headers:{'content-type':'application/json','cf-connecting-ip':'203.0.113.10'},body:'{"confirmed":true}'});
    assert.equal(anonymous.status,401);
    const invalid=await fetch(`${base}${path}`,{method:'POST',headers:{'content-type':'application/json'},body:'{"confirmed":true,"url":"https://example.com"}'});
    assert.equal(invalid.status,400);
    const missing=await fetch(`${base}${path}`,{method:'POST',headers:{'content-type':'application/json'},body:'{"confirmed":true}'});
    assert.equal(missing.status,400);
    const capture=store.repositories.feed.saveCapture({workspaceId:'local',provider:'x',externalId:item.externalId,sourceUrl:item.sourceUrl,contentHash:'fixture'});
    store.repositories.feed.saveContentItem({id,workspaceId:'local',captureId:capture.id,originType:'subscription',contentType:'post',sourceUrl:item.sourceUrl,body:'Isolated test content'});
    const created=await fetch(`${base}${path}`,{method:'POST',headers:{'content-type':'application/json'},body:'{"confirmed":true}'});
    assert.equal(created.status,202);
    const job=store.getJob((await created.json()).jobId);
    assert.equal(job.type,X_LIKE_JOB_TYPE);
    assert.deepEqual(job.input,{contentItemId:id});
    const response=await fetch(`${base}${path}/${job.id}`).then(r=>r.json());
    assert.equal(response.job.id,job.id);assert.equal(response.job.status,'queued');assert.equal('input' in response.job,false);
    const foreign=store.createJob({type:'system.healthcheck',input:{contentItemId:id}});
    assert.equal((await fetch(`${base}${path}/${foreign.id}`)).status,404);
  } finally { await app.close(); }
});
