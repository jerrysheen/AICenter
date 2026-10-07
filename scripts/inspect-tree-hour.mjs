import Database from 'better-sqlite3';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {resolveInstanceConfig} from '../packages/instance/src/index.js';
import {resolveDailyConfig} from '../packages/domain/src/daily-window.js';
import {createInformationTreeRepository} from '../packages/database/src/repositories/information-tree-repository.js';
import {createInformationTreeReader} from '../packages/domain/src/information-tree-service.js';
import {loadInformationTreeSkills} from '../packages/runtime/src/information-tree/skills.js';
import {collectTreeReadiness,readinessMarkdown} from './lib/tree-readiness-diagnostics.mjs';
const args=process.argv.slice(2),arg=(name,fallback)=>args.includes(name) ? args[args.indexOf(name)+1] : fallback;
const instance=resolveInstanceConfig({repositoryRoot:process.cwd()}),{timezone}=resolveDailyConfig(process.env);
const startAt=Number(arg('--hour-start','1791331200000')),endAt=startAt+3600000;
if(!Number.isSafeInteger(startAt) || startAt<0 || startAt%3600000)throw new Error('须显式指定UTC毫秒整小时');
const directory=path.resolve(arg('--output','.ai-data/tree-hour-2026-10-07/target'));mkdirSync(directory,{recursive:true});
const db=new Database(instance.databasePath,{readonly:true,fileMustExist:true});
try {
  db.exec('BEGIN'); // All evidence belongs to one SQLite read snapshot; never migrate or write production.
  const inspectedAt=Date.now();
  const repository=createInformationTreeRepository(db,()=>{throw new Error('诊断禁止写入');}),reader=createInformationTreeReader({repository,timezone});
  const row=repository.list('local',startAt,endAt,'hourly')[0],edition=row?.edition || null;
  const modules=(edition?.roots || []).map(id=>({...reader.node('local',id),directChildren:reader.children('local',id)}));
  const information=repository.listInformation('local',{startAt,endAt});
  const editionIds=JSON.stringify([edition?.id,row?.attempt?.id].filter(Boolean));
  const jobs=db.prepare(`SELECT id,type,status,input_json,output_json,error_json,attempt_count,available_at,created_at,updated_at FROM jobs WHERE workspace_id='local' AND type='report.hourly.extract'
    AND (json_extract(input_json,'$.hourStart')=? OR json_extract(output_json,'$.editionId') IN (SELECT value FROM json_each(?))
      OR EXISTS (SELECT 1 FROM json_each(json_extract(output_json,'$.snapshotIds')) WHERE value IN (SELECT value FROM json_each(?)))) ORDER BY created_at`)
    .all(startAt,editionIds,editionIds).map(({input_json,output_json,error_json,...r})=>({...r,input:JSON.parse(input_json),output:output_json ? JSON.parse(output_json) : null,error:error_json ? JSON.parse(error_json) : null}));
  const usage=jobs.length ? db.prepare('SELECT record_json FROM model_usage_index WHERE workspace_id=? AND job_id IN (SELECT value FROM json_each(?)) ORDER BY occurred_at,id').all('local',JSON.stringify(jobs.map(j=>j.id))).map(r=>JSON.parse(r.record_json)) : [];
  const stages=db.prepare("SELECT stage_key,status,input_json,output_json,error,updated_at FROM daily_analysis_stages WHERE workspace_id='local' AND report_date='tree-preparation'").all().map(({input_json,output_json,...r})=>({...r,input:JSON.parse(input_json),output:output_json ? JSON.parse(output_json) : null}));
  const rawCounts={feed:db.prepare('SELECT count(*) n FROM content_items WHERE workspace_id=? AND coalesce(published_at,created_at)>=? AND coalesce(published_at,created_at)<?').get('local',startAt,endAt).n,
    media:db.prepare('SELECT count(*) n FROM media_index_entries WHERE workspace_id=? AND coalesce(published_at,observed_at)>=? AND coalesce(published_at,observed_at)<?').get('local',startAt,endAt).n};
  const snapshot={inspectedAt,timezone,pipeline:process.env.AI_CENTER_INFORMATION_PIPELINE,window:{startAt,endAt},windowStatus:inspectedAt<startAt ? 'not-started' : inspectedAt<endAt ? 'in-progress' : 'ended',
    rawCounts,rawCountsScope:'保存记录时间窗口计数；非JEV放行候选数量',preparedCount:information.length,edition,attempt:row?.attempt || null,modules,information,jobs,usage,usageRequestCount:usage.filter(r=>r.kind==='request').length,
    preparation:stages.filter(s=>information.some(n=>n.sourceId===s.input?.sourceId) || [...(edition?.pendingIds || []),...(row?.attempt?.pendingIds || [])].includes(s.input?.sourceId)),
    effectivePromptHashes:Object.fromEntries(Object.entries(loadInformationTreeSkills()).map(([k,v])=>[k,v.effectivePromptHash]))};
  const baselinePath=arg('--baseline',null),baseline=baselinePath ? JSON.parse(readFileSync(path.resolve(baselinePath),'utf8')) : null;
  if(baselinePath && path.resolve(baselinePath)===path.join(directory,'result.json'))throw new Error('输出目录不能覆盖baseline原始证据');
  if(baseline && (baseline.window?.startAt!==startAt || baseline.window?.endAt!==endAt))throw new Error('baseline窗口与目标小时不符');
  const targetEdition=baseline?.edition || edition;
  const readiness=collectTreeReadiness(db,{edition:targetEdition,inspectedAt,window:{startAt,endAt}});
  readiness.baselineInspectedAt=baseline?.inspectedAt || null;
  readiness.schedules=db.prepare('SELECT schedule_key,job_type,enabled,schedule_json,next_run_at FROM job_schedules WHERE workspace_id=?').all('local');
  readiness.subscriptions=db.prepare('SELECT source_account_id,enabled,refresh_interval_minutes,next_sync_at FROM subscriptions WHERE workspace_id=?').all('local');
  db.exec('COMMIT');
  writeFileSync(path.join(directory,'readiness.json'),JSON.stringify(readiness,null,2));
  writeFileSync(path.join(directory,'readiness-items.jsonl'),readiness.items.map(item=>JSON.stringify(item)).join('\n')+'\n');
  writeFileSync(path.join(directory,'readiness.md'),readinessMarkdown(readiness,timezone));
  writeFileSync(path.join(directory,'result.json'),JSON.stringify(snapshot,null,2));
  const stamp=at=>new Intl.DateTimeFormat('zh-CN',{timeZone:timezone,dateStyle:'short',timeStyle:'short'}).format(at);
  const text=[`# ${stamp(startAt)}—${stamp(endAt)} 小时验收`,`时区：${timezone}；窗口：${snapshot.windowStatus}；已准备信息稿：${information.length}。`,
    `所读发布版本：${edition?.id || '尚无'}；状态：${edition?.status || '尚无'}。`,
    ...modules.flatMap(n=>[`## ${n.title}`,n.text,`ref：${n.id}`, ...n.directChildren.flatMap(c=>[`### 直接信息稿：${c.title}`,c.text,`节点：${c.id}；来源：${c.sourceId}；主Tag：${c.tagId ?? 'null'}`])]),
    '## 待补',...(row?.attempt?.pending || []).map(p=>`${p.id}：${p.reason}；可重试=${p.retryable}`),...(row?.attempt?.groupFailures || []).map(p=>`${p.tagId ?? 'null'}：${p.reason}`),
    ...(!modules.length ? ['本窗尚无可交付正文；未借用其他小时或示例。'] : []),`定向Job记录：${jobs.length}；对应现有账本请求：${snapshot.usageRequestCount}（共${usage.length}条请求及聚合记录；聚合不重复计量，不把同期其他Job用量计入）。`].join('\n\n');
  writeFileSync(path.join(directory,'hour.md'),text+'\n');console.log(JSON.stringify({timezone,window:snapshot.window,windowStatus:snapshot.windowStatus,rawCounts,preparedCount:information.length,editionId:edition?.id || null,status:edition?.status || null,modules:modules.length,jobs:jobs.length,usageRecords:usage.length,directory}));
}finally{db.close();}
