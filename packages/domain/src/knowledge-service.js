import { StructureJobOutputSchema, ValidationError, parseContract } from '../../contracts/src/index.js';
import { projectAnswerSourceFooter } from './answer-source-footer.js';

const STRUCTURE_DIMENSION_ORDER = [
  'domain', 'asset-class', 'market', 'lens', 'industry', 'topic', 'platform', 'project',
];

function taxonomyView(catalog, assignments) {
  const byKey = new Map((catalog || []).map((node) => [node.key, node]));
  return [...assignments]
    .sort((left, right) => {
      const leftDim = STRUCTURE_DIMENSION_ORDER.indexOf(left.key.split('.')[0]);
      const rightDim = STRUCTURE_DIMENSION_ORDER.indexOf(right.key.split('.')[0]);
      return (leftDim === -1 ? 99 : leftDim) - (rightDim === -1 ? 99 : rightDim);
    })
    .map((item) => {
      const node = byKey.get(item.key);
      const parent = node?.parentKey ? byKey.get(node.parentKey) : null;
      return {
        key: item.key,
        name: node?.name || item.key,
        parentName: parent?.name || null,
        dimension: item.key.split('.')[0],
        primary: Boolean(item.primary),
      };
    });
}

export function formatTaxonomyPath(taxonomy = []) {
  const items = taxonomy.filter((item) => item.primary);
  const source = items.length ? items : taxonomy;
  return source.map((item) => (
    item.parentName && (item.dimension === 'industry' || item.dimension === 'topic')
      ? `${item.parentName} / ${item.name}`
      : item.name
  )).filter(Boolean).join(' · ');
}

function searchInput(query, limit) {
  if (query && typeof query === 'object' && !Array.isArray(query)) return query;
  return { query, limit };
}

