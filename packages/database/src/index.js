import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DEFAULT_WORKSPACE_ID, runMigrations } from './migrations.js';
import { translationRetryDelayMs } from './translation-retry.js';
import { createDomainRepositories } from './repositories/index.js';
import { createRuntimeRepository } from './repositories/runtime-repository.js';
import { FeedTranslationJobInputSchema } from '../../contracts/src/feed.js';
import {PrepareTreeInformationInputSchema} from '../../contracts/src/information-tree.js';
export { createAttachmentStore } from './attachment-store.js';

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

const NOTE_COLUMNS = `id, body, ai_reply, want_ai, status, knowledge_id, pinned,
  source_type, source_id, source_url, source_title, capture_channel, source_app,
  client_mutation_id, captured_at, title, inspiration_type, created_at, updated_at, archived_at`;

function mapNote(row) {
  return {
    id: row.id,
    title: row.title || '',
    body: row.body,
    inspirationType: row.inspiration_type || '',
    aiReply: row.ai_reply || '',
    wantAi: Boolean(row.want_ai),
    status: row.status,
    pinned: Boolean(row.pinned),
    knowledgeId: row.knowledge_id || '',
    sourceType: row.source_type || '',
    sourceId: row.source_id || '',
    sourceUrl: row.source_url || '',
    sourceTitle: row.source_title || '',
    captureChannel: row.capture_channel || 'web',
    sourceApp: row.source_app || '',
    clientMutationId: row.client_mutation_id || '',
    capturedAt: row.captured_at || row.created_at,
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
    knowledgeType: row.knowledge_type || '',
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

function parseJobExecutor(executor = {}) {
  const workerId = String(executor.workerId || '').trim();
  const attemptCount = Number(executor.attemptCount);
  if (!workerId || !Number.isInteger(attemptCount) || attemptCount < 1) return null;
  return { workerId, attemptCount };
}

function jobFailureText(value, max) {
  return typeof value === 'string' && value ? value.slice(0, max) : null;
}

function jobFailureGroup(item) {
  if (!item || typeof item !== 'object') return null;
  return {
    kind: jobFailureText(item.kind, 40),
    code: jobFailureText(item.code, 80),
    message: jobFailureText(item.message, 500),
    group: jobFailureText(item.group, 80),
    model: jobFailureText(item.model, 80),
    durationMs: Number.isFinite(item.durationMs) ? Math.round(item.durationMs) : null,
    httpStatus: Number.isInteger(item.httpStatus) ? item.httpStatus : null,
  };
}

function jobErrorPayload(error) {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error).slice(0, 500) };
  const payload = { name: error.name || 'Error', message: String(error.message || '').slice(0, 500) };
  const extra = error.reportFailure;
  if (!extra || typeof extra !== 'object') return payload;
  const kind = jobFailureText(extra.kind, 40);
  const code = jobFailureText(extra.code, 80);
  const message = jobFailureText(extra.message, 500);
  const summary = jobFailureText(extra.summary, 200);
  if (kind) payload.kind = kind;
  if (code) payload.code = code;
  if (message) payload.message = message;
  if (summary) payload.summary = summary;
  payload.group = jobFailureText(extra.group, 80);
  payload.model = jobFailureText(extra.model, 80);
  payload.durationMs = Number.isFinite(extra.durationMs) ? Math.round(extra.durationMs) : null;
  payload.httpStatus = Number.isInteger(extra.httpStatus) ? extra.httpStatus : null;
  payload.groups = Array.isArray(extra.groups) ? extra.groups.slice(0, 12).map(jobFailureGroup).filter(Boolean) : [];
  return payload;
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
    schemaVersion: row.schema_version || 1,
    correlationId: row.correlation_id || null,
    causationId: row.causation_id || null,
    occurredAt: row.occurred_at || row.created_at,
    createdAt: row.created_at,
  };
}

