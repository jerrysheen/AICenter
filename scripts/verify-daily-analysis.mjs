import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {resolveInstanceConfig} from '../packages/instance/src/index.js';
import {loadMediaConfig} from '../packages/instance/src/media-config.js';
import {createStore} from '../packages/database/src/index.js';
import {createReportService} from '../packages/domain/src/report-service.js';
import {createDailyBriefService} from '../packages/domain/src/daily-brief-service.js';
import {createMediaIngestionService} from '../packages/domain/src/media-ingestion-service.js';
import {createMediaConnector} from '../packages/connectors/src/media/port.js';
import {createHarnessAgentRuntime} from '../packages/harness/src/harness-agent-runtime.js';
import {createToolRegistry} from '../packages/runtime/src/tool-registry.js';
import {packDailyBatches,DAILY_ANALYSIS_BUDGET} from '../packages/domain/src/daily-analysis.js';

// Only reads the running Instance DB. All migrations, checkpoints and replay results go to a copy.
if(!process.argv.includes('--run') && !process.argv.includes('--prepare')) {
  console.log('Use --prepare for a material replay, or --run for the same replay through the configured Harness.');process.exit(0);
}
const arg=name=>{const i=process.argv.indexOf(name);return i>=0 ? process.argv[i+1] : null;};
const instance=resolveInstanceConfig({repositoryRoot:process.cwd()});
const source=new Database(instance.databasePath,{readonly:true});
const date=arg('--date') || source.prepare('SELECT report_date FROM daily_reports ORDER BY report_date DESC LIMIT 1').get()?.report_date;
const original=source.prepare('SELECT * FROM daily_reports WHERE workspace_id=? AND report_date=?').get('local',date);
if(!original) throw new Error('No saved report for selected date');
const oldContent=JSON.parse(original.content_json);
if(oldContent.window.endAt>Date.now()) throw new Error('Replay requires a completed window');
const oldBriefRow=source.prepare('SELECT * FROM daily_report_briefs WHERE workspace_id=? AND report_date=?').get('local',date);
const oldBrief=oldBriefRow ? JSON.parse(oldBriefRow.brief_json) : null;
const dir=path.resolve(arg('--directory') || path.join(instance.runtimeDirectory,'daily-audit',`${date}-${Date.now()}`));
fs.mkdirSync(dir,{recursive:true});
const copy=path.join(dir,'replay.db');
if(!fs.existsSync(copy)) await source.backup(copy);
source.close();
const store=createStore(copy);
const media=createMediaIngestionService({mediaRepository:store.repositories.media,feedRepository:store.repositories.feed,
  mediaPort:createMediaConnector(loadMediaConfig(instance.configDirectory))});
const reportService=createReportService({reportRepository:store.repositories.report,feedService:store.repositories.feed,mediaPort:media,
  tradingService:{getBoard:async({board})=>({...oldContent.market[board],watchlist:oldContent.market[board].observations || [],note:'使用该日已保存行情；没有历史利率/汇率字段时保持缺失'})},
  staticSignalPort:{readBoard:async()=>({releases:oldContent.officialReleases,upcoming:oldContent.upcoming,sourceHealth:[]})},
  defaultConfig:{timezone:oldContent.timezone,cutoffHour:Number(new Intl.DateTimeFormat('en-GB',{timeZone:oldContent.timezone,hour:'2-digit',hourCycle:'h23'}).format(new Date(oldContent.window.endAt))),cutoffMinute:Number(new Intl.DateTimeFormat('en-GB',{timeZone:oldContent.timezone,minute:'2-digit'}).format(new Date(oldContent.window.endAt))),upcomingHours:36}});
