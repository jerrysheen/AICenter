import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {createStore} from '../packages/database/src/index.js';
import {createReportService} from '../packages/domain/src/report-service.js';
import {createContextService} from '../packages/domain/src/context-service.js';
import {createInformationDigestService,assembleInformationEditorial,assembleBriefEditorial,isCurrentBriefEditorial,BRIEF_EDITORIAL_VERSION,HOUR_MS} from '../packages/domain/src/information-digest-service.js';
import {createDailyBriefService} from '../packages/domain/src/daily-brief-service.js';
import {createRuntimeService} from '../packages/domain/src/runtime-service.js';
import {createReportRoutes} from '../apps/web/src/routes/report-routes.js';
import {createRouter} from '../apps/web/src/http/router.js';
import {ensureHourlyDigestSchedule,createReportJobHandlers,REPORT_HOURLY_JOB_TYPE} from '../packages/runtime/src/report-module.js';
import {createScheduler} from '../packages/runtime/src/scheduler.js';
import {createLocalToolRegistry} from '../packages/runtime/src/local-tools.js';
import {DailyAnalysisOutputSchema,InformationSearchInputSchema,GenerateHourlyDigestInputSchema} from '../packages/contracts/src/report.js';

const hour=Date.parse('2026-10-04T21:00:00Z');
function directionOutput(items,text) {
  return {key:'tech',label:'科技与产业',articleTitle:'试验方法与交付范围',lead:{text:items[0].sentence,itemIds:[items[0].id]},
    sections:text ? [{heading:'新功能范围与交付',paragraphs:[{text,itemIds:items.map(i=>i.id)}]}] :
      Array.from({length:Math.ceil(items.length/8)},(_,n)=>({heading:`关键进展 ${n+1}`,paragraphs:items.slice(n*8,n*8+8).map(i=>({text:i.sentence,itemIds:[i.id]}))}))};
}
function editorialOutput(items) {return {overview:items[0].sentence.slice(0,500),overviewItemIds:[items[0].id],directions:[directionOutput(items)]};}
test('reading editorial merges cross-source themes, leaves omissions in the raw pool and rejects invented or repeated IDs',async()=>{
  const f=fixture();try {
    f.add('release','厂商计划下季度量产。');f.add('scope','目前仅部分测试用户开放，尚未披露交付。');f.add('unused','作者自报试验耗时55分钟。');
    const base=f.agentRuntime.run;
    f.agentRuntime.run=async input=>{
      const p=JSON.parse(input.message);
      if(p.stage!=='hourly-editorial') return base(input);
      assert.equal(input.closedTask,'hourly-brief');assert.equal(input.sessionId,undefined);assert.match(p.items[0].id,/^i[0-9]+$/);assert.match(p.items[0].sourceIds[0],/^s[0-9]+$/);
      const ids=p.items.slice(0,2).map(i=>i.id);
      return {answer:JSON.stringify({overview:'新功能仅部分开放，量产仍是计划。',overviewItemIds:ids,
        directions:[directionOutput(p.items.slice(0,2),'厂商计划下季度量产，目前仅部分测试用户开放，尚未披露交付。')]})};
    };
    const [d]=await f.info.generateHourlyDigests({hourStart:hour});
    assert.equal(d.items.length,3);assert.equal(d.editorial.status,'ready');
    const theme=d.editorial.directions[0].sections[0].paragraphs[0];assert.equal(theme.evidence.length,2);assert.ok(theme.itemIds.every(id=>d.items.some(i=>i.id===id)));assert.ok(theme.itemIds.every(id=>!/^i[0-9]+$/.test(id)));
    assert.equal(theme.text.includes('55分钟'),false);
    assert.equal(f.report.searchInformation('local',{startAt:hour,endAt:hour+HOUR_MS,query:'55分钟'}).items.length,1);
    for(const e of theme.evidence) assert.ok(f.report.getInformationEvidence('local',e));
    const invalid=editorialOutput([{id:'invented',sentence:'杜撰事实'}]);assert.throws(()=>assembleBriefEditorial(d.items,invalid),/未知/);
    const duplicate=editorialOutput(d.items);duplicate.directions[0].sections[0].paragraphs[0].itemIds.push(duplicate.directions[0].sections[0].paragraphs[0].itemIds[0]);assert.throws(()=>assembleBriefEditorial(d.items,duplicate),/重复/);
    assert.throws(()=>assembleBriefEditorial(d.items,{overview:'无依据概括',overviewItemIds:[],directions:[]}),/依据/);
  }finally{f.close();}
});

test('hourly editorial failure preserves ready publication, draft search and frozen evidence, then retries without rereading',async()=>{
  const f=fixture();try {
    f.add('one','新功能仅测试开放。');const [first]=await f.info.generateHourlyDigests({hourStart:hour});
    const base=f.agentRuntime.run;let fail=true;
    f.agentRuntime.run=async input=>{if(JSON.parse(input.message).stage==='hourly-editorial' && fail) throw Error('编辑断线');return base(input);};
    f.add('new','新增事项，厂商预计下季度交付。');
    const [draft]=await f.info.generateHourlyDigests({hourStart:hour});
    assert.equal(draft.editorial.status,'failed');assert.equal(draft.items.length,2);
    assert.equal(f.report.getHourlyDigest('local',hour).id,first.id);
    assert.equal(f.report.getHourlyDigestIndex('local',{startAt:hour,endAt:hour+HOUR_MS}).hours[0].status,'failed');
    assert.equal(f.report.searchInformation('local',{startAt:hour,endAt:hour+HOUR_MS,query:'新增事项'}).items.length,1);
    for(const e of draft.items.flatMap(i=>i.evidence)) assert.ok(f.report.getInformationEvidence('local',e));
    const reads=f.calls.filter(p=>p.stage==='information-extract').length;fail=false;
    const [ready]=await f.info.generateHourlyDigests({hourStart:hour});assert.equal(ready.editorial.status,'ready');
    assert.equal(f.calls.filter(p=>p.stage==='information-extract').length,reads);
  }finally{f.close();}
});