function mapAgentRunEvent(row) {
  return {
    id: Number(row.id),
    version: Number(row.version) || 1,
    runId: row.run_id,
    workspaceId: row.workspace_id,
    event: row.event_name,
    detail: parseJson(row.detail_json),
    at: row.occurred_at,
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

const LAST_SEEN_INTERVAL_MS = 60_000;

function instrumentWriteTransactions(database) {
  const logSlow = /[/\\]apps[/\\]worker[/\\]/.test(process.argv[1] || '');
  const original = database.transaction.bind(database);
  database.transaction = (fn) => original(function timedWrite(...args) {
    const started = performance.now();
    try {
      return fn.apply(this, args);
    } finally {
      const elapsed = performance.now() - started;
      if (logSlow && elapsed >= 200) {
        const at = (new Error().stack || '').split('\n').slice(1, 8)
          .map((line) => line.trim())
          .filter((line) => line && !line.includes('node_modules') && !line.includes('timedWrite'))
          .slice(0, 2)
          .join(' ');
        console.warn(`[worker] sqlite write ${Math.round(elapsed)}ms ${at}`);
      }
    }
  });
}

export function createStore(databasePath) {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  const schemaVersion = runMigrations(database);
  instrumentWriteTransactions(database);
  const lastSeenWrittenAt = new Map();
  const updateLastSeen = database.prepare(
    'UPDATE devices SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL',
  );

  function scheduleLastSeen(deviceId, seenAt) {
    const previous = lastSeenWrittenAt.get(deviceId) || 0;
    if (seenAt - previous < LAST_SEEN_INTERVAL_MS) return;
    lastSeenWrittenAt.set(deviceId, seenAt);
    setImmediate(() => {
      let narrowed = false;
      try {
        database.pragma('busy_timeout = 0');
        narrowed = true;
        updateLastSeen.run(seenAt, deviceId);
      } catch (error) {
        lastSeenWrittenAt.delete(deviceId);
        const code = error?.code || '';
        const closed = code === 'SQLITE_MISUSE' || /not open/i.test(String(error?.message || ''));
        if (code !== 'SQLITE_BUSY' && code !== 'SQLITE_BUSY_TIMEOUT' && !closed) {
          console.error('[sqlite] last_seen_at skipped', code || error?.message || error);
        }
      } finally {
        if (narrowed) {
          try { database.pragma('busy_timeout = 5000'); } catch { /* connection already closed */ }
        }
      }
    });
  }

  const SSE_DATA_MAX_BYTES = 8_000;

  function insertEvent(name, aggregateType, aggregateId, payload = {}, workspaceId = DEFAULT_WORKSPACE_ID) {
    const now = Date.now();
    const payloadJson = JSON.stringify(payload);
    const payloadBytes = Buffer.byteLength(payloadJson);
    const sseData = payloadBytes <= SSE_DATA_MAX_BYTES
      ? payloadJson
      : `{"truncated":true,"bytes":${payloadBytes}}`;
    const result = database.prepare(`INSERT INTO outbox_events
      (workspace_id, event_name, aggregate_type, aggregate_id, payload_json, payload_bytes, sse_data, schema_version,
       occurred_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(workspaceId, name, aggregateType, aggregateId, payloadJson, payloadBytes, sseData, now, now);
    return Number(result.lastInsertRowid);
  }

  const repositories = createDomainRepositories(database, insertEvent);
  const runtimeRepository = createRuntimeRepository(database, insertEvent);

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

  function insertDevice(deviceName) {
    const now = Date.now();
    const token = `${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`;
    const device = { id: randomUUID(), name: deviceName, pairedAt: now, lastSeenAt: now, revokedAt: null };
    database.prepare(`INSERT INTO devices
      (id, name, token_hash, paired_at, last_seen_at, revoked_at, workspace_id)
      VALUES (?, ?, ?, ?, ?, NULL, ?)`)
      .run(device.id, device.name, sha256(token), now, now, DEFAULT_WORKSPACE_ID);
    insertEvent('device.paired', 'device', device.id, { device }, DEFAULT_WORKSPACE_ID);
    return { device, token };
  }

  return {
    repositories,
    upsertJobSchedule: (value) => runtimeRepository.upsertJobSchedule(value),
    getJobSchedule: (workspaceId, key) => runtimeRepository.getJobSchedule(workspaceId, key),
    listDueSchedules: (now, limit) => runtimeRepository.listDueSchedules(now, limit),
    enqueueDueSchedule: (scheduleId, now) => runtimeRepository.enqueueDueSchedule(scheduleId, now),
    createPairingCode(ttlMinutes = 10) {
      const now = Date.now();
      database.prepare('UPDATE pairing_codes SET used_at = ? WHERE used_at IS NULL').run(now);
      const code = String(randomInt(100000, 1_000_000));
      const pairToken = randomBytes(32).toString('base64url');
      const expiresAt = now + ttlMinutes * 60_000;
      database.prepare(`INSERT INTO pairing_codes
        (code_hash, public_secret_hash, expires_at, used_at, created_at)
        VALUES (?, ?, ?, NULL, ?)`)
        .run(sha256(code), sha256(pairToken), expiresAt, now);
      return { code, pairToken, expiresAt };
    },

    issueDevice(deviceName) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const result = insertDevice(deviceName);
        database.exec('COMMIT');
        return result;
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },

    redeemPairingCode(code, deviceName, { requireSecret = false } = {}) {
      const now = Date.now();
      const codeHash = sha256(code);
      database.exec('BEGIN IMMEDIATE');
      try {
        const pairing = requireSecret
          ? database.prepare(`SELECT code_hash, expires_at, used_at FROM pairing_codes
              WHERE public_secret_hash = ?`).get(codeHash)
          : database.prepare(`SELECT code_hash, expires_at, used_at FROM pairing_codes
              WHERE code_hash = ? OR public_secret_hash = ?`).get(codeHash, codeHash);
        if (!pairing || pairing.used_at || pairing.expires_at <= now) {
          database.exec('ROLLBACK');
          return null;
        }
        database.prepare('UPDATE pairing_codes SET used_at = ? WHERE code_hash = ?').run(now, pairing.code_hash);
        const result = insertDevice(deviceName);
        database.exec('COMMIT');
        return result;
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
      scheduleLastSeen(row.id, Date.now());
      return mapDevice(row);
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
        FROM posts WHERE hidden_at IS NULL ORDER BY created_at DESC LIMIT ?`).all(Math.max(1, Math.min(Number(limit) || 100, 200))).map(mapPost);
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

    hidePost(id) {
      const now = Date.now();
      const result = database.prepare(`UPDATE posts SET hidden_at = ?, updated_at = ?
        WHERE id = ? AND hidden_at IS NULL`).run(now, now, id);
      if (result.changes > 0) insertEvent('feed.post.hidden.v1', 'post', id, { postId: id }, DEFAULT_WORKSPACE_ID);
      return result.changes > 0;
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
      if (input.clientMutationId) {
        const existing = database.prepare(`SELECT ${NOTE_COLUMNS} FROM notes
          WHERE workspace_id = ? AND client_mutation_id = ?`)
          .get(DEFAULT_WORKSPACE_ID, input.clientMutationId);
        if (existing) return mapNote(existing);
      }
      const now = Date.now();
      const note = {
        id: randomUUID(),
        title: input.title || '',
        body: input.body,
        inspirationType: input.inspirationType || '',
        wantAi: Boolean(input.wantAi),
        aiReply: input.wantAi ? sketchReply(input.body) : '',
        status: 'inbox',
        knowledgeId: '',
        sourceType: input.sourceType || '',
        sourceId: input.sourceId || '',
        sourceUrl: input.sourceUrl || '',
        sourceTitle: input.sourceTitle || '',
        captureChannel: input.captureChannel || 'web',
        sourceApp: input.sourceApp || '',
        clientMutationId: input.clientMutationId || '',
        capturedAt: Number.isInteger(input.capturedAt) && input.capturedAt >= 0 ? input.capturedAt : now,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        pinned: false,
      };
      database.transaction(() => {
        database.prepare(`INSERT INTO notes
          (id, body, ai_reply, want_ai, status, knowledge_id, source_type, source_id,
           source_url, source_title, capture_channel, source_app, title, inspiration_type,
           client_mutation_id, captured_at, created_at, updated_at, archived_at, workspace_id)
          VALUES (?, ?, ?, ?, 'inbox', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
          .run(note.id, note.body, note.aiReply, note.wantAi ? 1 : 0,
            note.sourceType, note.sourceId, note.sourceUrl, note.sourceTitle, note.captureChannel,
            note.sourceApp, note.title, note.inspirationType, note.clientMutationId, note.capturedAt,
            now, now, DEFAULT_WORKSPACE_ID);
        if (note.aiReply) {
          repositories.knowledge.recordAgentRun({
            jobId: note.id,
            workspaceId: DEFAULT_WORKSPACE_ID,
            message: note.body,
            answer: note.aiReply,
            providerId: 'local-template',
            modelId: '',
            sourceType: 'inspiration',
            sourceId: note.id,
            taskType: 'idea-sketch',
          });
        }
        insertEvent('inspiration.created', 'inspiration', note.id, { note }, DEFAULT_WORKSPACE_ID);
      })();
      return note;
    },

    getNote(id) {
      const row = database.prepare(`SELECT ${NOTE_COLUMNS} FROM notes WHERE id = ?`).get(id);
      return row ? mapNote(row) : null;
    },

    listNotes(status = 'inbox') {
      if (status === 'all') {
        return database.prepare(`SELECT ${NOTE_COLUMNS} FROM notes ORDER BY pinned DESC, captured_at DESC, created_at DESC`)
          .all().map(mapNote);
      }
      const allowed = status === 'archived' ? 'archived' : 'inbox';
      return database.prepare(`SELECT ${NOTE_COLUMNS} FROM notes WHERE status = ? ORDER BY pinned DESC, captured_at DESC, created_at DESC`)
        .all(allowed).map(mapNote);
    },

    pinNote(id) {
      const row = database.prepare(`SELECT ${NOTE_COLUMNS} FROM notes WHERE id = ?`).get(id);
      if (!row) return null;
      const pinned = row.pinned ? 0 : 1;
      database.prepare('UPDATE notes SET pinned = ?, updated_at = ? WHERE id = ?').run(pinned, Date.now(), id);
      return mapNote(database.prepare(`SELECT ${NOTE_COLUMNS} FROM notes WHERE id = ?`).get(id));
    },

    deleteNote(id) {
      const result = database.prepare('DELETE FROM notes WHERE id = ?').run(id);
      return result.changes > 0;
    },

    archiveNote(id) {
      const row = database.prepare(`SELECT ${NOTE_COLUMNS} FROM notes WHERE id = ?`).get(id);
      if (!row || row.status === 'archived') return row ? mapNote(row) : null;
      const now = Date.now();
      const title = row.title || `${row.body.slice(0, 28)}${row.body.length > 28 ? '…' : ''}`;
      database.transaction(() => {
        const document = repositories.knowledge.createDocument({
          workspaceId: DEFAULT_WORKSPACE_ID,
          title,
          body: row.body,
          createdByType: 'user',
          createdById: null,
          source: 'inspiration',
          sourceNoteId: row.id,
          metadata: { kind: 'inspiration', inspirationId: row.id },
        });
        repositories.knowledge.linkDerivedFrom({
          knowledgeId: document.id,
          sourceType: 'inspiration',
          sourceId: row.id,
        });
        database.prepare(`UPDATE notes SET status = 'archived', knowledge_id = ?, archived_at = ?, updated_at = ?
          WHERE id = ?`).run(document.id, now, now, id);
        insertEvent('inspiration.promoted', 'inspiration', id,
          { inspirationId: id, knowledgeId: document.id }, DEFAULT_WORKSPACE_ID);
      })();
      return mapNote(database.prepare(`SELECT ${NOTE_COLUMNS} FROM notes WHERE id = ?`).get(id));
    },

    listKnowledge() {
      return database.prepare(`SELECT id, title, body, source, source_note_id, knowledge_type, created_at, updated_at
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

    prioritizeQueuedJobs(workspaceId, ids, priority) {
      if(!Array.isArray(ids) || !Number.isSafeInteger(priority))throw new Error('队列优先级参数不合法');
      return database.transaction(()=>{
        const changed=[];
        for(const id of new Set(ids)) {
          const result=database.prepare("UPDATE jobs SET priority=?,updated_at=? WHERE id=? AND workspace_id=? AND status='queued' AND priority<?").run(priority,Date.now(),id,workspaceId,priority);
          if(result.changes){insertEvent('job.prioritized','job',id,{jobId:id,priority},workspaceId);changed.push(id);}
        }
        return changed;
      })();
    },

    reprioritizeQueuedJobs(workspaceId,changes) {
      if(!Array.isArray(changes) || changes.some(c=>typeof c.id!=='string' || !Number.isSafeInteger(c.priority) || !Number.isSafeInteger(c.expectedPriority)))throw new Error('队列优先级参数不合法');
      return database.transaction(()=>{
        const changed=[];
        for(const value of changes) {
          const result=database.prepare("UPDATE jobs SET priority=?,updated_at=? WHERE id=? AND workspace_id=? AND status='queued' AND priority=?")
            .run(value.priority,Date.now(),value.id,workspaceId,value.expectedPriority);
          if(result.changes){insertEvent('job.prioritized','job',value.id,{jobId:value.id,priority:value.priority},workspaceId);changed.push(value.id);}
        }
        return changed;
      })();
    },

    rescheduleQueuedJobs(workspaceId,changes) {
      if(!Array.isArray(changes) || changes.some(c=>typeof c.id!=='string' || !Number.isSafeInteger(c.availableAt) || c.availableAt<0 || !Number.isSafeInteger(c.expectedAvailableAt)))throw new Error('队列时间参数不合法');
      return database.transaction(()=>{
        const changed=[];
        for(const value of changes){
          const result=database.prepare("UPDATE jobs SET available_at=?,updated_at=? WHERE id=? AND workspace_id=? AND status='queued' AND available_at=?")
            .run(value.availableAt,Date.now(),value.id,workspaceId,value.expectedAvailableAt);
          if(result.changes){insertEvent('job.rescheduled','job',value.id,{jobId:value.id,availableAt:value.availableAt},workspaceId);changed.push(value.id);}
        }
        return changed;
      })();
    },

    claimNextJob(workerId, acceptedTypes = [], options = {}) {
      const now = Date.now();
      let claimedId = null;
      const minPriority = Number.isFinite(Number(options?.minPriority)) ? Math.trunc(Number(options.minPriority)) : null;
      database.exec('BEGIN IMMEDIATE');
      try {
        const typeFilter = acceptedTypes.length
          ? `AND type IN (${acceptedTypes.map(() => '?').join(', ')})`
          : '';
        const priorityFilter = minPriority == null ? '' : 'AND priority >= ?';
        const params = [now, ...acceptedTypes];
        if (minPriority != null) params.push(minPriority);
        const nextQueued = database.prepare(`SELECT * FROM jobs
          WHERE status = 'queued' AND available_at <= ? ${typeFilter} ${priorityFilter}
          ORDER BY priority DESC, created_at ASC LIMIT 1`);
        const maxAttemptFor = database.prepare('SELECT MAX(attempt_number) AS maxAttempt FROM job_attempts WHERE job_id = ?');
        const capError = JSON.stringify({ name: 'MaxAttemptsExceeded', message: '已达到尝试上限，不再领取' });
        const exhaust = database.prepare(`UPDATE jobs SET status = 'failed', error_json = ?, completed_at = ?,
          locked_by = NULL, locked_at = NULL, updated_at = ?
          WHERE id = ? AND status = 'queued'`);
        const claim = database.prepare(`UPDATE jobs SET status = 'running', locked_by = ?, locked_at = ?,
          started_at = COALESCE(started_at, ?), attempt_count = ?, updated_at = ?
          WHERE id = ? AND status = 'queued'`);
        const insertAttempt = database.prepare(`INSERT INTO job_attempts
          (id, job_id, attempt_number, worker_id, status, error_json, started_at, completed_at)
          VALUES (?, ?, ?, ?, 'running', NULL, ?, NULL)`);
        while (true) {
          const row = nextQueued.get(...params);
          if (!row) {
            database.exec('COMMIT');
            return null;
          }
          const maxRow = maxAttemptFor.get(row.id);
          const attemptNumber = Math.max(Number(row.attempt_count) + 1, Number(maxRow?.maxAttempt || 0) + 1);
          const exhausted = Number(row.attempt_count) >= Number(row.max_attempts) || attemptNumber > Number(row.max_attempts);
          if (exhausted) {
            const capped = exhaust.run(capError, now, now, row.id);
            if (!capped.changes) {
              database.exec('ROLLBACK');
              return null;
            }
            insertEvent('job.failed', 'job', row.id, {
              jobId: row.id,
              error: { name: 'MaxAttemptsExceeded', message: '已达到尝试上限，不再领取' },
            }, row.workspace_id);
            continue;
          }
          claimedId = row.id;
          const result = claim.run(workerId, now, now, attemptNumber, now, row.id);
          if (!result.changes) {
            database.exec('ROLLBACK');
            return null;
          }
          insertAttempt.run(randomUUID(), row.id, attemptNumber, workerId, now);
          insertEvent('job.started', 'job', row.id, { jobId: row.id, workerId }, row.workspace_id);
          database.exec('COMMIT');
          return mapJob(database.prepare('SELECT * FROM jobs WHERE id = ?').get(row.id));
        }
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        if (claimedId && error && typeof error === 'object') error.jobId = claimedId;
        throw error;
      }
    },

    completeJob(id, output = {}, executor = {}) {
      const now = Date.now();
      const claim = parseJobExecutor(executor);
      const current = database.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
      if (!current) return null;
      if (!claim) return mapJob(current);
      database.transaction(() => {
        const result = database.prepare(`UPDATE jobs SET status = 'completed', output_json = ?, error_json = NULL,
          completed_at = ?, locked_by = NULL, locked_at = NULL, updated_at = ?
          WHERE id = ? AND status = 'running' AND locked_by = ? AND attempt_count = ?`)
          .run(JSON.stringify(output), now, now, id, claim.workerId, claim.attemptCount);
        if (result.changes) {
          database.prepare(`UPDATE job_attempts SET status = 'completed', completed_at = ?
            WHERE job_id = ? AND attempt_number = ? AND worker_id = ? AND status = 'running'`)
            .run(now, id, claim.attemptCount, claim.workerId);
          insertEvent('job.completed', 'job', id, { jobId: id, output }, current.workspace_id);
        }
      })();
      return mapJob(database.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
    },

    replaceRunningJobInput(id, input, executor = {}) {
      const claim = parseJobExecutor(executor);
      const current = database.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
      if (!current || !claim || current.status !== 'running' || current.type !== 'feed.translation.run') return false;
      const value = FeedTranslationJobInputSchema.parse({
        ...(current.input_json ? parseJson(current.input_json) : {}),
        ...input,
        workspaceId: current.workspace_id,
      });
      const result = database.prepare(`UPDATE jobs SET input_json = ?, updated_at = ?
        WHERE id = ? AND status = 'running' AND locked_by = ? AND attempt_count = ?`)
        .run(JSON.stringify(value), Date.now(), id, claim.workerId, claim.attemptCount);
      return result.changes === 1;
    },

    failJob(id, error, retryDelayMs = 1_000, executor = {}) {
      const now = Date.now();
      const claim = parseJobExecutor(executor);
      const current = database.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
      if (!current) return null;
      if (!claim || current.status !== 'running') return mapJob(current);
      const retry = current.attempt_count < current.max_attempts;
      const status = retry ? 'queued' : 'failed';
      const availableAt = retry ? now + Math.max(0, Number(retryDelayMs) || 0) : current.available_at;
      const errorPayload = jobErrorPayload(error);
      let changed = false;
      database.transaction(() => {
        const result = database.prepare(`UPDATE jobs SET status = ?, error_json = ?, available_at = ?,
          completed_at = ?, locked_by = NULL, locked_at = NULL, updated_at = ?
          WHERE id = ? AND status = 'running' AND locked_by = ? AND attempt_count = ?`)
          .run(status, JSON.stringify(errorPayload), availableAt, retry ? null : now, now, id,
            claim.workerId, claim.attemptCount);
        if (!result.changes) return;
        changed = true;
        database.prepare(`UPDATE job_attempts SET status = 'failed', error_json = ?, completed_at = ?
          WHERE job_id = ? AND attempt_number = ? AND worker_id = ? AND status = 'running'`)
          .run(JSON.stringify(errorPayload), now, id, claim.attemptCount, claim.workerId);
        insertEvent(retry ? 'job.retry_scheduled' : 'job.failed', 'job', id,
          { jobId: id, error: errorPayload, availableAt: retry ? availableAt : null }, current.workspace_id);
      })();
      if (changed && current.type === 'feed.translation.run') {
        const input = parseJson(current.input_json);
        repositories.feed.noteTranslationFailure?.({
          workspaceId: current.workspace_id,
          items: input.items || [],
          targetLang: input.targetLang,
          error,
          attemptCount: current.attempt_count,
          terminal: !retry,
          nextRetryAt: retry ? availableAt : null,
        });
      }
      return mapJob(database.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
    },

    touchJob(id, workerId) {
      const result = database.prepare(`UPDATE jobs SET locked_at = ?, updated_at = ?
        WHERE id = ? AND status = 'running' AND locked_by = ?`)
        .run(Date.now(), Date.now(), id, workerId);
      return result.changes > 0;
    },

    recoverStaleJobs(staleAfterMs = 10 * 60_000, now = Date.now(), options = {}) {
      const leaseMs = Number(staleAfterMs);
      const duration = Number.isFinite(leaseMs) && leaseMs > 0 ? leaseMs : 10 * 60_000;
      const cutoff = Number(now) - duration;
      const observedAt = Date.now();
      const globalMax = Number(options.maxRunningMs);
      const byType = options.maxRunningMsByType && typeof options.maxRunningMsByType === 'object' ? options.maxRunningMsByType : {};
      const attemptStart = database.prepare(`SELECT started_at FROM job_attempts WHERE job_id = ? AND status = 'running' ORDER BY started_at ASC LIMIT 1`);
      const executing = new Set((Array.isArray(options.executingIds) ? options.executingIds : []).filter((id) => typeof id === 'string' && id));
      const rows = database.prepare(`SELECT * FROM jobs WHERE status = 'running'`).all().flatMap((row) => {
        const leaseStale = row.locked_at < cutoff;
        const limit = Number(byType[row.type] ?? globalMax);
        const started = attemptStart.get(row.id)?.started_at || row.started_at || row.locked_at;
        const runtimeStale = Number.isFinite(limit) && limit > 0 && Number(started) < Number(now) - limit;
        if (executing.has(row.id) && !runtimeStale) return [];
        return leaseStale || runtimeStale ? [{ ...row, leaseStale, runtimeStale }] : [];
      });
      database.transaction(() => {
        for (const row of rows) {
          const expiredRuntime = row.runtimeStale === true;
          const leaseInterrupted = !expiredRuntime && row.type === 'feed.translation.run';
          const retry = leaseInterrupted || (!expiredRuntime && row.attempt_count < row.max_attempts);
          const status = retry ? 'queued' : 'failed';
          const error = expiredRuntime
            ? { name: 'WorkerRunTimeout', message: '任务运行超过时限，已释放以便队列继续' }
            : { name: 'WorkerLeaseExpired', message: '后台进程中断，任务租约已过期' };
          // Keep attempt_count and the attempt row. A lease interrupt is compensated
          // by one extra max_attempts so it does not consume the translation budget.
          const attemptCount = row.attempt_count;
          const maxAttempts = leaseInterrupted ? Number(row.max_attempts) + 1 : row.max_attempts;
          const delay = row.type === 'feed.translation.run' && !leaseInterrupted ? translationRetryDelayMs(row.attempt_count) : 0;
          const availableAt = retry ? observedAt + delay : row.available_at;
          database.prepare(`UPDATE jobs SET status = ?, error_json = ?, available_at = ?, completed_at = ?,
            attempt_count = ?, max_attempts = ?, locked_by = NULL, locked_at = NULL, updated_at = ? WHERE id = ?`)
            .run(status, JSON.stringify(error), availableAt, retry ? null : observedAt, attemptCount, maxAttempts, observedAt, row.id);
          database.prepare(`UPDATE job_attempts SET status = 'abandoned', error_json = ?, completed_at = ?
            WHERE job_id = ? AND attempt_number = ? AND status = 'running'`)
            .run(JSON.stringify(error), observedAt, row.id, row.attempt_count);
          insertEvent(retry ? 'job.recovered' : 'job.failed', 'job', row.id,
            { jobId: row.id, error }, row.workspace_id);
          if (row.type === 'feed.translation.run' && !leaseInterrupted) {
            const input = parseJson(row.input_json);
            repositories.feed.noteTranslationFailure?.({
              workspaceId: row.workspace_id,
              items: input.items || [],
              targetLang: input.targetLang,
              error,
              attemptCount: row.attempt_count,
              terminal: !retry,
              nextRetryAt: retry ? availableAt : null,
            });
          }
        }
      })();
      return rows.length;
    },

    splitQueuedInformationPreparation(workspaceId,ids) {
      if(!Array.isArray(ids) || ids.length>100 || ids.some(id=>typeof id!=='string'))throw new Error('准备任务拆分参数不合法');
      return database.transaction(()=>{
        const results=[];
        for(const id of new Set(ids)) {
          const row=database.prepare("SELECT * FROM jobs WHERE id=? AND workspace_id=? AND type='report.information.prepare' AND status='queued' AND attempt_count=0").get(id,workspaceId);
          if(!row)continue;
          const input=PrepareTreeInformationInputSchema.parse(JSON.parse(row.input_json));
          if(input.workspaceId!==workspaceId)throw new Error('准备任务工作区不符');
          const sources=[...new Set(input.sourceIds)];if(sources.length<=1)continue;
          const children=sources.map(sourceId=>this.createJob({type:row.type,workspaceId,input:{...input,sourceIds:[sourceId]},
            priority:row.priority,maxAttempts:row.max_attempts,availableAt:row.available_at}));
          const output={status:'superseded',reason:'single-material-preparation',jobIds:children.map(j=>j.id)},now=Date.now();
          database.prepare("UPDATE jobs SET status='cancelled',output_json=?,completed_at=?,updated_at=? WHERE id=? AND status='queued'")
            .run(JSON.stringify(output),now,now,id);
          insertEvent('job.cancelled','job',id,{jobId:id,...output},workspaceId);
          results.push({originalId:id,jobIds:output.jobIds});
        }
        return results;
      }).immediate();
    },

    listOpenJobs(type) {
      const jobType = String(type || '').trim();
      if (!jobType) return [];
      return database.prepare(`SELECT * FROM jobs
        WHERE type = ? AND status IN ('queued', 'running')
        ORDER BY created_at ASC`).all(jobType).map(mapJob);
    },

    cancelOpenJobs(type, output = {}, now = Date.now()) {
      const jobType = String(type || '').trim();
      if (!jobType) return 0;
      const rows = database.prepare(`SELECT * FROM jobs WHERE type = ? AND status IN ('queued', 'running')`).all(jobType);
      const payload = JSON.stringify(output && typeof output === 'object' ? output : {status: 'skipped'});
      database.transaction(() => {
        for (const row of rows) {
          database.prepare(`UPDATE jobs SET status = 'cancelled', output_json = ?, error_json = NULL,
            completed_at = ?, locked_by = NULL, locked_at = NULL, updated_at = ?
            WHERE id = ? AND status IN ('queued', 'running')`)
            .run(payload, now, now, row.id);
          database.prepare(`UPDATE job_attempts SET status = 'abandoned', completed_at = ?
            WHERE job_id = ? AND status = 'running'`)
            .run(now, row.id);
          insertEvent('job.cancelled', 'job', row.id, { jobId: row.id, ...output }, row.workspace_id);
        }
      })();
      return rows.length;
    },

    failQueuedJob(id, error, now = Date.now()) {
      const current = database.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
      if (!current || current.status !== 'queued') return current ? mapJob(current) : null;
      const errorPayload = jobErrorPayload(error);
      database.transaction(() => {
        const result = database.prepare(`UPDATE jobs SET status = 'failed', error_json = ?, completed_at = ?,
          locked_by = NULL, locked_at = NULL, updated_at = ?
          WHERE id = ? AND status = 'queued'`)
          .run(JSON.stringify(errorPayload), now, now, id);
        if (!result.changes) return;
        insertEvent('job.failed', 'job', id, { jobId: id, error: errorPayload }, current.workspace_id);
      })();
      return mapJob(database.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
    },

    discardQueuedJobs(type, message, now = Date.now()) {
      const jobType = String(type || '').trim();
      if (!jobType) return 0;
      const rows = database.prepare(`SELECT * FROM jobs WHERE type = ? AND status = 'queued'`).all(jobType);
      const error = { name: 'FeedSyncCollapsed', message: String(message || '积压的订阅同步已合并为新的一轮') };
      database.transaction(() => {
        for (const row of rows) {
          database.prepare(`UPDATE jobs SET status = 'failed', error_json = ?, completed_at = ?,
            locked_by = NULL, locked_at = NULL, updated_at = ? WHERE id = ? AND status = 'queued'`)
            .run(JSON.stringify(error), now, now, row.id);
          insertEvent('job.failed', 'job', row.id, { jobId: row.id, error }, row.workspace_id);
        }
      })();
      return rows.length;
    },

    abandonRunningJobs(types, message, now = Date.now()) {
      const accepted = [...new Set((Array.isArray(types) ? types : []).map((type) => String(type || '')))];
      if (!accepted.length) return 0;
      const rows = database.prepare(`SELECT * FROM jobs WHERE status = 'running' AND type IN (${accepted.map(() => '?').join(', ')})`)
        .all(...accepted);
      const error = { name: 'WorkerInterrupted', message: String(message || '后台进程已重启，未完成的任务不会自动重跑') };
      database.transaction(() => {
        for (const row of rows) {
          database.prepare(`UPDATE jobs SET status = 'failed', error_json = ?, completed_at = ?,
            locked_by = NULL, locked_at = NULL, updated_at = ? WHERE id = ? AND status = 'running'`)
            .run(JSON.stringify(error), now, now, row.id);
          database.prepare(`UPDATE job_attempts SET status = 'abandoned', error_json = ?, completed_at = ?
            WHERE job_id = ? AND status = 'running'`)
            .run(JSON.stringify(error), now, row.id);
          insertEvent('job.failed', 'job', row.id, { jobId: row.id, error }, row.workspace_id);
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

    listJobsByType(type, { since = 0, limit = 200 } = {}) {
      const jobType = String(type || '').trim();
      if (!jobType) return [];
      const floor = Math.max(0, Number(since) || 0);
      const size = Math.max(1, Math.min(Number(limit) || 200, 5000));
      return database.prepare(`SELECT * FROM jobs WHERE type = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?`)
        .all(jobType, floor, size).map(mapJob);
    },

    listActiveAgentJobs(workspaceId = DEFAULT_WORKSPACE_ID) {
      return database.prepare(`SELECT * FROM jobs
        WHERE workspace_id = ? AND type IN ('ai.agent.run', 'ai.article.analyze') AND status IN ('queued', 'running')
        ORDER BY created_at ASC`)
        .all(workspaceId).map(mapJob);
    },

    appendAgentRunEvent({
      runId,
      workspaceId = DEFAULT_WORKSPACE_ID,
      version = 1,
      event,
      detail = {},
      at = Date.now(),
    }) {
      let appended = null;
      database.transaction(() => {
        const result = database.prepare(`INSERT INTO agent_run_events
          (run_id, workspace_id, version, event_name, detail_json, occurred_at)
          VALUES (?, ?, ?, ?, ?, ?)`)
          .run(runId, workspaceId, version, event, JSON.stringify(detail), at);
        const revision = Number(result.lastInsertRowid);
        appended = mapAgentRunEvent(database.prepare('SELECT * FROM agent_run_events WHERE id = ?').get(revision));
        insertEvent('runtime.agent-run.progressed.v1', 'agent-run', runId, {
          runId,
          revision,
          event,
          occurredAt: at,
        }, workspaceId);
      })();
      return appended;
    },

    listAgentRunEvents(runId, { fromAt = 0, toAt = Number.MAX_SAFE_INTEGER, limit = 2_000 } = {}) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 2_000, 10_000));
      return database.prepare(`SELECT * FROM agent_run_events
        WHERE run_id = ? AND occurred_at >= ? AND occurred_at <= ?
        ORDER BY id ASC LIMIT ?`)
        .all(runId, Math.max(0, Number(fromAt) || 0), Math.max(0, Number(toAt) || Number.MAX_SAFE_INTEGER), safeLimit)
        .map(mapAgentRunEvent);
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

    listEventFrameHeads(afterId = 0, limit = 1, workspaceId = null) {
      const safeAfterId = Math.max(0, Number(afterId) || 0);
      const safeLimit = Math.max(1, Math.min(Number(limit) || 1, 100));
      const rows = workspaceId
        ? database.prepare(`SELECT id, workspace_id, event_name, payload_bytes, sse_data
            FROM outbox_events WHERE workspace_id = ? AND id > ? ORDER BY id ASC LIMIT ?`)
          .all(workspaceId, safeAfterId, safeLimit)
        : database.prepare(`SELECT id, workspace_id, event_name, payload_bytes, sse_data
            FROM outbox_events WHERE id > ? ORDER BY id ASC LIMIT ?`)
          .all(safeAfterId, safeLimit);
      return rows.map((row) => ({
        id: row.id,
        workspaceId: row.workspace_id,
        name: row.event_name,
        payloadBytes: row.payload_bytes == null ? null : Number(row.payload_bytes),
        sseData: row.sse_data == null ? null : String(row.sse_data),
      }));
    },

    readEventPayloadSlice(id, offset = 0, length = 8000) {
      const start = Math.max(0, Number(offset) || 0);
      const size = Math.max(1, Math.min(Number(length) || 8000, 64_000));
      const row = database.prepare(`SELECT substr(payload_json, ?, ?) AS slice FROM outbox_events WHERE id = ?`)
        .get(start + 1, size, Number(id));
      return row?.slice || '';
    },

    listEventFrames(afterId = 0, limit = 8, workspaceId = null) {
      const safeAfterId = Math.max(0, Number(afterId) || 0);
      const safeLimit = Math.max(1, Math.min(Number(limit) || 8, 1_000));
      const rows = workspaceId
        ? database.prepare(`SELECT id, workspace_id, event_name, sse_data
            FROM outbox_events WHERE workspace_id = ? AND id > ? ORDER BY id ASC LIMIT ?`)
          .all(workspaceId, safeAfterId, safeLimit)
        : database.prepare(`SELECT id, workspace_id, event_name, sse_data
            FROM outbox_events WHERE id > ? ORDER BY id ASC LIMIT ?`)
          .all(safeAfterId, safeLimit);
      return rows.map((row) => ({
        id: row.id,
        workspaceId: row.workspace_id,
        name: row.event_name,
        payloadJson: row.sse_data || '{"truncated":true,"bytes":null}',
      }));
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
