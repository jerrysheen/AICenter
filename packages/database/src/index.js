import { createHash, randomInt, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DEFAULT_WORKSPACE_ID, runMigrations } from './migrations.js';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function mapPost(row) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    sourceUrl: row.source_url,
    tags: JSON.parse(row.tags_json || '[]'),
    createdByDevice: row.created_by_device,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDevice(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id || DEFAULT_WORKSPACE_ID,
    name: row.name,
    pairedAt: row.paired_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

function mapNote(row) {
  return {
    id: row.id,
    body: row.body,
    aiReply: row.ai_reply || '',
    wantAi: Boolean(row.want_ai),
    status: row.status,
    knowledgeId: row.knowledge_id || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at || null,
  };
}

function mapKnowledge(row) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    source: row.source,
    sourceNoteId: row.source_note_id || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseJson(value, fallback = {}) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function mapJob(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    type: row.type,
    status: row.status,
    input: parseJson(row.input_json),
    output: parseJson(row.output_json, null),
    error: parseJson(row.error_json, null),
    priority: row.priority,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at,
    lockedBy: row.locked_by || '',
    lockedAt: row.locked_at || null,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapOutboxEvent(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.event_name,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    payload: parseJson(row.payload_json),
    createdAt: row.created_at,
  };
}

function sketchReply(body) {
  const snippet = body.replace(/\s+/g, ' ').slice(0, 72);
  return [
    '可以顺着这几个方向想：',
    '1. 这条笔记想留下什么结论？',
    '2. 有没有一个很小的下一步？',
    '3. 以后整进知识库时，标题怎么写更清楚？',
    '',
    `原文要点：${snippet}${body.length > 72 ? '…' : ''}`,
  ].join('\n');
}

export function createStore(databasePath) {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  const schemaVersion = runMigrations(database);

  function insertEvent(name, aggregateType, aggregateId, payload = {}, workspaceId = DEFAULT_WORKSPACE_ID) {
    const result = database.prepare(`INSERT INTO outbox_events
      (workspace_id, event_name, aggregate_type, aggregate_id, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(workspaceId, name, aggregateType, aggregateId, JSON.stringify(payload), Date.now());
    return Number(result.lastInsertRowid);
  }

  const postCount = database.prepare('SELECT COUNT(*) AS count FROM posts').get().count;
  if (postCount === 0) {
    const now = Date.now();
    database.prepare(`INSERT INTO posts
      (id, title, body, source_url, tags_json, created_by_device, created_at, updated_at)
      VALUES (?, ?, ?, '', ?, NULL, ?, ?)`)
      .run(
        randomUUID(),
        'AI Center 已连接',
        '这条信息由本机发布，并已准备同步到鸿蒙手机。',
        JSON.stringify(['系统', '首发测试']),
        now,
        now,
      );
  }

  return {
    createPairingCode(ttlMinutes = 10) {
      const now = Date.now();
      database.prepare('UPDATE pairing_codes SET used_at = ? WHERE used_at IS NULL').run(now);
      const code = String(randomInt(100000, 1_000_000));
      const expiresAt = now + ttlMinutes * 60_000;
      database.prepare(`INSERT INTO pairing_codes (code_hash, expires_at, used_at, created_at)
        VALUES (?, ?, NULL, ?)`)
        .run(sha256(code), expiresAt, now);
      return { code, expiresAt };
    },

    redeemPairingCode(code, deviceName) {
      const now = Date.now();
      const codeHash = sha256(code);
      database.exec('BEGIN IMMEDIATE');
      try {
        const pairing = database.prepare(`SELECT code_hash, expires_at, used_at FROM pairing_codes
          WHERE code_hash = ?`).get(codeHash);
        if (!pairing || pairing.used_at || pairing.expires_at <= now) {
          database.exec('ROLLBACK');
          return null;
        }
        database.prepare('UPDATE pairing_codes SET used_at = ? WHERE code_hash = ?').run(now, codeHash);
        const token = `${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`;
        const device = { id: randomUUID(), name: deviceName, pairedAt: now, lastSeenAt: now, revokedAt: null };
        database.prepare(`INSERT INTO devices
          (id, name, token_hash, paired_at, last_seen_at, revoked_at, workspace_id)
          VALUES (?, ?, ?, ?, ?, NULL, ?)`)
          .run(device.id, device.name, sha256(token), now, now, DEFAULT_WORKSPACE_ID);
        insertEvent('device.paired', 'device', device.id, { device }, DEFAULT_WORKSPACE_ID);
        database.exec('COMMIT');
        return { device, token };
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },

    authorizeToken(token) {
      if (!token) return null;
      const row = database.prepare(`SELECT id, workspace_id, name, paired_at, last_seen_at, revoked_at
        FROM devices WHERE token_hash = ? AND revoked_at IS NULL`).get(sha256(token));
      if (!row) return null;
      const now = Date.now();
      database.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now, row.id);
      return { ...mapDevice(row), lastSeenAt: now };
    },

    listDevices() {
      return database.prepare(`SELECT id, workspace_id, name, paired_at, last_seen_at, revoked_at
        FROM devices ORDER BY paired_at DESC`).all().map(mapDevice);
    },

    revokeDevice(id) {
      const now = Date.now();
      const result = database.prepare(`UPDATE devices SET revoked_at = ?
        WHERE id = ? AND revoked_at IS NULL`).run(now, id);
      if (result.changes > 0) insertEvent('device.revoked', 'device', id, { deviceId: id }, DEFAULT_WORKSPACE_ID);
      return result.changes > 0;
    },

    listPosts(limit = 100) {
      return database.prepare(`SELECT id, title, body, source_url, tags_json,
        created_by_device, created_at, updated_at
        FROM posts ORDER BY created_at DESC LIMIT ?`).all(Math.max(1, Math.min(Number(limit) || 100, 200))).map(mapPost);
    },

    getPost(id) {
      const row = database.prepare(`SELECT id, title, body, source_url, tags_json,
        created_by_device, created_at, updated_at FROM posts WHERE id = ?`).get(id);
      return row ? mapPost(row) : null;
    },

    createPost(input, deviceId = null) {
      const now = Date.now();
      const post = {
        id: randomUUID(),
        ...input,
        createdByDevice: deviceId,
        createdAt: now,
        updatedAt: now,
      };
      database.transaction(() => {
        database.prepare(`INSERT INTO posts
          (id, title, body, source_url, tags_json, created_by_device, created_at, updated_at, workspace_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(post.id, post.title, post.body, post.sourceUrl, JSON.stringify(post.tags), deviceId, now, now, DEFAULT_WORKSPACE_ID);
        insertEvent('post.created', 'post', post.id, { post }, DEFAULT_WORKSPACE_ID);
      })();
      return post;
    },

    recordBehavior(name, deviceId = null, metadata = {}) {
      database.prepare(`INSERT INTO behavior_events
        (device_id, event_name, metadata_json, created_at) VALUES (?, ?, ?, ?)`)
        .run(deviceId, name, JSON.stringify(metadata), Date.now());
    },

    getMetrics() {
      const since = Date.now() - 24 * 60 * 60 * 1000;
      const activeDevices = database.prepare(`SELECT COUNT(*) AS count FROM devices
        WHERE revoked_at IS NULL`).get().count;
      const counts = Object.fromEntries(database.prepare(`SELECT event_name, COUNT(*) AS count
        FROM behavior_events WHERE created_at >= ? GROUP BY event_name`).all(since)
        .map((row) => [row.event_name, row.count]));
      return {
        windowHours: 24,
        activeDevices,
        appOpens: counts['app.open'] || 0,
        feedsLoaded: counts['feed.loaded'] || 0,
        composerStarts: counts['composer.started'] || 0,
        detailsOpened: counts['post.opened'] || 0,
        published: counts['post.created'] || 0,
      };
    },

    createNote(input) {
      const now = Date.now();
      const note = {
        id: randomUUID(),
        body: input.body,
        wantAi: Boolean(input.wantAi),
        aiReply: input.wantAi ? sketchReply(input.body) : '',
        status: 'inbox',
        knowledgeId: '',
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      };
      database.transaction(() => {
        database.prepare(`INSERT INTO notes
          (id, body, ai_reply, want_ai, status, knowledge_id, created_at, updated_at, archived_at, workspace_id)
          VALUES (?, ?, ?, ?, 'inbox', NULL, ?, ?, NULL, ?)`)
          .run(note.id, note.body, note.aiReply, note.wantAi ? 1 : 0, now, now, DEFAULT_WORKSPACE_ID);
        if (note.aiReply) {
          database.prepare(`INSERT INTO ai_runs
            (id, workspace_id, source_type, source_id, task_type, status, provider_id, model_id,
             input_hash, output_text, output_json, error_json, created_at, completed_at)
            VALUES (?, ?, 'inspiration', ?, 'idea-sketch', 'completed', 'local-template', '', ?, ?, NULL, NULL, ?, ?)`)
            .run(randomUUID(), DEFAULT_WORKSPACE_ID, note.id, sha256(note.body), note.aiReply, now, now);
        }
        insertEvent('inspiration.created', 'inspiration', note.id, { note }, DEFAULT_WORKSPACE_ID);
      })();
      return note;
    },

    listNotes(status = 'inbox') {
      const allowed = status === 'archived' ? 'archived' : 'inbox';
      return database.prepare(`SELECT id, body, ai_reply, want_ai, status, knowledge_id,
        created_at, updated_at, archived_at FROM notes WHERE status = ? ORDER BY created_at DESC`)
        .all(allowed).map(mapNote);
    },

    archiveNote(id) {
      const row = database.prepare(`SELECT id, body, ai_reply, want_ai, status, knowledge_id,
        created_at, updated_at, archived_at FROM notes WHERE id = ?`).get(id);
      if (!row || row.status === 'archived') return row ? mapNote(row) : null;
      const now = Date.now();
      const title = `${row.body.slice(0, 28)}${row.body.length > 28 ? '…' : ''}`;
      const knowledgeId = randomUUID();
      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare(`INSERT INTO knowledge_items
          (id, title, body, source, source_note_id, created_at, updated_at, workspace_id)
          VALUES (?, ?, ?, 'inspiration', ?, ?, ?, ?)`)
          .run(knowledgeId, title, row.body, row.id, now, now, DEFAULT_WORKSPACE_ID);
        database.prepare(`INSERT INTO knowledge_links
          (knowledge_id, source_type, source_id, relation_type, created_at)
          VALUES (?, 'inspiration', ?, 'derived_from', ?)`)
          .run(knowledgeId, row.id, now);
        database.prepare(`UPDATE notes SET status = 'archived', knowledge_id = ?, archived_at = ?, updated_at = ?
          WHERE id = ?`).run(knowledgeId, now, now, id);
        insertEvent('inspiration.promoted', 'inspiration', id, { inspirationId: id, knowledgeId }, DEFAULT_WORKSPACE_ID);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      return mapNote(database.prepare(`SELECT id, body, ai_reply, want_ai, status, knowledge_id,
        created_at, updated_at, archived_at FROM notes WHERE id = ?`).get(id));
    },

    listKnowledge() {
      return database.prepare(`SELECT id, title, body, source, source_note_id, created_at, updated_at
        FROM knowledge_items ORDER BY created_at DESC`).all().map(mapKnowledge);
    },

    createJob(input) {
      const now = Date.now();
      const job = {
        id: randomUUID(),
        workspaceId: input.workspaceId || DEFAULT_WORKSPACE_ID,
        type: input.type,
        status: 'queued',
        input: input.input || {},
        output: null,
        error: null,
        priority: Number.isFinite(input.priority) ? Math.trunc(input.priority) : 0,
        attemptCount: 0,
        maxAttempts: Math.max(1, Math.min(Number(input.maxAttempts) || 3, 10)),
        availableAt: Number(input.availableAt) || now,
        lockedBy: '',
        lockedAt: null,
        startedAt: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      database.transaction(() => {
        database.prepare(`INSERT INTO jobs
          (id, workspace_id, type, status, input_json, output_json, error_json, priority,
           attempt_count, max_attempts, available_at, locked_by, locked_at, started_at,
           completed_at, created_at, updated_at)
          VALUES (?, ?, ?, 'queued', ?, NULL, NULL, ?, 0, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`)
          .run(job.id, job.workspaceId, job.type, JSON.stringify(job.input), job.priority,
            job.maxAttempts, job.availableAt, now, now);
        insertEvent('job.queued', 'job', job.id, { job }, job.workspaceId);
      })();
      return job;
    },

    claimNextJob(workerId, acceptedTypes = []) {
      const now = Date.now();
      database.exec('BEGIN IMMEDIATE');
      try {
        const typeFilter = acceptedTypes.length
          ? `AND type IN (${acceptedTypes.map(() => '?').join(', ')})`
          : '';
        const row = database.prepare(`SELECT * FROM jobs
          WHERE status = 'queued' AND available_at <= ? ${typeFilter}
          ORDER BY priority DESC, created_at ASC LIMIT 1`).get(now, ...acceptedTypes);
        if (!row) {
          database.exec('COMMIT');
          return null;
        }
        const result = database.prepare(`UPDATE jobs SET status = 'running', locked_by = ?, locked_at = ?,
          started_at = COALESCE(started_at, ?), attempt_count = attempt_count + 1, updated_at = ?
          WHERE id = ? AND status = 'queued'`).run(workerId, now, now, now, row.id);
        if (!result.changes) {
          database.exec('ROLLBACK');
          return null;
        }
        insertEvent('job.started', 'job', row.id, { jobId: row.id, workerId }, row.workspace_id);
        database.exec('COMMIT');
        return mapJob(database.prepare('SELECT * FROM jobs WHERE id = ?').get(row.id));
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },

    completeJob(id, output = {}) {
      const now = Date.now();
      const current = database.prepare('SELECT workspace_id FROM jobs WHERE id = ?').get(id);
      if (!current) return null;
      database.transaction(() => {
        const result = database.prepare(`UPDATE jobs SET status = 'completed', output_json = ?, error_json = NULL,
          completed_at = ?, locked_by = NULL, locked_at = NULL, updated_at = ?
          WHERE id = ? AND status = 'running'`)
          .run(JSON.stringify(output), now, now, id);
        if (result.changes) insertEvent('job.completed', 'job', id, { jobId: id, output }, current.workspace_id);
      })();
      return mapJob(database.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
    },

    failJob(id, error, retryDelayMs = 1_000) {
      const now = Date.now();
      const current = database.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
      if (!current) return null;
      if (current.status !== 'running') return mapJob(current);
      const retry = current.attempt_count < current.max_attempts;
      const status = retry ? 'queued' : 'failed';
      const availableAt = retry ? now + Math.max(0, Number(retryDelayMs) || 0) : current.available_at;
      const errorPayload = error instanceof Error
        ? { name: error.name, message: error.message }
        : { name: 'Error', message: String(error) };
      database.transaction(() => {
        database.prepare(`UPDATE jobs SET status = ?, error_json = ?, available_at = ?,
          completed_at = ?, locked_by = NULL, locked_at = NULL, updated_at = ? WHERE id = ?`)
          .run(status, JSON.stringify(errorPayload), availableAt, retry ? null : now, now, id);
        insertEvent(retry ? 'job.retry_scheduled' : 'job.failed', 'job', id,
          { jobId: id, error: errorPayload, availableAt: retry ? availableAt : null }, current.workspace_id);
      })();
      return mapJob(database.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
    },

    touchJob(id, workerId) {
      const result = database.prepare(`UPDATE jobs SET locked_at = ?, updated_at = ?
        WHERE id = ? AND status = 'running' AND locked_by = ?`)
        .run(Date.now(), Date.now(), id, workerId);
      return result.changes > 0;
    },

    recoverStaleJobs(staleAfterMs = 10 * 60_000) {
      const now = Date.now();
      const cutoff = now - Math.max(60_000, Number(staleAfterMs) || 10 * 60_000);
      const rows = database.prepare(`SELECT * FROM jobs WHERE status = 'running' AND locked_at < ?`).all(cutoff);
      database.transaction(() => {
        for (const row of rows) {
          const retry = row.attempt_count < row.max_attempts;
          const status = retry ? 'queued' : 'failed';
          const error = { name: 'WorkerLeaseExpired', message: '后台进程中断，任务租约已过期' };
          database.prepare(`UPDATE jobs SET status = ?, error_json = ?, available_at = ?, completed_at = ?,
            locked_by = NULL, locked_at = NULL, updated_at = ? WHERE id = ?`)
            .run(status, JSON.stringify(error), now, retry ? null : now, now, row.id);
          insertEvent(retry ? 'job.recovered' : 'job.failed', 'job', row.id,
            { jobId: row.id, error }, row.workspace_id);
        }
      })();
      return rows.length;
    },

    getJob(id) {
      const row = database.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
      return row ? mapJob(row) : null;
    },

    listJobs(limit = 50) {
      return database.prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`)
        .all(Math.max(1, Math.min(Number(limit) || 50, 200))).map(mapJob);
    },

    listEvents(afterId = 0, limit = 200, workspaceId = null) {
      const safeAfterId = Math.max(0, Number(afterId) || 0);
      const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 1_000));
      const rows = workspaceId
        ? database.prepare(`SELECT * FROM outbox_events WHERE workspace_id = ? AND id > ? ORDER BY id ASC LIMIT ?`)
          .all(workspaceId, safeAfterId, safeLimit)
        : database.prepare(`SELECT * FROM outbox_events WHERE id > ? ORDER BY id ASC LIMIT ?`)
          .all(safeAfterId, safeLimit);
      return rows
        .map(mapOutboxEvent);
    },

    latestEventId() {
      return database.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM outbox_events').get().id;
    },

    setProviderHealth(providerId, status, message = '', metadata = {}) {
      const now = Date.now();
      const successAt = status === 'healthy' ? now : null;
      const failureAt = status === 'unhealthy' ? now : null;
      database.prepare(`INSERT INTO provider_health
        (workspace_id, provider_id, status, message, last_success_at, last_failure_at, checked_at, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, provider_id) DO UPDATE SET
          status = excluded.status,
          message = excluded.message,
          last_success_at = COALESCE(excluded.last_success_at, provider_health.last_success_at),
          last_failure_at = COALESCE(excluded.last_failure_at, provider_health.last_failure_at),
          checked_at = excluded.checked_at,
          metadata_json = excluded.metadata_json`)
        .run(DEFAULT_WORKSPACE_ID, providerId, status, message, successAt, failureAt, now, JSON.stringify(metadata));
    },

    getRuntimeStatus() {
      const jobs = Object.fromEntries(database.prepare(`SELECT status, COUNT(*) AS count
        FROM jobs GROUP BY status`).all().map((row) => [row.status, row.count]));
      const providers = database.prepare(`SELECT provider_id AS providerId, status, message,
        last_success_at AS lastSuccessAt, last_failure_at AS lastFailureAt, checked_at AS checkedAt,
        metadata_json AS metadataJson FROM provider_health ORDER BY provider_id`).all()
        .map(({ metadataJson, ...row }) => ({ ...row, metadata: parseJson(metadataJson) }));
      return {
        schemaVersion,
        workspaceId: DEFAULT_WORKSPACE_ID,
        latestEventId: database.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM outbox_events').get().id,
        jobs,
        providers,
      };
    },

    close() {
      database.close();
    },
  };
}
