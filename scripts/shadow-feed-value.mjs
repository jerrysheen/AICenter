import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync,writeFileSync,appendFileSync,mkdirSync,existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import { readFeedQualityWindow } from '../packages/database/src/repositories/feed-quality-audit-repository.js';
import { createTypeSafeSystemOneClient } from '../packages/connectors/src/typesafe-system-one.js';
import { openJevClient } from '../packages/domain/src/jev-enabled.js';
import { FeedValueReferenceSchema } from '../packages/contracts/src/feed-value.js';
import { createFeedQualityEvaluator,decideFeedQuality } from '../packages/domain/src/feed-quality.js';
import { normalizeFeedValueText,createFeedValueEvaluator,decideFeedValue,calibrateFeedValue,
  decideFeedQualityWithoutScope,feedValuePolicyHash,FEED_VALUE_VERSION } from '../packages/domain/src/feed-value.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const instance=resolveInstanceConfig({repositoryRoot:root});
const args=process.argv.slice(2),opt=(k,d)=>args.find(a=>a.startsWith(`--${k}=`))?.slice(k.length+3)||d;
const day=opt('day','2026-10-04');if(!/^\d{4}-\d{2}-\d{2}$/.test(day))throw new Error('Invalid day');
const oldDir=path.join(instance.runtimeDirectory,'feed-quality-audit',`${day}-feed-quality-v2.0`);
const dir=path.join(instance.runtimeDirectory,'feed-quality-audit',`${day}-${FEED_VALUE_VERSION}`);
mkdirSync(dir,{recursive:true});
const read=(base,name)=>JSON.parse(readFileSync(path.join(base,name),'utf8'));
const save=(name,data)=>writeFileSync(path.join(dir,name),JSON.stringify(data,null,2));
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const old=read(oldDir,'results.json'),oldRef=read(oldDir,'review-set.json');
const oldMap=new Map(old.items.map(i=>[i.id,i]));
const counts=rows=>rows.reduce((a,r)=>{const d=r.decision;a[d.decision]=(a[d.decision]||0)+1;
  a.reasons[d.reason]=(a.reasons[d.reason]||0)+1;return a;},{KEEP:0,DROP:0,REVIEW:0,reasons:{}});
if(!existsSync(path.join(dir,'corpus.json'))) {
  const db=new Database(instance.databasePath,{readonly:true});let snapshot;
  try{snapshot=readFeedQualityWindow(db,{startAt:old.summary.manifest.startAt,endAt:old.summary.manifest.endAt});}finally{db.close();}
  const metadata=new Map(snapshot.feed.map(r=>[`feed:${r.id}`,JSON.parse(r.metadata_json||'{}')]));
  const items=old.items.map(i=>{const m=metadata.get(i.id),exact=m?.originalText===i.rawText;
    return {...i,input:normalizeFeedValueText(i.rawText,{title:i.title,authorName:i.author,
      bodyMissing:i.input.bodyMissing,truncated:i.input.truncated,keyContextMissing:i.input.keyContextMissing,
      capture:exact?(m.captureContext||{}):{}}),captureMetadataMatched:exact||false};});
  save('corpus.json',{manifest:{...old.summary.manifest,readingScope:undefined,version:FEED_VALUE_VERSION,
    normalizationHash:hash(items.map(i=>[i.id,i.input])),policyHash:feedValuePolicyHash()},items});
  const used=new Set(oldRef.rows.map(r=>r.id)); const fresh=[];
  for(const source of [...new Set(items.map(i=>i.source))])fresh.push(...items.filter(i=>i.source===source&&!used.has(i.id))
    .sort((a,b)=>hash(a.id).localeCompare(hash(b.id))).slice(0,8));
  const rows=[...oldRef.rows.map(r=>({...r,split:'seen-regression-calibration',priorLabel:r.referenceLabel,
    quality:'UNREVIEWED',qualityEvidence:'',completeness:r.referenceLabel==='INCOMPLETE'?'SUSPECTED_MISSING':'UNREVIEWED',
    completenessEvidence:'',interest:r.referenceLabel==='OUT_OF_SCOPE'?'outside-prior-scope':'not-reassessed'})),
    ...fresh.map(i=>({id:i.id,title:i.title,split:'fresh-holdout',quality:'UNREVIEWED',qualityEvidence:'',
      completeness:'UNREVIEWED',completenessEvidence:'',interest:'not-reassessed'}))];
  save('review-set.json',{annotationSource:'Codex AI-assisted, not human truth',oldSetIsSeen:true,
    freshSelection:'8 per source, deterministic ID hash, excludes old 200, selected before new scores',
    freshSampleHash:hash(fresh.map(i=>i.id)),rows});
}
const corpus=read(dir,'corpus.json'),refs=read(dir,'review-set.json');
refs.rows.forEach(r=>FeedValueReferenceSchema.parse(r));
const a=old.items.map(i=>({id:i.id,decision:decideFeedQualityWithoutScope(i.scores,{input:i.input,errorReason:i.errorReason})}));
save('stage-a.json',{warning:'Old interest-conditioned V2 probabilities; not new topic-free scoring',counts:counts(a),items:a});
if(args.includes('--prepare')){console.log(JSON.stringify({dir,items:corpus.items.length,old:oldRef.rows.length,fresh:refs.rows.filter(r=>r.split==='fresh-holdout').length,A:counts(a)}));process.exit(0);}
const stage=opt('stage','C');if(!['B','C'].includes(stage))throw new Error('Stage B or C');
const model=opt('model','jev-1.13.0'),client=openJevClient(process.env, undefined, (options) => createTypeSafeSystemOneClient({...options,model,timeoutMs:30000}));
if(!client) throw new Error('AI_CENTER_JEV_ENABLED=false，不调用 TypeSafe');
if(!client.available())throw new Error('JEV unavailable; no fabricated scores');
const evaluator=stage==='C'?createFeedValueEvaluator({client,model}):createFeedQualityEvaluator({client,model,readingScope:old.summary.manifest.readingScope});
const bInput=i=>({...oldMap.get(i.id).input,body:[i.input.body,...i.input.continuations.map(p=>p.text),...i.input.references.map(p=>p.text)].filter(Boolean).join('\n\n'),
  bodyMissing:i.input.bodyMissing,truncated:i.input.truncated,keyContextMissing:i.input.keyContextMissing});
