import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {resolveInstanceConfig} from '../packages/instance/src/index.js';
import {createStore} from '../packages/database/src/index.js';
import {createToolRegistry} from '../packages/runtime/src/tool-registry.js';
import {createHarnessAgentRuntime} from '../packages/harness/src/harness-agent-runtime.js';
import {createInformationDigestService,HOUR_MS} from '../packages/domain/src/information-digest-service.js';
import {createReportService} from '../packages/domain/src/report-service.js';

// Explicit live smoke: synthetic source text, isolated SQLite, existing Harness, no tools or live Instance writes.
if(!process.argv.includes('--run')) {
  console.log('Use --run for a synthetic hourly extraction/editorial smoke through the configured Harness.');
  process.exit(0);
}
const instance=resolveInstanceConfig({repositoryRoot:process.cwd()});
const dir=path.join(instance.runtimeDirectory,'information-audit',String(Date.now()));fs.mkdirSync(dir,{recursive:true});
const store=createStore(path.join(dir,'smoke.db'));
const runtime=createHarnessAgentRuntime({tools:createToolRegistry(),env:process.env,runtimeDirectory:path.join(dir,'harness')});
const hourStart=Math.floor(Date.now()/HOUR_MS)*HOUR_MS-2*HOUR_MS;
const samples=[
  {id:'synthetic:method',title:'合成样本：纪录片制作实践',body:'作者自报：制作两个不同题材的纪录片任务分别耗时116分钟和55分钟，另用60分钟整理检查规则。\n\n作者把镜头穿地和音画错位等失败经验固化为可重复执行的检查规则，用于下一次制作。',eventAt:hourStart+1000},
  {id:'synthetic:release',title:'合成样本：新功能公告',body:'厂商宣布发布新功能，目前仅向部分测试用户开放。厂商预计下季度量产；本次公告没有披露实际交付。',eventAt:hourStart+2000},
].map(row=>({...row,sourceId:'synthetic',sourceUrl:'https://example.com/synthetic',publishedAt:row.eventAt,createdAt:row.eventAt,updatedAt:row.eventAt,capturedAt:row.eventAt}));
const feed={listWindowSources:()=>[{sourceId:'synthetic',sourceName:'合成原文',provider:'local',available:samples.length}],listContentItemsInWindow:()=>samples};
const info=createInformationDigestService({reportRepository:store.repositories.report,feedService:feed,agentRuntime:runtime});
const report=createReportService({reportRepository:store.repositories.report,feedService:feed,tradingService:{getBoard:async()=>null}});
try {
  const [digest]=await info.generateHourlyDigests({hourStart});
  assert.ok(digest.items.length);
  for(const item of digest.items) for(const e of item.evidence) assert.ok(report.getInformationEvidence('local',e));
  assert.equal(digest.editorial.status,'ready');
  const items=digest.editorial.directions.flatMap(d=>d.sections.flatMap(s=>s.paragraphs));
  assert.ok(items.length);
  for(const item of items) for(const e of item.evidence) assert.ok(report.getInformationEvidence('local',e));
  fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify({synthetic:true,digest,items},null,2));
  console.log(JSON.stringify({synthetic:true,hourlyItems:digest.items.length,editorialItems:items.length,
    overview:digest.editorial.overview,topics:items.map(i=>({text:i.text})),evidenceResolved:true,originalInstanceUntouched:true}));
} finally {await runtime.close();store.close();}
