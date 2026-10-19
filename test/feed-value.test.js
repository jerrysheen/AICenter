import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeFeedValueText,createFeedValueEvaluator,buildFeedValueQuestions,decideFeedValue,
  feedValuePolicyHash,calibrateFeedValue,decideFeedQualityWithoutScope } from '../packages/domain/src/feed-value.js';
import { createFeedFilter } from '../packages/domain/src/feed-filter.js';
import { createStore } from '../packages/database/src/index.js';
import { createFeedService } from '../packages/domain/src/feed-service.js';
import { FeedValueScoresSchema,FeedValueReferenceSchema } from '../packages/contracts/src/feed-value.js';
import { buildXCaptureContext,buildStatusCommentsExpression,buildTweetExtractExpression } from '../packages/connectors/src/x/home-browser.js';
import vm from 'node:vm';
import {createFeedValueReviewService} from '../packages/domain/src/feed-value-review-service.js';
import {createFeedValueRefreshService} from '../packages/domain/src/feed-value-refresh-service.js';
import { tweetToFeedItem } from '../packages/connectors/src/x/home-timeline.js';

const scores={reading_value:.9,advertising:.99,specific_content:.1,sufficient_information:.2,missing_context:.05};
const answers=s=>Object.fromEntries(Object.entries(s).map(([k,noul])=>[k,{type:'noul',noul}]));
const input=normalizeFeedValueText('一个普通产品新增了离线导出。');
const calibration={version:'feed-value-v3.0',policyHash:feedValuePolicyHash(),model:'fixed',sampleHash:'sample',
  keepAt:.8,dropBelow:.2,annotationSource:'test-fixture',productionQualified:false};
const part=(overrides={})=>({id:'reply',author:{handle:'AUTHOR'},replyToId:'root',relationVerified:true,text:'具体方法：先缓存再重试。',...overrides});

test('V3 has one substantive-value question, no topic inputs, and no source fame or comment leakage',async()=>{
  const calls=[];const e=createFeedValueEvaluator({model:'fixed',calibration,readingScope:['ignored'],client:{async evaluate(p){calls.push(p);return {model:'fixed',answers:answers(scores)};}}});
  const i=normalizeFeedValueText('小产品新增离线导出。\n评论\n· 第三方：太强了');
  const r=await e.evaluate(i);assert.equal(r.decision.decision,'KEEP');
  assert.deepEqual(Object.keys(calls[0].questions),['reading_value','advertising','specific_content','sufficient_information','missing_context']);
  assert.equal('readingScope' in calls[0].state,false);assert.equal('tags' in calls[0].state,false);
  assert.equal('comments' in calls[0].state,false);assert.equal('author' in calls[0].state,false);
  assert.match(buildFeedValueQuestions().reading_value.instructions,/值得保存/);
  assert.match(buildFeedValueQuestions().missing_context.instructions,/captureState/);
});

test('high ads and low auxiliary dimensions cannot veto substantive value; numbers cannot rescue empty content',()=>{
  assert.equal(decideFeedValue(scores,{input,calibration,model:'fixed'}).decision,'KEEP');
  assert.equal(decideFeedValue({...scores,reading_value:.1,specific_content:1,sufficient_information:1,advertising:0},{input,calibration,model:'fixed'}).decision,'DROP');
  assert.equal(decideFeedValue({...scores,reading_value:.5},{input,calibration,model:'fixed'}).reviewKind,'semantic');
});

