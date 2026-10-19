import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {resolveInstanceConfig} from '../packages/instance/src/index.js';
import {loadMediaConfig} from '../packages/instance/src/media-config.js';
import {loadFeedValueCalibration} from '../packages/instance/src/feed-value-config.js';
import {createStore} from '../packages/database/src/index.js';
import {createMediaConnector} from '../packages/connectors/src/media/port.js';
import {createTypeSafeSystemOneClient} from '../packages/connectors/src/typesafe-system-one.js';
import {openJevClient} from '../packages/domain/src/jev-enabled.js';
import {legacyPriceSnapshot} from '../packages/connectors/src/trendforce-prices.js';
import {createHardwareArtifactStore} from '../packages/connectors/src/hardware-artifacts.js';
import {createHardwarePriceService} from '../packages/domain/src/hardware-price-service.js';
import {createContentRoutingService} from '../packages/domain/src/content-routing-service.js';
import {createMediaIngestionService} from '../packages/domain/src/media-ingestion-service.js';
import {createFeedFilterFromEnv} from '../packages/domain/src/feed-filter.js';
import {createSourceModuleRegistry} from '../packages/source/src/module-registry.js';
import {createJobRunner} from '../packages/runtime/src/job-runner.js';

const repositoryRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const instance=resolveInstanceConfig({repositoryRoot});
if(process.argv.slice(2).some(arg=>arg!=='--run'))throw new Error('Only --run is supported; without it this script is read-only.');
const before=new Database(instance.databasePath,{readonly:true});
function fingerprint(database) {
  const rows=database.prepare(`SELECT ci.*,c.external_id,c.content_hash,c.metadata_json,c.captured_at,c.raw_artifact_path
    FROM content_items ci JOIN captures c ON c.id=ci.capture_id WHERE c.provider='trendforce' ORDER BY ci.id`).all();
  const ids=JSON.stringify(rows.map(r=>r.id));
  const states=database.prepare('SELECT * FROM user_item_states WHERE content_item_id IN (SELECT value FROM json_each(?)) ORDER BY content_item_id').all(ids);
  const tags=database.prepare("SELECT * FROM resource_taggings WHERE resource_type='content-item' AND resource_id IN (SELECT value FROM json_each(?)) ORDER BY resource_id").all(ids);
  return createHash('sha256').update(JSON.stringify({rows,states,tags})).digest('hex');
}
const initial=fingerprint(before);
const count=before.prepare("SELECT count(*) n FROM content_items ci JOIN captures c ON c.id=ci.capture_id WHERE c.provider='trendforce'").get().n;
if(!process.argv.includes('--run')) {
  console.log(JSON.stringify({mode:'inspect',schemaVersion:before.pragma('user_version',{simple:true}),legacyItems:count,run:'node scripts/migrate-trendforce-content.mjs --run'}));
  before.close();
} else {
  const backup=path.join(instance.runtimeDirectory,'backups',`trendforce-before-routing-v${before.pragma('user_version',{simple:true})}-${Date.now()}.db`);
  mkdirSync(path.dirname(backup),{recursive:true});await before.backup(backup);before.close();
  const store=createStore(instance.databasePath);
  try {
    const feedFilter=createFeedFilterFromEnv({env:process.env,client:openJevClient(process.env, undefined, (options)=>createTypeSafeSystemOneClient(options)),calibration:loadFeedValueCalibration(instance)});
    const media=createMediaIngestionService({mediaRepository:store.repositories.media,feedRepository:store.repositories.feed,taggingRepository:store.repositories.tagging,
      mediaPort:createMediaConnector(loadMediaConfig(instance.configDirectory)),feedFilter});
    const hardware=createHardwarePriceService({repository:store.repositories.hardwarePrices,artifactStore:createHardwareArtifactStore({dataDirectory:instance.dataDirectory})});
    const routing=createContentRoutingService({mediaService:media,hardwarePrices:hardware,feedRepository:store.repositories.feed,legacyPricePort:legacyPriceSnapshot});
    const registry=createSourceModuleRegistry({mediaService:media,migrateTrendforce:workspaceId=>routing.migrate(workspaceId)});
    const handler=registry.createJobHandlers()['feed.trendforce.migrate'];
    const job=store.createJob({type:'feed.trendforce.migrate',workspaceId:'local',input:{workspaceId:'local'},maxAttempts:1});
    // runOnce claims only this registered handler; it never recovers or abandons unrelated live jobs.
    const runner=createJobRunner({store,handlers:{'feed.trendforce.migrate':handler}});
    while(store.getJob(job.id).status==='queued')await runner.runOnce();
    const result=store.getJob(job.id);if(result.status!=='completed')throw new Error(result.error || `migration job ${result.status}`);
    const repeated=await routing.migrate('local');
    const after=new Database(instance.databasePath,{readonly:true});let intact;try {intact=fingerprint(after)===initial;}finally {after.close();}
    if(!intact)throw new Error('Legacy content or user state changed during migration; backup is retained.');
    console.log(JSON.stringify({mode:'migrated',legacyItems:count,result:result.output,repeated,legacyIntact:intact,
      quoteSeries:hardware.list('local',{limit:500}).items.length,backup:path.relative(instance.instanceRoot,backup)}));
  }finally {store.close();}
}
