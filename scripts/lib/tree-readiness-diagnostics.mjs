import {TREE_VALIDATOR_VERSION} from '../../packages/contracts/src/information-tree.js';
import {loadInformationTreeSkills} from '../../packages/runtime/src/information-tree/skills.js';

const HOUR=3600000;
const parse=value=>value ? JSON.parse(value) : null;
const count=rows=>rows.reduce((result,key)=>(result[key]=(result[key] || 0)+1,result),{});

// Job membership does not prove which material within a running batch is executing.
export function preparationState({id,version,head,stages=[],jobs=[],at,promptHashes}) {
  const versionMatches=head && (!version || head.sourceVersion===version);
  const usable=versionMatches && head.validatorVersion===TREE_VALIDATOR_VERSION && promptHashes.includes(head.effectivePromptHash);
  const matching=stages.filter(s=>s.updatedAt<=at && s.input?.sourceVersion===version).sort((a,b)=>b.updatedAt-a.updatedAt);
  const active=jobs.filter(j=>j.createdAt<=at && j.attempts.some(a=>a.startedAt<=at && (a.completedAt===null || a.completedAt>at)));
  const queued=jobs.filter(j=>j.createdAt<=at && !j.attempts.some(a=>a.startedAt<=at)
    && !(j.status==='cancelled' && j.updatedAt<=at));
  const failure=matching.find(s=>s.output?.pending)?.output.pending;
  let reason;
  if(usable && head.generatedAt<=at)reason='ready';
  else if(active.length)reason=active.some(j=>j.sourceIds.length>1) ? 'running-batch-member' : 'running';
  else if(failure)reason=failure.retryAt>at ? 'retry-cooldown' : 'preparation-failed';
  else if(queued.length)reason='queued-not-started';
  else if(head && head.generatedAt<=at && !versionMatches)reason='source-version-mismatch';
  else if(head && head.generatedAt<=at && !usable)reason='prompt-or-validator-mismatch';
  else reason='no-matching-evidence';
  return {reason,failure:failure || null,activeJobIds:active.map(j=>j.id),queuedJobIds:queued.map(j=>j.id),
    headVersionMatches:!!versionMatches,headReusable:!!usable,
    evidenceScope:'任务attempt可重建执行区间；阶段表可被重试覆盖，缺记录不等于从未处理；批次成员不等于该篇正在调用模型'};
}

