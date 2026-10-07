import Database from 'better-sqlite3';
import {resolveInstanceConfig} from '../packages/instance/src/index.js';
import {createStore} from '../packages/database/src/index.js';
const instance=resolveInstanceConfig(),db=new Database(instance.databasePath,{readonly:true,fileMustExist:true});
let ids;
try{ids=db.prepare("SELECT id FROM jobs WHERE workspace_id='local' AND type='report.information.prepare' AND status='queued' AND attempt_count=0 AND json_array_length(input_json,'$.sourceIds')>1 ORDER BY created_at LIMIT 100").all().map(r=>r.id);}finally{db.close();}
if(!process.argv.includes('--apply'))console.log(JSON.stringify({queuedBatches:ids.length,apply:'node scripts/split-tree-preparation.mjs --apply'}));
else {
  const store=createStore(instance.databasePath);
  try{const result=store.splitQueuedInformationPreparation('local',ids);console.log(JSON.stringify({splitBatches:result.length,createdJobs:result.reduce((sum,r)=>sum+r.jobIds.length,0),result}));}finally{store.close();}
}