function mergeKnowledgeHits(fileHits, storedHits, cap) {
  const seen = new Set();
  const merged = [];
  for (const item of [...fileHits, ...storedHits]) {
    const id = String(item?.knowledgeId || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push(item);
    if (merged.length >= cap) break;
  }
  return merged;
}

function mentionKind(item = {}) {
  const kind = String(item.kind || item.type || item.knowledgeType || '').trim();
  if (kind) return kind;
  const id = String(item.knowledgeId || '');
  if (id.includes('.framework.')) return 'framework';
  if (id.includes('.concept')) return 'concept';
  return 'knowledge';
}

function toMention(item) {
  const label = String(item.title || item.knowledgeId || '知识').replace(/\s+/g, ' ').trim().slice(0, 200);
  const preview = String(item.snippet || item.body || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  const revision = Number.isInteger(item.revision) && item.revision > 0 ? item.revision : null;
  return {
    resourceType: 'knowledge-revision',
    resourceId: String(item.knowledgeId),
    revision,
    label: label || String(item.knowledgeId),
    kind: mentionKind(item),
    preview,
  };
}

export function createKnowledgeService({ legacyRepository, knowledgeRepository, fileKnowledgePort = null }) {
  if (!legacyRepository || !knowledgeRepository) throw new Error('knowledge repositories are required');

  return Object.freeze({
    createInspiration(input) {
      return legacyRepository.createNote(input);
    },
    getInspiration(_workspaceId, id) {
      return legacyRepository.getNote(id);
    },
    listInspirations(status) {
      const notes = legacyRepository.listNotes(status);
      const catalog = knowledgeRepository.listTaxonomy('local');
      return notes.map((note) => ({
        ...note,
        taxonomy: taxonomyView(catalog, knowledgeRepository.listResourceTaxonomy('local', 'inspiration', note.id)),
      }));
    },
    archiveInspiration(id) {
      return legacyRepository.archiveNote(id);
    },
    toggleInspirationPin(id) {
      return legacyRepository.toggleInspirationPin
        ? legacyRepository.toggleInspirationPin(id)
        : legacyRepository.pinNote(id);
    },
    deleteInspiration(id) {
      knowledgeRepository.clearResourceAnnotations('local', 'inspiration', id);
      return legacyRepository.deleteNote(id);
    },
    listLegacyKnowledge() {
      const catalog = knowledgeRepository.listTaxonomy('local');
      return legacyRepository.listKnowledge().map((item) => ({
        ...item,
        taxonomy: taxonomyView(catalog, knowledgeRepository.listResourceTaxonomy('local', 'knowledge', item.id)),
      }));
    },
    listTaggableItems(workspaceId, resourceType, { limit = 200, ids = [] } = {}) {
      const wanted = new Set((ids || []).map((id) => String(id || '').trim()).filter(Boolean));
      const take = Math.max(1, Math.min(Number(limit) || 200, 500));
      if (resourceType === 'inspiration') {
        const notes = [
          ...(legacyRepository.listNotes('inbox') || []),
          ...(legacyRepository.listNotes('archived') || []),
        ];
        return notes
          .filter((note) => (!wanted.size || wanted.has(note.id)) && String(note.body || '').trim())
          .slice(0, take)
          .map((note) => ({
            id: note.id,
            source: 'inspiration',
            author: '',
            title: note.title || '',
            body: note.body || '',
          }));
      }
      if (resourceType === 'knowledge') {
        const rows = legacyRepository.listKnowledge() || [];
        return rows
          .filter((item) => (!wanted.size || wanted.has(item.id)) && (item.title || item.body))
          .slice(0, take)
          .map((item) => ({
            id: item.id,
            source: 'knowledge',
            author: '',
            title: item.title || '',
            body: item.body || '',
          }));
      }
      return [];
    },
    createDocument(input) {
      return knowledgeRepository.createDocument(input);
    },
    deleteDocument(workspaceId, knowledgeId) {
      return knowledgeRepository.deleteDocument(workspaceId, knowledgeId);
    },
    addRevision(input) {
      return knowledgeRepository.addRevision(input);
    },
    listRevisions(knowledgeId) {
      return knowledgeRepository.listRevisions(knowledgeId);
    },
    getCurrentRevision(workspaceId, knowledgeId) {
      const file = fileKnowledgePort?.get(knowledgeId);
      if (file) return { workspaceId, ...file };
      return knowledgeRepository.getCurrentRevision(workspaceId, knowledgeId);
    },
    getRevision(workspaceId, knowledgeId, revision) {
      const file = fileKnowledgePort?.get(knowledgeId);
      if (file) return file.revision === revision ? { workspaceId, ...file } : null;
      return knowledgeRepository.getRevision(workspaceId, knowledgeId, revision);
    },
    getAgentRun(workspaceId, runId) {
      return knowledgeRepository.getAiRun(workspaceId, runId);
    },
    listRunContextRefs(workspaceId, runId) {
      return knowledgeRepository.listRunContextRefs(workspaceId, runId);
    },
    listTaxonomy(workspaceId) {
      return knowledgeRepository.listTaxonomy(workspaceId);
    },
    prepareStructureFromRun({ workspaceId, runId, target, instruction = '' }) {
      const run = knowledgeRepository.getAiRun(workspaceId, runId);
      if (!run) throw new ValidationError('问答记录不存在', ['runId']);
      if (run.status !== 'completed') throw new ValidationError('问答尚未完成', ['runId']);
      const text = String(run.outputText || '').trim();
      if (!text) throw new ValidationError('没有可保存的内容', ['runId']);
      return {
        target,
        workspaceId,
        sourceRunId: run.id,
        instruction: String(instruction || '').trim(),
      };
    },
    persistStructuredArtifact({
      workspaceId,
      artifact,
      assignedBy = 'ai',
      sourceRunId,
      sourceType,
      sourceId,
      extraLinks = [],
    }) {
      let resolvedType = sourceType || '';
      let resolvedId = sourceId || '';
      let selectedRefs = [...extraLinks];
      if (sourceRunId) {
        const run = knowledgeRepository.getAiRun(workspaceId, sourceRunId);
        if (!run) throw new ValidationError('问答记录不存在', ['sourceRunId']);
        resolvedType = resolvedType || 'ai-run';
        resolvedId = resolvedId || run.id;
        if (!extraLinks.length) {
          selectedRefs = knowledgeRepository.listRunContextRefs(workspaceId, sourceRunId)
            .filter((item) => item.origin === 'selected');
        }
      }
      if (!resolvedType || !resolvedId) throw new ValidationError('缺少可追溯来源', ['sourceId']);
      const catalog = knowledgeRepository.listTaxonomy(workspaceId);
      let resourceType;
      let resourceId;
      const title = artifact.title;
      if (artifact.target === 'inspiration') {
        const note = legacyRepository.createNote({
          title: artifact.title,
          body: artifact.bodyMarkdown.slice(0, 100_000),
          inspirationType: artifact.contentType,
          wantAi: false,
          sourceType: resolvedType,
          sourceId: resolvedId,
        });
        resourceType = 'inspiration';
        resourceId = note.id;
      } else {
        const document = knowledgeRepository.createDocument({
          workspaceId,
          title: artifact.title,
          body: artifact.bodyMarkdown,
          knowledgeType: artifact.contentType,
          createdByType: 'agent',
          createdById: null,
          source: resolvedType,
          metadata: { kind: resolvedType, sourceId: resolvedId, sourceRunId: sourceRunId || null },
        });
        knowledgeRepository.linkDerivedFrom({
          knowledgeId: document.id,
          sourceType: resolvedType,
          sourceId: resolvedId,
        });
        for (const item of selectedRefs) {
          knowledgeRepository.linkDerivedFrom({
            knowledgeId: document.id,
            sourceType: item.resourceType,
            sourceId: item.resourceId,
          });
        }
        resourceType = 'knowledge';
        resourceId = document.id;
      }
      knowledgeRepository.replaceResourceTaxonomy({
        workspaceId,
        resourceType,
        resourceId,
        assignments: artifact.taxonomy,
        assignedBy,
      });
      const proposals = knowledgeRepository.recordTaxonomyProposals({
        workspaceId,
        resourceType,
        resourceId,
        proposals: artifact.taxonomyProposals,
      });
      const taxonomy = taxonomyView(catalog, artifact.taxonomy);
      return parseContract(StructureJobOutputSchema, {
        resourceType,
        resourceId,
        title,
        contentType: artifact.contentType,
        taxonomy,
        proposalCount: proposals.length,
      });
    },
    createDocumentFromUser({ workspaceId, title, body, sourceRefs = [] }) {
      const fromRun = sourceRefs.some((item) => item.resourceType === 'ai-run');
      const document = knowledgeRepository.createDocument({
        workspaceId,
        title,
        body,
        createdByType: 'user',
        createdById: null,
        source: fromRun ? 'ai-run' : 'manual',
        metadata: fromRun ? { kind: 'ai-run' } : {},
      });
      for (const item of sourceRefs) {
        knowledgeRepository.linkDerivedFrom({
          knowledgeId: document.id,
          sourceType: item.resourceType,
          sourceId: item.resourceId,
        });
      }
      return document;
    },
    getCurrentRevisionByMetadataKind(workspaceId, kind) {
      return knowledgeRepository.getCurrentRevisionByMetadataKind(workspaceId, kind);
    },
    search(workspaceId, query, limit) {
      const input = searchInput(query, limit);
      const cap = Math.max(1, Math.min(Number(input.limit) || 20, 100));
      const stored = knowledgeRepository.search(workspaceId, { ...input, limit: cap });
      const files = input.query && fileKnowledgePort?.search
        ? fileKnowledgePort.search({ query: input.query, limit: cap })
        : [];
      return mergeKnowledgeHits(files, stored, cap);
    },
    listMentions(workspaceId, query, limit) {
      const input = searchInput(query, limit);
      const cap = Math.max(1, Math.min(Number(input.limit) || 8, 20));
      const term = String(input.query || '').trim();
      const files = term
        ? (fileKnowledgePort?.search?.({ query: term, limit: cap }) || [])
        : (fileKnowledgePort?.list?.({ limit: cap }) || []);
      const stored = term
        ? knowledgeRepository.search(workspaceId, { query: term, limit: cap })
        : knowledgeRepository.listRecent(workspaceId, cap);
      return mergeKnowledgeHits(files, stored, cap).map(toMention);
    },
    recordAgentRun(input) {
      return knowledgeRepository.recordAgentRun(input);
    },
    createQaSession(input) {
      return knowledgeRepository.createSession({ ...input, kind: 'question-answer' });
    },
    ensureQaSession({ workspaceId, sessionId, title }) {
      if (sessionId) {
        const session = knowledgeRepository.getSession(workspaceId, sessionId);
        if (!session) throw new ValidationError('问答记录不存在', ['sessionId']);
        if (session.kind !== 'question-answer') throw new ValidationError('这条记录不能继续问答', ['sessionId']);
        return session;
      }
      return knowledgeRepository.createSession({
        workspaceId,
        kind: 'question-answer',
        title,
      });
    },
    getAiSession(workspaceId, sessionId) {
      const detail = knowledgeRepository.getSessionDetail(workspaceId, sessionId);
      if (!detail) return null;
      return {
        ...detail,
        exchanges: detail.exchanges.map((exchange) => ({
          ...exchange,
          sourceFooter: projectAnswerSourceFooter(exchange.refs),
        })),
      };
    },
    getDocumentForView(workspaceId, knowledgeId) {
      const item = this.getCurrentRevision(workspaceId, knowledgeId);
      if (!item) return null;
      return {
        id: item.knowledgeId,
        knowledgeId: item.knowledgeId,
        title: item.title || item.knowledgeId,
        body: item.body || '',
        revision: item.revision || null,
        knowledgeType: item.knowledgeType || item.kind || '',
        createdAt: item.createdAt || item.updatedAt || Date.now(),
      };
    },
    listAiSessions(workspaceId, page) {
      return knowledgeRepository.listSessions(workspaceId, page);
    },
    listSessionTurns(workspaceId, sessionId) {
      return knowledgeRepository.listSessionTurns(workspaceId, sessionId);
    },
  });
}