export function collectTreeReadiness(db,{workspaceId='local',edition,inspectedAt,window}) {
  const skills=loadInformationTreeSkills(),promptHashes=[skills.information.version,...skills.information.compatiblePromptHashes];
  const nodes=db.prepare('SELECT value_json FROM information_tree_nodes WHERE workspace_id=?').all(workspaceId).map(r=>parse(r.value_json)).filter(n=>n.layer==='information');
  const byId=new Map(nodes.map(n=>[n.id,n]));
  const heads=new Map(db.prepare('SELECT source_id,node_id FROM information_tree_information_heads WHERE workspace_id=?').all(workspaceId).map(r=>[r.source_id,byId.get(r.node_id)]));
  const stages=db.prepare("SELECT stage_key,input_hash,input_json,output_json,status,error,updated_at FROM daily_analysis_stages WHERE workspace_id=? AND report_date='tree-preparation'").all(workspaceId)
    .map(r=>({key:r.stage_key,inputHash:r.input_hash,input:parse(r.input_json),output:parse(r.output_json),status:r.status,error:r.error,updatedAt:r.updated_at}));
  const attempts=db.prepare('SELECT a.job_id,a.attempt_number,a.status,a.error_json,a.started_at,a.completed_at FROM job_attempts a JOIN jobs j ON j.id=a.job_id WHERE j.workspace_id=? AND j.type=?').all(workspaceId,'report.information.prepare')
    .map(r=>({jobId:r.job_id,number:r.attempt_number,status:r.status,error:parse(r.error_json),startedAt:r.started_at,completedAt:r.completed_at}));
  const jobs=db.prepare('SELECT id,status,priority,attempt_count,max_attempts,available_at,created_at,updated_at,input_json,output_json,error_json FROM jobs WHERE workspace_id=? AND type=? ORDER BY created_at,id').all(workspaceId,'report.information.prepare')
    .map(r=>{const input=parse(r.input_json);return {id:r.id,status:r.status,priority:r.priority,attemptCount:r.attempt_count,maxAttempts:r.max_attempts,availableAt:r.available_at,createdAt:r.created_at,updatedAt:r.updated_at,
      sourceIds:input.sourceIds || [],force:!!input.force,catchup:!!input.catchup,output:parse(r.output_json),error:parse(r.error_json),attempts:attempts.filter(a=>a.jobId===r.id)};});
  const pending=edition?.pending || [],inputs=(edition?.inputIds || []).map(id=>byId.get(id)).filter(Boolean);
  const target=new Map([...inputs.map(n=>[n.sourceId,{version:n.sourceVersion,inputNodeId:n.id}]),...pending.map(p=>[p.id,{version:p.sourceVersion,publishedPending:p}])]);
  const rawFeed=db.prepare(`SELECT ci.id,ci.title,ci.created_at,ci.updated_at,coalesce(ci.published_at,ci.created_at) event_at,c.metadata_json,
    EXISTS(SELECT 1 FROM user_item_states u WHERE u.workspace_id=ci.workspace_id AND u.content_item_id=ci.id AND u.is_hidden=1) hidden
    FROM content_items ci LEFT JOIN captures c ON c.id=ci.capture_id AND c.workspace_id=ci.workspace_id
    WHERE ci.workspace_id=? AND coalesce(ci.published_at,ci.created_at)>=? AND coalesce(ci.published_at,ci.created_at)<?`).all(workspaceId,window.startAt,window.endAt)
    .map(r=>({id:'feed:'+r.id,title:r.title,createdAt:r.created_at,updatedAt:r.updated_at,eventAt:r.event_at,version:String(r.updated_at || r.created_at),hidden:!!r.hidden,admission:parse(r.metadata_json)}));
  const rawMedia=db.prepare('SELECT external_id,title,revision,created_at,updated_at,coalesce(published_at,observed_at) event_at,fetch_state_json FROM media_index_entries WHERE workspace_id=? AND coalesce(published_at,observed_at)>=? AND coalesce(published_at,observed_at)<?').all(workspaceId,window.startAt,window.endAt)
    .map(r=>({id:'media:'+r.external_id,title:r.title,createdAt:r.created_at,updatedAt:r.updated_at,eventAt:r.event_at,indexRevision:r.revision,fetchState:parse(r.fetch_state_json),
      admissionCaptures:db.prepare('SELECT metadata_json FROM captures WHERE workspace_id=? AND provider=? AND external_id=?').all(workspaceId,'media',r.external_id).map(c=>parse(c.metadata_json))}));
  // Keep only gate evidence, never original article bodies or arbitrary capture metadata.
  const gate=m=>m ? Object.fromEntries(['filterMode','filterRule','filterDecision','filterScores','filterApplied','filterReason'].filter(k=>m[k]!==undefined).map(k=>[k,m[k]])) : null;
  for(const r of rawFeed)r.admission=gate(r.admission);
  for(const r of rawMedia)r.admissionCaptures=r.admissionCaptures.map(gate);
  const raw=[...rawFeed,...rawMedia],rawById=new Map(raw.map(r=>[r.id,r]));
  const items=[...target].map(([id,t])=>{
    const ownJobs=jobs.filter(j=>j.sourceIds.includes(id)),ownStages=stages.filter(s=>s.input?.sourceId===id);
    const historical=nodes.filter(n=>n.sourceId===id && n.generatedAt<=edition.generatedAt).sort((a,b)=>b.generatedAt-a.generatedAt);
    const atGeneration=preparationState({id,version:t.version,head:historical.find(n=>n.sourceVersion===t.version) || historical[0],stages:ownStages,jobs:ownJobs,at:edition.generatedAt,promptHashes});
    const current=preparationState({id,version:t.version,head:heads.get(id),stages:ownStages,jobs:ownJobs,at:inspectedAt,promptHashes});
    return {id,...t,title:rawById.get(id)?.title || heads.get(id)?.title || '',atGeneration,current,currentHead:heads.get(id) ? Object.fromEntries(['id','sourceVersion','generatedAt','effectivePromptHash','validatorVersion'].map(k=>[k,heads.get(id)[k]])) : null,
      stages:ownStages,jobs:ownJobs,raw:rawById.get(id) || null};
  });
  const rawNotInEdition=raw.filter(r=>!target.has(r.id)).map(r=>({...r,
    explanation:!edition ? 'no-edition' : r.createdAt>edition.generatedAt ? 'arrived-after-edition' : r.hidden ? 'hidden-now' :
      [r.admission,...(r.admissionCaptures || [])].some(g=>g?.filterDecision && g.filterDecision!=='KEEP') ? 'admission-not-keep-now' : 'exclusion-not-proven',
    scope:'当前保存的准入/抓取证据；历史刊期未冻结排除清单，不能据此伪造出刊时的排除原因'}));
  const firstEnqueue=new Map();
  for(const j of jobs)for(const id of j.sourceIds)firstEnqueue.set(id,Math.min(firstEnqueue.get(id) ?? Infinity,j.createdAt));
  const firstReady=new Map();
  for(const n of nodes)firstReady.set(n.sourceId,Math.min(firstReady.get(n.sourceId) ?? Infinity,n.generatedAt));
  const bins=[];
  for(let startAt=Math.floor(inspectedAt/HOUR)*HOUR-6*HOUR;startAt<=inspectedAt;startAt+=HOUR){const endAt=Math.min(startAt+HOUR,inspectedAt),within=t=>t>=startAt && t<endAt;
    const finished=jobs.filter(j=>j.status==='completed' && within(j.updatedAt));
    const durations=attempts.filter(a=>a.completedAt && within(a.completedAt)).map(a=>a.completedAt-a.startedAt).sort((a,b)=>a-b);
    bins.push({startAt,endAt,partialHour:endAt<startAt+HOUR,newUniqueQueued:[...firstEnqueue.values()].filter(within).length,firstReadySources:[...firstReady.values()].filter(within).length,
      completedJobs:finished.length,preparedOutputs:finished.reduce((s,j)=>s+(j.output?.prepared || 0),0),calls:finished.reduce((s,j)=>s+(j.output?.calls || 0),0),cacheHits:finished.reduce((s,j)=>s+(j.output?.cacheHits || 0),0),
      pendingReasons:count(finished.flatMap(j=>(j.output?.pending || []).map(p=>p.reason))),attemptDurationMs:{count:durations.length,median:durations[Math.floor(durations.length/2)] ?? null,max:durations.at(-1) ?? null}});
  }
  const cacheTimings=db.prepare("SELECT stage_key,input_json,status,error,updated_at FROM daily_analysis_stages WHERE workspace_id=? AND report_date='tree-cache' AND updated_at>=?").all(workspaceId,inspectedAt-6*HOUR)
    .map(r=>({key:r.stage_key,status:r.status,error:r.error,updatedAt:r.updated_at,input:parse(r.input_json)})).filter(r=>r.input.executionTiming || r.input.failure);
  return {schemaVersion:1,inspectedAt,editionGeneratedAt:edition?.generatedAt || null,editionId:edition?.id || null,window,
    scope:'只读事务快照；atGeneration是保留的attempt/不可变节点证据重建，current是检查时与该刊期来源版本对照；阶段重试覆盖造成的历史未知明确保留',
    summary:{rawRecords:raw.length,editionSources:items.length,publishedInputs:inputs.length,publishedPending:pending.length,
      pendingAtGeneration:count(items.filter(i=>i.publishedPending).map(i=>i.atGeneration.reason)),pendingNow:count(items.filter(i=>i.publishedPending).map(i=>i.current.reason))},
    items,rawNotInEdition,capacity:{scope:'最近6个整小时及当前未结束小时；按首次入队/首次信息节点计唯一来源，拆分及重试不重复计新增；Job完成不等于材料成功；缓存命中不能当重做，阶段计时不是全量调用历史',
      queuedJobs:jobs.filter(j=>j.status==='queued').length,queuedUniqueSources:new Set(jobs.filter(j=>j.status==='queued').flatMap(j=>j.sourceIds)).size,
      runningJobs:jobs.filter(j=>j.status==='running').map(j=>({id:j.id,sourceCount:j.sourceIds.length,attempts:j.attempts})),bins,cacheTimings},
    limitations:['旧刊期未冻结每篇准备原因，不能还原被覆盖的阶段错误、历史优先级或批次内单篇开始时间。','新版诊断文件冻结本次逐条证据；容量按队列首次入队计，不等于采集量或JEV放行量。','目前Job.calls/cacheHits是任务汇总；没有请求到来源版本的完整关联时，不声称已确定重复模型调用次数。']};
}

