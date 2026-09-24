import { randomUUID } from 'node:crypto';
import {
  DailyBriefSchema,
  DailyReportSchema,
  parseContract,
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
      const now = Date.now();
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

    getLatestDailyBrief(workspaceId) {
      const row = database.prepare(`SELECT * FROM daily_report_briefs
        WHERE workspace_id = ? ORDER BY report_date DESC, updated_at DESC LIMIT 1`).get(workspaceId);
      return row ? mapBrief(row) : null;
    },

    upsertDailyBrief(value) {
      const now = Date.now();
      const brief = parseContract(DailyBriefSchema, value.brief);
      const snapshot = value.inputSnapshot || {};
      database.transaction(() => {
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
