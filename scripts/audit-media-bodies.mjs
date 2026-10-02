import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';

const instance = resolveInstanceConfig({ repositoryRoot: process.cwd() });
const db = new Database(instance.databasePath, { readonly: true, fileMustExist: true });
const sql = `WITH latest AS (SELECT workspace_id,external_id,MAX(revision) revision FROM media_body_snapshots GROUP BY workspace_id,external_id)
 SELECT e.source_key,e.external_id,e.canonical_url,e.content_level,e.status,e.revision index_revision,
 length(e.summary) summary_chars,b.revision snapshot_revision,length(b.body_text) body_chars,
 length(CAST(b.body_text AS BLOB)) body_bytes,b.body_hash,b.truncated,
 c.id content_item_id,length(c.body) content_item_chars
 FROM media_index_entries e LEFT JOIN latest l USING(workspace_id,external_id)
 LEFT JOIN media_body_snapshots b ON b.workspace_id=l.workspace_id AND b.external_id=l.external_id AND b.revision=l.revision
 LEFT JOIN captures cap ON cap.workspace_id=e.workspace_id AND cap.provider='media' AND cap.external_id=e.external_id
 LEFT JOIN content_items c ON c.capture_id=cap.id ORDER BY e.source_key,e.external_id`;
const rows = db.prepare(sql).all();
const sources = [...new Set(rows.map(r => r.source_key))].map(key => {
  const group = rows.filter(r => r.source_key === key);
  const bodies = group.filter(r => r.body_chars > 0);
  return { sourceKey: key, indexed: group.length, labelledFull: group.filter(r => r.content_level === 'full').length,
    withSnapshot: bodies.length, minBodyChars: bodies.length ? Math.min(...bodies.map(r => r.body_chars)) : null,
    maxBodyChars: bodies.length ? Math.max(...bodies.map(r => r.body_chars)) : null,
    fullWithoutSnapshot: group.filter(r => r.content_level === 'full' && !r.body_chars).length,
    projectionMismatch: bodies.filter(r => r.body_chars !== r.content_item_chars).length };
});
const output = { observedAt: new Date().toISOString(), runtime: process.version,
  database: path.relative(instance.repositoryRoot, instance.databasePath).replaceAll('\\', '/'),
  schemaVersion: db.pragma('user_version', { simple: true }), sources, rows,
  states: db.prepare('SELECT source_key,enabled,host_direct_verified,body_use_acknowledged,health,last_sync_at,last_probe_json FROM media_source_states').all().map(({last_probe_json,...state})=>({...state,probe:JSON.parse(last_probe_json || 'null')})),
  budgets: db.prepare('SELECT * FROM media_budget_days ORDER BY day_key DESC LIMIT 7').all(),
  recentJobs: db.prepare("SELECT type,status,output_json,error_json,updated_at FROM jobs WHERE type LIKE 'media.%' ORDER BY updated_at DESC LIMIT 10").all().map(row => {
    const result = JSON.parse(row.output_json || '{}');
    return { type: row.type, status: row.status, updatedAt: row.updated_at,
      health: result.health || null, bodyStats: result.bodyStats || null,
      indexResults: result.results?.map(r=>({sourceKey:r.sourceKey,health:r.health,added:r.added,deferred:r.deferred || 0})) || [],
      briefs: result.briefs?.map(b => ({externalId: b.externalId,status: b.status})) || [],
      error: row.error_json ? JSON.parse(row.error_json) : null };
  }),
  failureObservation: db.prepare("PRAGMA table_info(media_index_entries)").all().some(r => r.name === 'fetch_state_json') ? 'recorded in fetch_state_json' : '当前未记录逐篇失败原因' };
db.close();
const outputIndex = process.argv.indexOf('--output');
if (outputIndex >= 0) {
  const destination = process.argv[outputIndex + 1];
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify(output, null, 2) + '\n');
}
console.log(JSON.stringify({ ...output, rows: `${rows.length} rows in output file` }, null, 2));