test('registered hourly jobs report editorial failure while preserving the draft and resume only the failed editor',async()=>{
  const f=fixture();try {
    f.add('one','厂商计划交付，尚未实际交付。');const base=f.agentRuntime.run;let fail=true;
    f.agentRuntime.run=async input=>{if(JSON.parse(input.message).stage==='hourly-editorial' && fail) throw Error('编辑断线');return base(input);};
    const handler=createReportJobHandlers({reportService:f.report,informationService:f.info})[REPORT_HOURLY_JOB_TYPE];
    await assert.rejects(()=>handler({hourStart:hour}),/主题整理未完成/);
    const draft=f.report.getHourlyDigest('local',hour);assert.equal(draft.editorial.status,'failed');assert.equal(draft.items.length,1);
    assert.ok(f.report.getInformationEvidence('local',draft.items[0].evidence[0]));
    const reads=f.calls.filter(p=>p.stage==='information-extract').length;fail=false;
    assert.ok((await handler({hourStart:hour})).snapshotIds.length);
    assert.equal(f.report.getHourlyDigest('local',hour).editorial.status,'ready');
    assert.equal(f.calls.filter(p=>p.stage==='information-extract').length,reads);
  }finally{f.close();}
});

test('legacy hourly raw snapshots upgrade to an immutable reading version without rereading or changing references',async()=>{
  const f=fixture();try {
    f.add('one','作者自报，尚未独立验证。');const [saved]=await f.info.generateHourlyDigests({hourStart:hour});
    const db=new Database(f.dbPath);try {db.prepare("UPDATE hourly_information_snapshots SET digest_json=json_remove(digest_json,'$.editorial') WHERE id=?").run(saved.id);}finally{db.close();}
    const reads=f.calls.filter(p=>p.stage==='information-extract').length;
    const [ready]=await f.info.generateHourlyDigests({hourStart:hour});
    assert.notEqual(ready.id,saved.id);assert.equal(ready.editorial.status,'ready');assert.deepEqual(ready.items,saved.items);
    assert.equal(f.calls.filter(p=>p.stage==='information-extract').length,reads);
    assert.ok(f.report.getInformationEvidence('local',saved.items[0].evidence[0]));
  }finally{f.close();}
});

