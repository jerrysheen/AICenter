// Dry-run by default. --run requires an explicit comma-separated ID set.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import { EXTRACTOR_VERSION } from '../packages/connectors/src/media/article-html.js';
const instance=resolveInstanceConfig({repositoryRoot:process.cwd()});
const db=new Database(instance.databasePath,{readonly:true});
const legacy=db.prepare(`SELECT e.external_id externalId,e.source_key sourceKey,e.body_hash bodyHash,
  (SELECT article_json FROM media_body_snapshots b WHERE b.workspace_id=e.workspace_id AND b.external_id=e.external_id AND b.body_hash=e.body_hash ORDER BY revision DESC LIMIT 1) article
  FROM media_index_entries e WHERE content_level=?`).all('full')
  .filter(row=>JSON.parse(row.article || '{}').extractorVersion!==EXTRACTOR_VERSION).map(({article,...row})=>row);
const destination=path.join(instance.runtimeDirectory,'media-audit','legacy-repair-plan.json');
fs.mkdirSync(path.dirname(destination),{recursive:true});
fs.writeFileSync(destination,JSON.stringify({observedAt:new Date().toISOString(),legacy},null,2)+'\n');
console.log(JSON.stringify({mode:'dry-run',legacy},null,2));
const index=process.argv.indexOf('--ids');
const ids=index>=0 ? process.argv[index+1].split(',').filter(Boolean) : [];
const known=new Map(db.prepare('SELECT external_id,source_key FROM media_index_entries').all().map(r=>[r.external_id,r.source_key]));
db.close();
if(process.argv.includes('--run')) {
  if(!ids.length || ids.length>40 || ids.some(id=>!known.has(id))) throw new Error('--run requires 1–40 explicit existing IDs');
  const body={externalIds:ids,repair:true};
  if(process.argv.includes('--acknowledge')) { body.usageReviewed=true;body.sourceKeys=[...new Set(ids.map(id=>known.get(id)))]; }
  const response=await fetch(`http://127.0.0.1:${instance.port}/api/v1/feed/media/bodies`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();
  if(response.status!==202) throw new Error(JSON.stringify(result));
  fs.writeFileSync(path.join(instance.runtimeDirectory,'media-audit','repair-job.json'),JSON.stringify({jobId:result.jobId,externalIds:ids},null,2)+'\n');
  console.log(JSON.stringify({mode:'queued',...result}));
}