test('only same-account verified reachable continuations and necessary verified quotes are included',()=>{
  const capture={rootId:'root',author:{handle:'author'},continuations:[part({id:'second',replyToId:'reply'}),part(),
    part({id:'wrong',author:{handle:'other'}}),part({id:'unrelated',replyToId:'other-root'}),part({id:'unknown',relationVerified:false})],
    references:[{id:'q',referencedById:'root',relationVerified:true,necessary:true,text:'核心引用'},
      {id:'bad',referencedById:'unrelated',relationVerified:true,necessary:true,text:'无关引用'}]};
  const i=normalizeFeedValueText('主帖',{capture});
  assert.deepEqual(i.continuations.map(p=>p.id),['reply','second']);assert.deepEqual(i.references.map(p=>p.id),['q']);
  assert.equal(i.suspectedContinuation,true);
  const identityConflict=normalizeFeedValueText('正文',{capture:{rootId:'root',author:{accountId:'1',handle:'same'},
    continuations:[part({author:{accountId:'2',handle:'same'}})]}});
  assert.equal(identityConflict.continuations.length,0);
});

test('display-name text is suspicion, not an authenticated continuation; low value cannot discard it',()=>{
  const i=normalizeFeedValueText('这里是15个提示词：\n评论\n· 同名：提示词内容',{authorName:'同名'});
  assert.equal(i.continuations.length,0);assert.equal(i.suspectedContinuation,true);
  assert.equal(decideFeedValue({...scores,reading_value:.1},{input:i,calibration,model:'fixed'}).reason,'context-unconfirmed');
  assert.equal(decideFeedValue(scores,{input:i,calibration,model:'fixed'}).decision,'KEEP');
});

test('capture facts preempt model scores and avoid requests; supplementary media do not block standalone value',async()=>{
  let calls=0;const e=createFeedValueEvaluator({model:'fixed',calibration,client:{async evaluate(){calls++;return {model:'fixed',answers:answers(scores)};}}});
  const truncated=await e.evaluate(normalizeFeedValueText('看图',{capture:{truncated:true}}));
  assert.equal(truncated.decision.decision,'KEEP');
  assert.equal(truncated.decision.bodyPending,true);
  assert.equal(truncated.decision.reviewKind,'none');
  for(const capture of [{threadIncomplete:true},{missingParts:[{kind:'image',critical:true,status:'confirmed',evidence:'only-answer-in-image'}]}]) {
    const r=await e.evaluate(normalizeFeedValueText('看图',{capture}));assert.equal(r.decision.reviewKind,'missing-content');
  }
  assert.equal(calls,1);
  const i=normalizeFeedValueText('完整提示词：绘制一个红色立方体。\n[未抓取] 视频',{capture:{missingParts:[{kind:'video',critical:false,status:'confirmed',evidence:'output-demo-only'}]}});
  assert.equal((await e.evaluate(i)).decision.decision,'KEEP');assert.equal(calls,2);
  assert.equal((await e.evaluate(normalizeFeedValueText('长文摘要\n[未抓取] X 长文'))).decision.reason,'context-missing');
});

test('invalid capture, invalid scores, absent calibration and stale calibration never classify DROP',async()=>{
  assert.equal(decideFeedValue(scores,{input,model:'fixed'}).reason,'uncalibrated');
  assert.equal(decideFeedValue(scores,{input,model:'changed',calibration}).reason,'calibration-mismatch');
  for(const v of [null,NaN,Infinity,'0.9',-1,1.1])assert.equal(FeedValueScoresSchema.safeParse({...scores,reading_value:v}).success,false);
  const i=normalizeFeedValueText('正文',{capture:{truncated:'false'}});
  assert.equal(decideFeedValue(scores,{input:i,calibration,model:'fixed'}).reason,'invalid-capture');
  assert.equal(decideFeedValue(scores,{input:{},calibration,model:'fixed'}).reason,'body-missing');
  const e=createFeedValueEvaluator({client:{async evaluate(){throw new Error('timeout');}},model:'fixed',calibration});
  assert.equal((await e.evaluate(input)).decision.reviewKind,'technical');
});

test('cache fingerprints change with confirmed input and model, never with ignored interests',()=>{
  const a=createFeedValueEvaluator({model:'a',readingScope:['AI']});
  const b=createFeedValueEvaluator({model:'a',readingScope:['sports']});
  const c=createFeedValueEvaluator({model:'b'});
  assert.equal(a.cacheKey(input),b.cacheKey(input));assert.notEqual(a.cacheKey(input),c.cacheKey(input));
  assert.notEqual(a.cacheKey(input),a.cacheKey({...input,body:'新的正文'}));
});

