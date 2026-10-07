import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
const args=process.argv.slice(2),dir=path.resolve(args.includes('--replay') ? args[args.indexOf('--replay')+1] : '.ai-data/tree-next-2026-10-06/replay');
const read=name=>JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));
const result=read('result.json'),sample=read('sample-manifest.json'),baseline=JSON.parse(fs.readFileSync('.ai-data/tree-next-2026-10-06/baseline/result.json','utf8').replace(/^\uFEFF/,''));
const db=new Database(path.join(dir,'ai-center.db'),{readonly:true,fileMustExist:true});
try{
  const nodes=new Map(db.prepare("SELECT id,value_json FROM information_tree_nodes WHERE workspace_id='local'").all().map(row=>[row.id,JSON.parse(row.value_json)]));
  const projection=hours=>new Map(hours.flatMap(h=>h.inputIds).map(id=>nodes.get(id)).filter(Boolean).map(n=>[n.sourceId,n]));
  const a=new Map(baseline.nodes.filter(n=>n.layer==='information').map(n=>[n.sourceId,n])),b=projection(result.B),c=projection(result.C);
  const comparisons=sample.hours.flatMap(h=>h.materials).map(m=>({sourceId:m.id,scope:m.contentLevel,bodyCharacters:m.paragraphs.filter(p=>p.role!=='comment').reduce((n,p)=>n+Array.from(p.text).length,0),A:a.get(m.id) || null,B:b.get(m.id) || null,C:c.get(m.id) || null,textReusedBtoC:b.has(m.id) && c.has(m.id) ? b.get(m.id).text===c.get(m.id).text : null}));
  const usage=db.prepare('SELECT record_json FROM model_usage_index ORDER BY occurred_at,id').all().map(row=>JSON.parse(row.record_json));
  const requests=usage.filter(v=>v.kind==='request'),stages=[...new Set(requests.map(v=>v.stage))];
  const byStage=Object.fromEntries(stages.map(stage=>{const rows=requests.filter(r=>r.stage===stage);return [stage,{requests:rows.length,succeeded:rows.filter(r=>r.status==='succeeded').length,failed:rows.filter(r=>r.status==='failed').length,unknownUsage:rows.filter(r=>r.completeness!=='complete').length,reportedInputTokens:rows.reduce((n,r)=>n+(r.usage.inputTokens || 0),0),reportedOutputTokens:rows.reduce((n,r)=>n+(r.usage.outputTokens || 0),0),reportedCacheReadTokens:rows.reduce((n,r)=>n+(r.usage.cacheReadTokens || 0),0),reportedTotalTokens:rows.reduce((n,r)=>n+(r.usage.totalTokens || 0),0)}];}));
  const businessStages=db.prepare("SELECT report_date,stage_key,status,input_json,error FROM daily_analysis_stages WHERE report_date IN ('tree-cache','tree-preparation')").all().map(r=>({period:r.report_date,key:r.stage_key,status:r.status,input:JSON.parse(r.input_json),error:r.error}));
  const full=result.full.map(f=>({sourceId:f.sourceId,nodes:f.nodes,pending:f.pending,calls:f.calls,cacheHits:f.cacheHits,sourceCharacters:sample.full.find(m=>m.id===f.sourceId)?.paragraphs.filter(p=>p.role!=='comment').reduce((n,p)=>n+Array.from(p.text).length,0)}));
  const audit={realModelReplay:true,productionEnabled:false,comparisons,full,repeats:result.repeats,syntheticGuards:result.guards || null,byStage,requests:requests.length,reportedTotalTokens:requests.reduce((n,r)=>n+(r.usage.totalTokens || 0),0),unknownUsageRequests:requests.filter(r=>r.completeness!=='complete').length,cost:null,businessStages,fullOver150:full.filter(f=>f.nodes.some(n=>Array.from(n.text).length>150)).map(f=>f.sourceId),baseline76RequestsExcluded:true};
  fs.writeFileSync(path.join(dir,'audit.json'),JSON.stringify(audit,null,2));fs.writeFileSync(path.join(dir,'usage.json'),JSON.stringify(usage,null,2));
  const text=['# 本轮真实回放对照','',`固定目标 ${comparisons.length} 篇；完整正文队列 ${full.length} 篇，成功 ${full.filter(f=>f.nodes.length).length} 篇；重复 ${result.repeats.length} 次。实际请求 ${audit.requests}，已报告总Token ${audit.reportedTotalTokens}，用量不完整请求 ${audit.unknownUsageRequests}；供应商金额未知。`,'','A是旧真实结果；B为新Skill及旧分类；C复用正文并修主分类和阅读归组。此文件不判断来源真伪，失败和全部重复结果保留。',''];
  for(const row of comparisons){text.push(`## ${row.sourceId}`,'',`来源范围 ${row.scope}；正文 ${row.bodyCharacters} 字；B→C正文复用 ${row.textReusedBtoC}。`,'');for(const label of ['A','B','C']){const n=row[label];text.push(`${label}：${n ? `${n.tagId ?? 'null'} / ${Array.from(n.text).length}字 / ${n.text}` : '无成功信息稿'}`,'');}}
  text.push('## 完整正文及全部重复','',...full.map(f=>`${f.sourceId}：${f.nodes.length ? f.nodes.map(n=>`${Array.from(n.text).length}字 / ${n.text}`).join('；') : JSON.stringify(f.pending)}`),'',...result.repeats.map(r=>`${r.sourceId} repeat${r.repeat}：${r.nodes.length ? r.nodes.map(n=>`${Array.from(n.text).length}字 / ${n.text}`).join('；') : JSON.stringify(r.pending)}`));
  if(result.guards)text.push('','## 合成语义边界实际模型输出（不计入保存新闻）','',...result.guards.nodes.map(n=>`${n.sourceId}：${n.text}`),'',JSON.stringify(result.guards.pending));
  fs.writeFileSync(path.join(dir,'comparison.md'),text.join('\n'));console.log(JSON.stringify({requests:audit.requests,totalTokens:audit.reportedTotalTokens,full:full.length,fullOver150:audit.fullOver150.length,byStage}));
}finally{db.close();}
