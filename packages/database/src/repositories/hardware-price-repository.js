import { randomUUID, createHash } from 'node:crypto';
import { HardwarePriceSnapshotInputSchema, HardwareQuoteRowSchema } from '../../../contracts/src/hardware-prices.js';
import { retireSupersededHardwareQuotes } from '../hardware-price-current.js';
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const snapshot = r => r ? ({id:r.id,sourceKey:r.source_key,pageKey:r.page_key,sourceUrl:r.source_url,title:r.title,capturedAt:r.captured_at,
  lastCheckedAt:r.last_checked_at || r.captured_at,lastChangedAt:r.captured_at,
  format:r.format,parserVersion:r.parser_version,artifactPath:r.artifact_path,warnings:JSON.parse(r.warnings_json)}) : null;
const observation = r => r ? ({...JSON.parse(r.row_json),id:r.id,seriesKey:r.series_key,revision:r.revision,previousId:r.previous_id,
  snapshotId:r.snapshot_id,capturedAt:r.captured_at,isCurrent:Boolean(r.is_current)}) : null;
export function createHardwarePriceRepository(database,emitEvent=()=>{}) {
  return {
    save(workspaceId,input,artifact) {
      const value=HardwarePriceSnapshotInputSchema.parse(input);
      for(const row of value.rows) HardwareQuoteRowSchema.parse(row);
      const touchPage=(snapshotId)=>{
        const existing=database.prepare('SELECT * FROM hardware_price_page_checks WHERE workspace_id=? AND source_key=? AND page_key=?').get(workspaceId,value.sourceKey,value.pageKey);
        const changed=!existing || existing.content_hash!==artifact.hash;
        const lastChangedAt=changed ? value.capturedAt : existing.last_changed_at;
        database.prepare(`INSERT INTO hardware_price_page_checks
          (workspace_id,source_key,page_key,last_checked_at,last_changed_at,content_hash,parser_version,snapshot_id)
          VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(workspace_id,source_key,page_key) DO UPDATE SET
            last_checked_at=excluded.last_checked_at,last_changed_at=excluded.last_changed_at,
            content_hash=excluded.content_hash,parser_version=excluded.parser_version,snapshot_id=excluded.snapshot_id`)
          .run(workspaceId,value.sourceKey,value.pageKey,value.capturedAt,lastChangedAt,artifact.hash,value.parserVersion,snapshotId);
      };
      return database.transaction(()=>{
        let saved=database.prepare('SELECT * FROM hardware_price_snapshots WHERE workspace_id=? AND source_key=? AND page_key=? AND content_hash=? AND parser_version=?')
          .get(workspaceId,value.sourceKey,value.pageKey,artifact.hash,value.parserVersion);
        if(saved){
          database.prepare('UPDATE hardware_price_snapshots SET last_checked_at=? WHERE id=?').run(value.capturedAt,saved.id);
          touchPage(saved.id);
          retireSupersededHardwareQuotes(database,workspaceId);
          return snapshot(database.prepare('SELECT * FROM hardware_price_snapshots WHERE id=?').get(saved.id));
        }
        const id=randomUUID();
        database.prepare(`INSERT INTO hardware_price_snapshots
          (id,workspace_id,source_key,page_key,source_url,title,captured_at,content_hash,artifact_path,format,parser_version,warnings_json,last_checked_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,workspaceId,value.sourceKey,value.pageKey,value.sourceUrl,value.title,value.capturedAt,
          artifact.hash,artifact.relativePath,value.format,value.parserVersion,JSON.stringify(value.warnings),value.capturedAt);
        for(const row of value.rows) {
          const canonical=hash([value.sourceKey,row.specification,row.category,row.quoteType,row.currency,row.unit,row.taxBasis,row.averageBasis]);
          const found=database.prepare(`SELECT series_key seriesKey,json_extract(row_json,'$.currency') currency,json_extract(row_json,'$.unit') unit,COUNT(*) n
            FROM hardware_price_observations WHERE workspace_id=? AND json_extract(row_json,'$.specification')=?
              AND json_extract(row_json,'$.category')=? AND json_extract(row_json,'$.quoteType')=? GROUP BY series_key`).all(workspaceId,row.specification,row.category,row.quoteType);
          const compatible=found.filter(item=>(item.currency==null || row.currency==null || item.currency===row.currency) && (item.unit==null || row.unit==null || item.unit===row.unit))
            .sort((a,b)=>b.n-a.n || String(a.seriesKey).localeCompare(String(b.seriesKey)));
          const seriesKey=compatible[0]?.seriesKey || canonical;
          // Unknown periods belong to this snapshot, never to an invented collection day.
          const periodKey=row.period ? JSON.stringify([row.period,row.periodStart,row.periodEnd]) : `unverified:${id}`;
          const valueHash=hash([row.average,row.high,row.low,row.reportedChange,row.changeBasis,row.highBasis,row.lowBasis]);
          const prior=database.prepare('SELECT * FROM hardware_price_observations WHERE workspace_id=? AND series_key=? AND period_key=? AND is_current=1 ORDER BY revision DESC LIMIT 1').get(workspaceId,seriesKey,periodKey);
          const priorRow=prior ? JSON.parse(prior.row_json) : null;
          // Same prices used to reuse the old row and leave a null currency on screen.
          // A filled currency, unit, tax basis, or cleaned name is a new revision; the old row stays.
          const sameQuote=Boolean(prior) && prior.value_hash===valueHash
            && priorRow.currency===row.currency && priorRow.unit===row.unit
            && priorRow.taxBasis===row.taxBasis && priorRow.specification===row.specification;
          let obsId=sameQuote ? prior.id : null;
          if(!obsId) {
            obsId=randomUUID();const revision=(database.prepare('SELECT MAX(revision) n FROM hardware_price_observations WHERE workspace_id=? AND series_key=? AND period_key=?').get(workspaceId,seriesKey,periodKey).n || 0)+1;
            const current=!prior || row.sourceUpdatedAt===null || prior.source_updated_at===null || row.sourceUpdatedAt>=prior.source_updated_at;
            if(current)database.prepare('UPDATE hardware_price_observations SET is_current=0 WHERE workspace_id=? AND series_key=? AND period_key=?').run(workspaceId,seriesKey,periodKey);
            database.prepare('INSERT INTO hardware_price_observations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(obsId,workspaceId,seriesKey,periodKey,revision,prior?.id || null,valueHash,id,value.capturedAt,row.periodStart,row.sourceUpdatedAt,current?1:0,JSON.stringify(row));
          }
          database.prepare('INSERT INTO hardware_price_snapshot_rows VALUES (?,?,?,?,?,?)').run(workspaceId,id,row.tableIndex,row.rowIndex,obsId,JSON.stringify(row));
        }
        touchPage(id);
        retireSupersededHardwareQuotes(database,workspaceId);
        emitEvent('trading.hardware-prices.saved.v1','hardware-price-snapshot',id,{snapshotId:id},workspaceId);
        return snapshot(database.prepare('SELECT * FROM hardware_price_snapshots WHERE id=?').get(id));
      })();
    },
    pageChecks(workspaceId) {
      return database.prepare('SELECT * FROM hardware_price_page_checks WHERE workspace_id=? ORDER BY page_key').all(workspaceId).map(row=>({
        sourceKey:row.source_key,pageKey:row.page_key,lastCheckedAt:row.last_checked_at,lastChangedAt:row.last_changed_at,
        unchanged:row.last_checked_at!==row.last_changed_at,
      }));
    },
    list(workspaceId,{snapshotId=null,seriesKey=null,limit=200}={}) {
      if(snapshotId)return database.prepare(`SELECT o.*,r.row_json snapshot_row_json,s.captured_at snapshot_captured_at FROM hardware_price_snapshot_rows r JOIN hardware_price_observations o ON o.id=r.observation_id AND o.workspace_id=r.workspace_id
        JOIN hardware_price_snapshots s ON s.id=r.snapshot_id AND s.workspace_id=r.workspace_id
        WHERE r.workspace_id=? AND r.snapshot_id=? ORDER BY r.table_index,r.row_index LIMIT ?`).all(workspaceId,snapshotId,limit).map(r=>({...observation(r),...JSON.parse(r.snapshot_row_json),snapshotId,capturedAt:r.snapshot_captured_at}));
      return database.prepare(`SELECT o.*,r.row_json snapshot_row_json,s.id referenced_snapshot_id,s.captured_at snapshot_captured_at FROM (SELECT *,ROW_NUMBER() OVER (PARTITION BY series_key ORDER BY period_start IS NOT NULL DESC,period_start DESC,captured_at DESC,revision DESC) n
        FROM hardware_price_observations WHERE workspace_id=? AND is_current=1 AND (? IS NULL OR series_key=?)) o
        JOIN hardware_price_snapshot_rows r ON r.observation_id=o.id AND r.rowid=(SELECT rr.rowid FROM hardware_price_snapshot_rows rr
          JOIN hardware_price_snapshots ss ON ss.id=rr.snapshot_id AND ss.workspace_id=rr.workspace_id WHERE rr.observation_id=o.id AND rr.workspace_id=o.workspace_id ORDER BY ss.captured_at DESC,ss.rowid DESC,rr.table_index,rr.row_index LIMIT 1)
        JOIN hardware_price_snapshots s ON s.id=r.snapshot_id AND s.workspace_id=r.workspace_id
        WHERE o.n=1 ORDER BY o.period_start DESC,s.captured_at DESC LIMIT ?`).all(workspaceId,seriesKey,seriesKey,limit).map(r=>({...observation(r),...JSON.parse(r.snapshot_row_json),snapshotId:r.referenced_snapshot_id,capturedAt:r.snapshot_captured_at}));
    },
    history(workspaceId,seriesKey) { return database.prepare('SELECT * FROM hardware_price_observations WHERE workspace_id=? AND series_key=? ORDER BY period_start,captured_at,revision LIMIT 5000').all(workspaceId,seriesKey).map(observation); },
    recentHistory(workspaceId,seriesKey,limit=30) {
      const cap=Math.max(1,Math.min(Number(limit)||30,500));
      return database.prepare(`SELECT * FROM (
        SELECT * FROM hardware_price_observations WHERE workspace_id=? AND series_key=?
        ORDER BY period_start DESC, captured_at DESC, revision DESC LIMIT ?
      ) ORDER BY period_start, captured_at, revision`).all(workspaceId,seriesKey,cap).map(observation);
    },
    seriesSnapshots(workspaceId,seriesKey) {return database.prepare(`SELECT DISTINCT s.* FROM hardware_price_snapshots s JOIN hardware_price_snapshot_rows r ON r.snapshot_id=s.id AND r.workspace_id=s.workspace_id
      JOIN hardware_price_observations o ON o.id=r.observation_id AND o.workspace_id=r.workspace_id WHERE s.workspace_id=? AND o.series_key=? ORDER BY s.captured_at DESC LIMIT 500`).all(workspaceId,seriesKey).map(snapshot);},
    getSnapshot(workspaceId,id) {return snapshot(database.prepare('SELECT * FROM hardware_price_snapshots WHERE workspace_id=? AND id=?').get(workspaceId,id));},
    savedSnapshots(workspaceId) {return database.prepare('SELECT * FROM hardware_price_snapshots WHERE workspace_id=? ORDER BY captured_at,id').all(workspaceId).map(snapshot);},
    legacyItemIds(workspaceId) {return database.prepare('SELECT content_item_id FROM hardware_price_legacy_links WHERE workspace_id=?').all(workspaceId).map(r=>r.content_item_id);},
    linkLegacy(workspaceId,externalId,contentItemId,snapshotId) {
      database.transaction(()=>{
        const changed=database.prepare('INSERT OR IGNORE INTO hardware_price_legacy_links VALUES (?,?,?,?)').run(workspaceId,externalId,contentItemId,snapshotId).changes;
        if(changed)emitEvent('trading.hardware-legacy.linked.v1','hardware-price-snapshot',snapshotId,{externalId,snapshotId},workspaceId);
      })();
    },
    legacySnapshot(workspaceId,key) { const r=database.prepare('SELECT snapshot_id FROM hardware_price_legacy_links WHERE workspace_id=? AND (external_id=? OR content_item_id=?)').get(workspaceId,key,key);return r?this.getSnapshot(workspaceId,r.snapshot_id):null; },
  };
}
