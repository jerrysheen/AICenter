import { randomUUID } from 'node:crypto';
import {
  JobScheduleSchema,
  parseContract,
  ScheduleSpecSchema,
  ValidationError,
} from '../../../contracts/src/index.js';
import { resolveDueOccurrence } from '../../../domain/src/schedule-clock.js';
import { assertTimeZone } from '../../../domain/src/zoned-time.js';

function parseJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function mapSchedule(row) {
  return parseContract(JobScheduleSchema, {
    id: row.id,
    workspaceId: row.workspace_id,
    key: row.schedule_key,
    jobType: row.job_type,
    enabled: Boolean(row.enabled),
    schedule: parseJson(row.schedule_json, {}),
    input: parseJson(row.input_json, {}),
    priority: row.priority,
    maxAttempts: row.max_attempts,
    nextRunAt: row.next_run_at,
    lastEnqueuedAt: row.last_enqueued_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function createRuntimeRepository(database, insertEvent) {
  return {
    upsertJobSchedule(value) {
      const schedule = parseContract(ScheduleSpecSchema, value.schedule);
      if (schedule.kind === 'daily') {
        try { assertTimeZone(schedule.timezone); } catch {
          throw new ValidationError('无法识别调度时区', ['schedule.timezone']);
        }
      }
      const jobType = String(value.jobType || '').trim();
      if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(jobType)) {
        throw new ValidationError('调度任务类型不正确', ['jobType']);
      }
      const now = Date.now();
      const workspaceId = value.workspaceId || 'local';
      const key = String(value.key || '').trim();
      if (!key) throw new ValidationError('调度键不能为空', ['key']);
      const input = value.input && typeof value.input === 'object' && !Array.isArray(value.input) ? value.input : {};
      const priority = Number.isFinite(value.priority) ? Math.trunc(value.priority) : 0;
      const maxAttempts = Math.max(1, Math.min(Number(value.maxAttempts) || 3, 10));
      const nextRunAt = Number(value.nextRunAt);
      if (!Number.isInteger(nextRunAt) || nextRunAt < 0) throw new ValidationError('下次运行时间不正确', ['nextRunAt']);
      const scheduleJson = JSON.stringify(schedule);
      const id = randomUUID();
      database.transaction(() => {
        database.prepare(`INSERT INTO job_schedules
          (id, workspace_id, schedule_key, job_type, enabled, schedule_json, input_json, priority,
           max_attempts, next_run_at, last_enqueued_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
          ON CONFLICT(workspace_id, schedule_key) DO UPDATE SET
            job_type = excluded.job_type,
            enabled = excluded.enabled,
            schedule_json = excluded.schedule_json,
            input_json = excluded.input_json,
            priority = excluded.priority,
            max_attempts = excluded.max_attempts,
            next_run_at = CASE
              WHEN job_schedules.schedule_json = excluded.schedule_json THEN job_schedules.next_run_at
              ELSE excluded.next_run_at
            END,
            updated_at = excluded.updated_at`)
          .run(id, workspaceId, key, jobType, value.enabled === false ? 0 : 1, scheduleJson,
            JSON.stringify(input), priority, maxAttempts, nextRunAt, now, now);
      })();
      return mapSchedule(database.prepare(`SELECT * FROM job_schedules
        WHERE workspace_id = ? AND schedule_key = ?`).get(workspaceId, key));
    },

    getJobSchedule(workspaceId, key) {
      const row = database.prepare(`SELECT * FROM job_schedules
        WHERE workspace_id = ? AND schedule_key = ?`).get(workspaceId, key);
      return row ? mapSchedule(row) : null;
    },

    listDueSchedules(now = Date.now(), limit = 50) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
      return database.prepare(`SELECT * FROM job_schedules
        WHERE enabled = 1 AND next_run_at <= ?
        ORDER BY next_run_at ASC, schedule_key ASC
        LIMIT ?`).all(now, safeLimit).flatMap((row) => {
        try { return [mapSchedule(row)]; } catch { return []; }
      });
    },

    enqueueDueSchedule(scheduleId, now = Date.now()) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const row = database.prepare('SELECT * FROM job_schedules WHERE id = ?').get(scheduleId);
        if (!row || !row.enabled || row.next_run_at > now) {
          database.exec('COMMIT');
          return null;
        }
        const schedule = mapSchedule(row);
        const occurrence = resolveDueOccurrence(schedule, now);
        if (!occurrence) {
          database.exec('COMMIT');
          return null;
        }
        const jobId = randomUUID();
        const jobInput = {
          ...(schedule.input || {}),
          scheduleKey: schedule.key,
          scheduledFor: occurrence.scheduledFor,
        };
        database.prepare(`INSERT INTO jobs
          (id, workspace_id, type, status, input_json, output_json, error_json, priority,
           attempt_count, max_attempts, available_at, locked_by, locked_at, started_at,
           completed_at, created_at, updated_at)
          VALUES (?, ?, ?, 'queued', ?, NULL, NULL, ?, 0, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`)
          .run(jobId, schedule.workspaceId, schedule.jobType, JSON.stringify(jobInput), schedule.priority,
            schedule.maxAttempts, now, now, now);
        const updated = database.prepare(`UPDATE job_schedules
          SET last_enqueued_at = ?, next_run_at = ?, updated_at = ?
          WHERE id = ? AND next_run_at = ?`).run(
          occurrence.scheduledFor, occurrence.nextRunAt, now, schedule.id, row.next_run_at,
        );
        if (!updated.changes) {
          database.exec('ROLLBACK');
          return null;
        }
        insertEvent('job.queued', 'job', jobId, {
          jobId,
          type: schedule.jobType,
          scheduleKey: schedule.key,
          scheduledFor: occurrence.scheduledFor,
        }, schedule.workspaceId);
        database.exec('COMMIT');
        return {
          jobId,
          schedule: mapSchedule(database.prepare('SELECT * FROM job_schedules WHERE id = ?').get(schedule.id)),
        };
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },
  };
}