test('A removes both topic KEEP and DROP gates but preserves other old V2 conditions',()=>{
  const v={...scores,reading_value:.9,specific_content:.9,sufficient_information:.9,topic_relevance:0};
  assert.equal(decideFeedQualityWithoutScope(v,{input}).decision,'KEEP');
  assert.equal(decideFeedQualityWithoutScope({...v,reading_value:.1,specific_content:.1},{input}).decision,'DROP');
});

test('calibration uses only explicit complete-quality labels and excludes disputes and missing inputs',()=>{
  const row=(quality,value,extra={})=>({quality,completeness:'COMPLETE',input,scores:{...scores,reading_value:value},...extra});
  const c=calibrateFeedValue([row('EMPTY',.1),row('EMPTY',.2),row('SUBSTANTIVE',.8),row('SUBSTANTIVE',.9),
    row('DISPUTED',0),row('SUBSTANTIVE',0,{completeness:'SUSPECTED_MISSING'})],{model:'fixed',sampleHash:'frozen'});
  assert.equal(c.keepAt,.8);assert.ok(c.dropBelow<=.8);assert.equal(c.productionQualified,false);
  assert.throws(()=>calibrateFeedValue([row('SUBSTANTIVE',.8)],{model:'fixed',sampleHash:'x'}),/Calibration needs/);
  const core=calibrateFeedValue([row('EMPTY',.3,{completeness:'SUSPECTED_MISSING',mainInformationComplete:true,input:{...input,suspectedContinuation:true}}),
    row('SUBSTANTIVE',.8)],{model:'fixed',sampleHash:'core'});
  assert.equal(core.keepAt,.8);assert.equal(core.dropBelow,.3);
  assert.equal(FeedValueReferenceSchema.safeParse({id:'x',split:'fresh-holdout',quality:'EMPTY',qualityEvidence:'',
    completeness:'COMPLETE',completenessEvidence:'正文完整',interest:'not-reassessed'}).success,false);
});

test('connector preserves truncation and unexpanded-article facts through Source item projection',()=>{
  const capture=buildXCaptureContext({tweet_id:'root',author_handle:'a',truncated:true,article_unfetched:true});
  const i=tweetToFeedItem({tweet_id:'root',author_handle:'a',text:'摘要',capture_context:capture});
  assert.equal(i.captureContext.truncated,true);assert.equal(i.captureContext.missingParts[0].critical,true);
  const pending=buildXCaptureContext({tweet_id:'root',author_handle:'a',comments:[{id:'reply',authorHandle:'a',text:'作者续写',replyToId:'',relationVerified:false}]});
  const unknown=normalizeFeedValueText('主帖',{capture:pending});assert.equal(unknown.suspectedContinuation,true);
  assert.equal(unknown.continuations.length,0);
  new vm.Script(buildStatusCommentsExpression('123'));new vm.Script(buildTweetExtractExpression());
});