const inputOf=i=>stage==='C'?i.input:bInput(i);
const cacheFile=path.join(dir,`scores-${stage.toLowerCase()}.jsonl`);
const cached=existsSync(cacheFile)?readFileSync(cacheFile,'utf8').split('\n').filter(Boolean).map(s=>JSON.parse(s)):[];
const scoreMap=new Map(cached.filter(r=>r.requestedModel===model).map(r=>[r.id,r]));
for(const i of corpus.items)if(scoreMap.get(i.id)?.cacheKey!==evaluator.cacheKey(inputOf(i)))scoreMap.delete(i.id);
const oldBUnchanged=i=>hash(inputOf(i))===hash(oldMap.get(i.id).input);
if(stage==='B')for(const i of corpus.items.filter(oldBUnchanged))scoreMap.set(i.id,{...oldMap.get(i.id),reusedOldRequest:true});
const pending=corpus.items.filter(i=>!scoreMap.has(i.id));
console.log(JSON.stringify({stage,pending:pending.length,count:corpus.items.length,dir}));
let cursor=0,done=0,failed=0;
await Promise.all(Array.from({length:4},async()=>{while(cursor<pending.length){const i=pending[cursor++];
  const score=await evaluator.evaluate(inputOf(i));const row={id:i.id,...score,requestedModel:model};
  appendFileSync(cacheFile,JSON.stringify(row)+'\n');scoreMap.set(i.id,row);done++;
  if(score.errorReason==='jev-failed')failed++;
  if(done%200===0||done===pending.length)console.log(JSON.stringify({stage,done,failed}));
  if(done>=12&&failed/done>.5)throw new Error('Repeated provider failure; resume without losing cache');
}}));
if(stage==='B'){
  const rows=corpus.items.map(i=>{const s=scoreMap.get(i.id);let decision=decideFeedQuality(s.scores,{input:bInput(i),errorReason:s.errorReason});
    if(decision.decision==='DROP'&&i.input.suspectedContinuation)decision={decision:'REVIEW',reason:'context-unconfirmed'};
    return {id:i.id,input:bInput(i),scores:s.scores,decision,reusedOldRequest:s.reusedOldRequest||false};});
  save('stage-b.json',{warning:'Old V2 questions/range; input repair only',counts:counts(rows),rescored:pending.length,items:rows});
  console.log(JSON.stringify({stage,counts:counts(rows),rescored:pending.length}));process.exit(0);
}
const inputs=new Map(corpus.items.map(i=>[i.id,i.input]));
const training=refs.rows.filter(r=>r.split==='seen-regression-calibration').map(r=>({...r,input:inputs.get(r.id),scores:scoreMap.get(r.id)?.scores}));
const calibration=calibrateFeedValue(training,{model,sampleHash:hash(training.map(r=>({id:r.id,quality:r.quality,completeness:r.completeness,qualityEvidence:r.qualityEvidence,mainInformationComplete:r.mainInformationComplete}))) });
if(existsSync(path.join(dir,'calibration-freeze.json'))&&hash(read(dir,'calibration-freeze.json').calibration)!==hash(calibration))
  throw new Error('Frozen calibration differs; never silently refit after holdout review');