const report=await reportService.generateDailyReport({reportDate:date,requestKey:process.argv.includes('--refresh-materials') ? `replay-${date}-${Date.now()}` : `replay-${date}`});
const batchBytes=Number(arg('--batch-bytes') || DAILY_ANALYSIS_BUDGET.batchBytes);
const counts={social:packDailyBatches(report.content.materials.filter(m=>m.group==='social'),batchBytes).length,news:packDailyBatches(report.content.materials.filter(m=>m.group!=='social'),batchBytes).length};
console.log(JSON.stringify({phase:'prepared',date,materials:report.content.materials.length,batches:counts,coverage:report.content.coverage}));
fs.writeFileSync(path.join(dir,'coverage.json'),JSON.stringify({date,counts,coverage:report.content.coverage},null,2));
let runtime;
try {
  if(process.argv.includes('--run')) {
    runtime=createHarnessAgentRuntime({tools:createToolRegistry(),env:process.env,runtimeDirectory:path.join(dir,'harness')});
    const wrapped={run:async input=>{
      const invocation=JSON.parse(input.message);console.log(JSON.stringify({phase:'model-start',stage:invocation.stage,bytes:Buffer.byteLength(input.message)}));
      const started=Date.now();const result=await runtime.run({...input,trace:async({event})=>{if(['model.requested','model.responded','run.failed'].includes(event)) console.log(JSON.stringify({phase:'trace',event}));}});
      console.log(JSON.stringify({phase:'model-return',stage:invocation.stage,durationMs:Date.now()-started}));return result;
    }};
    const briefService=createDailyBriefService({reportRepository:store.repositories.report,agentRuntime:wrapped,
      analysisBudget:{batchBytes,socialBatches:Number(arg('--social-batches') || DAILY_ANALYSIS_BUDGET.socialBatches),newsBatches:Number(arg('--news-batches') || DAILY_ANALYSIS_BUDGET.newsBatches)}});
    const brief=await briefService.generateDailyBrief({reportId:report.id});
    fs.writeFileSync(path.join(dir,'new-brief.json'),JSON.stringify(brief,null,2));
    const stageDb=new Database(copy,{readonly:true});
    const stages=stageDb.prepare('SELECT stage_key,input_hash,input_json,output_json,status FROM daily_analysis_stages WHERE report_date=? ORDER BY updated_at').all(date);
    fs.writeFileSync(path.join(dir,'stages.json'),JSON.stringify(stages,null,2));stageDb.close();
    const lines=[`# ${date} 日报新旧对照（只读回放）`,'','原始日报、采集与阅读状态未写入。回放在在线备份副本进行；迟到材料是补充版本，不能代表截止时已知。','',
      '## 旧日报','',oldBrief?.overview || '没有旧稿',...(oldBrief?.items || []).flatMap(i=>['',`### ${i.headline}`,i.whyItMatters,`接着看：${i.watchNext}`]),'',
      '## 新日报','',brief.overview,...brief.sections.flatMap(s=>['',`### ${s.title}`,s.body,`证据：${s.evidence.map(e=>`${e.materialId}/${e.paragraphId}`).join('；')}`]),'',`下一验证：${brief.nextWatch}`,'',
      brief.trackingUpdates.length ? `关注问题更新 ${brief.trackingUpdates.length} 项` : '持续关注问题尚未配置；未自动加入主题。','',
      '## 来源覆盖','', '| 来源 | 窗口可用 | 快照 | 正文 | 完整读取 | 未完整读取 | 失败 |','|---|---:|---:|---:|---:|---:|---:|',
      ...brief.coverage.map(c=>`| ${c.sourceId} | ${c.available} | ${c.included} | ${c.full} | ${c.read} | ${c.unread} | ${c.failed} |`),'',brief.limitations,'',
      `模型批次：社交 ${Math.min(counts.social,Number(arg('--social-batches') || DAILY_ANALYSIS_BUDGET.socialBatches))}，新闻 ${Math.min(counts.news,Number(arg('--news-batches') || DAILY_ANALYSIS_BUDGET.newsBatches))}。`];
    fs.writeFileSync(path.join(dir,'comparison.md'),lines.join('\n'));
    fs.rmSync(path.join(dir,'failure-status.json'),{force:true});
    console.log(JSON.stringify({phase:'completed',sections:brief.sections.length,coverage:brief.coverage,dir}));
  }
} catch(error) {
  const stageDb=new Database(copy,{readonly:true});
  const stages=stageDb.prepare('SELECT stage_key,input_hash,input_json,output_json,status,error FROM daily_analysis_stages WHERE report_date=? ORDER BY updated_at').all(date);
  fs.writeFileSync(path.join(dir,'stages.json'),JSON.stringify(stages,null,2));stageDb.close();
  fs.writeFileSync(path.join(dir,'failure-status.json'),JSON.stringify({date,status:'failed',error:error.message,originalPreserved:true,completedStages:stages.filter(s=>s.status==='completed').length},null,2));
  throw error;
} finally {await runtime?.close?.();store.close();}
