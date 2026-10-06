import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {resolveInstanceConfig} from '../packages/instance/src/index.js';
import {createStore} from '../packages/database/src/index.js';
import {createAiCenterWorker} from '../apps/worker/src/worker.js';
import {createScheduler} from '../packages/runtime/src/scheduler.js';

// Uses registered Worker handlers and automatic enrichment; never supplies article IDs.
if (!process.argv.includes('--run')) {
  console.log('Add --run to perform one scheduled media acceptance run using the current media configuration.');
  process.exit(0);
}
const instance=resolveInstanceConfig({repositoryRoot:process.cwd()});
const repeat=process.argv.includes('--repeat');
const runningWorker=process.argv.includes('--running-worker');
const dir=path.join(instance.runtimeDirectory,'media-audit','native-channels');
fs.mkdirSync(dir,{recursive:true});
const readDb=new Database(instance.databasePath,{readonly:true});
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
await readDb.backup(path.join(dir,`before-${stamp}.db`));
const beforeStates=readDb.prepare('SELECT content_item_id,is_read,is_hidden FROM user_item_states').all();
const beforeIds=readDb.prepare('SELECT external_id FROM media_index_entries').all().map(r=>r.external_id);
const beforeCounts=readDb.prepare('SELECT COUNT(*) count FROM media_body_snapshots').get();
readDb.close();
const store=createStore(instance.databasePath);
const scheduler=createScheduler({store,allowedJobTypes:['media.sources.sync']});
const worker=runningWorker?null:createAiCenterWorker({store,instanceConfig:instance,scheduler,enableDefaultSchedules:false});
const key='media-channel-acceptance';
const at=Date.now();
// A bounded acceptance schedule, disabled after the run. The regular schedule is unchanged.
const schedule=repeat?null:store.upsertJobSchedule({workspaceId:'local',key,jobType:'media.sources.sync',enabled:true,
  schedule:{kind:'interval',intervalMinutes:60},input:{},maxAttempts:1,nextRunAt:at});
let result;
try {
  const queued=repeat?[store.createJob({type:'media.sources.sync',input:{channel:'macro',force:true},maxAttempts:1})]:await scheduler.tick(at);
  console.log(JSON.stringify({phase:'scheduled',jobs:queued.map(j=>j.jobId || j.id)}));
  const outputs=[];
  for(let i=0;i<5;i++) {
    const pending=store.listJobs(100).filter(j=>['media.sources.sync','media.index.enrich'].includes(j.type)&&(j.status==='queued'||runningWorker&&j.status==='running'));
    if(!pending.length)break;
    console.log(JSON.stringify({phase:'worker',types:pending.map(j=>j.type)}));
    if(worker)await worker.runner.runOnce();
    else {
      const deadline=Date.now()+1800000;
      while(pending.some(prior=>['queued','running'].includes(store.getJob(prior.id).status))) {
        if(Date.now()>deadline)throw new Error('Running Worker acceptance job timeout');
        await new Promise(resolve=>setTimeout(resolve,1000));
      }
    }
    for(const prior of pending) {
      const job=store.getJob(prior.id);
      if(job.status==='completed'||job.status==='failed')outputs.push({id:job.id,type:job.type,input:job.input,status:job.status,output:job.output,error:job.error});
    }
  }
  for(const job of store.listJobs(100).filter(j=>j.type==='media.index.enrich'&&j.createdAt>=at&&['completed','failed'].includes(j.status))) {
    if(!outputs.some(item=>item.id===job.id))outputs.push({id:job.id,type:job.type,input:job.input,status:job.status,output:job.output,error:job.error});
  }
  const db=new Database(instance.databasePath,{readonly:true});
  const keys=['bbc','bbcworld','guardian','guardianworld','yahooeconomy'];
  const sync=outputs.find(j=>j.type==='media.sources.sync');
  const comparisons=(sync?.output?.results || []).filter(r=>keys.includes(r.sourceKey)).map(r=>({...r,
    comparisons:(r.comparisons || []).map(item=>{
      const row=db.prepare('SELECT status,publisher_key,publisher_name,fetch_state_json FROM media_index_entries WHERE workspace_id=? AND external_id=?').get('local',item.externalId);
      const state=JSON.parse(row?.fetch_state_json || '{}');
      return {...item,indexStatus:row?.status || item.status,publisherKey:row?.publisher_key,publisherName:row?.publisher_name,
        bodyStatus:state.fetchStatus || 'pending',bodyReason:state.extractionReason || ''};
    })}));
  const afterStates=db.prepare('SELECT content_item_id,is_read,is_hidden FROM user_item_states').all();
  const afterIds=new Set(db.prepare('SELECT external_id FROM media_index_entries').all().map(r=>r.external_id));
  const snapshots=db.prepare(`SELECT e.external_id,e.source_key,b.body_text,b.article_json FROM media_index_entries e
    JOIN media_body_snapshots b ON b.workspace_id=e.workspace_id AND b.external_id=e.external_id AND b.body_hash=e.body_hash
    WHERE e.source_key IN ('bbc','bbcworld','guardian','guardianworld','reuterswire','bloombergwire','yahooeconomy') AND b.content_level='full'`).all();
  result={observedAt:new Date().toISOString(),outputs,comparisons,
    budget:db.prepare('SELECT * FROM media_budget_days ORDER BY day_key DESC LIMIT 1').get(),
    identitiesPreserved:beforeIds.every(id=>afterIds.has(id)),readingStatesPreserved:beforeStates.every(row=>afterStates.some(s=>s.content_item_id===row.content_item_id&&s.is_read===row.is_read&&s.is_hidden===row.is_hidden)),
    bodySnapshotsBefore:beforeCounts.count,bodySnapshotsAfter:db.prepare('SELECT COUNT(*) count FROM media_body_snapshots').get().count,
    savedBodyBoundaries:snapshots.map(row=>{
      const article=JSON.parse(row.article_json || '{}');
      const paragraphs=article.paragraphs || [];
      return {externalId:row.external_id,sourceKey:row.source_key,bodyHash:createHash('sha256').update(row.body_text).digest('hex'),paragraphs:paragraphs.length,
        firstHash:createHash('sha256').update(paragraphs[0]?.text || '').digest('hex'),lastHash:createHash('sha256').update(paragraphs.at(-1)?.text || '').digest('hex'),
        note:'stored snapshot only; no extra article request made for audit'};
    })};
  db.close();
  const reportName=runningWorker?'acceptance-running-worker.json':repeat?'acceptance-repeat.json':'acceptance.json';
  fs.writeFileSync(path.join(dir,reportName),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({phase:'complete',report:path.join(dir,reportName),channels:comparisons.map(r=>({sourceKey:r.sourceKey,health:r.health,added:r.added,firstTen:r.comparisons.length,indexed:r.comparisons.filter(i=>i.indexed).length})),budget:result.budget,identitiesPreserved:result.identitiesPreserved,readingStatesPreserved:result.readingStatesPreserved},null,2));
} finally {
  if(schedule)store.upsertJobSchedule({...schedule,enabled:false,nextRunAt:at});
  if(worker)await worker.close();else store.close();
}
