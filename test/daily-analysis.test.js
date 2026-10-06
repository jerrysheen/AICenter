import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createStore} from '../packages/database/src/index.js';
import {createReportService} from '../packages/domain/src/report-service.js';
import {createDailyBriefService} from '../packages/domain/src/daily-brief-service.js';
import {createMediaIngestionService} from '../packages/domain/src/media-ingestion-service.js';
import {createMediaConnector} from '../packages/connectors/src/media/port.js';
import {packDailyBatches,validateEvidence,DAILY_STAGE_INSTRUCTIONS,generateDailyAnalysis} from '../packages/domain/src/daily-analysis.js';
import {SaveDailyTrackingQuestionsSchema,DailyMaterialSchema} from '../packages/contracts/src/report.js';
import {createRuntimeService} from '../packages/domain/src/runtime-service.js';
import {createReportRoutes} from '../apps/web/src/routes/report-routes.js';

const at=Date.parse('2026-10-04T00:00:00Z');
function fixture() {
  const dir=mkdtempSync(path.join(os.tmpdir(),'daily-v2-')),store=createStore(path.join(dir,'test.db'));
  const media=createMediaIngestionService({mediaRepository:store.repositories.media,feedRepository:store.repositories.feed,
    mediaPort:createMediaConnector({sources:[]}),now:()=>at});
  const report=createReportService({reportRepository:store.repositories.report,feedService:store.repositories.feed,mediaPort:media,
    tradingService:{getBoard:async()=>({mode:'live',fetchedAt:at+1000,indices:[],watchlist:[{symbol:'US10Y',name:'美债利率',lastPrice:4.1,asOf:at-1000,currency:'USD',unit:'percent'}],groups:['利率'],note:'利率快照'})},
    staticSignalPort:{readBoard:async()=>({releases:[],upcoming:[],sourceHealth:[]})},now:()=>at+2000});
  return {store,report,media,close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
function social(f,count=230) {
  const repo=f.store.repositories.feed;
  const source=repo.upsertSourceAccount({workspaceId:'local',provider:'x',externalId:'home',displayName:'X',authMode:'public'});
  for(let i=0;i<count;i++) {
    const capture=repo.saveCapture({workspaceId:'local',provider:'x',externalId:String(i),sourceAccountId:source.id,title:`post${i}`,contentHash:String(i),publishedAt:at-86400000+i*1000,capturedAt:at-500});
    repo.saveContentItem({workspaceId:'local',captureId:capture.id,originType:'subscription',contentType:'article',title:`post${i}`,body:`讨论 ${i}。\n\n${i===count-1 ? '后半段重要信息' : '实际体验'}\n\n评论：不同作者的意见`,publishedAt:at-86400000+i*1000,sourceUrl:`https://example.com/posts/${i}`});
  }
}
function seedMedia(f,id='tech:late',channel='tech',full=true) {
  const r=f.store.repositories.media;
  const entry={workspaceId:'local',externalId:id,sourceKey:id.split(':')[0],publisherKey:'publisher',publisherName:'新闻社',authorName:'作者',channel,
    canonicalUrl:`https://example.com/${id}`,title:'X没有提到的新闻',summary:'摘要说需求强劲',publishedAt:at-1000,publishedAtRaw:'',contentLevel:full ? 'full' : 'summary_only',contentHash:'index',revision:1,status:'indexed',observedAt:at-900,createdAt:at-900,updatedAt:at-900,
    bodyHash:full ? 'saved-hash' : '',fetchState:{fetchStatus:full ? 'ready' : 'failed',httpStatus:200,extractionReason:full ? '' : 'source_unavailable',attemptCount:1,failureCount:full ? 0 : 1,lastAttemptAt:at-900,nextRetryAt:null,responseBytes:100,extractedBytes:100,paragraphCount:2,extractionMethod:'dom',extractorVersion:f.media.catalog ? 'test' : '',fetchedRevision:1,etag:'',lastModified:'',finalUrl:'https://example.com/',author:'作者',publishedAtRaw:'',updatedAtRaw:'',selectedReason:'',visualEvidenceRequired:false}};
  r.upsertEntry(entry);r.saveFetchState('local',id,entry.fetchState);
  if(full) {
    // Use the actual current extractor version without fetching, translating, tagging or generating a brief.
    const port=createMediaConnector({sources:[]});
    const row=r.getEntries('local',[id])[0];r.saveFetchState('local',id,{...row.fetchState,extractorVersion:port.extractorVersion});
    r.saveSnapshot({workspaceId:'local',externalId:id,revision:1,bodyHash:'saved-hash',bodyText:'第一段。\n\n最后一段：交付推迟，与社交乐观说法相反。',contentLevel:'full',truncated:false,observedAt:at-900,
      article:{extractorVersion:port.extractorVersion,paragraphs:[{id:'p0001',kind:'paragraph',text:'第一段。'},{id:'p0002',kind:'paragraph',text:'最后一段：交付推迟，与社交乐观说法相反。'}]}});
  }
}
function runtime(seen,fail={}) {
  return {run:async input=>{
    const p=JSON.parse(input.message);seen.push(p);
    if(fail.stage===p.stage && !fail.done) {fail.done=true;throw new Error('模拟第三轮失败');}
    if(['social','news'].includes(p.stage)) return {answer:JSON.stringify({analysis:p.stage==='news' ? '独立新闻发现交付推迟，与社交观点冲突。' : '社交中有人乐观，仅代表该样本，重复转述不算独立确认。',
      evidence:p.materials.slice(-2).map(m=>({materialId:m.id,paragraphId:m.paragraphs[0].id})),questions:['实际交付是否完成？']})};
    if(p.stage==='tracking') return {answer:JSON.stringify({updates:p.tracking.map(t=>({questionId:t.question.id,status:'challenged',judgment:'交付延后挑战原有假设。',nextCheck:'核对实际交付披露',evidence:[{materialId:p.evidenceMaterials[0].id,paragraphId:p.evidenceMaterials[0].paragraphs[0].id}]}))})};
    return {answer:JSON.stringify({overview:'新闻与社交观点存在冲突。',sections:[{title:'从讨论到交付证据',body:'社交提出乐观解释，新闻末段披露交付推迟，仍需要继续验证。',evidence:p.evidenceMaterials.slice(0,2).map(m=>({materialId:m.id,paragraphId:m.paragraphs[0].id}))}],nextWatch:'实际交付',limitations:'封闭材料；不能宣称独立外部核验。'})};
  }};
}

test('source pagination reads beyond 200 with independent media indexes and full final paragraph without enrichment',async()=>{
  const f=fixture();try {
    social(f);seedMedia(f);seedMedia(f,'macro:one','macro',false);
    const report=await f.report.generateDailyReport({reportDate:'2026-10-04'});
    assert.equal(report.content.materials.filter(m=>m.kind==='social').length,230);
    assert.ok(report.content.materials.some(m=>m.title==='post229'));
    const media=report.content.materials.find(m=>m.id==='media:tech:late');
    assert.equal(media.contentLevel,'full');assert.match(media.paragraphs.at(-1).text,/交付推迟/);
    assert.equal(media.author,'作者');assert.equal(media.publisher,'新闻社');
    assert.equal(report.content.coverage.find(c=>c.sourceId==='tech').available,1);
    assert.equal(report.content.market.global.observations[0].symbol,'US10Y');
    assert.equal(report.content.market.global.asOf,at-1000);
    assert.equal(report.content.tracking.length,0);
    const batches=packDailyBatches(report.content.materials,10000);
    assert.ok(batches.flat().some(m=>m.paragraphs.some(p=>p.text.includes('交付推迟'))));
    assert.ok(batches.flat().every(m=>m.paragraphCount>=m.paragraphs.length));
    assert.ok(report.content.materials.some(m=>m.paragraphs.some(p=>p.role==='comment')));
  }finally{f.close();}
});

test('four rounds save evidence, resume third-round failure, preserve old versions and rewrite only editorial',async()=>{
  const f=fixture(),seen=[];try {
    social(f,4);seedMedia(f);
    f.report.saveTrackingQuestions('local',{questions:[{id:'delivery',question:'需求是否变成实际交付？',enabled:true,baseline:'交付向好',pending:'交付口径'}]});
    const report=await f.report.generateDailyReport({reportDate:'2026-10-04',requestKey:'same-job'});
    assert.equal((await f.report.generateDailyReport({reportDate:'2026-10-04',requestKey:'same-job'})).updatedAt,report.updatedAt);
    const service=createDailyBriefService({reportRepository:f.store.repositories.report,agentRuntime:runtime(seen,{stage:'tracking'}),now:()=>at+5000});
    await assert.rejects(()=>service.generateDailyBrief({reportId:report.id}),/模拟第三轮失败/);
    assert.deepEqual(seen.map(p=>p.stage),['social','news','tracking']);
    assert.equal(f.report.getLatestDailyBrief('local'),null);
    const brief=await service.generateDailyBrief({reportId:report.id});
    assert.deepEqual(seen.map(p=>p.stage),['social','news','tracking','tracking','editorial']);
    assert.equal(brief.schemaVersion,2);assert.equal(brief.trackingUpdates[0].status,'challenged');
    assert.ok(brief.sections[0].evidence.length);assert.ok(brief.coverage.every(c=>c.read===c.available));
    const m=brief.sections[0].evidence[0];const evidence=f.report.getDailyEvidence('local',brief.reportDate,brief.generatedAt,m.materialId,m.paragraphId);
    assert.ok(evidence.paragraph.text);assert.equal(evidence.material.hash.length,64);
    const newer=await service.generateDailyBrief({reportId:report.id,mode:'rewrite',requestKey:'rewrite-1'});
    assert.deepEqual(seen.map(p=>p.stage),['social','news','tracking','tracking','editorial','editorial']);
    assert.ok(newer.generatedAt>brief.generatedAt);assert.equal(newer.materialVersion,brief.materialVersion);
    const old=f.report.getDailyBriefItemReference('local',{resourceType:'daily-brief-item',resourceId:`${brief.reportDate}/${brief.items[0].candidateId}`,revision:brief.generatedAt});
    assert.equal(old.generatedAt,brief.generatedAt);assert.ok(old.body);assert.ok(old.evidence.length);
    const next=await f.report.generateDailyReport({reportDate:'2026-10-05'});
    assert.equal(next.content.tracking[0].previousDate,'2026-10-04');
    assert.ok(next.content.tracking[0].previousEvidence[0].excerpt);
  }finally{f.close();}
});

test('hidden media is excluded while late captures stay marked and window-end publications stay outside',async()=>{
  const f=fixture();try {
    seedMedia(f,'tech:hidden');seedMedia(f,'tech:visible');seedMedia(f,'tech:future');
    f.store.repositories.feed.upsertIdentityFingerprint({workspaceId:'local',provider:'media',externalId:'tech:hidden',identityHash:'hidden',hiddenAt:at});
    const future=f.store.repositories.media.getEntries('local',['tech:future'])[0];
    f.store.repositories.media.upsertEntry({...future,publishedAt:at});
    const visible=f.store.repositories.media.getEntries('local',['tech:visible'])[0];
    f.store.repositories.media.upsertEntry({...visible,bodyHash:'later-hash'});
    f.store.repositories.media.saveSnapshot({workspaceId:'local',externalId:visible.externalId,revision:2,bodyHash:'later-hash',bodyText:'补充正文',contentLevel:'full',truncated:false,observedAt:at+1000,
      article:{extractorVersion:createMediaConnector({sources:[]}).extractorVersion,paragraphs:[{id:'p0001',kind:'paragraph',text:'补充正文'}]}});
    const report=await f.report.generateDailyReport({reportDate:'2026-10-04'});
    assert.equal(report.content.coverage.find(c=>c.sourceId==='tech').available,1);
    assert.ok(!report.content.materials.some(m=>['media:tech:hidden','media:tech:future'].includes(m.id)));
    const material=report.content.materials.find(m=>m.id==='media:tech:visible');
    assert.equal(material.late,true);assert.equal(material.obtainedAt,at+1000);
  }finally{f.close();}
});

test('hard stage deadline stops an unresponsive runtime and preserves the completed valid brief',async()=>{
  const f=fixture();try {
    social(f,1);const report=await f.report.generateDailyReport({reportDate:'2026-10-04'});
    const previous=await createDailyBriefService({reportRepository:f.store.repositories.report,agentRuntime:runtime([])}).generateDailyBrief({reportId:report.id});
    let signal;
    const never={run:input=>{signal=input.signal;return new Promise(()=>{});}};
    await assert.rejects(()=>generateDailyAnalysis({reportRepository:f.store.repositories.report,report,agentRuntime:never,budget:{timeoutMs:20},input:{mode:'rewrite',requestKey:'never'}}),/超时/);
    assert.equal(signal.aborted,true);
    assert.equal(f.report.getLatestDailyBrief('local').generatedAt,previous.generatedAt);
    assert.equal(f.report.getAnalysisStatus('local',report.reportDate).status,'failed');
  }finally{f.close();}
});

test('upgrading a legacy brief archives the original reference revision',async()=>{
  const f=fixture();try {
    social(f,1);const report=await f.report.generateDailyReport({reportDate:'2026-10-04'});
    const legacy={id:'legacy',reportId:report.id,reportDate:report.reportDate,generatedAt:at,overview:'原来的日报',items:[{candidateId:'old:one',type:'news',headline:'原判断',whyItMatters:'原依据',watchNext:'原验证点',occurredAt:at-1,sourceRefs:[]}],providerId:'',modelId:'',sourceReportUpdatedAt:report.updatedAt};
    f.store.repositories.report.upsertDailyBrief({workspaceId:'local',reportId:report.id,reportDate:report.reportDate,status:'ready',sourceReportUpdatedAt:report.updatedAt,inputHash:'old',inputSnapshot:{candidates:[]},brief:legacy});
    await createDailyBriefService({reportRepository:f.store.repositories.report,agentRuntime:runtime([])}).generateDailyBrief({reportId:report.id});
    const ref=f.report.getDailyBriefItemReference('local',{resourceType:'daily-brief-item',resourceId:`${report.reportDate}/old:one`,revision:at});
    assert.equal(ref.item.headline,'原判断');assert.equal(ref.generatedAt,at);
  }finally{f.close();}
});

test('failed editorial resumes cached reading, uses its own deadline and renews the run lease',async()=>{
  const f=fixture(),seen=[];try {
    social(f,1);seedMedia(f);
    const report=await f.report.generateDailyReport({reportDate:'2026-10-04'});
    await assert.rejects(()=>createDailyBriefService({reportRepository:f.store.repositories.report,
      agentRuntime:runtime(seen,{stage:'editorial'})}).generateDailyBrief({reportId:report.id}),/模拟第三轮失败/);
    const before=seen.length,repo=f.store.repositories.report;
    let renewals=0;
    const renew=repo.renewAnalysisRun.bind(repo);
    repo.renewAnalysisRun=(...args)=>{renewals++;return renew(...args);};
    const fake=runtime(seen);
    const service=createDailyBriefService({reportRepository:repo,analysisBudget:{timeoutMs:20,editorialTimeoutMs:500,heartbeatMs:10},
      agentRuntime:{run:async input=>{
        assert.equal(JSON.parse(input.message).stage,'editorial');assert.equal(input.timeoutMs,500);
        await new Promise(resolve=>setTimeout(resolve,70));return fake.run(input);
      }}});
    const brief=await service.generateDailyBrief({reportId:report.id});
    assert.deepEqual(seen.slice(before).map(p=>p.stage),['editorial']);assert.ok(renewals>=4);
    assert.equal(brief.schemaVersion,2);assert.equal(f.report.getAnalysisStatus('local',report.reportDate).status,'completed');
    assert.ok(brief.sections[0].evidence.length);assert.ok(brief.coverage.length);
  }finally{f.close();}
});

test('reading deadline leaves independent news and editorial time and publishes honest partial coverage',async()=>{
  const f=fixture(),seen=[];try {
    social(f,100);seedMedia(f);const report=await f.report.generateDailyReport({reportDate:'2026-10-04'});
    const fake=runtime(seen);
    const slow={run:async input=>{const p=JSON.parse(input.message);if(p.stage==='social') await new Promise(r=>setTimeout(r,90));return fake.run(input);}};
    const brief=await createDailyBriefService({reportRepository:f.store.repositories.report,agentRuntime:slow,
      analysisBudget:{totalMs:400,timeoutMs:200,batchBytes:7000,socialBatches:10,newsBatches:2}}).generateDailyBrief({reportId:report.id});
    assert.equal(seen.filter(p=>p.stage==='social').length,1);
    assert.ok(seen.some(p=>p.stage==='news'));assert.equal(seen.at(-1).stage,'editorial');
    assert.ok(brief.coverage.find(c=>c.group==='social').unread>0);
    assert.ok(seen.at(-1).warnings.some(w=>w.includes('社交阅读达到')));
  }finally{f.close();}
});

test('unsolicited model commentary is dropped without inventing tracking or relaxing evidence validation',async()=>{
  const f=fixture();try {
    social(f,1);const report=await f.report.generateDailyReport({reportDate:'2026-10-04'});
    const base=runtime([]);const extra={run:async input=>{const result=await base.run(input);return {...result,answer:JSON.stringify({...JSON.parse(result.answer),judgment:'不应成为追踪判断',call_tool:'不执行'})};}};
    const brief=await createDailyBriefService({reportRepository:f.store.repositories.report,agentRuntime:extra}).generateDailyBrief({reportId:report.id});
    assert.deepEqual(brief.trackingUpdates,[]);assert.ok(!('judgment' in brief));
    assert.ok(brief.sections[0].evidence.length);
  }finally{f.close();}
});

test('unknown evidence is rejected; per-source omissions and model unread counts stay explicit',async()=>{
  const f=fixture(),seen=[];try {
    social(f,220);seedMedia(f);
    const report=await f.report.generateDailyReport({reportDate:'2026-10-04',newsLimit:210});
    assert.equal(report.content.coverage.find(c=>c.group==='social').omitted,10);
    assert.throws(()=>validateEvidence([{materialId:'invented',paragraphId:'p1'}],report.content.materials),/已读原文/);
    const service=createDailyBriefService({reportRepository:f.store.repositories.report,agentRuntime:runtime(seen),analysisBudget:{batchBytes:7000,socialBatches:1,newsBatches:2}});
    const brief=await service.generateDailyBrief({reportId:report.id});
    assert.ok(brief.coverage.find(c=>c.group==='social').unread>0);
    const socialInput=seen.find(p=>p.stage==='social');
    assert.ok(socialInput.materials.some(m=>Number(m.title.replace('post',''))>=110),'bounded reading includes later source time slots');
    assert.equal(brief.coverage.find(c=>c.group==='tech').read,1);
    assert.equal(seen.some(p=>p.stage==='tracking'),false);
  }finally{f.close();}
});

test('question configuration is explicit and invalid duplicates fail; concurrent matching jobs deduplicate',()=>{
  const f=fixture();try {
    assert.equal(SaveDailyTrackingQuestionsSchema.safeParse({questions:[{id:'one',question:'?',enabled:true},{id:'one',question:'?',enabled:true}]}).success,false);
    const runtime=createRuntimeService({runtimeRepository:f.store,dailyConfig:{timezone:'Asia/Shanghai',cutoffHour:8,cutoffMinute:0}});
    const first=runtime.requestDailyReport({reportDate:'2026-10-04'});
    assert.equal(runtime.requestDailyReport({reportDate:'2026-10-04'}).id,first.id);
    f.store.repositories.report.acquireAnalysisRun('local','key','2026-10-04',{report:{content:{frozenAt:at}}},'owner',Date.now());
    assert.throws(()=>f.store.repositories.report.acquireAnalysisRun('local','key','2026-10-04',{},'other',Date.now()),/正在生成/);
    assert.equal(DailyMaterialSchema.safeParse({id:'x'}).success,false);
  }finally{f.close();}
});

test('regeneration request separates refresh from rewrite; UI binds the selected date and evidence',async()=>{
  const route=createReportRoutes().find(r=>r.path==='/api/v1/reports/daily/brief/generate');
  const calls=[];const response={writeHead(){},end(){}};
  const services={report:{getDailyReport:()=>({id:'day'})},runtime:{requestDailyReport:i=>{calls.push(['refresh',i]);return {};},requestDailyBrief:i=>{calls.push(['rewrite',i]);return {};}}};
  for(const mode of ['refresh','rewrite']) await route.handler({request:{async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify({date:'2026-10-03',mode}));}},response,services});
  assert.deepEqual(calls,[['refresh',{reportDate:'2026-10-03'}],['rewrite',{reportId:'day',mode:'rewrite'}]]);
  const app=readFileSync(new URL('../apps/web/public/app.js',import.meta.url),'utf8');
  assert.match(app,/JSON.stringify\(\{date,mode\}\)/);assert.match(app,/原文证据/);assert.match(app,/完整读取/);
  assert.match(DAILY_STAGE_INSTRUCTIONS.news,/不能只沿社交观点找证明/);
});