export function readinessMarkdown(report,timezone='Asia/Shanghai') {
  const stamp=t=>new Intl.DateTimeFormat('zh-CN',{timeZone:timezone,dateStyle:'short',timeStyle:'medium'}).format(t);
  const clean=t=>String(t ?? '').replace(/[|\r\n]/g,' ');
  return [`# 小时信息未就绪诊断`, `检查时间：${stamp(report.inspectedAt)}；刊期生成：${report.editionGeneratedAt ? stamp(report.editionGeneratedAt) : '无'}。`,
    `刊期：${report.editionId || '无'}。`,report.scope,'## 汇总',JSON.stringify(report.summary,null,2),'## 逐条待补',
    '| 来源ID | 标题 | 出刊时证据 | 检查时状态 | 准备失败原因 |','|---|---|---|---|---|',
    ...report.items.filter(i=>i.publishedPending).map(i=>`| ${clean(i.id)} | ${clean(i.title)} | ${i.atGeneration.reason} | ${i.current.reason} | ${i.current.failure?.reason || ''} |`),
    '## 原始记录与刊期差异',...report.rawNotInEdition.map(r=>`${r.id}：${r.title}；${r.explanation}。${r.scope}`),
    '## 最近准备吞吐','首次入队不是原始采集量；当前未结束小时不可与整小时直接比较。','| 时段 | 首次入队来源 | 首次就绪来源 | 完成Job | 模型调用 | 缓存命中 | 待补原因 |', '|---|---:|---:|---:|---:|---:|---|',
    ...report.capacity.bins.map(b=>`| ${stamp(b.startAt)}—${stamp(b.endAt)}${b.partialHour ? '（未结束）' : ''} | ${b.newUniqueQueued} | ${b.firstReadySources} | ${b.completedJobs} | ${b.calls} | ${b.cacheHits} | ${JSON.stringify(b.pendingReasons)} |`),
    '## 状态解释',
    '- queued-not-started：准备Job尚未开始；running-batch-member：属于在途批次，不代表已轮到该篇。',
    '- retry-cooldown：匹配来源版本的准备失败，仍在冷却；失败原因与retryAt见逐条JSON。',
    '- source-version-mismatch / prompt-or-validator-mismatch：已有稿与目标版本或有效规则不匹配。',
    '- ready：目标来源版本已有可复用信息稿；不代表已补进旧刊期。no-matching-evidence：证据不足，不推断从未处理。',
    '- queue-timeout：已开始准备任务，但模型执行队列未放行；execution-timeout：获得模型执行机会后超时；budget-deferred：本批预算不足。',
    '## 调度快照',
    ...(report.schedules || []).map(s=>`${s.schedule_key}：enabled=${s.enabled}；${s.schedule_json}；next=${stamp(s.next_run_at)}。`),
    ...(report.subscriptions || []).map(s=>`${s.source_account_id}：enabled=${s.enabled}；每${s.refresh_interval_minutes}分钟；next=${stamp(s.next_sync_at)}。`),
    '## 证据边界',...report.limitations.map(t=>'- '+t),'','完整逐条任务、attempt、来源版本、阶段原因/冷却、提示词/校验版本及阶段执行计时见readiness.json；readiness-items.jsonl按来源分行。'].join('\n\n').replace(/\|\n\n\|/g,'|\n|')+'\n';
}
