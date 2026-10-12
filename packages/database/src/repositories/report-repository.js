import { randomUUID } from 'node:crypto';
import {
  DailyBriefIndexItemSchema,
  DailyBriefSchema,
  DailyReportSchema,
  SaveDailyTrackingQuestionsSchema,
  parseContract,
  HourlyDigestSchema,
} from '../../../contracts/src/index.js';

function parseJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function mapReport(row) {
  return parseContract(DailyReportSchema, {
    id: row.id,
    workspaceId: row.workspace_id,
    reportDate: row.report_date,
    status: row.status,
    content: parseJson(row.content_json, {}),
    sourceRefs: parseJson(row.source_refs_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function createReportRepository(database, emitEvent) {
  return {
    getLatestHourlySavedDigest(workspaceId,hourStart) {
      const row=database.prepare(`SELECT digest_json FROM hourly_information_snapshots WHERE workspace_id=? AND hour_start=? AND status='completed'
        AND json_extract(digest_json,'$.window.endAt')=? ORDER BY updated_at DESC,rowid DESC LIMIT 1`).get(workspaceId,hourStart,hourStart+3600000);
      return row ? HourlyDigestSchema.parse(JSON.parse(row.digest_json)) : null;
    },
    getHourlyAttemptState(workspaceId,hourStart,at=Date.now()) {
      const row=database.prepare(`SELECT status,lease_until,updated_at,error,json_extract(digest_json,'$.editorial.status') editorial
        FROM hourly_information_snapshots WHERE workspace_id=? AND hour_start=?
        AND coalesce(json_extract(frozen_json,'$.window.endAt'),json_extract(digest_json,'$.window.endAt'),hour_start+3600000)=?
        ORDER BY updated_at DESC,rowid DESC LIMIT 1`).get(workspaceId,hourStart,hourStart+3600000);
      return row ? {running:row.status==='running' && row.lease_until>at,failed:row.status==='failed' || row.editorial==='failed' || (row.status==='running' && row.lease_until<=at),updatedAt:row.updated_at} : null;
    },
    getRecoverableHourlyInput(workspaceId,hourStart,at) {
      const row=database.prepare(`SELECT status,lease_until,frozen_json FROM hourly_information_snapshots
        WHERE workspace_id=? AND hour_start=? ORDER BY updated_at DESC,rowid DESC LIMIT 1`).get(workspaceId,hourStart);
      if (!row || row.status==='completed' || (row.status==='running' && row.lease_until>at)) return null;
      const frozen=JSON.parse(row.frozen_json);
      if (!frozen.inputVersion || (frozen.window && (frozen.window.startAt!==hourStart || frozen.window.endAt!==hourStart+3600000))) return null;
      return frozen;
    },
    findHourlyInputSnapshot(workspaceId,hourStart,inputVersion) {
      const row=database.prepare("SELECT digest_json FROM hourly_information_snapshots WHERE workspace_id=? AND hour_start=? AND status='completed' AND json_extract(frozen_json,'$.inputVersion')=? ORDER BY updated_at DESC,rowid DESC LIMIT 1").get(workspaceId,hourStart,inputVersion);
      return row ? HourlyDigestSchema.parse(JSON.parse(row.digest_json)) : null;
    },
    acquireHourlySnapshot(workspaceId,hourStart,materialVersion,frozen,owner,at) {
      return database.transaction(()=>{
        const row=database.prepare('SELECT * FROM hourly_information_snapshots WHERE workspace_id=? AND hour_start=? AND material_version=?').get(workspaceId,hourStart,materialVersion);
        if(row?.status==='completed') return {id:row.id,frozen:JSON.parse(row.frozen_json),digest:HourlyDigestSchema.parse(JSON.parse(row.digest_json))};
        if(row?.status==='running' && row.lease_until>at) throw new Error('相同小时材料正在提炼');
        const id=row?.id || randomUUID();
        database.prepare(`INSERT INTO hourly_information_snapshots VALUES (?,?,?,?,?,NULL,'running',?,?,'',?)
          ON CONFLICT(workspace_id,hour_start,material_version) DO UPDATE SET status='running',owner=excluded.owner,lease_until=excluded.lease_until,error='',updated_at=excluded.updated_at`)
          .run(id,workspaceId,hourStart,materialVersion,JSON.stringify(frozen),owner,at+240000,at);
        emitEvent('report.hourly.started.v1','hourly-digest',id,{hourStart},workspaceId);
        return {id,frozen:row ? JSON.parse(row.frozen_json) : frozen,digest:null,recovering:Boolean(row)};
      })();
    },
    renewHourlySnapshot(workspaceId,id,owner,at) {
      const result=database.prepare("UPDATE hourly_information_snapshots SET lease_until=? WHERE workspace_id=? AND id=? AND owner=? AND status='running' AND lease_until>=?").run(at+240000,workspaceId,id,owner,at);
      if(!result.changes) throw new Error('小时摘选运行租约已失效');
    },
    finishHourlySnapshot(workspaceId,id,owner,digest,error='') {
      const value=digest ? HourlyDigestSchema.parse(digest) : null;
      database.transaction(()=>{
        const at=Date.now();
        const result=database.prepare("UPDATE hourly_information_snapshots SET digest_json=?,status=?,error=?,updated_at=? WHERE workspace_id=? AND id=? AND owner=? AND status='running' AND lease_until>=?")
          .run(value ? JSON.stringify(value) : null,value ? 'completed' : 'failed',String(error).slice(0,500),at,workspaceId,id,owner,at);
        if(!result.changes) throw new Error('小时摘选运行租约已失效');
        emitEvent('report.hourly.updated.v1','hourly-digest',id,{status:value ? 'completed' : 'failed'},workspaceId);
      })();
      return value;
    },
    getHourlySnapshot(workspaceId,id) {
      const row=database.prepare("SELECT * FROM hourly_information_snapshots WHERE workspace_id=? AND id=? AND status='completed'").get(workspaceId,id);
      return row ? {digest:HourlyDigestSchema.parse(JSON.parse(row.digest_json)),frozen:JSON.parse(row.frozen_json)} : null;
    },
    getHourlyDigest(workspaceId,hourStart) {
      const row=database.prepare(`SELECT s.digest_json FROM hourly_information_heads h JOIN hourly_information_snapshots s ON s.id=h.snapshot_id AND s.workspace_id=h.workspace_id
        WHERE h.workspace_id=? AND h.hour_start=? AND s.status='completed'`).get(workspaceId,hourStart);
      return row ? HourlyDigestSchema.parse(JSON.parse(row.digest_json)) : null;
    },
    publishHourlySnapshot(workspaceId,id) {
      database.transaction(()=>{
        const row=database.prepare("SELECT hour_start,digest_json FROM hourly_information_snapshots WHERE workspace_id=? AND id=? AND status='completed'").get(workspaceId,id);
        if(!row) throw new Error('小时快照不存在');
        const digest=HourlyDigestSchema.parse(JSON.parse(row.digest_json));
        if(digest.window.startAt!==row.hour_start || digest.window.endAt!==row.hour_start+3600000) throw new Error('日报边界快照不能作为完整小时结果');
        const head=database.prepare('SELECT snapshot_id FROM hourly_information_heads WHERE workspace_id=? AND hour_start=?').get(workspaceId,row.hour_start);
        if(head?.snapshot_id===id) return;
        database.prepare(`INSERT INTO hourly_information_heads VALUES (?,?,?,?) ON CONFLICT(workspace_id,hour_start)
          DO UPDATE SET snapshot_id=excluded.snapshot_id,updated_at=excluded.updated_at`).run(workspaceId,row.hour_start,id,Date.now());
        emitEvent('report.hourly.published.v1','hourly-digest',id,{hourStart:row.hour_start},workspaceId);
      })();
    },
    listHourlyDigests(workspaceId,startAt,endAt) {
      const rows=database.prepare(`SELECT s.digest_json FROM hourly_information_heads h JOIN hourly_information_snapshots s ON s.id=h.snapshot_id AND s.workspace_id=h.workspace_id
        WHERE h.workspace_id=? AND h.hour_start>=? AND h.hour_start<? AND s.status='completed' ORDER BY h.hour_start DESC`).all(workspaceId,startAt,endAt);
      return rows.map(r=>HourlyDigestSchema.parse(JSON.parse(r.digest_json)));
    },
    listHourlyInformationDigests(workspaceId,startAt,endAt) {
      // Search uses the latest preserved raw pool, even when its editorial did not replace a ready publication.
      const rows=database.prepare(`SELECT s.digest_json FROM hourly_information_snapshots s
        WHERE s.workspace_id=? AND s.hour_start>=? AND s.hour_start<? AND s.status='completed'
        AND json_extract(s.digest_json,'$.window.endAt')=s.hour_start+3600000
        AND s.rowid=(SELECT t.rowid FROM hourly_information_snapshots t WHERE t.workspace_id=s.workspace_id AND t.hour_start=s.hour_start
          AND t.status='completed' AND json_extract(t.digest_json,'$.window.endAt')=t.hour_start+3600000 ORDER BY t.updated_at DESC,t.rowid DESC LIMIT 1)
        ORDER BY s.hour_start DESC`).all(workspaceId,startAt,endAt);
      return rows.map(r=>HourlyDigestSchema.parse(JSON.parse(r.digest_json)));
    },
    listHourlyDigestIndex(workspaceId,startAt,endAt) {
      // Read only published metadata and the latest attempt, never frozen source bodies.
      const rows=database.prepare(`SELECT s.hour_start AS hourStart,
        CASE WHEN (s.status='running' AND s.lease_until<=?) OR json_extract(s.digest_json,'$.editorial.status')='failed' THEN 'failed' ELSE s.status END AS status,s.updated_at AS updatedAt,
        p.id,json_extract(p.digest_json,'$.generatedAt') AS generatedAt,
        CASE WHEN json_extract(p.digest_json,'$.editorial.status')='ready' AND json_extract(p.digest_json,'$.editorial.version')='brief-editorial-v3'
          THEN coalesce(json_array_length(p.digest_json,'$.editorial.directions'),0)
          WHEN json_extract(p.digest_json,'$.editorial.status')='ready'
          THEN coalesce((SELECT sum(json_array_length(value,'$.topics')) FROM json_each(p.digest_json,'$.editorial.directions')),0)
          ELSE coalesce(json_array_length(p.digest_json,'$.items'),0) END AS itemCount,
        coalesce((SELECT sum(coalesce(json_extract(value,'$.unread'),0)) FROM json_each(p.digest_json,'$.coverage')),0) AS unread,
        coalesce((SELECT sum(coalesce(json_extract(value,'$.failed'),0)) FROM json_each(p.digest_json,'$.coverage')),0) AS failed,
        json_extract(p.digest_json,'$.editorial.status') publishedEditorial,
        coalesce(json_array_length(p.digest_json,'$.editorial.directions'),0) publishedDirections,
        json_extract(s.digest_json,'$.editorial.status') latestEditorial
        FROM hourly_information_snapshots s
        LEFT JOIN hourly_information_heads h ON h.workspace_id=s.workspace_id AND h.hour_start=s.hour_start
        LEFT JOIN hourly_information_snapshots p ON p.id=h.snapshot_id AND p.workspace_id=h.workspace_id AND p.status='completed'
        WHERE s.workspace_id=? AND s.hour_start>=? AND s.hour_start<?
        AND s.hour_start%3600000=0 AND coalesce(json_extract(s.frozen_json,'$.window.endAt'),json_extract(s.digest_json,'$.window.endAt'),s.hour_start+3600000)=s.hour_start+3600000
        AND s.rowid=(SELECT t.rowid FROM hourly_information_snapshots t WHERE t.workspace_id=s.workspace_id AND t.hour_start=s.hour_start
          AND coalesce(json_extract(t.frozen_json,'$.window.endAt'),json_extract(t.digest_json,'$.window.endAt'),t.hour_start+3600000)=t.hour_start+3600000 ORDER BY t.updated_at DESC,t.rowid DESC LIMIT 1)
        ORDER BY s.hour_start DESC`).all(Date.now(),workspaceId,startAt,endAt);
      const stageQuery=database.prepare(`SELECT status,stage_key,updated_at,error,json_extract(input_json,'$.stage') stage,
        json_extract(input_json,'$.executionTiming') timing FROM daily_analysis_stages WHERE workspace_id=? AND report_date=? ORDER BY updated_at DESC,rowid DESC LIMIT 1`);
      const draftQuery=database.prepare(`SELECT id,coalesce(json_array_length(digest_json,'$.items'),0) items FROM hourly_information_snapshots
        WHERE workspace_id=? AND hour_start=? AND status='completed' AND json_extract(digest_json,'$.window.endAt')=? ORDER BY updated_at DESC,rowid DESC LIMIT 1`);
      return rows.map(({publishedEditorial,publishedDirections,latestEditorial,...row})=>{
        const stage=stageQuery.get(workspaceId,`hour:${row.hourStart}`),timing=parseJson(stage?.timing,null),editing=stage?.stage==='hourly-editorial';
        const draft=draftQuery.get(workspaceId,row.hourStart,row.hourStart+3600000),readable=publishedEditorial==='ready' && publishedDirections>0;
        const phase=row.status==='running' ? `${timing?.phase==='queued' ? 'queued-' : ''}${editing ? 'editing' : 'extraction'}` :
          row.status==='failed' ? 'failed' : latestEditorial==='ready' ? (readable ? 'ready' : 'empty') : 'draft';
        const reason=timing?.finishReason;
        return {...row,readable,draftId:draft?.id || null,draftItemCount:draft?.items || 0,phase:phase==='extraction' ? 'extracting' : phase,
          ...(row.status==='failed' ? {failureStage:editing ? 'editing' : stage ? 'extraction' : 'unknown',
            failureReason:reason==='ModelQueueTimeout' ? 'queue-timeout' : reason==='ModelExecutionTimeout' ? 'execution-timeout' : reason==='HarnessModelError' ? 'model-error' :
              reason==='StageBudgetTimeout' || /预算/.test(stage?.error || '') ? 'budget' : ['SyntaxError','ZodError'].includes(reason) ? 'invalid-output' :
                !stage || stage.status==='running' ? 'interrupted' : 'other'} : {}),
          ...(timing ? {queueMs:timing.queueMs,executionMs:timing.executionMs} : {})};
      });
    },
    getTrackingQuestions(workspaceId) {
      return database.prepare('SELECT question_json FROM daily_tracking_questions WHERE workspace_id=? ORDER BY id').all(workspaceId).map(r=>JSON.parse(r.question_json));
    },
    saveTrackingQuestions(workspaceId, value) {
      const {questions}=parseContract(SaveDailyTrackingQuestionsSchema,value);
      database.transaction(()=>{
        database.prepare('DELETE FROM daily_tracking_questions WHERE workspace_id=?').run(workspaceId);
        for(const q of questions) database.prepare('INSERT INTO daily_tracking_questions VALUES (?,?,?,?)').run(workspaceId,q.id,JSON.stringify({...q,updatedAt:Date.now()}),Date.now());
        emitEvent('report.tracking.updated.v1','daily-tracking',workspaceId,{count:questions.length},workspaceId);
      })();
      return this.getTrackingQuestions(workspaceId);
    },
    getPreviousTracking(workspaceId,reportDate,question) {
      const rows=database.prepare(`SELECT report_date,brief_json,input_snapshot_json FROM daily_brief_versions
        WHERE workspace_id=? AND report_date<? ORDER BY report_date DESC,generated_at DESC LIMIT 200`).all(workspaceId,reportDate);
      for(const row of rows) {
        const config=JSON.parse(row.input_snapshot_json).report?.content?.tracking?.find(t=>t.question.id===question.id);
        if(config?.question.question!==question.question) continue;
        const previous=JSON.parse(row.brief_json).trackingUpdates?.find(t=>t.questionId===question.id);
        if(previous) {
          const snapshot=JSON.parse(row.input_snapshot_json);
          const previousEvidence=previous.evidence.slice(0,6).flatMap(reference=>{
            const material=snapshot.report?.content?.materials.find(m=>m.id===reference.materialId);
            const paragraph=material?.paragraphs.find(p=>p.id===reference.paragraphId);
            return paragraph ? [{reference,hash:material.hash,version:material.version,sourceUrl:material.sourceUrl,excerpt:paragraph.text.slice(0,1000)}] : [];
          });
          return {previous,previousDate:row.report_date,previousRevision:JSON.parse(row.brief_json).generatedAt,previousEvidence,
            previousEvidenceOmitted:Math.max(0,previous.evidence.length-previousEvidence.length)};
        }
      }
      return {previous:null,previousDate:null};
    },
    acquireAnalysisRun(workspaceId,runKey,reportDate,snapshot,owner,at) {
      return database.transaction(()=>{
        const row=database.prepare('SELECT * FROM daily_analysis_runs WHERE workspace_id=? AND run_key=?').get(workspaceId,runKey);
        if(row?.status==='running' && row.lease_until>at) throw new Error('相同材料的日报正在生成');
        database.prepare(`INSERT INTO daily_analysis_runs VALUES (?,?,?,?,?,?,?,'',?)
          ON CONFLICT(workspace_id,run_key) DO UPDATE SET status='running',owner=excluded.owner,lease_until=excluded.lease_until,error='',updated_at=excluded.updated_at`)
          .run(workspaceId,runKey,reportDate,JSON.stringify(snapshot),'running',owner,at+240000,at);
        emitEvent('report.analysis.started.v1','daily-analysis',runKey,{reportDate},workspaceId);
        return row ? JSON.parse(row.snapshot_json) : snapshot;
      })();
    },
    renewAnalysisRun(workspaceId,runKey,owner,at) {
      const result=database.prepare("UPDATE daily_analysis_runs SET lease_until=?,updated_at=? WHERE workspace_id=? AND run_key=? AND owner=? AND status='running' AND lease_until>=?").run(at+240000,at,workspaceId,runKey,owner,at);
      if(!result.changes) throw new Error('日报运行租约已失效');
    },
    finishAnalysisRun(workspaceId,runKey,owner,status,error='') {
      database.transaction(()=>{
        database.prepare('UPDATE daily_analysis_runs SET status=?,error=?,updated_at=? WHERE workspace_id=? AND run_key=? AND owner=?').run(status,String(error).slice(0,500),Date.now(),workspaceId,runKey,owner);
        emitEvent('report.analysis.updated.v1','daily-analysis',runKey,{status},workspaceId);
      })();
    },
    listTreePreparationStates(workspaceId,sourceIds) {
      if(!sourceIds.length)return [];
      const payload=JSON.stringify(sourceIds);
      return database.prepare(`SELECT input_json,output_json,status FROM daily_analysis_stages WHERE workspace_id=? AND report_date='tree-preparation' AND stage_key IN (SELECT 'information:' || value FROM json_each(?) UNION ALL SELECT 'article:' || value FROM json_each(?)) ORDER BY updated_at DESC`)
        .all(workspaceId,payload,payload).map(r=>({input:JSON.parse(r.input_json),output:r.output_json ? JSON.parse(r.output_json) : null,status:r.status}));
    },
    getAnalysisStage(workspaceId,reportDate,stageKey,inputHash) {
      const row=database.prepare('SELECT * FROM daily_analysis_stages WHERE workspace_id=? AND report_date=? AND stage_key=? AND input_hash=?').get(workspaceId,reportDate,stageKey,inputHash);
      return row ? {status:row.status,output:parseJson(row.output_json,null),input:parseJson(row.input_json,null),error:row.error,updatedAt:row.updated_at} : null;
    },
    saveAnalysisStage(workspaceId,reportDate,stageKey,inputHash,input,output,status,error='') {
      database.transaction(()=>{
        database.prepare(`INSERT INTO daily_analysis_stages VALUES (?,?,?,?,?,?,?,?,?)
          ON CONFLICT(workspace_id,report_date,stage_key,input_hash) DO UPDATE SET input_json=excluded.input_json,output_json=excluded.output_json,status=excluded.status,error=excluded.error,updated_at=excluded.updated_at`)
          .run(workspaceId,reportDate,stageKey,inputHash,JSON.stringify(input),output ? JSON.stringify(output) : null,status,String(error).slice(0,500),Date.now());
        emitEvent('report.analysis.stage.updated.v1','daily-analysis-stage',inputHash,{reportDate,stageKey,status},workspaceId);
      })();
    },
    getAnalysisStatus(workspaceId,reportDate) {
      const run=database.prepare('SELECT run_key,status,error,updated_at,snapshot_json FROM daily_analysis_runs WHERE workspace_id=? AND report_date=? ORDER BY updated_at DESC LIMIT 1').get(workspaceId,reportDate);
      if(!run) return null;
      const frozenAt=JSON.parse(run.snapshot_json).report.content.frozenAt;
      const rows=database.prepare("SELECT stage_key,status,error,updated_at FROM daily_analysis_stages WHERE workspace_id=? AND report_date=? AND json_extract(input_json,'$.frozenAt')=? ORDER BY updated_at").all(workspaceId,reportDate,frozenAt);
      const stages=[...new Map(rows.map(s=>[s.stage_key,s])).values()];
      return {status:run.status,error:run.error,updatedAt:run.updated_at,frozenAt,stages:stages.map(s=>({stage:s.stage_key,status:s.status,error:s.error,updatedAt:s.updated_at}))};
    },
    getDailyReport(workspaceId, reportDate) {
      const row = database.prepare(`SELECT * FROM daily_reports
        WHERE workspace_id = ? AND report_date = ?`).get(workspaceId, reportDate);
      return row ? mapReport(row) : null;
    },

    getLatestDailyReport(workspaceId) {
      const row = database.prepare(`SELECT * FROM daily_reports
        WHERE workspace_id = ? ORDER BY report_date DESC, updated_at DESC LIMIT 1`).get(workspaceId);
      return row ? mapReport(row) : null;
    },

    listDailyReports(workspaceId, limit = 30) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 30, 200));
      return database.prepare(`SELECT * FROM daily_reports
        WHERE workspace_id = ? ORDER BY report_date DESC LIMIT ?`)
        .all(workspaceId, safeLimit).map(mapReport);
    },

    upsertDailyReport(value) {
      const previous=this.getDailyReport(value.workspaceId,value.reportDate);
      const now = Math.max(Date.now(),(previous?.updatedAt || 0)+1);
      const id = value.id || randomUUID();
      const content = value.content;
      const sourceRefs = value.sourceRefs || [];
      const status = value.status;
      database.transaction(() => {
        database.prepare(`INSERT INTO daily_reports
          (id, workspace_id, report_date, status, content_json, source_refs_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id, report_date) DO UPDATE SET
            status = excluded.status,
            content_json = excluded.content_json,
            source_refs_json = excluded.source_refs_json,
            updated_at = excluded.updated_at`)
          .run(id, value.workspaceId, value.reportDate, status, JSON.stringify(content),
            JSON.stringify(sourceRefs), now, now);
        const row = database.prepare(`SELECT * FROM daily_reports
          WHERE workspace_id = ? AND report_date = ?`).get(value.workspaceId, value.reportDate);
        emitEvent('report.daily.generated.v1', 'daily-report', row.id, {
          reportId: row.id,
          reportDate: row.report_date,
          status: row.status,
        }, value.workspaceId);
      })();
      return mapReport(database.prepare(`SELECT * FROM daily_reports
        WHERE workspace_id = ? AND report_date = ?`).get(value.workspaceId, value.reportDate));
    },

    getDailyReportById(workspaceId, reportId) {
      const row = database.prepare(`SELECT * FROM daily_reports
        WHERE workspace_id = ? AND id = ?`).get(workspaceId, reportId);
      return row ? mapReport(row) : null;
    },

    getPreviousDailyReport(workspaceId, reportDate) {
      const row = database.prepare(`SELECT * FROM daily_reports
        WHERE workspace_id = ? AND report_date < ?
        ORDER BY report_date DESC LIMIT 1`).get(workspaceId, reportDate);
      return row ? mapReport(row) : null;
    },

    getDailyBriefByReportId(workspaceId, reportId) {
      const row = database.prepare(`SELECT * FROM daily_report_briefs
        WHERE workspace_id = ? AND report_id = ?`).get(workspaceId, reportId);
      return row ? mapBrief(row) : null;
    },

    getDailyBriefByDate(workspaceId, reportDate) {
      const row = database.prepare(`SELECT * FROM daily_report_briefs
        WHERE workspace_id = ? AND report_date = ?`).get(workspaceId, reportDate);
      return row ? mapBrief(row) : null;
    },

    getDailyBriefReferenceSnapshot(workspaceId, reportDate, revision = null) {
      if(revision !== null) {
        const archived=database.prepare('SELECT brief_json,input_snapshot_json FROM daily_brief_versions WHERE workspace_id=? AND report_date=? AND generated_at=?').get(workspaceId,reportDate,revision);
        if(archived) return {brief:mapBrief(archived),inputSnapshot:parseJson(archived.input_snapshot_json,{})};
      }
      const row = database.prepare(`SELECT brief_json, input_snapshot_json FROM daily_report_briefs
        WHERE workspace_id = ? AND report_date = ?`).get(workspaceId, reportDate);
      return row ? {
        brief: mapBrief(row),
        inputSnapshot: parseJson(row.input_snapshot_json, {}),
      } : null;
    },

    getLatestDailyBrief(workspaceId) {
      const row = database.prepare(`SELECT * FROM daily_report_briefs
        WHERE workspace_id = ? ORDER BY report_date DESC, updated_at DESC LIMIT 1`).get(workspaceId);
      return row ? mapBrief(row) : null;
    },

    listDailyBriefs(workspaceId, limit = 60) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 60, 200));
      const rows = database.prepare(`SELECT report_date,
          json_extract(brief_json, '$.overview') AS overview,
          CASE WHEN json_extract(brief_json,'$.editorial.status')='ready' AND json_extract(brief_json,'$.editorial.version')='brief-editorial-v3'
            THEN coalesce(json_array_length(brief_json,'$.editorial.directions'),0)
            WHEN json_extract(brief_json,'$.editorial.status')='ready'
            THEN coalesce((SELECT sum(json_array_length(value,'$.topics')) FROM json_each(brief_json,'$.editorial.directions')),0)
            ELSE COALESCE(json_array_length(json_extract(brief_json, '$.informationItems')), json_array_length(json_extract(brief_json, '$.items')), 0) END AS item_count,
          json_extract(brief_json, '$.generatedAt') AS generated_at
        FROM daily_report_briefs
        WHERE workspace_id = ?
        ORDER BY report_date DESC
        LIMIT ?`).all(workspaceId, safeLimit);
      return rows.flatMap((row) => {
        try {
          return [parseContract(DailyBriefIndexItemSchema, {
            reportDate: row.report_date,
            overview: row.overview,
            itemCount: Number(row.item_count) || 0,
            generatedAt: Number(row.generated_at),
          })];
        } catch {
          return [];
        }
      });
    },

    upsertDailyBrief(value) {
      const now = Date.now();
      const brief = parseContract(DailyBriefSchema, value.brief);
      const snapshot = value.inputSnapshot || {};
      database.transaction(() => {
        if(brief.schemaVersion===2) {
          const previous=database.prepare('SELECT brief_json,input_snapshot_json FROM daily_report_briefs WHERE workspace_id=? AND report_id=?').get(value.workspaceId,value.reportId);
          if(previous) database.prepare('INSERT OR IGNORE INTO daily_brief_versions VALUES (?,?,?,?,?)')
            .run(value.workspaceId,value.reportDate,JSON.parse(previous.brief_json).generatedAt,previous.brief_json,previous.input_snapshot_json);
        }
        if(brief.schemaVersion===2) database.prepare('INSERT INTO daily_brief_versions VALUES (?,?,?,?,?)')
          .run(value.workspaceId,value.reportDate,brief.generatedAt,JSON.stringify(brief),JSON.stringify(snapshot));
        database.prepare(`INSERT INTO daily_report_briefs
          (id, workspace_id, report_id, report_date, status, source_report_updated_at,
           input_hash, input_snapshot_json, brief_json, provider_id, model_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id, report_id) DO UPDATE SET
            report_date = excluded.report_date,
            status = excluded.status,
            source_report_updated_at = excluded.source_report_updated_at,
            input_hash = excluded.input_hash,
            input_snapshot_json = excluded.input_snapshot_json,
            brief_json = excluded.brief_json,
            provider_id = excluded.provider_id,
            model_id = excluded.model_id,
            updated_at = excluded.updated_at`)
          .run(
            brief.id,
            value.workspaceId,
            value.reportId,
            value.reportDate,
            value.status,
            value.sourceReportUpdatedAt,
            value.inputHash,
            JSON.stringify(snapshot),
            JSON.stringify(brief),
            value.providerId || '',
            value.modelId || '',
            now,
            now,
          );
        const row = database.prepare(`SELECT * FROM daily_report_briefs
          WHERE workspace_id = ? AND report_id = ?`).get(value.workspaceId, value.reportId);
        emitEvent('report.daily.brief.generated.v1', 'daily-report-brief', row.id, {
          briefId: row.id,
          reportId: row.report_id,
          reportDate: row.report_date,
          status: row.status,
        }, value.workspaceId);
      })();
      return mapBrief(database.prepare(`SELECT * FROM daily_report_briefs
        WHERE workspace_id = ? AND report_id = ?`).get(value.workspaceId, value.reportId));
    },
  };
}

function mapBrief(row) {
  return parseContract(DailyBriefSchema, parseJson(row.brief_json, {}));
}