test('stale scheduled occurrences process the newest ended hour before at most one recent missing hour',async()=>{
  const f=fixture();try {
    f.add('old','已完成提炼的旧时段。');const [saved]=await f.info.generateHourlyDigests({hourStart:hour});
    const db=new Database(f.dbPath);try {
      db.prepare("UPDATE hourly_information_snapshots SET digest_json=json_remove(digest_json,'$.editorial') WHERE id=?").run(saved.id);
      db.prepare("DELETE FROM daily_analysis_stages WHERE stage_key='hourly-editorial'").run();
    }finally{db.close();}
    f.add('new','较新时段尚未提炼的材料。',hour+HOUR_MS+1000);
    f.add('latest','最新已结束小时的材料。',hour+2*HOUR_MS+1000);f.calls.length=0;
    const result=await f.info.generateHourlyDigests({scheduledFor:hour+HOUR_MS});
    assert.equal(result.length,2);assert.equal(result[0].window.startAt,hour+2*HOUR_MS);
    assert.equal(f.calls[0].stage,'information-extract');assert.equal(f.calls[0].window.startAt,hour+2*HOUR_MS);
    assert.equal(f.report.getHourlyDigest('local',hour).editorial,undefined);
    assert.ok(f.calls.some(p=>p.stage==='information-extract' && p.window.startAt===hour+HOUR_MS));
  }finally{f.close();}
});
function fixture({runtime,budget={}}={}) {
  const dir=mkdtempSync(path.join(os.tmpdir(),'information-digest-')),dbPath=path.join(dir,'test.db');
  let store=createStore(dbPath),rows=[],calls=[];
  const feed={
    listWindowSources(_workspace,w) {return [{sourceId:'x',sourceName:'X',provider:'x',available:rows.filter(r=>r.eventAt>=w.startAt && r.eventAt<w.endAt).length}];},
    listContentItemsInWindow(_workspace,w) {return rows.filter(r=>r.eventAt>=w.startAt && r.eventAt<w.endAt && (!w.cursor || r.eventAt>w.cursor.eventAt || (r.eventAt===w.cursor.eventAt && r.id>w.cursor.id))).slice(0,w.limit);},
  };
  const agentRuntime=runtime || {run:async input=>{
    assert.equal(input.closedContext,true);assert.equal(input.webMode,'off');
    const p=JSON.parse(input.message);calls.push(p);
    if(p.stage==='information-extract') return {answer:JSON.stringify({items:p.materials.flatMap(m=>m.paragraphs.map(para=>({sentence:para.text.slice(0,300),evidence:[{materialId:m.id,paragraphId:para.id}]})))})};
    if(['hourly-editorial','daily-editorial'].includes(p.stage)) return {answer:JSON.stringify(editorialOutput(p.items))};
    return {answer:JSON.stringify({items:p.items.map(i=>({sentence:i.sentence,itemIds:[i.id]}))})};
  }};
  const report=createReportService({reportRepository:store.repositories.report,feedService:feed,
    tradingService:{getBoard:async()=>({mode:'live',indices:[]})},staticSignalPort:{readBoard:async()=>({releases:[],upcoming:[]})},now:()=>hour+3*HOUR_MS});
  const info=createInformationDigestService({reportRepository:store.repositories.report,feedService:feed,agentRuntime,now:()=>hour+3*HOUR_MS,budget});
  return {get store(){return store;},dir,dbPath,rows,calls,report,info,agentRuntime,feed,
    add(id,text,at=hour+1000,version=1) {rows.push({id,sourceId:'x',title:id,body:text,eventAt:at,publishedAt:at,createdAt:hour+HOUR_MS,updatedAt:hour+HOUR_MS+version,capturedAt:hour+HOUR_MS,sourceUrl:`https://example.com/${id}`});},
    close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('background editor failure preserves its draft, does not fail the newest-hour job and cools down',async()=>{
  const f=fixture();try {
    f.add('latest','本小时最新信息。',hour+2*HOUR_MS+1000);
    f.add('old','前一小时仍可复用的底稿。',hour+HOUR_MS+1000);
    const base=f.agentRuntime.run,priorities=[];
    f.agentRuntime.run=async input=>{
      const p=JSON.parse(input.message);priorities.push({priority:input.executionPriority,at:p.window?.startAt,stage:p.stage});
      if(p.stage==='hourly-editorial' && p.window.startAt===hour+HOUR_MS) throw Error('旧稿编辑失败');
      return base(input);
    };
    const handler=createReportJobHandlers({reportService:f.report,informationService:f.info})[REPORT_HOURLY_JOB_TYPE];
    const first=await handler({scheduledFor:hour+HOUR_MS});
    assert.equal(first.backgroundIncomplete.length,1);
    assert.equal(f.report.getHourlyDigest('local',hour+2*HOUR_MS).editorial.status,'ready');
    const failed=f.report.getHourlyDigestIndex('local',{startAt:hour+HOUR_MS,endAt:hour+2*HOUR_MS}).hours[0];
    assert.equal(failed.phase,'failed');assert.equal(failed.failureStage,'editing');assert.equal(failed.readable,false);assert.equal(failed.draftItemCount,1);
    assert.ok(failed.queueMs>=0 && failed.executionMs>=0);
    assert.ok(priorities.some(p=>p.priority===10 && p.at===hour+2*HOUR_MS));
    assert.ok(priorities.some(p=>p.priority===-10 && p.at===hour+HOUR_MS));
    const oldCalls=priorities.filter(p=>p.at===hour+HOUR_MS).length;
    await handler({scheduledFor:hour+HOUR_MS});
    assert.equal(priorities.filter(p=>p.at===hour+HOUR_MS).length,oldCalls);
    const reads=f.calls.filter(p=>p.stage==='information-extract' && p.window.startAt===hour+HOUR_MS).length;
    f.agentRuntime.run=base;
    await f.info.generateHourlyDigests({hourStart:hour+HOUR_MS});
    assert.equal(f.report.getHourlyDigest('local',hour+HOUR_MS).editorial.status,'ready');
    assert.equal(f.calls.filter(p=>p.stage==='information-extract' && p.window.startAt===hour+HOUR_MS).length,reads);
  }finally{f.close();}
});

test('hourly index distinguishes waiting admission, executing editor and queue failure without leaking errors',async()=>{
  const f=fixture({budget:{queueTimeoutMs:60,totalMs:1000,timeoutMs:100}});try {
    f.add('one','冻结底稿。');const base=f.agentRuntime.run;
    f.agentRuntime.supportsExecutionAdmission=true;
    let queued;
    const waiting=new Promise(resolve=>queued=resolve);
    f.agentRuntime.run=async input=>{
      if(JSON.parse(input.message).stage==='hourly-editorial') {
        queued();return new Promise((_,reject)=>input.signal.addEventListener('abort',()=>reject(input.signal.reason),{once:true}));
      }
      input.onExecutionStart();return base(input);
    };
    const run=f.info.generateHourlyDigests({hourStart:hour});await waiting;
    const during=f.report.getHourlyDigestIndex('local',{startAt:hour,endAt:hour+HOUR_MS}).hours[0];
    assert.equal(during.phase,'queued-editing');assert.equal(during.readable,false);
    const [draft]=await run;assert.equal(draft.items.length,1);
    const after=f.report.getHourlyDigestIndex('local',{startAt:hour,endAt:hour+HOUR_MS}).hours[0];
    assert.equal(after.failureReason,'queue-timeout');assert.ok(after.queueMs>=50);assert.equal(after.executionMs,0);
    assert.equal(JSON.stringify(after).includes('Elucid'),false);assert.equal('error' in after,false);
    f.agentRuntime.run=async input=>{input.onExecutionStart();return base(input);};
    const reads=f.calls.filter(p=>p.stage==='information-extract').length;
    await f.info.generateHourlyDigests({hourStart:hour});
    assert.equal(f.calls.filter(p=>p.stage==='information-extract').length,reads);
    assert.equal(f.report.getHourlyDigestIndex('local',{startAt:hour,endAt:hour+HOUR_MS}).hours[0].readable,true);
    const index=f.report.getHourlyDigestIndex('local',{startAt:hour,endAt:hour+5*HOUR_MS});
    assert.deepEqual(index.hours.map(h=>h.hourStart),[hour+2*HOUR_MS,hour+HOUR_MS,hour]);
    assert.equal(index.hours[0].phase,'not-started');
  }finally{f.close();}
});

test('contracts require per-information evidence, valid time bounds and fixed job inputs',()=>{
  assert.ok(DailyAnalysisOutputSchema.safeParse({items:[{sentence:'作者预计下季度量产。',evidence:[{materialId:'a',paragraphId:'p1'}]}]}).success);
  assert.equal(DailyAnalysisOutputSchema.safeParse({items:[{sentence:'已量产',evidence:[]}]}).success,false);
  assert.equal(DailyAnalysisOutputSchema.safeParse({analysis:'旧分析',evidence:[],questions:[]}).success,false);
  assert.equal(InformationSearchInputSchema.safeParse({startAt:hour,endAt:hour}).success,false);
  assert.equal(GenerateHourlyDigestInputSchema.safeParse({hourStart:hour+1}).success,false);
  assert.equal(GenerateHourlyDigestInputSchema.safeParse({hourStart:hour,followUp:'classification-deferred'}).success,true);
  assert.equal(GenerateHourlyDigestInputSchema.safeParse({hourStart:hour,followUp:'edition-pending'}).success,true);
  assert.equal(GenerateHourlyDigestInputSchema.safeParse({hourStart:hour,followUp:'edition-pending-sweep'}).success,true);
  assert.equal(GenerateHourlyDigestInputSchema.safeParse({hourStart:hour,followUp:'other'}).success,false);
  assert.equal(GenerateHourlyDigestInputSchema.safeParse({command:'pwsh'}).success,false);
});

test('hourly manifest is scoped, excludes daily boundary snapshots, and retains published results during failures',async()=>{
  const f=fixture();try {
    f.add('one','完整信息与限定。');
    const [digest]=await f.info.generateHourlyDigests({hourStart:hour});
    const original=f.report.getHourlyDigestIndex('local',{startAt:hour,endAt:hour+HOUR_MS});
    assert.equal(original.hours[0].id,digest.id);assert.equal(original.hours[0].itemCount,1);
    assert.equal('items' in original.hours[0],false);assert.equal('frozen' in original.hours[0],false);
    const isolated=f.report.getHourlyDigestIndex('other',{startAt:hour,endAt:hour+HOUR_MS}).hours;
    assert.equal(isolated.length,1);assert.equal(isolated[0].id,null);assert.equal(isolated[0].phase,'not-started');
    const repo=f.store.repositories.report,at=Date.now();
    const attempt=repo.acquireHourlySnapshot('local',hour,'failed-version',{window:{startAt:hour,endAt:hour+HOUR_MS}},'owner',at);
    repo.finishHourlySnapshot('local',attempt.id,'owner',null,'failure');
    const failed=f.report.getHourlyDigestIndex('local',{startAt:hour,endAt:hour+HOUR_MS}).hours[0];
    assert.equal(failed.status,'failed');assert.equal(failed.id,digest.id);
    repo.acquireHourlySnapshot('local',hour,'boundary',{window:{startAt:hour,endAt:hour+HOUR_MS/2}},'boundary-owner',Date.now());
    assert.equal(f.report.getHourlyDigestIndex('local',{startAt:hour,endAt:hour+HOUR_MS}).hours[0].status,'failed');
    assert.equal(f.report.getHourlyDigestIndex('local',{startAt:hour+HOUR_MS,endAt:hour+2*HOUR_MS}).hours[0].phase,'not-started');
    repo.acquireHourlySnapshot('local',hour-HOUR_MS,'expired',{window:{startAt:hour-HOUR_MS,endAt:hour}},'expired-owner',Date.now()-300000);
    assert.equal(f.report.getHourlyDigestIndex('local',{startAt:hour-HOUR_MS,endAt:hour}).hours[0].status,'failed');
    const services={report:f.report,runtime:{requestHourlyDigest(){throw Error('GET must not create jobs');}}};
    const router=createRouter(createReportRoutes()),response={writeHead(status){this.status=status;},end(body){this.body=JSON.parse(body);}};
    await router.dispatch({request:{method:'GET'},response,url:new URL(`http://localhost/api/v1/reports/hourly/index?startAt=${hour}&endAt=${hour+HOUR_MS}`),identity:{kind:'device'},services});
    assert.equal(response.status,200);assert.equal(response.body.hours[0].id,digest.id);
  }finally {f.close();}
});

test('hourly snapshots are idempotent, half-open and preserve old evidence across source edits and reopen',async()=>{
  const f=fixture();try {
    f.add('one','作者预计下季度量产。\n\n仅部分用户开放。');f.add('end','下一小时的发布',hour+HOUR_MS);
    const [first]=await f.info.generateHourlyDigests({hourStart:hour});
    assert.equal(first.items.length,2);assert.equal(first.coverage[0].read,1);
    const reference=first.items[0].evidence[0];
    const evidence=f.report.getInformationEvidence('local',reference);
    assert.equal(evidence.paragraph.text,'作者预计下季度量产。');assert.equal(evidence.context.length,2);
    assert.equal(evidence.material.late,true);
    const calls=f.calls.length;
    assert.equal((await f.info.generateHourlyDigests({hourStart:hour}))[0].id,first.id);
    assert.equal(f.calls.length,calls);
    f.rows[0].body='厂商确认已量产。';f.rows[0].updatedAt++;
    const [next]=await f.info.generateHourlyDigests({hourStart:hour});
    assert.notEqual(next.id,first.id);
    assert.equal(f.report.getInformationEvidence('local',reference).paragraph.text,'作者预计下季度量产。');
    assert.equal(f.report.getInformationEvidence('another',reference),null);
    assert.equal(f.report.getInformationEvidence('local',{...reference,materialHash:'0'.repeat(64)}),null);
    const reopened=createStore(f.dbPath);
    try {assert.equal(reopened.repositories.report.getHourlySnapshot('local',first.id).digest.items[0].sentence,'作者预计下季度量产。');} finally {reopened.close();}
  } finally {f.close();}
});

test('daily information keeps more than eight items, reuses hourly reading and resolves every daily item directly',async()=>{
  const f=fixture();try {
    for(let i=0;i<12;i++) f.add(`item${i}`,`作者自报：试验 ${i} 耗时 ${i+20} 分钟。`);
    await f.info.generateHourlyDigests({hourStart:hour});
    const extractionCalls=f.calls.filter(p=>p.stage==='information-extract').length;
    const report=await f.report.generateDailyReport({reportDate:'2026-10-05'});
    const briefService=createDailyBriefService({reportRepository:f.store.repositories.report,agentRuntime:f.agentRuntime,informationService:f.info,now:()=>hour+4*HOUR_MS});
    const brief=await briefService.generateDailyBrief({reportId:report.id});
    assert.equal(f.calls.filter(p=>p.stage==='information-extract').length,extractionCalls);
    assert.equal(brief.informationItems.length,12);assert.equal(brief.items.length,8);assert.equal(brief.sections.length,0);
    const last=brief.informationItems[11];
    const selected=f.report.getDailyBriefItemReference('local',{resourceType:'daily-brief-item',resourceId:`${brief.reportDate}/${last.id}`,revision:brief.generatedAt});
    assert.equal(selected.body,last.sentence);assert.ok(selected.evidence.length);
    assert.equal(f.report.listDailyBriefs('local')[0].itemCount,1);
    assert.deepEqual(f.report.getDailyBriefWindow('local',{date:brief.reportDate,revision:brief.generatedAt}),{window:report.content.window,timezone:report.content.timezone});
    assert.deepEqual(f.report.getDailyBriefWindow('other',{date:brief.reportDate,revision:brief.generatedAt}),{window:null,timezone:null});
    assert.deepEqual(f.report.getDailyBriefWindow('local',{date:brief.reportDate,revision:brief.generatedAt+1}),{window:null,timezone:null});
    f.rows[0].body='修订正文';f.rows[0].updatedAt++;
    const [latest]=await f.info.generateHourlyDigests({hourStart:hour});
    assert.ok(f.report.getInformationEvidence('local',brief.informationItems[0].evidence[0]).paragraph.text.startsWith('作者自报'));
    await briefService.generateDailyBrief({reportId:report.id,mode:'rewrite',requestKey:'rewrite-old-frozen'});
    assert.equal(f.report.getHourlyDigest('local',hour).id,latest.id);
  } finally {f.close();}
});

test('daily reading organizes hourly themes while omitted raw items remain searchable and both reference kinds resolve',async()=>{
  const f=fixture();try {
    f.add('one','厂商宣布新功能仅向测试用户开放。');f.add('two','厂商预计下季度交付，尚未实际交付。');f.add('unused','作者自报制作耗时55分钟。');
    await f.info.generateHourlyDigests({hourStart:hour});
    const base=f.agentRuntime.run;
    f.agentRuntime.run=async input=>{
      const p=JSON.parse(input.message);if(p.stage!=='daily-editorial')return base(input);
      assert.ok(p.hourlyThemes.some(h=>h.directions[0].sections[0].paragraphs.length===3));
      const ids=p.items.filter(i=>!i.sentence.includes('55分钟')).map(i=>i.id);
      return {answer:JSON.stringify({overview:'新功能测试开放，交付仍是计划。',overviewItemIds:ids,directions:[directionOutput(p.items.filter(i=>ids.includes(i.id)),'新功能仅向测试用户开放，厂商预计下季度交付，尚未实际交付。')]})};
    };
    const report=await f.report.generateDailyReport({reportDate:'2026-10-05'}),brief=await f.info.generateDailyInformation({report});
    assert.equal(brief.informationItems.length,3);assert.equal(brief.editorial.directions.length,1);
    assert.equal(f.report.listDailyBriefs('local')[0].itemCount,1);
    const topic=brief.editorial.directions[0];
    const ref=id=>f.report.getDailyBriefItemReference('local',{resourceType:'daily-brief-item',resourceId:`${brief.reportDate}/${id}`,revision:brief.generatedAt});
    assert.match(ref(topic.id).body,/尚未实际交付/);assert.equal(ref(topic.id).evidence.length,2);
    const raw=brief.informationItems.find(i=>i.sentence.includes('55分钟'));assert.match(ref(raw.id).body,/55分钟/);
  }finally{f.close();}
});

test('editorial merges inherit all references and omissions do not delete information',async()=>{
  const f=fixture();try {
    f.add('one','发布新功能。');f.add('two','新功能仅部分用户开放。',hour+HOUR_MS+1000);
    const [a]=await f.info.generateHourlyDigests({hourStart:hour}),[b]=await f.info.generateHourlyDigests({hourStart:hour+HOUR_MS});
    const input=[...a.items,...b.items];
    const merged=assembleInformationEditorial(input,{items:[{sentence:'发布新功能，目前仅部分用户开放。',itemIds:input.map(i=>i.id)}]},hour);
    assert.equal(merged.length,1);assert.equal(merged[0].evidence.length,2);
    assert.equal(assembleInformationEditorial(input,{items:[]},hour).length,2);
    assert.throws(()=>assembleInformationEditorial(input,{items:[{sentence:'新功能',itemIds:['invented']}]},hour),/未知/);
    assert.throws(()=>assembleInformationEditorial(input,{items:[{sentence:'a',itemIds:[input[0].id]},{sentence:'b',itemIds:[input[0].id]}]},hour),/重复/);
  } finally {f.close();}
});

test('failed reading resumes checkpoint and a hallucinated paragraph cannot replace a valid digest',async()=>{
  let calls=0,fail=true,hallucinate=false;
  const f=fixture({budget:{batchBytes:2300},runtime:{run:async input=>{
    const p=JSON.parse(input.message);calls++;
    if(p.stage==='hourly-editorial') {calls--;return {answer:JSON.stringify(editorialOutput(p.items))};}
    if(fail && calls===2) throw new Error('模拟断线');
    return {answer:JSON.stringify({items:[{sentence:'作者自报：已完成试验。',evidence:[{materialId:p.materials[0].id,paragraphId:hallucinate ? 'invented' : p.materials[0].paragraphs[0].id}]}]})};
  }}});
  try {
    f.add('long',`${'甲'.repeat(380)}\n\n${'乙'.repeat(380)}\n\n${'丙'.repeat(380)}`);
    const [partial]=await f.info.generateHourlyDigests({hourStart:hour});
    assert.equal(partial.coverage[0].readParagraphs,1);
    assert.equal(partial.coverage[0].unread,1);
    assert.match(partial.warnings.join(''),/后续批次未完成/);
    assert.ok(f.report.getInformationEvidence('local',partial.items[0].evidence[0]));
    fail=false;
    const [digest]=await f.info.generateHourlyDigests({hourStart:hour});
    assert.equal(calls,4);assert.equal(digest.coverage[0].read,1);
    hallucinate=true;f.rows[0].updatedAt++;
    await assert.rejects(()=>f.info.generateHourlyDigests({hourStart:hour}),/证据不属于/);
    assert.equal(f.report.getHourlyDigest('local',hour).id,digest.id);
  } finally {f.close();}
});

test('failed legacy attempts publish only validated frozen checkpoints before continuing with new arrivals',async()=>{
  const f=fixture({budget:{batchBytes:2300}});try {
    f.add('long',`${'甲'.repeat(380)}\n\n${'乙'.repeat(380)}\n\n${'丙'.repeat(380)}`);
    const [partial]=await f.info.generateHourlyDigests({hourStart:hour});
    const db=new Database(f.dbPath);
    try {
      // Model a pre-fix attempt that saved checkpoints but failed to publish its digest.
      db.prepare("UPDATE hourly_information_snapshots SET status='failed',digest_json=NULL WHERE id=?").run(partial.id);
      db.prepare('DELETE FROM hourly_information_heads WHERE snapshot_id=?').run(partial.id);
      db.prepare("DELETE FROM daily_analysis_stages WHERE report_date=? AND stage_key<>?").run(`hour:${hour}`,`hour:${hour}:0`);
    } finally {db.close();}
    f.add('late','迟到材料不能改写这份冻结依据。');
    const calls=f.calls.length;
    const [recovered]=await f.info.generateHourlyDigests({hourStart:hour});
    assert.equal(f.calls.filter(p=>p.stage==='information-extract').length,f.calls.slice(0,calls).filter(p=>p.stage==='information-extract').length);assert.equal(recovered.coverage[0].readParagraphs,1);
    assert.equal(recovered.items.length,1);assert.match(recovered.warnings.join(''),/恢复上轮/);
    assert.ok(f.report.getInformationEvidence('local',recovered.items[0].evidence[0]));
    const [next]=await f.info.generateHourlyDigests({hourStart:hour});
    assert.ok(next.items.some(i=>i.sentence.includes('迟到材料')));
  } finally {f.close();}
});

test('reading budget reports unread material and all extracted items remain saved',async()=>{
  const f=fixture({budget:{batchBytes:2300,maxCalls:1}});try {
    f.add('long',`${'甲'.repeat(380)}\n\n${'乙'.repeat(380)}\n\n${'丙'.repeat(380)}`);
    const [digest]=await f.info.generateHourlyDigests({hourStart:hour});
    assert.ok(digest.items.length);assert.equal(digest.coverage[0].unread,1);assert.equal(digest.coverage[0].read,0);
    assert.equal(digest.editorial.status,'ready');assert.ok(digest.editorial.directions.length);
    assert.match(digest.warnings.join(''),/未完整读取/);
    const [second]=await f.info.generateHourlyDigests({hourStart:hour});
    assert.equal(second.coverage[0].readParagraphs,2);
    const [third]=await f.info.generateHourlyDigests({hourStart:hour});
    assert.equal(third.coverage[0].read,1);
    assert.equal(third.items.length,3);
    assert.ok(f.report.getInformationEvidence('local',digest.items[0].evidence[0]));
  } finally {f.close();}
});

test('registered schedule catches up latest slot and only HTTP desktop can enqueue extraction',async()=>{
  const f=fixture();try {
    const schedule=ensureHourlyDigestSchedule(f.store,hour);
    const scheduler=createScheduler({store:f.store,allowedJobTypes:[REPORT_HOURLY_JOB_TYPE]});
    await scheduler.tick(hour+3*HOUR_MS+1000);
    const jobs=f.store.listOpenJobs(REPORT_HOURLY_JOB_TYPE);
    assert.equal(jobs.length,1);assert.equal(jobs[0].input.scheduledFor,hour+3*HOUR_MS);
    assert.equal(f.store.getJobSchedule('local',schedule.key).nextRunAt,hour+4*HOUR_MS);
    const runtime=createRuntimeService({runtimeRepository:f.store}),router=createRouter(createReportRoutes());
    const request=body=>({method:'POST',async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify(body));}});
    const response=()=>({status:0,body:'',writeHead(status){this.status=status;},end(body){this.body=body;}});
    const denied=response();
    await router.dispatch({request:request({hourStart:hour}),response:denied,url:new URL('http://127.0.0.1/api/v1/reports/hourly/generate'),identity:{kind:'device'},services:{report:f.report,runtime}});
    assert.equal(denied.status,403);
    const accepted=response();
    await router.dispatch({request:request({hourStart:hour}),response:accepted,url:new URL('http://127.0.0.1/api/v1/reports/hourly/generate'),identity:{kind:'desktop'},services:{report:f.report,runtime}});
    assert.equal(accepted.status,202);
    const handler=createReportJobHandlers({reportService:f.report,informationService:f.info})[REPORT_HOURLY_JOB_TYPE];
    assert.ok((await handler({hourStart:hour})).snapshotIds.length);
    await assert.rejects(()=>handler({hourStart:hour,command:'pwsh'}));
  } finally {f.close();}
});

