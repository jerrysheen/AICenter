import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import {
  CreateKnowledgeDocumentInputSchema,
  CreateKnowledgeRevisionInputSchema,
  AgentToolReferenceSchema,
  parseContract,
  ValidationError,
} from '../../../contracts/src/index.js';

function mapDocument(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    knowledgeType: row.knowledge_type || '',
    currentRevision: row.current_revision,
    status: row.status,
    metadata: JSON.parse(row.metadata_json || '{}'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRevision(row) {
  return {
    id: row.id,
    knowledgeId: row.knowledge_id,
    revision: row.revision,
    title: row.title,
    body: row.body,
    createdByType: row.created_by_type,
    createdById: row.created_by_id || null,
    createdAt: row.created_at,
  };
}

function mapAiRun(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id || '',
    sourceType: row.source_type,
    sourceId: row.source_id,
    taskType: row.task_type,
    status: row.status,
    providerId: row.provider_id,
    modelId: row.model_id,
    inputHash: row.input_hash,
    inputText: row.input_text || '',
    outputText: row.output_text,
    output: row.output_json ? JSON.parse(row.output_json) : null,
    error: row.error_json ? JSON.parse(row.error_json) : null,
    createdAt: row.created_at,
    completedAt: row.completed_at || null,
  };
}

const SESSION_TITLE_MAX = 36;
const SESSION_PREVIEW_MAX = 180;
const SESSION_HISTORY_LIMIT = 16;

function clipText(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function sessionKindOf(sourceType, taskType) {
  if (sourceType === 'inspiration' || taskType === 'idea-sketch') return 'inspiration';
  return 'question-answer';
}

function encodePageCursor(updatedAt, id) {
  return Buffer.from(JSON.stringify({ t: updatedAt, i: id })).toString('base64url');
}

function decodePageCursor(cursor) {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (Number.isInteger(parsed.t) && typeof parsed.i === 'string' && parsed.i) return parsed;
  } catch {}
  throw new ValidationError('分页游标无效', ['cursor']);
}

function mapSession(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    title: row.title,
    preview: row.preview || '',
    sourceType: row.source_type || '',
    sourceId: row.source_id || '',
    runCount: Number(row.run_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapExchange(row) {
  return {
    id: row.id,
    question: row.input_text || '',
    answer: row.output_text || '',
    status: row.status,
    providerId: row.provider_id || '',
    modelId: row.model_id || '',
    createdAt: row.created_at,
    completedAt: row.completed_at || null,
    refs: [],
  };
}

function mapRunRef(row) {
  return {
    id: row.id,
    runId: row.run_id,
    workspaceId: row.workspace_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    revision: row.revision ?? null,
    asOf: row.as_of ?? null,
    origin: row.origin || 'tool',
    label: row.label || '',
    createdAt: row.created_at,
  };
}

function mapTaxonomyNode(row) {
  return {
    workspaceId: row.workspace_id,
    key: row.key,
    dimension: row.dimension,
    name: row.name,
    parentKey: row.parent_key || null,
    description: row.description || '',
    status: row.status,
    createdBy: row.created_by,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTaxonomyAssignment(row) {
  return {
    workspaceId: row.workspace_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    key: row.taxonomy_key,
    primary: Boolean(row.is_primary),
    assignedBy: row.assigned_by,
    confidence: row.confidence === '' || row.confidence == null ? null : Number(row.confidence),
    createdAt: row.created_at,
  };
}

function mapTaxonomyProposal(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    dimension: row.dimension,
    key: row.key,
    name: row.name,
    parentKey: row.parent_key,
    reason: row.reason || '',
    status: row.status,
    createdAt: row.created_at,
  };
}

const SESSION_SELECT = `SELECT s.*,
  (SELECT COUNT(*) FROM ai_runs r WHERE r.session_id = s.id) AS run_count
  FROM ai_sessions s`;

export function createKnowledgeRepository(database, emitEvent) {
  return Object.freeze({
    createDocument(value) {
      const input = parseContract(CreateKnowledgeDocumentInputSchema, value);
      const now = Date.now();
      const knowledgeId = input.id || randomUUID();
      const revisionId = randomUUID();
      const source = input.source || input.createdByType;
      const sourceNoteId = input.sourceNoteId || null;
      database.transaction(() => {
        database.prepare(`INSERT INTO knowledge_items
          (id, workspace_id, title, body, source, source_note_id, status, current_revision,
           knowledge_type, metadata_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?)`)
          .run(knowledgeId, input.workspaceId, input.title, input.body,
            source, sourceNoteId, input.knowledgeType || '', JSON.stringify(input.metadata), now, now);
        database.prepare(`INSERT INTO knowledge_revisions
          (id, knowledge_id, revision, title, body, created_by_type, created_by_id, created_at)
          VALUES (?, ?, 1, ?, ?, ?, ?, ?)`)
          .run(revisionId, knowledgeId, input.title, input.body,
            input.createdByType, input.createdById, now);
        database.prepare(`INSERT INTO knowledge_fts (knowledge_id, revision, title, body)
          VALUES (?, 1, ?, ?)`).run(knowledgeId, input.title, input.body);
        emitEvent('knowledge.document.created.v1', 'knowledge-document', knowledgeId,
          { knowledgeId, revision: 1 }, input.workspaceId);
      })();
      return mapDocument(database.prepare('SELECT * FROM knowledge_items WHERE id = ?').get(knowledgeId));
    },

    linkDerivedFrom({ knowledgeId, sourceType, sourceId, relationType = 'derived_from' }) {
      const now = Date.now();
      database.prepare(`INSERT OR IGNORE INTO knowledge_links
        (knowledge_id, source_type, source_id, relation_type, created_at)
        VALUES (?, ?, ?, ?, ?)`).run(knowledgeId, sourceType, sourceId, relationType, now);
    },

    addRevision(value) {
      const input = parseContract(CreateKnowledgeRevisionInputSchema, value);
      const document = database.prepare('SELECT * FROM knowledge_items WHERE id = ?').get(input.knowledgeId);
      if (!document) throw new ValidationError('知识文档不存在', ['knowledgeId']);
      const revision = document.current_revision + 1;
      const now = Date.now();
      const id = input.id || randomUUID();
      database.transaction(() => {
        database.prepare(`INSERT INTO knowledge_revisions
          (id, knowledge_id, revision, title, body, created_by_type, created_by_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, input.knowledgeId, revision, input.title, input.body,
            input.createdByType, input.createdById, now);
        database.prepare(`UPDATE knowledge_items SET title = ?, body = ?, current_revision = ?,
          updated_at = ? WHERE id = ?`).run(input.title, input.body, revision, now, input.knowledgeId);
        database.prepare(`INSERT INTO knowledge_fts (knowledge_id, revision, title, body)
          VALUES (?, ?, ?, ?)`).run(input.knowledgeId, revision, input.title, input.body);
        emitEvent('knowledge.document.revised.v1', 'knowledge-document', input.knowledgeId,
          { knowledgeId: input.knowledgeId, revision }, document.workspace_id);
      })();
      return mapRevision(database.prepare(`SELECT * FROM knowledge_revisions
        WHERE knowledge_id = ? AND revision = ?`).get(input.knowledgeId, revision));
    },

    listRevisions(knowledgeId) {
      return database.prepare(`SELECT * FROM knowledge_revisions WHERE knowledge_id = ?
        ORDER BY revision DESC`).all(knowledgeId).map(mapRevision);
    },

    getCurrentRevision(workspaceId, knowledgeId) {
      const row = database.prepare(`SELECT r.* FROM knowledge_revisions r
        INNER JOIN knowledge_items k ON k.id = r.knowledge_id
        WHERE k.workspace_id = ? AND k.id = ? AND r.revision = k.current_revision`).get(workspaceId, knowledgeId);
      return row ? mapRevision(row) : null;
    },

    getRevision(workspaceId, knowledgeId, revision) {
      const row = database.prepare(`SELECT r.* FROM knowledge_revisions r
        INNER JOIN knowledge_items k ON k.id = r.knowledge_id
        WHERE k.workspace_id = ? AND k.id = ? AND r.revision = ?`).get(workspaceId, knowledgeId, revision);
      return row ? mapRevision(row) : null;
    },

    getAiRun(workspaceId, runId) {
      const row = database.prepare('SELECT * FROM ai_runs WHERE workspace_id = ? AND id = ?')
        .get(workspaceId, runId);
      return row ? mapAiRun(row) : null;
    },

    getCurrentRevisionByMetadataKind(workspaceId, kind) {
      const row = database.prepare(`SELECT r.* FROM knowledge_revisions r
        INNER JOIN knowledge_items k ON k.id = r.knowledge_id
        WHERE k.workspace_id = ? AND json_extract(k.metadata_json, '$.kind') = ?
          AND r.revision = k.current_revision
        ORDER BY k.updated_at DESC LIMIT 1`).get(workspaceId, kind);
      return row ? mapRevision(row) : null;
    },

    search(workspaceId, queryOrInput, limit = 20) {
      const input = queryOrInput && typeof queryOrInput === 'object' && !Array.isArray(queryOrInput)
        ? queryOrInput
        : { query: queryOrInput, limit };
      const term = String(input.query || '').trim();
      const taxonomy = [...new Set((input.taxonomy || []).map((item) => String(item || '').trim()).filter(Boolean))];
      const cap = Math.max(1, Math.min(Number(input.limit ?? limit) || 20, 100));
      if (!term && !taxonomy.length) return [];
      const taxonomyClause = taxonomy.length
        ? `AND k.id IN (
            SELECT resource_id FROM resource_taxonomy
            WHERE workspace_id = ? AND resource_type = 'knowledge' AND taxonomy_key IN (${taxonomy.map(() => '?').join(',')})
            GROUP BY resource_id
            HAVING COUNT(DISTINCT taxonomy_key) = ?
          )`
        : '';
      const taxonomyParams = taxonomy.length ? [workspaceId, ...taxonomy, taxonomy.length] : [];
      if (term) {
        return database.prepare(`SELECT f.knowledge_id AS knowledgeId, f.revision, f.title,
          snippet(knowledge_fts, 3, '', '', '…', 24) AS snippet
          FROM knowledge_fts f
          JOIN knowledge_items k ON k.id = f.knowledge_id
          WHERE k.workspace_id = ? AND f.revision = k.current_revision AND knowledge_fts MATCH ?
            ${taxonomyClause}
          ORDER BY rank LIMIT ?`).all(workspaceId, term, ...taxonomyParams, cap);
      }
      return database.prepare(`SELECT k.id AS knowledgeId, k.current_revision AS revision, k.title,
        substr(k.body, 1, 80) AS snippet
        FROM knowledge_items k
        WHERE k.workspace_id = ? ${taxonomyClause}
        ORDER BY k.updated_at DESC LIMIT ?`).all(workspaceId, ...taxonomyParams, cap);
    },

    listRecent(workspaceId, limit = 8) {
      const cap = Math.max(1, Math.min(Number(limit) || 8, 20));
      return database.prepare(`SELECT k.id AS knowledgeId, k.current_revision AS revision, k.title,
        substr(k.body, 1, 80) AS snippet
        FROM knowledge_items k
        WHERE k.workspace_id = ?
        ORDER BY k.updated_at DESC LIMIT ?`).all(workspaceId, cap);
    },

    listTaxonomy(workspaceId) {
      return database.prepare(`SELECT * FROM taxonomy_nodes
        WHERE workspace_id = ? AND status = 'active'
        ORDER BY dimension, sort_order, key`).all(workspaceId).map(mapTaxonomyNode);
    },

    getTaxonomyNode(workspaceId, key) {
      const row = database.prepare('SELECT * FROM taxonomy_nodes WHERE workspace_id = ? AND key = ?')
        .get(workspaceId, key);
      return row ? mapTaxonomyNode(row) : null;
    },

    replaceResourceTaxonomy({ workspaceId, resourceType, resourceId, assignments = [], assignedBy = 'ai' }) {
      const now = Date.now();
      database.transaction(() => {
        database.prepare(`DELETE FROM resource_taxonomy
          WHERE workspace_id = ? AND resource_type = ? AND resource_id = ?`)
          .run(workspaceId, resourceType, resourceId);
        const insert = database.prepare(`INSERT INTO resource_taxonomy
          (workspace_id, resource_type, resource_id, taxonomy_key, is_primary, assigned_by, confidence, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const item of assignments) {
          insert.run(
            workspaceId, resourceType, resourceId, item.key, item.primary ? 1 : 0, assignedBy,
            item.confidence == null ? '' : String(item.confidence), now,
          );
        }
      })();
      return this.listResourceTaxonomy(workspaceId, resourceType, resourceId);
    },

    listResourceTaxonomy(workspaceId, resourceType, resourceId) {
      return database.prepare(`SELECT * FROM resource_taxonomy
        WHERE workspace_id = ? AND resource_type = ? AND resource_id = ?
        ORDER BY is_primary DESC, taxonomy_key`).all(workspaceId, resourceType, resourceId)
        .map(mapTaxonomyAssignment);
    },

    recordTaxonomyProposals({ workspaceId, resourceType, resourceId, proposals = [] }) {
      const now = Date.now();
      const insert = database.prepare(`INSERT INTO taxonomy_proposals
        (id, workspace_id, resource_type, resource_id, dimension, key, name, parent_key, reason, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`);
      const saved = [];
      database.transaction(() => {
        for (const item of proposals.slice(0, 1)) {
          const id = randomUUID();
          insert.run(id, workspaceId, resourceType, resourceId, item.dimension, item.key,
            item.name, item.parentKey, item.reason || '', now);
          saved.push(id);
        }
      })();
      return saved;
    },

    listRunContextRefs(workspaceId, runId) {
      return database.prepare(`SELECT * FROM ai_run_context_refs
        WHERE workspace_id = ? AND run_id = ? ORDER BY created_at ASC, id ASC`)
        .all(workspaceId, runId).map(mapRunRef);
    },

    clearResourceAnnotations(workspaceId, resourceType, resourceId) {
      database.prepare(`DELETE FROM resource_taxonomy
        WHERE workspace_id = ? AND resource_type = ? AND resource_id = ?`)
        .run(workspaceId, resourceType, resourceId);
      database.prepare(`DELETE FROM taxonomy_proposals
        WHERE workspace_id = ? AND resource_type = ? AND resource_id = ?`)
        .run(workspaceId, resourceType, resourceId);
    },

    deleteDocument(workspaceId, knowledgeId) {
      const document = database.prepare('SELECT * FROM knowledge_items WHERE workspace_id = ? AND id = ?')
        .get(workspaceId, knowledgeId);
      if (!document) return false;
      database.transaction(() => {
        database.prepare('DELETE FROM knowledge_fts WHERE knowledge_id = ?').run(knowledgeId);
        database.prepare('DELETE FROM knowledge_revisions WHERE knowledge_id = ?').run(knowledgeId);
        database.prepare('DELETE FROM knowledge_links WHERE knowledge_id = ?').run(knowledgeId);
        database.prepare('DELETE FROM knowledge_chunks WHERE knowledge_id = ?').run(knowledgeId);
        database.prepare(`DELETE FROM resource_taxonomy
          WHERE workspace_id = ? AND resource_type = 'knowledge' AND resource_id = ?`)
          .run(workspaceId, knowledgeId);
        database.prepare(`DELETE FROM taxonomy_proposals
          WHERE workspace_id = ? AND resource_type = 'knowledge' AND resource_id = ?`)
          .run(workspaceId, knowledgeId);
        database.prepare('UPDATE notes SET knowledge_id = NULL WHERE knowledge_id = ?').run(knowledgeId);
        database.prepare('DELETE FROM knowledge_items WHERE id = ? AND workspace_id = ?').run(knowledgeId, workspaceId);
        emitEvent('knowledge.document.deleted.v1', 'knowledge-document', knowledgeId,
          { knowledgeId }, workspaceId);
      })();
      return true;
    },

    createSession({ workspaceId, kind = 'question-answer', title, preview = '', sourceType = '', sourceId = '' }) {
      const now = Date.now();
      const id = randomUUID();
      const sessionKind = kind === 'inspiration' ? 'inspiration' : 'question-answer';
      database.transaction(() => {
        database.prepare(`INSERT INTO ai_sessions
          (id, workspace_id, kind, title, preview, source_type, source_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, workspaceId, sessionKind, clipText(title, SESSION_TITLE_MAX) || '未命名记录',
            clipText(preview, SESSION_PREVIEW_MAX), sourceType, sourceId, now, now);
        emitEvent('knowledge.ai-session.created.v1', 'ai-session', id,
          { sessionId: id, kind: sessionKind }, workspaceId);
      })();
      return this.getSession(workspaceId, id);
    },

    getSession(workspaceId, sessionId) {
      const row = database.prepare(`${SESSION_SELECT} WHERE s.workspace_id = ? AND s.id = ?`)
        .get(workspaceId, sessionId);
      return row ? mapSession(row) : null;
    },

    getSessionDetail(workspaceId, sessionId) {
      const session = this.getSession(workspaceId, sessionId);
      if (!session) return null;
      const exchanges = database.prepare(`SELECT * FROM ai_runs WHERE session_id = ? ORDER BY created_at ASC`)
        .all(sessionId).map(mapExchange);
      if (exchanges.length) {
        const placeholders = exchanges.map(() => '?').join(',');
        const refs = database.prepare(`SELECT * FROM ai_run_context_refs
          WHERE run_id IN (${placeholders}) ORDER BY created_at ASC, id ASC`)
          .all(...exchanges.map((exchange) => exchange.id)).map(mapRunRef);
        const byRun = new Map();
        for (const item of refs) {
          if (!byRun.has(item.runId)) byRun.set(item.runId, []);
          byRun.get(item.runId).push(item);
        }
        for (const exchange of exchanges) exchange.refs = byRun.get(exchange.id) || [];
      }
      return { session, exchanges };
    },

    listSessions(workspaceId, { cursor, limit = 50 } = {}) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
      const decoded = decodePageCursor(cursor);
      const rows = decoded
        ? database.prepare(`${SESSION_SELECT}
            WHERE s.workspace_id = ? AND (s.updated_at < ? OR (s.updated_at = ? AND s.id < ?))
            ORDER BY s.updated_at DESC, s.id DESC LIMIT ?`)
          .all(workspaceId, decoded.t, decoded.t, decoded.i, safeLimit + 1)
        : database.prepare(`${SESSION_SELECT}
            WHERE s.workspace_id = ?
            ORDER BY s.updated_at DESC, s.id DESC LIMIT ?`)
          .all(workspaceId, safeLimit + 1);
      const hasMore = rows.length > safeLimit;
      const pageRows = hasMore ? rows.slice(0, safeLimit) : rows;
      const last = pageRows.at(-1);
      return {
        sessions: pageRows.map(mapSession),
        page: {
          nextCursor: hasMore && last ? encodePageCursor(last.updated_at, last.id) : null,
          hasMore,
        },
      };
    },

    listSessionTurns(workspaceId, sessionId, limit = SESSION_HISTORY_LIMIT) {
      const session = this.getSession(workspaceId, sessionId);
      if (!session) return [];
      const rows = database.prepare(`SELECT id, input_text, output_text FROM ai_runs
        WHERE session_id = ? AND status = 'completed' ORDER BY created_at ASC`).all(sessionId);
      const page = rows.slice(-Math.max(1, Math.min(Number(limit) || SESSION_HISTORY_LIMIT, 20)));
      const selectedByRun = new Map();
      if (page.length) {
        const placeholders = page.map(() => '?').join(',');
        const refs = database.prepare(`SELECT * FROM ai_run_context_refs
          WHERE run_id IN (${placeholders}) AND origin = 'selected'
          ORDER BY created_at ASC, id ASC`).all(...page.map((row) => row.id)).map(mapRunRef);
        for (const item of refs) {
          if (!selectedByRun.has(item.runId)) selectedByRun.set(item.runId, []);
          selectedByRun.get(item.runId).push({
            resourceType: item.resourceType,
            resourceId: item.resourceId,
            ...(item.revision ? { revision: item.revision } : {}),
          });
        }
      }
      return page.map((row) => ({
        inputText: row.input_text || '',
        outputText: row.output_text || '',
        selectedRefs: selectedByRun.get(row.id) || [],
      }));
    },

    recordAgentRun({
      jobId, workspaceId, sessionId = '', message, answer, providerId, modelId,
      toolCalls = [], refs = [], warnings = [], sourceType = 'agent-run', sourceId, taskType = 'question-answer',
    }) {
      const now = Date.now();
      const id = randomUUID();
      const kind = sessionKindOf(sourceType, taskType);
      const inputHash = createHash('sha256').update(String(message)).digest('hex');
      const runSourceId = sourceId || jobId;
      let resolvedSessionId = sessionId || '';
      let existingRunId = '';
      const normalizedRefs = [];
      const seenRefs = new Set();
      for (const value of refs) {
        const item = parseContract(AgentToolReferenceSchema, value);
        const key = `${item.origin}\u0000${item.resourceType}\u0000${item.resourceId}\u0000${item.revision ?? ''}\u0000${item.asOf ?? ''}`;
        if (seenRefs.has(key)) continue;
        seenRefs.add(key);
        normalizedRefs.push(item);
      }
      database.transaction(() => {
        if (sourceType === 'agent-run' && runSourceId) {
          const existing = database.prepare(`SELECT id FROM ai_runs
            WHERE workspace_id = ? AND source_type = 'agent-run' AND source_id = ? AND status = 'completed'
            ORDER BY completed_at DESC LIMIT 1`).get(workspaceId, runSourceId);
          if (existing) {
            existingRunId = existing.id;
            return;
          }
        }
        if (resolvedSessionId) {
          const existing = database.prepare('SELECT id FROM ai_sessions WHERE workspace_id = ? AND id = ?')
            .get(workspaceId, resolvedSessionId);
          if (!existing) throw new ValidationError('AI 记录不存在', ['sessionId']);
        } else if (kind === 'inspiration' && runSourceId) {
          const existing = database.prepare(`SELECT id FROM ai_sessions
            WHERE workspace_id = ? AND kind = 'inspiration' AND source_id = ? LIMIT 1`)
            .get(workspaceId, runSourceId);
          if (existing) resolvedSessionId = existing.id;
        }
        if (!resolvedSessionId) {
          resolvedSessionId = randomUUID();
          database.prepare(`INSERT INTO ai_sessions
            (id, workspace_id, kind, title, preview, source_type, source_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(resolvedSessionId, workspaceId, kind, clipText(message, SESSION_TITLE_MAX) || '未命名记录',
              clipText(answer, SESSION_PREVIEW_MAX), sourceType, runSourceId || '', now, now);
          emitEvent('knowledge.ai-session.created.v1', 'ai-session', resolvedSessionId,
            { sessionId: resolvedSessionId, kind }, workspaceId);
        }
        database.prepare(`INSERT INTO ai_runs
          (id, workspace_id, session_id, source_type, source_id, task_type, status, provider_id, model_id,
           input_hash, input_text, output_text, output_json, error_json, created_at, completed_at)
          VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, NULL, ?, ?)`)
          .run(id, workspaceId, resolvedSessionId, sourceType, runSourceId, taskType, providerId, modelId,
            inputHash, String(message || ''), answer, JSON.stringify({ toolCalls, warnings }), now, now);
        database.prepare('UPDATE ai_sessions SET preview = ?, updated_at = ? WHERE id = ?')
          .run(clipText(answer || message, SESSION_PREVIEW_MAX), now, resolvedSessionId);
        const insertRef = database.prepare(`INSERT INTO ai_run_context_refs
          (id, run_id, workspace_id, resource_type, resource_id, revision, as_of, origin, label, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const item of normalizedRefs) {
          insertRef.run(randomUUID(), id, workspaceId, item.resourceType, item.resourceId,
            item.revision, item.asOf, item.origin || 'tool', item.label || '', now);
        }
        emitEvent('knowledge.ai-run.completed.v1', 'ai-run', id,
          { runId: id, jobId, providerId, modelId, sessionId: resolvedSessionId }, workspaceId);
      })();
      return mapAiRun(database.prepare('SELECT * FROM ai_runs WHERE id = ?').get(existingRunId || id));
    },
  });
}