test('V3 shadow retains untagged content and stores separate quality state before Tag processing',async()=>{
  const directory=mkdtempSync(path.join(os.tmpdir(),'ai-center-value-'));
  const store=createStore(path.join(directory,'test.db'));
  try{
    const item={externalId:'v3',title:'无实质内容',body:'买就赢',sourceUrl:'https://example.org/v3',authorName:'x'};
    const filter=createFeedFilter({config:{mode:'shadow',version:'feed-value-v3.0'},calibration,
      client:{modelId:'fixed',async evaluate(){return {model:'fixed',answers:answers({...scores,reading_value:.1})};}}});
    const service=createFeedService({legacyRepository:store,feedRepository:store.repositories.feed,feedFilter:filter,
      sourcePort:{findByProvider:()=>({id:'x'}),persistence:()=>({providerId:'x',sourceAccount:{externalId:'x:home:for-you',displayName:'X',profileUrl:'https://x.com/home',authMode:'browser-session'}}),
        read:async()=>({data:{feed:'for-you',fetchedAt:Date.now(),items:[item],mode:'live'}})}});
    const result=await service.getExternalFeed('x',{feed:'for-you',refresh:true});assert.equal(result.added,1);
    const capture=store.repositories.feed.getCapture('local','x','v3');
    assert.ok(store.repositories.feed.getContentItemByCapture('local',capture.id));
    assert.equal(capture.metadata.filterDecision,'DROP');assert.equal(capture.metadata.wouldIgnore,true);
    assert.equal(capture.metadata.filterVersion,'feed-value-v3.0');
    assert.equal(capture.metadata.enforceQualified,false);
    const enforce=createFeedFilter({config:{mode:'enforce',version:'feed-value-v3.0'},calibration,
      client:{modelId:'fixed',async evaluate(){return {model:'fixed',answers:answers({...scores,reading_value:.1})};}}});
    assert.equal((await enforce.evaluate({item})).createContentItem,true);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('explicit two-of-three enforce applies strict boundaries, all pairs, and keeps missing/technical protection',async()=>{
  const rule='two-of-three-0.60',options={input,rule};
  for(const pair of [[0,1],[0,2],[1,2]]) {
    const s={...scores,reading_value:.1,specific_content:.1,sufficient_information:.1};
    const keys=['reading_value','specific_content','sufficient_information'];
    for(const i of pair)s[keys[i]]=.61;
    assert.equal(decideFeedValue(s,options).decision,'KEEP');
    s[keys[pair[0]]]=.60;
    assert.equal(decideFeedValue(s,options).decision,'DROP');
  }
  assert.equal(decideFeedValue({...scores,reading_value:.60,specific_content:.60,sufficient_information:.60},options).decision,'DROP');
  const truncatedTwo=decideFeedValue(scores,{...options,input:{...input,truncated:true}});
  assert.equal(truncatedTwo.decision,'DROP');
  assert.equal(truncatedTwo.bodyPending,false);
  const keptTruncated=decideFeedValue({...scores,reading_value:.9,specific_content:.9,sufficient_information:.9},{...options,input:{...input,truncated:true}});
  assert.equal(keptTruncated.decision,'KEEP');
  assert.equal(keptTruncated.bodyPending,true);
  assert.equal(decideFeedValue({...scores,missing_context:.60},options).decision,'REVIEW');
  assert.equal(decideFeedValue(scores,{...options,input:{...input,suspectedContinuation:true}}).reason,'context-unconfirmed');
  const e=createFeedValueEvaluator({rule,model:'fixed'});
  assert.equal(e.cacheKey(input),createFeedValueEvaluator({model:'fixed'}).cacheKey(input));
  const filter=createFeedFilter({config:{mode:'enforce',version:'feed-value-v3.0',rule},calibration,
    client:{async evaluate(){return {model:'fixed',answers:answers(scores)};}}});
  const result=await filter.evaluate({item:{body:input.body}});
  assert.equal(result.createContentItem,false);assert.equal(result.status,'ignored');
  assert.equal(result.metadata.filterMode,'enforce');assert.equal(result.metadata.filterRule,rule);
  assert.equal(result.metadata.enforceQualified,false);
  const broken=createFeedFilter({config:{mode:'enforce',version:'feed-value-v3.0',rule},client:{async evaluate(){throw new Error('timeout');}}});
  assert.equal((await broken.evaluate({item:{body:input.body}})).createContentItem,true);
});

test('production replay preserves history, excludes applied DROP, and rejects scores for changed text',()=>{
  const directory=mkdtempSync(path.join(os.tmpdir(),'ai-center-replay-'));
  const store=createStore(path.join(directory,'test.db')),repo=store.repositories.feed;
  try {
    const capture=repo.saveCapture({workspaceId:'local',provider:'x',externalId:'saved',contentHash:'hash',metadata:{originalText:input.body}});
    const item=repo.saveContentItem({workspaceId:'local',captureId:capture.id,originType:'import',contentType:'post',body:input.body});
    const service=createFeedValueReviewService({feedRepository:repo});
    const rows=[{id:`feed:${item.id}`,input,scores,model:'jev-1.13.0',errorReason:''}];
    const result=service.apply(rows);assert.equal(result.DROP,1);
    assert.equal(repo.listContentItemsByProvider('local','x').length,0);
    const keptLow = repo.listContentItemsByProvider('local','x',{includeLowValue:true});
    assert.equal(keptLow.length,1);
    assert.equal(keptLow[0].lowValue,true);
    assert.equal(repo.getContentItem('local',item.id).body,input.body);
    assert.equal(repo.getCapture('local','x','saved').metadata.originalText,input.body);
    const latest=repo.getCapture('local','x','saved');
    repo.saveCapture({...latest,metadata:{...latest.metadata,originalText:'已经更新的正文'}});
    assert.equal(service.apply(rows).changedInput,1);
    const held=repo.getCapture('local','x','saved');
    assert.equal(held.metadata.filterScores,null);
    assert.equal(held.metadata.scoreOrigin,'input-changed-needs-rescore');
    assert.equal(held.metadata.filterDecision,'REVIEW');
    assert.equal(repo.listContentItemsByProvider('local','x').length,0);
    const ignoredButNotApplied={...latest,metadata:{...latest.metadata,filterApplied:false}};
    repo.saveCapture(ignoredButNotApplied);
    assert.equal(repo.listContentItemsByProvider('local','x').length,1);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('all-three requires each score >=0.60, and actual admission blocks DROP, missing context and request failures',async()=>{
  const rule='all-three-0.60',good={...scores,reading_value:.60,specific_content:.60,sufficient_information:.60};
  assert.equal(decideFeedValue(good,{input,rule}).decision,'KEEP');
  for(const key of ['reading_value','specific_content','sufficient_information']) assert.equal(decideFeedValue({...good,[key]:.599},{input,rule}).decision,'DROP');
  const directory=mkdtempSync(path.join(os.tmpdir(),'ai-center-all-three-'));
  const store=createStore(path.join(directory,'test.db')),repo=store.repositories.feed;
  try {
    const filter=createFeedFilter({config:{mode:'enforce',version:'feed-value-v3.0',rule},client:{modelId:'fixed',async evaluate({state}){
      if(state.body==='接口失败')throw new Error('timeout');
      return {model:'fixed',answers:answers(state.body==='不足'?{...good,reading_value:.59}:good)};
    }}});
    const items=[['pass','完整材料',{}],['drop','不足',{}],['missing','正文截断',{truncated:true}],['failure','接口失败',{}]].map(([id,body,captureContext])=>({externalId:id,body,captureContext,sourceUrl:`https://example.org/${id}`}));
    const service=createFeedService({legacyRepository:store,feedRepository:repo,feedFilter:filter,
      sourcePort:{findByProvider:()=>({id:'x'}),persistence:()=>({providerId:'x',sourceAccount:{externalId:'x:all-three',displayName:'X',profileUrl:'https://x.com/home',authMode:'browser-session'}}),
        read:async()=>({data:{feed:'for-you',fetchedAt:Date.now(),items,mode:'live'}})}});
    assert.equal((await service.getExternalFeed('x',{feed:'for-you',refresh:true})).added,2);
    assert.deepEqual(repo.listContentItemsByProvider('local','x').map(i=>i.externalId).sort(),['missing','pass']);
    const pending=repo.getCapture('local','x','missing');
    assert.equal(pending.metadata.filterDecision,'KEEP');
    assert.equal(pending.metadata.bodyCompletion,'pending');
    assert.equal(pending.status,'ready');
    assert.deepEqual(repo.listPendingBodyExternalIds('local','x'),['missing']);
    for(const id of ['drop','failure']) {
      const capture=repo.getCapture('local','x',id);
      assert.ok(capture.metadata.originalText);assert.equal(capture.metadata.filterApplied,true);
      assert.equal(repo.getContentItemByCapture('local',capture.id),null);
      assert.equal(capture.status,id==='drop'?'ignored':'captured');
    }
    const existing=repo.getCapture('local','x','pass');
    const item=repo.getContentItemByCapture('local',existing.id);
    const replay=createFeedValueReviewService({feedRepository:repo});
    replay.apply([{id:`feed:${item.id}`,input:normalizeFeedValueText('完整材料',{capture:{}}),scores:good,model:'jev-1.13.0',errorReason:'jev-failed'}]);
    assert.deepEqual(repo.listContentItemsByProvider('local','x').map((row) => row.externalId), ['missing']);
    assert.equal(repo.getContentItem('local',item.id).body,'完整材料');
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('current pool excludes unscored history, reuses identical five-question scores and removes failed records',async()=>{
  const directory=mkdtempSync(path.join(os.tmpdir(),'ai-center-pool-')),store=createStore(path.join(directory,'test.db'));
  const repo=store.repositories.feed,good={...scores,reading_value:.8,specific_content:.8,sufficient_information:.8};
  try {
    for(const [id,body] of [['cache','缓存通过'],['low','低分内容'],['failed','接口失败']]) {
      const c=repo.saveCapture({workspaceId:'local',provider:'x',externalId:id,contentHash:id,metadata:{originalText:body}});
      repo.saveContentItem({workspaceId:'local',captureId:c.id,originType:'import',contentType:'post',body});
    }
    assert.equal(repo.listContentItemsByProvider('local','x',{qualityRule:'all-three-0.60'}).length,0);
    let calls=0;
    const service=createFeedValueRefreshService({feedRepository:repo,model:'fixed',scoreCache:{policyHash:feedValuePolicyHash(),model:'fixed',rows:[{input:normalizeFeedValueText('缓存通过'),model:'fixed',scores:good}]},
      client:{async evaluate({state}){calls++;if(state.body==='接口失败')throw new Error('timeout');return{model:'fixed',answers:answers({...good,reading_value:.2})};}}});
    const result=await service.refresh({concurrency:2},{runId:'pool-test'});
    assert.equal(result.total,3);assert.equal(result.reused,1);assert.equal(calls,2);
    assert.equal(result.KEEP,1);assert.equal(result.DROP,1);assert.equal(result.REVIEW,1);
    assert.deepEqual(repo.listContentItemsByProvider('local','x',{qualityRule:'all-three-0.60'}).map(r=>r.externalId),['cache']);
    assert.equal(repo.getCapture('local','x','failed').metadata.filterRefreshRunId,'pool-test');
    assert.equal(repo.getCapture('local','x','low').metadata.originalText,'低分内容');
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('strict admission cannot fall back to unpersisted live snapshot when persistence fails',async()=>{
  const directory=mkdtempSync(path.join(os.tmpdir(),'ai-center-no-fallback-')),store=createStore(path.join(directory,'test.db'));
  try {
    const repo={...store.repositories.feed,saveCapture(){throw new Error('storage unavailable');}};
    const filter=createFeedFilter({config:{mode:'enforce',version:'feed-value-v3.0',rule:'all-three-0.60'},client:{async evaluate(){return {model:'fixed',answers:answers({...scores,reading_value:.9,specific_content:.9,sufficient_information:.9})};}}});
    const service=createFeedService({legacyRepository:store,feedRepository:repo,feedFilter:filter,
      sourcePort:{findByProvider:()=>({id:'x'}),persistence:()=>({providerId:'x',sourceAccount:{externalId:'x:fallback',displayName:'X',profileUrl:'https://x.com/home',authMode:'browser-session'}}),
        read:async()=>({data:{feed:'for-you',fetchedAt:Date.now(),mode:'live',items:[{externalId:'raw',body:'未成功入库',sourceUrl:'https://example.org/raw'}]}})}});
    assert.equal((await service.getExternalFeed('x',{feed:'for-you',refresh:true})).items.length,0);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