test('Ask can browse an hour then retrieve immutable evidence through read-only tools',async()=>{
  const f=fixture();try {
    f.add('one','作者预计下季度量产。');await f.info.generateHourlyDigests({hourStart:hour});
    const tools=createLocalToolRegistry({contextService:{},feedService:{},knowledgeService:{},tradingService:{},reportService:f.report});
    const context={workspaceId:'local'};
    const search=tools.list().find(t=>t.id==='report.information.search');
    const result=await tools.execute(search.id,{startAt:hour,endAt:hour+HOUR_MS},context);
    assert.equal(search.effect,'read');assert.equal(result.data.items[0].sentence,'作者预计下季度量产。');
    const evidence=await tools.execute('report.information.evidence',result.data.items[0].evidence[0],context);
    assert.equal(evidence.data.evidence.paragraph.text,'作者预计下季度量产。');
  } finally {f.close();}
});

test('selected hourly citations resolve the frozen reading version without depending on the current publication',async()=>{
  const f=fixture();try {
    f.add('one','作者自报试验耗时55分钟，尚未独立核验。');const [first]=await f.info.generateHourlyDigests({hourStart:hour});
    f.rows[0].body='后来修订为60分钟。';f.rows[0].updatedAt++;await f.info.generateHourlyDigests({hourStart:hour});
    const context=createContextService({feedService:{},tradingService:{},knowledgeService:{},reportService:f.report});
    const input={resourceType:'hourly-digest',resourceId:first.id};
    const selected=await context.resolveReferences({workspaceId:'local',references:[input]});
    assert.equal(selected.items.length,1);assert.equal(selected.missing.length,0);
    assert.match(selected.promptText,/55分钟/);assert.doesNotMatch(selected.promptText,/修订为60分钟/);
    assert.match(selected.promptText,/report.information.search/);assert.match(selected.promptText,/冻结证据/);
    const missing=await context.resolveReferences({workspaceId:'other',references:[input]});
    assert.equal(missing.items.length,0);assert.match(missing.promptText,/不得猜测/);
  }finally{f.close();}
});