// Freeze calibration before using holdout labels; no fitting on fresh-holdout.
save('calibration.json',calibration);
const rows=corpus.items.map(i=>{const s=scoreMap.get(i.id);return{id:i.id,source:i.source,tagStatus:i.tagStatus,tags:i.tags,title:i.title,url:i.url,
  input:i.input,scores:s.scores,errorReason:s.errorReason,model:s.model,
  decision:decideFeedValue(s.scores,{input:i.input,calibration,model:s.model,errorReason:s.errorReason})};});
const evaluated=new Map(rows.map(i=>[i.id,i]));
const metrics=split=>{const sample=refs.rows.filter(r=>r.split===split);const m={total:sample.length,quality:{},decisions:{}};
  for(const r of sample){const d=evaluated.get(r.id).decision;const key=`${r.quality}/${r.completeness}`;m.quality[key]=(m.quality[key]||0)+1;
    const k=`${r.quality}:${d.decision}`;m.decisions[k]=(m.decisions[k]||0)+1;}
  return m;};
const tracked=oldRef.rows.filter(r=> (r.referenceLabel==='GOOD'&&oldMap.get(r.id).decisions.balanced.decision!=='KEEP')
  || (r.referenceLabel==='INCOMPLETE'&&oldMap.get(r.id).decisions.balanced.decision==='DROP'))
  .map(r=>({id:r.id,title:r.title,priorLabel:r.referenceLabel,old:oldMap.get(r.id).decisions.balanced,A:a.find(i=>i.id===r.id).decision,
    B:existsSync(path.join(dir,'stage-b.json'))?read(dir,'stage-b.json').items.find(i=>i.id===r.id)?.decision:null,
    C:evaluated.get(r.id).decision,quality:refs.rows.find(i=>i.id===r.id).quality}));
const summary={version:FEED_VALUE_VERSION,counts:counts(rows),calibration,oldSetIsSeen:true,
  annotationSource:refs.annotationSource,productionEnforceEnabled:false,
  bySource:Object.fromEntries([...new Set(rows.map(i=>i.source))].map(k=>[k,counts(rows.filter(i=>i.source===k))])),
  byTagStatus:Object.fromEntries(['tagged','empty','pending'].map(k=>[k,counts(rows.filter(i=>i.tagStatus===k))])),
  seen:metrics('seen-regression-calibration'),firstHoldoutDiagnostic:metrics('first-holdout-diagnostic'),
  fresh:metrics('fresh-holdout'),tracked};
save('results.json',{summary,items:rows});save('summary.json',summary);
const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>保存价值 V3 对照</title><style>body{max-width:1100px;margin:32px auto;padding:0 20px;font:15px/1.7 system-ui}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:8px;text-align:left}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>保存价值 V3 对照</h1><p>仅 shadow。旧200条是已见材料；新${summary.fresh.total}条为评分前选定的辅助复核样本。全部标签均不是人工真值。</p><pre>${escape(JSON.stringify({...summary,tracked:undefined},null,2))}</pre><h2>原问题样本去向</h2><table><tr><th>材料</th><th>V2</th><th>A</th><th>B</th><th>C</th><th>新质量参考</th></tr>${tracked.map(r=>`<tr><td>${escape(r.title)}</td>${[r.old,r.A,r.B,r.C].map(d=>`<td>${escape(d?d.decision+' / '+d.reason:'未运行')}</td>`).join('')}<td>${escape(r.quality)}</td></tr>`).join('')}</table><p>逐条输入和分数保存为旁边的 results.json；本页不内嵌全量原文。</p></html>`;
writeFileSync(path.join(dir,'report.html'),html);
console.log(JSON.stringify({stage,counts:summary.counts,calibration,seen:summary.seen,fresh:summary.fresh,reportBytes:Buffer.byteLength(html)}));
