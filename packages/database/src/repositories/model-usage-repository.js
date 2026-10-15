import { ModelUsageRecordSchema } from '../../../contracts/src/model-usage.js';
export function createModelUsageRepository(database, emitEvent) {
  return Object.freeze({
    save(value) {
      const row = ModelUsageRecordSchema.parse(value);
      const serialized = JSON.stringify(row);
      database.transaction(() => {
        const old = database.prepare('SELECT record_json FROM model_usage_index WHERE workspace_id=? AND id=?').get(row.workspaceId, row.id);
        if (old?.record_json === serialized) return;
        database.prepare(`INSERT INTO model_usage_index(workspace_id,id,job_id,occurred_at,record_json,http_status) VALUES(?,?,?,?,?,?)
          ON CONFLICT(workspace_id,id) DO UPDATE SET record_json=excluded.record_json, http_status=excluded.http_status`)
          .run(row.workspaceId, row.id, row.jobId, row.occurredAt, serialized, row.httpStatus);
        emitEvent('runtime.model-usage.updated.v1', 'model-usage', row.id, { kind: row.kind }, row.workspaceId);
      })();
    },
    latestMatching(workspaceId, { stage, applicationSessionId, model } = {}) {
      const row = database.prepare(`SELECT occurred_at AS at FROM model_usage_index
        WHERE workspace_id=? AND json_extract(record_json,'$.stage')=?
          AND json_extract(record_json,'$.applicationSessionId')=?
          AND json_extract(record_json,'$.model')=?
        ORDER BY occurred_at DESC LIMIT 1`).get(workspaceId, stage, applicationSessionId, model);
      return row?.at || 0;
    },
    list(workspaceId, { limit = 50, offset = 0, jobId } = {}) {
      const where = jobId === undefined ? 'workspace_id=?' : 'workspace_id=? AND job_id=?';
      const args = jobId === undefined ? [workspaceId] : [workspaceId, jobId];
      return database.prepare(`SELECT record_json FROM model_usage_index WHERE ${where} ORDER BY occurred_at DESC,id LIMIT ? OFFSET ?`)
        .all(...args, limit, offset).map(row => ModelUsageRecordSchema.parse(JSON.parse(row.record_json)));
    },
    summarize(workspaceId,{startAt,endAt,jobId,stage}={}) {
      const where=["m.workspace_id=?","json_extract(m.record_json,'$.kind')='request'"],args=[workspaceId];
      for(const [value,clause] of [[startAt,'m.occurred_at>=?'],[endAt,'m.occurred_at<?'],[jobId,'m.job_id=?'],[stage,"json_extract(m.record_json,'$.stage')=?"]])if(value!==undefined){where.push(clause);args.push(value);}
      const keys=['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','reasoningTokens','totalTokens'];
      const buckets=keys.flatMap(k=>[`COALESCE(SUM(json_extract(m.record_json,'$.usage.${k}')),0) AS ${k}`,`SUM(json_extract(m.record_json,'$.usage.${k}') IS NULL) AS ${k}Unknown`]);
      return database.prepare(`SELECT json_extract(m.record_json,'$.stage') stage,
        CASE WHEN json_extract(m.record_json,'$.status')='pending' AND j.id IS NOT NULL
          AND (j.status!='running' OR j.attempt_count!=json_extract(m.record_json,'$.jobAttempt')) THEN 'interrupted'
          ELSE json_extract(m.record_json,'$.status') END status,COUNT(*) requestCount,${buckets.join(',')}
        FROM model_usage_index m LEFT JOIN jobs j ON j.id=m.job_id AND j.workspace_id=m.workspace_id
        WHERE ${where.join(' AND ')} GROUP BY 1,2 ORDER BY 1,2`).all(...args);
    },
  });
}