test('forward hourly migrations preserve earlier user content alongside independent later migrations',()=>{
  const f=fixture();f.store.close();
  const db=new Database(f.dbPath);
  try {
    db.exec('DROP TABLE hourly_information_heads; DROP TABLE hourly_information_snapshots; DELETE FROM schema_migrations WHERE version IN (38,39);');
    db.prepare('INSERT INTO posts(id,title,body,source_url,tags_json,created_by_device,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run('existing','用户原文','保留我','', '[]',null,hour,hour);
  } finally {db.close();}
  const store=createStore(f.dbPath);
  try {
    assert.equal(store.getPost('existing').body,'保留我');
    assert.equal(store.repositories.report.getHourlyDigest('local',hour),null);
  } finally {store.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('editorial failure preserves an earlier daily version and invalid IDs do not poison the retry cache',async()=>{
  const f=fixture();try {
    f.add('one','作者预计下季度量产。');
    const service=createDailyBriefService({reportRepository:f.store.repositories.report,agentRuntime:f.agentRuntime,informationService:f.info});
    const report=await f.report.generateDailyReport({reportDate:'2026-10-05'});
    const first=await service.generateDailyBrief({reportId:report.id});
    f.rows[0].updatedAt++;f.rows[0].body='仍未披露交付，预计量产时间延后。';
    const refreshed=await f.report.generateDailyReport({reportDate:'2026-10-05'});
    const originalRun=f.agentRuntime.run;let invalid=true;
    f.agentRuntime.run=async input=>JSON.parse(input.message).stage==='daily-editorial' && invalid
      ? {answer:JSON.stringify(editorialOutput([{id:'invented',sentence:'错误引用'}]))} : originalRun(input);
    await assert.rejects(()=>service.generateDailyBrief({reportId:refreshed.id}),/未知/);
    assert.equal(f.report.getDailyBrief('local',report.reportDate).generatedAt,first.generatedAt);
    assert.equal(f.report.getAnalysisStatus('local',report.reportDate).status,'failed');
    invalid=false;
    const next=await service.generateDailyBrief({reportId:refreshed.id});
    assert.match(next.informationItems[0].sentence,/时间延后/);
    assert.equal(f.report.getDailyBriefItemReference('local',{resourceType:'daily-brief-item',resourceId:`${first.reportDate}/${first.informationItems[0].id}`,revision:first.generatedAt}).body,'作者预计下季度量产。');
  } finally {f.close();}
});

test('source read failure is distinct from an empty hour, and hung calls abort without replacing an old digest',async()=>{
  const f=fixture({budget:{timeoutMs:30,heartbeatMs:5}});try {
    f.add('one','已存原文。');
    const [first]=await f.info.generateHourlyDigests({hourStart:hour});
    const read=f.feed.listContentItemsInWindow;
    f.feed.listContentItemsInWindow=()=>{throw new Error('来源暂不可读');};
    const [failedSource]=await f.info.generateHourlyDigests({hourStart:hour});
    assert.equal(failedSource.coverage[0].failed,1);assert.ok(failedSource.warnings.length);
    f.feed.listContentItemsInWindow=read;f.rows[0].updatedAt++;
    let signal;f.agentRuntime.run=input=>{signal=input.signal;return new Promise(()=>{});};
    await assert.rejects(()=>f.info.generateHourlyDigests({hourStart:hour}),/超时/);
    assert.equal(signal.aborted,true);
    assert.ok(f.report.getInformationEvidence('local',first.items[0].evidence[0]));
    assert.equal(f.report.getHourlyDigest('local',hour).id,failedSource.id);
    f.rows[0].updatedAt--;f.agentRuntime.run=async()=>{throw new Error('已有版本不应再次调用');};
    const [recovered]=await f.info.generateHourlyDigests({hourStart:hour});
    assert.equal(recovered.id,first.id);assert.equal(f.report.getHourlyDigest('local',hour).id,first.id);
  } finally {f.close();}
});

test('tracking selects related information and updates only explicitly enabled questions',async()=>{
  const f=fixture();try {
    f.add('delivery','新功能仅部分用户开放，尚未交付。');f.add('unrelated','作者完成纪录片制作。');
    f.report.saveTrackingQuestions('local',{questions:[{id:'delivery',question:'是否实际交付？',enabled:true},{id:'disabled',question:'制作方法？',enabled:false}]});
    const base=f.agentRuntime.run;
    f.agentRuntime.run=async input=>{
      const p=JSON.parse(input.message);
      if(p.stage==='information-tracking-select') return {answer:JSON.stringify({itemIds:p.items.filter(i=>i.sentence.includes('交付')).map(i=>i.id)})};
      if(p.stage==='information-tracking') {
        assert.equal(p.tracking.question.id,'delivery');assert.equal(p.evidenceMaterials.length,1);
        return {answer:JSON.stringify({updates:[{questionId:'delivery',status:'challenged',judgment:'尚未实际交付。',nextCheck:'等待交付公告',evidence:[{materialId:p.evidenceMaterials[0].id,paragraphId:p.evidenceMaterials[0].paragraphs[0].id}]}]})};
      }
      return base(input);
    };
    const report=await f.report.generateDailyReport({reportDate:'2026-10-05'});
    const brief=await f.info.generateDailyInformation({report});
    assert.equal(brief.trackingUpdates.length,1);assert.equal(brief.trackingUpdates[0].questionId,'delivery');
    const e=brief.trackingUpdates[0].evidence[0];
    assert.match(f.report.getDailyEvidence('local',brief.reportDate,brief.generatedAt,e.materialId,e.paragraphId).paragraph.text,/未交付/);
  } finally {f.close();}
});

test('minute cutoffs produce scoped boundary snapshots without overwriting full hourly results',async()=>{
  const f=fixture();try {
    f.add('one','保留信息。');await f.info.generateHourlyDigests({hourStart:hour});
    const report=await f.report.generateDailyReport({reportDate:'2026-10-05',cutoffMinute:30});
    const brief=await f.info.generateDailyInformation({report});
    assert.equal(brief.hourlySnapshots.length,25);assert.equal(brief.informationItems.length,1);
    const start=f.store.repositories.report.getHourlySnapshot('local',brief.hourlySnapshots[0]).digest;
    assert.equal(start.window.endAt-start.window.startAt,HOUR_MS/2);
    assert.equal(f.report.getHourlyDigest('local',start.window.startAt-HOUR_MS/2),null);
    assert.equal(f.report.getHourlyDigest('local',hour).items.length,1);
  } finally {f.close();}
});

test('evidence API reads frozen paragraphs for paired devices and refuses forged material versions',async()=>{
  const f=fixture();try {
    f.add('one','原文及限定。');const [digest]=await f.info.generateHourlyDigests({hourStart:hour});
    const router=createRouter(createReportRoutes());
    async function get(e) {
      const response={status:0,body:'',writeHead(status){this.status=status;},end(body){this.body=body;}};
      await router.dispatch({request:{method:'GET'},response,url:new URL(`http://127.0.0.1/api/v1/reports/hourly/evidence?${new URLSearchParams(e)}`),identity:{kind:'device'},services:{report:f.report}});
      return response;
    }
    const e=digest.items[0].evidence[0],valid=await get(e);
    assert.equal(valid.status,200);assert.equal(JSON.parse(valid.body).evidence.paragraph.text,'原文及限定。');
    assert.equal((await get({...e,materialVersion:'forged'})).status,404);
  } finally {f.close();}
});


test('direction paragraphs may reuse an item across sections and leads, but cannot spread its main ownership across articles',async()=>{
  const f=fixture();try {
    f.add('one','作者研究：计划投入10亿元，仍待批准。');const [d]=await f.info.generateHourlyDigests({hourStart:hour});
    const output=editorialOutput(d.items),dir=output.directions[0];
    dir.sections[0].paragraphs.push({text:'该投入仍是计划，尚未获批。',itemIds:[d.items[0].id]});
    const article=assembleBriefEditorial(d.items,output);
    assert.equal(article.directions[0].sections[0].paragraphs.length,2);
    assert.deepEqual(article.directions[0].lead.evidence,article.directions[0].sections[0].paragraphs[1].evidence);
    assert.equal(article.inputVersion,d.editorial.inputVersion);
    dir.sections.push(dir.sections[0]);assert.ok(assembleBriefEditorial(d.items,output));
    output.directions.push({...dir,key:'finance',label:'金融与市场'});assert.throws(()=>assembleBriefEditorial(d.items,output),/重复正文归属/);output.directions.pop();dir.sections.pop();
    dir.key='finance';assert.throws(()=>assembleBriefEditorial(d.items,output),/方向身份/);
    assert.equal(isCurrentBriefEditorial({...d,items:[{...d.items[0],sentence:'输入有修订。'}]}),false);
  }finally{f.close();}
});

test('old ready editorial upgrades only the chosen frozen snapshot and preserves old evidence and failure publication',async()=>{
  const f=fixture();try {
    f.add('one','作者自报：计划投入10亿元，尚未交付。');const [saved]=await f.info.generateHourlyDigests({hourStart:hour});
    const legacy={status:'ready',version:'brief-editorial-v2',overview:saved.editorial.overview,overviewItemIds:saved.editorial.overviewItemIds,overviewEvidence:saved.editorial.overviewEvidence,
      directions:[{title:'科技与产业',topics:[{id:'legacy-topic',title:'旧主题',body:saved.items[0].sentence,itemIds:[saved.items[0].id],evidence:saved.items[0].evidence,occurredAt:hour}]}]};
    const db=new Database(f.dbPath);try {
      db.prepare('UPDATE hourly_information_snapshots SET digest_json=? WHERE id=?').run(JSON.stringify({...saved,editorial:legacy}),saved.id);
      db.prepare("DELETE FROM daily_analysis_stages WHERE stage_key='hourly-editorial'").run();
    }finally{db.close();}
    f.rows[0].body='当前原文改变了，不能混入冻结稿。';f.rows[0].updatedAt++;
    const base=f.agentRuntime.run,reads=f.calls.filter(p=>p.stage==='information-extract').length;let fail=true;
    f.agentRuntime.run=async input=>{
      const payload=JSON.parse(input.message);assert.equal(payload.stage,'hourly-editorial');
      assert.ok(payload.evidenceMaterials.some(p=>p.text.includes('10亿元')));assert.ok(!JSON.stringify(payload).includes('当前原文改变'));
      if(fail) throw Error('模型断线');return base(input);
    };
    const args={hourStart:hour,mode:'rewrite',snapshotId:saved.id};
    const [failed]=await f.info.generateHourlyDigests(args);assert.equal(failed.editorial.status,'failed');assert.equal(f.report.getHourlyDigest('local',hour).id,saved.id);
    fail=false;const [ready]=await f.info.generateHourlyDigests(args);
    assert.notEqual(ready.id,saved.id);assert.equal(ready.editorial.version,BRIEF_EDITORIAL_VERSION);assert.deepEqual(ready.items,saved.items);
    assert.equal(f.calls.filter(p=>p.stage==='information-extract').length,reads);
    assert.equal(f.report.getHourlySnapshotDigest('local',saved.id).editorial.version,'brief-editorial-v2');
    assert.match(f.report.getInformationEvidence('local',saved.items[0].evidence[0]).paragraph.text,/10亿元/);
    await assert.rejects(()=>f.info.generateHourlyDigests({...args,hourStart:hour+HOUR_MS}),/窗口不匹配/);
    await assert.rejects(()=>f.info.generateHourlyDigests({...args,workspaceId:'other'}),/不存在/);
    assert.equal(GenerateHourlyDigestInputSchema.safeParse({mode:'rewrite'}).success,false);
    assert.equal(GenerateHourlyDigestInputSchema.safeParse({hourStart:hour,snapshotId:saved.id}).success,false);
  }finally{f.close();}
});

test('automatic reuse compares the editorial version and input fingerprint even for fully read ready hours',async()=>{
  const f=fixture();try {
    f.add('one','已读完成的事项。');const [saved]=await f.info.generateHourlyDigests({hourStart:hour});
    const db=new Database(f.dbPath);try {db.prepare('UPDATE hourly_information_snapshots SET digest_json=? WHERE id=?').run(JSON.stringify({...saved,editorial:{...saved.editorial,inputVersion:'0'.repeat(64)}}),saved.id);}finally{db.close();}
    const reads=f.calls.filter(p=>p.stage==='information-extract').length;
    const [next]=await f.info.generateHourlyDigests({hourStart:hour});assert.notEqual(next.id,saved.id);assert.ok(isCurrentBriefEditorial(next));
    assert.equal(f.calls.filter(p=>p.stage==='information-extract').length,reads);
    const prepared=f.store.repositories.report.getHourlySnapshot('local',saved.id).frozen;
    assert.equal(prepared.inputVersion,f.store.repositories.report.getHourlySnapshot('local',next.id).frozen.inputVersion);
    assert.equal((await f.info.generateHourlyDigests({hourStart:hour}))[0].id,next.id);
  }finally{f.close();}
});


test('an hourly direction-article citation resolves only its frozen article and missing article IDs never fall back to the whole hour',async()=>{
  const f=fixture();try {
    f.add('finance','金融材料：作者预计下季融资10亿元。');f.add('tech','科技材料：仅部分测试用户开放。');
    const base=f.agentRuntime.run;
    f.agentRuntime.run=async input=>{
      const p=JSON.parse(input.message);if(p.stage!=='hourly-editorial')return base(input);
      return {answer:JSON.stringify({overview:p.items[0].sentence,overviewItemIds:[p.items[0].id],directions:[
        {...directionOutput([p.items[0]]),key:'finance',label:'金融与市场'},directionOutput([p.items[1]])]})};
    };
    const [d]=await f.info.generateHourlyDigests({hourStart:hour}),context=createContextService({feedService:f.feed,reportService:f.report,knowledgeService:{},tradingService:{}});
    const resourceId=`${d.id}/${d.editorial.directions[0].id}`;
    const selected=await context.resolveReferences({workspaceId:'local',references:[{resourceType:'hourly-digest',resourceId}]});
    assert.match(selected.promptText,/金融材料/);assert.doesNotMatch(selected.promptText,/科技材料/);assert.equal(selected.items[0].ref.resourceId,resourceId);
    const missing=await context.resolveReferences({workspaceId:'local',references:[{resourceType:'hourly-digest',resourceId:`${d.id}/missing-article`}]});
    assert.equal(missing.items.length,0);assert.match(missing.promptText,/不得猜测/);
    const whole=await context.resolveReferences({workspaceId:'local',references:[{resourceType:'hourly-digest',resourceId:d.id}]});assert.match(whole.promptText,/科技材料/);
  }finally{f.close();}
});
