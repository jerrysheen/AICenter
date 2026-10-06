import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {resolveInstanceConfig} from '../packages/instance/src/index.js';
import {createStore} from '../packages/database/src/index.js';
import {createHardwareArtifactStore} from '../packages/connectors/src/hardware-artifacts.js';
import {createHardwarePriceService} from '../packages/domain/src/hardware-price-service.js';
import {createSourceModuleRegistry} from '../packages/source/src/module-registry.js';
import {createJobRunner} from '../packages/runtime/src/job-runner.js';

if(process.argv.slice(2).some(arg=>arg!=='--run'))throw new Error('Only --run is supported. Without it this script is read-only.');
const instance=resolveInstanceConfig(),database=new Database(instance.databasePath,{readonly:true});
const originals=database.prepare('SELECT * FROM hardware_price_snapshots ORDER BY id').all();
const fingerprint=db=>createHash('sha256').update(JSON.stringify({
  content:db.prepare("SELECT ci.*,c.metadata_json FROM content_items ci JOIN captures c ON c.id=ci.capture_id WHERE c.provider='trendforce' ORDER BY ci.id").all(),
  states:db.prepare('SELECT * FROM user_item_states ORDER BY workspace_id,content_item_id').all(),
  tags:db.prepare('SELECT * FROM resource_taggings ORDER BY workspace_id,resource_type,resource_id').all(),
})).digest('hex');
const initial=fingerprint(database);
if(!process.argv.includes('--run')) {
  console.log(JSON.stringify({mode:'inspect',savedSnapshots:originals.length,htmlSnapshots:originals.filter(s=>s.format==='html').length}));database.close();
} else {
  const backup=path.join(instance.runtimeDirectory,'backups',`hardware-before-reparse-${Date.now()}.db`);mkdirSync(path.dirname(backup),{recursive:true});await database.backup(backup);database.close();
  const store=createStore(instance.databasePath);
  try {
    const hardwarePriceService=createHardwarePriceService({repository:store.repositories.hardwarePrices,artifactStore:createHardwareArtifactStore({dataDirectory:instance.dataDirectory})});
    const registry=createSourceModuleRegistry({hardwarePriceService});const handler=registry.createJobHandlers()['feed.trendforce.reparse'];
    const job=store.createJob({type:'feed.trendforce.reparse',workspaceId:'local',input:{workspaceId:'local'},maxAttempts:1});
    const runner=createJobRunner({store,handlers:{'feed.trendforce.reparse':handler}});
    while(store.getJob(job.id).status==='queued')await runner.runOnce();
    const result=store.getJob(job.id);if(result.status!=='completed')throw new Error(result.error || result.status);
    const repeated=await handler({workspaceId:'local'},{job:{workspaceId:'local'}});
    const after=new Database(instance.databasePath,{readonly:true});
    try {
      if(initial!==fingerprint(after))throw new Error('Original content or user state changed.');
      for(const saved of originals)if(JSON.stringify(after.prepare('SELECT * FROM hardware_price_snapshots WHERE id=?').get(saved.id))!==JSON.stringify(saved))throw new Error('Original snapshot changed.');
    }finally{after.close();}
    const items=hardwarePriceService.list('local',{limit:500}).items;
    console.log(JSON.stringify({mode:'reparsed',result:result.output,repeated,originalsIntact:true,series:items.length,withHistory:items.filter(r=>r.history.length>1).length,
      malformed:items.filter(r=>/日高點:|日低點:/.test(r.specification)).length,backup:path.relative(instance.instanceRoot,backup)}));
  }finally{store.close();}
}
