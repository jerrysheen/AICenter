import { randomUUID } from 'node:crypto';
import { StructureJobOutputSchema, ValidationError, parseContract, parseWorkPackageTrace, workPackageTraceId } from '../../contracts/src/index.js';
import { projectAnswerSourceFooter } from './answer-source-footer.js';
import { classifyProcessRestart } from './process-restart.js';
import {
  ATTACHMENT_MAX_BYTES,
  attachmentSha256,
  decodeAttachmentData,
  normalizeAttachmentIds,
  projectAttachment,
  sniffImageMime,
} from './attachment.js';

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

function deriveWorkPackageTitle(title, body) {
  const explicit = String(title || '').trim();
  if (explicit) return explicit.slice(0, 200);
  const line = String(body || '').replace(/\s+/g, ' ').trim();
  if (!line) return '工作包';
  return line.length > 28 ? `${line.slice(0, 28)}…` : line;
}

function attachNote(legacyRepository, pack) {
  return {
    ...pack,
    note: legacyRepository.getNote(pack.inspirationId),
  };
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

function withTraceId(pack) {
  return pack ? { ...pack, hashId: workPackageTraceId(pack.id) } : pack;
}

const CONTINUED_BODY_MAX = 100_000;

function takeMarkedSection(text, mark) {
  const source = String(text || '');
  const token = `\n${mark}\n`;
  const at = source.lastIndexOf(token);
  if (at >= 0) {
    return {
      value: source.slice(at + token.length).trim(),
      rest: source.slice(0, at).trim(),
    };
  }
  if (source.startsWith(`${mark}\n`)) {
    return { value: source.slice(mark.length + 1).trim(), rest: '' };
  }
  return { value: '', rest: source };
}

function formatParentStepLines(steps) {
  const rows = Array.isArray(steps) ? steps.slice(-80) : [];
  return rows.map((item) => {
    const summary = String(item?.summary || '').trim();
    const paths = Array.isArray(item?.paths) && item.paths.length
      ? ` [${item.paths.join(', ')}]`
      : '';
    return `${item?.step || 'step'} ${item?.status || ''}: ${summary}${paths}`.trim();
  }).filter(Boolean).join('\n');
}

function parentGoalText(parent, parentTrace) {
  const fromTrace = String(parentTrace?.goal?.objective || '').trim();
  if (fromTrace) return fromTrace;
  const title = String(parent?.title || '').trim();
  if (title && !title.endsWith('…')) return title;
  const parsed = parseContinuedWorkPackageBody(parent?.body);
  if (parsed.continued && parsed.instruction) return parsed.instruction;
  return String(parent?.body || '').trim();
}

function parentProgressText(parent, parentTrace) {
  const status = String(parentTrace?.progress?.status || parent?.status || '').trim();
  const summary = String(parentTrace?.progress?.summary || parent?.resultSummary || '').trim();
  return [status, summary].filter(Boolean).join(' · ');
}

export function buildContinuedWorkPackageBody(parent, instruction, parentTrace) {
  const previous = String(parent?.body || '').trim();
  const next = String(instruction || '').trim();
  const result = String(parent?.resultSummary || '').trim();
  const goal = parentGoalText(parent, parentTrace);
  const progress = parentProgressText(parent, parentTrace);
  const steps = formatParentStepLines(parentTrace?.steps) || '（无步骤账本）';
  const parts = [];
  if (previous) {
    parts.push('上一任务：', previous);
  }
  if (goal) {
    parts.push('', '上一目标：', goal);
  }
  if (progress) {
    parts.push('', '上一进展：', progress);
  }
  parts.push('', '上一步骤：', steps);
  if (result) {
    parts.push('', '上一结果：', result);
  }
  parts.push('', '继续指令：', next);
  const body = parts.join('\n').trim();
  if (body.length <= CONTINUED_BODY_MAX) return body;
  return `${body.slice(0, CONTINUED_BODY_MAX - 18)}\n…(上一过程已截断)`;
}

export function parseContinuedWorkPackageBody(body) {
  const text = String(body || '').replace(/\r\n/g, '\n').trim();
  if (!text) {
    return {
      previous: '', result: '', instruction: '', goal: '', progress: '', steps: '', continued: false,
    };
  }
  const instructionMark = '\n继续指令：\n';
  const instructionAt = text.lastIndexOf(instructionMark);
  let instruction = '';
  let rest = text;
  if (instructionAt >= 0) {
    instruction = text.slice(instructionAt + instructionMark.length).trim();
    rest = text.slice(0, instructionAt).trim();
  } else if (text.startsWith('继续指令：\n')) {
    instruction = text.slice('继续指令：\n'.length).trim();
    rest = '';
  } else {
    return {
      previous: '', result: '', instruction: text, goal: '', progress: '', steps: '', continued: false,
    };
  }

  let taken = takeMarkedSection(rest, '上一结果：');
  const result = taken.value;
  taken = takeMarkedSection(taken.rest, '上一步骤：');
  const steps = taken.value;
  taken = takeMarkedSection(taken.rest, '上一进展：');
  const progress = taken.value;
  taken = takeMarkedSection(taken.rest, '上一目标：');
  const goal = taken.value;
  rest = taken.rest;
  let previous = '';
  if (rest.startsWith('上一任务：')) {
    previous = rest.replace(/^上一任务：\s*/, '').trim();
  } else {
    previous = rest;
  }
  return { previous, result, instruction, goal, progress, steps, continued: true };
}

function persistWorkPackageTrace(workPackageTracePort, pack, summary) {
  if (!workPackageTracePort || !pack) return;
  if (typeof workPackageTracePort.writeProgress === 'function') {
    workPackageTracePort.writeProgress({ workPackage: pack, summary });
    return;
  }
  workPackageTracePort.seed?.({ workPackage: pack });
}

export function createKnowledgeService({
  legacyRepository,
  knowledgeRepository,
  fileKnowledgePort = null,
  workPackageTracePort = null,
  attachmentStore = null,
}) {
  if (!legacyRepository || !knowledgeRepository) throw new Error('knowledge repositories are required');

  function linkAttachments(workspaceId, resourceType, resourceId, attachmentIds) {
    const ids = normalizeAttachmentIds(attachmentIds);
    if (!knowledgeRepository.replaceResourceAttachments) return [];
    if (!ids.length) {
      knowledgeRepository.replaceResourceAttachments(workspaceId, resourceType, resourceId, []);
      return [];
    }
    const found = knowledgeRepository.listAttachmentsByIds(workspaceId, ids);
    if (found.length !== ids.length) {
      throw new ValidationError('有附件不存在或不属于当前 workspace', ['attachmentIds']);
    }
    knowledgeRepository.replaceResourceAttachments(workspaceId, resourceType, resourceId, ids);
    return found.map(projectAttachment);
  }

  function attachmentsFor(workspaceId, resourceType, resourceId) {
    if (!knowledgeRepository.listResourceAttachments) return [];
    return knowledgeRepository.listResourceAttachments(workspaceId, resourceType, resourceId)
      .map(projectAttachment);
  }

  function hydrateInspiration(note, workspaceId = 'local') {
    if (!note) return note;
    const catalog = knowledgeRepository.listTaxonomy(workspaceId);
    return {
      ...note,
      attachments: attachmentsFor(workspaceId, 'inspiration', note.id),
      taxonomy: taxonomyView(catalog, knowledgeRepository.listResourceTaxonomy(workspaceId, 'inspiration', note.id)),
    };
  }

  function hydrateWorkPackage(pack, workspaceId = 'local') {
    if (!pack) return pack;
    return {
      ...pack,
      attachments: attachmentsFor(workspaceId, 'work-package', pack.id),
    };
  }

  return Object.freeze({
    createAttachment({ workspaceId = 'local', mime, originalName, data, bytes } = {}) {
      if (!attachmentStore?.write || !knowledgeRepository.createAttachment) {
        throw new ValidationError('当前实例未配置附件存储', ['data']);
      }
      const buffer = Buffer.isBuffer(bytes) ? bytes : decodeAttachmentData(data);
      if (!buffer.length) throw new ValidationError('图片内容为空', ['data']);
      if (buffer.length > ATTACHMENT_MAX_BYTES) {
        throw new ValidationError('图片不能超过 8MB', ['data']);
      }
      const sniffed = sniffImageMime(buffer);
      if (!sniffed) throw new ValidationError('只支持 JPEG / PNG / WebP / GIF', ['data']);
      const id = randomUUID();
      const relativePath = attachmentStore.write({ id, mime: sniffed, bytes: buffer });
      const record = knowledgeRepository.createAttachment({
        id,
        workspaceId,
        mime: sniffed,
        byteSize: buffer.length,
        sha256: attachmentSha256(buffer),
        relativePath,
        originalName: String(originalName || mime || '').trim().slice(0, 200),
      });
      return projectAttachment(record);
    },
    getAttachment(workspaceId, id) {
      if (!knowledgeRepository.getAttachment) return null;
      return projectAttachment(knowledgeRepository.getAttachment(workspaceId, id));
    },
    readAttachmentFile(workspaceId, id) {
      if (!attachmentStore?.read || !knowledgeRepository.getAttachment) return null;
      const record = knowledgeRepository.getAttachment(workspaceId, id);
      if (!record) return null;
      return {
        mime: record.mime,
        originalName: record.originalName,
        bytes: attachmentStore.read(record.relativePath),
      };
    },
    listResourceAttachments(workspaceId, resourceType, resourceId) {
      return attachmentsFor(workspaceId, resourceType, resourceId);
    },
    resolveAttachmentFiles(workspaceId, resourceType, resourceId) {
      if (!knowledgeRepository.listResourceAttachments) return [];
      return knowledgeRepository.listResourceAttachments(workspaceId, resourceType, resourceId)
        .map((item) => ({
          id: item.id,
          relativePath: item.relativePath,
          absolutePath: attachmentStore?.resolveAbsolute
            ? attachmentStore.resolveAbsolute(item.relativePath)
            : '',
        }))
        .filter((item) => item.absolutePath);
    },
    createInspiration(input) {
      const note = legacyRepository.createNote(input);
      if (input.attachmentIds?.length) {
        linkAttachments('local', 'inspiration', note.id, input.attachmentIds);
      }
      return hydrateInspiration(note);
    },
    getInspiration(_workspaceId, id) {
      return hydrateInspiration(legacyRepository.getNote(id), _workspaceId || 'local');
    },
    listInspirations(status) {
      const notes = legacyRepository.listNotes(status)
        .filter((note) => note.sourceType !== 'work-package');
      const grouped = knowledgeRepository.listResourceAttachmentsForMany
        ? knowledgeRepository.listResourceAttachmentsForMany('local', 'inspiration', notes.map((note) => note.id))
        : new Map();
      const catalog = knowledgeRepository.listTaxonomy('local');
      return notes.map((note) => ({
        ...note,
        attachments: (grouped.get(note.id) || []).map(projectAttachment),
        taxonomy: taxonomyView(catalog, knowledgeRepository.listResourceTaxonomy('local', 'inspiration', note.id)),
        workPackage: null,
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
      if (knowledgeRepository.deleteWorkPackageByInspiration) {
        knowledgeRepository.deleteWorkPackageByInspiration('local', id);
      }
      knowledgeRepository.clearResourceAnnotations('local', 'inspiration', id);
      knowledgeRepository.clearResourceAttachments?.('local', 'inspiration', id);
      return legacyRepository.deleteNote(id);
    },
    createWorkPackage(input, workspaceId = 'local') {
      if (input.clientMutationId && knowledgeRepository.getWorkPackageByMutation) {
        const existing = knowledgeRepository.getWorkPackageByMutation(workspaceId, input.clientMutationId);
        if (existing) return hydrateWorkPackage(withTraceId(attachNote(legacyRepository, existing)), workspaceId);
      }
      const title = deriveWorkPackageTitle(input.title, input.body);
      const note = legacyRepository.createNote({
        title,
        body: input.body,
        inspirationType: 'idea',
        wantAi: false,
        sourceType: 'work-package',
        sourceUrl: input.sourceUrl || '',
        sourceTitle: input.sourceTitle || '',
        captureChannel: input.captureChannel || 'web',
        sourceApp: input.sourceApp || '',
        clientMutationId: input.clientMutationId || '',
        capturedAt: input.capturedAt,
      });
      const pack = knowledgeRepository.createWorkPackage({
        workspaceId,
        inspirationId: note.id,
        title,
        body: input.body,
        parentWorkPackageId: input.parentWorkPackageId || '',
        clientMutationId: input.clientMutationId || '',
      });
      if (input.attachmentIds?.length) {
        linkAttachments(workspaceId, 'inspiration', note.id, input.attachmentIds);
        linkAttachments(workspaceId, 'work-package', pack.id, input.attachmentIds);
      }
      const created = hydrateWorkPackage(withTraceId({
        ...pack,
        note: hydrateInspiration(note, workspaceId),
      }), workspaceId);
      if (workPackageTracePort?.seed) {
        workPackageTracePort.seed({ workPackage: created });
      } else {
        persistWorkPackageTrace(workPackageTracePort, created, '已投递，等待本机 Cursor 领取');
      }
      return created;
    },
    continueWorkPackage(workspaceId, parentId, input) {
      const parent = knowledgeRepository.getWorkPackage(workspaceId, parentId);
      if (!parent) throw new ValidationError('工作包不存在', ['id']);
      const instruction = String(input?.body || '').trim();
      if (!instruction) throw new ValidationError('继续指令不能为空', ['body']);
      const parentTrace = workPackageTracePort?.read
        ? workPackageTracePort.read(parent.id)
        : null;
      const body = buildContinuedWorkPackageBody(parent, instruction, parentTrace);
      const attachmentIds = Array.isArray(input.attachmentIds)
        ? input.attachmentIds
        : (knowledgeRepository.listResourceAttachments?.(workspaceId, 'work-package', parent.id) || [])
          .map((item) => item.id);
      return this.createWorkPackage({
        title: deriveWorkPackageTitle('', instruction),
        body,
        parentWorkPackageId: parent.id,
        captureChannel: input.captureChannel || 'web',
        sourceApp: input.sourceApp || '',
        attachmentIds,
      }, workspaceId);
    },
    listWorkPackages(workspaceId, status = 'active') {
      const packs = knowledgeRepository.listWorkPackages(workspaceId, status);
      const grouped = knowledgeRepository.listResourceAttachmentsForMany
        ? knowledgeRepository.listResourceAttachmentsForMany(workspaceId, 'work-package', packs.map((item) => item.id))
        : new Map();
      return packs.map((item) => hydrateWorkPackage({
        ...withTraceId(attachNote(legacyRepository, item)),
        attachments: (grouped.get(item.id) || []).map(projectAttachment),
      }, workspaceId));
    },
    notifyWorkPackages(workspaceId, input = {}) {
      const packs = input.id
        ? [knowledgeRepository.getWorkPackage(workspaceId, input.id)].filter(Boolean)
        : knowledgeRepository.listWorkPackages(workspaceId, 'open');
      if (input.id && !packs.length) throw new ValidationError('工作包不存在', ['id']);
      if (knowledgeRepository.notifyWorkPackages) {
        knowledgeRepository.notifyWorkPackages(workspaceId, packs.map((item) => item.id));
      }
      return {
        openCount: packs.length,
        workPackages: packs.map((item) => withTraceId(attachNote(legacyRepository, item))),
      };
    },
    getWorkPackage(workspaceId, id) {
      const pack = knowledgeRepository.getWorkPackage(workspaceId, id);
      return pack ? hydrateWorkPackage(withTraceId(attachNote(legacyRepository, pack)), workspaceId) : null;
    },
    attachCursorSession(workspaceId, id, input = {}) {
      if (!knowledgeRepository.attachCursorSession) {
        throw new ValidationError('当前数据库还不支持独立 Cursor session', ['id']);
      }
      const pack = knowledgeRepository.attachCursorSession(workspaceId, id, input);
      if (!pack) throw new ValidationError('工作包不存在', ['id']);
      const attached = withTraceId(attachNote(legacyRepository, pack));
      if (attached.dispatchJobId && attached.status === 'open') {
        persistWorkPackageTrace(workPackageTracePort, attached, '已派发独立会话');
      }
      return attached;
    },
    getWorkPackageTrace(workspaceId, id) {
      const pack = knowledgeRepository.getWorkPackage(workspaceId, id);
      if (!pack) return null;
      const hashId = workPackageTraceId(pack.id);
      if (!workPackageTracePort?.read) {
        return parseWorkPackageTrace({
          hashId,
          workPackageId: pack.id,
          relativeDir: '',
          prompt: '',
          goal: null,
          progress: null,
          steps: [],
          parentTrace: null,
        });
      }
      const raw = workPackageTracePort.read(pack.id) || {};
      return parseWorkPackageTrace({
        hashId: raw.hashId || hashId,
        workPackageId: raw.workPackageId || pack.id,
        relativeDir: raw.relativeDir || '',
        prompt: raw.prompt || '',
        goal: raw.goal || null,
        progress: raw.progress || null,
        steps: raw.steps || [],
        parentTrace: raw.parentTrace || null,
      });
    },
    claimWorkPackage(workspaceId, input) {
      const pack = knowledgeRepository.claimWorkPackage(workspaceId, input);
      if (!pack) {
        throw new ValidationError(input.id ? '工作包不存在或已被领取' : '没有待领取的工作包', ['id']);
      }
      const claimed = withTraceId(attachNote(legacyRepository, pack));
      persistWorkPackageTrace(workPackageTracePort, claimed, '本机 Cursor 已领取并开始执行');
      return claimed;
    },
    completeWorkPackage(workspaceId, id, input) {
      const classified = classifyProcessRestart(input.changedPaths || []);
      const restartRequired = input.restartRequired && input.restartRequired !== 'unknown'
        ? input.restartRequired
        : classified.restartRequired;
      const pack = knowledgeRepository.completeWorkPackage(workspaceId, id, {
        claimedBy: input.claimedBy,
        resultSummary: input.resultSummary || '',
        restartRequired,
      });
      if (!pack) throw new ValidationError('只能完成当前已领取的工作包', ['id']);
      const completed = { ...withTraceId(attachNote(legacyRepository, pack)), restart: classified };
      persistWorkPackageTrace(workPackageTracePort, completed, completed.resultSummary || '已完成');
      return completed;
    },
    failWorkPackage(workspaceId, id, input) {
      const pack = knowledgeRepository.failWorkPackage(workspaceId, id, {
        claimedBy: input.claimedBy,
        resultSummary: input.resultSummary,
      });
      if (!pack) throw new ValidationError('只能结束当前已领取的工作包', ['id']);
      const failed = withTraceId(attachNote(legacyRepository, pack));
      persistWorkPackageTrace(workPackageTracePort, failed, failed.resultSummary || '未完成');
      return failed;
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
          .filter((note) => (
            (!wanted.size || wanted.has(note.id))
            && note.sourceType !== 'work-package'
            && String(note.body || '').trim()
          ))
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
    ensureArticleAnalysisSession({ workspaceId, sessionId, title }) {
      if (sessionId) {
        const session = knowledgeRepository.getSession(workspaceId, sessionId);
        if (!session) throw new ValidationError('文章分析记录不存在', ['sessionId']);
        if (session.kind !== 'article-analysis') throw new ValidationError('这条记录不能继续文章分析', ['sessionId']);
        return session;
      }
      return knowledgeRepository.createSession({
        workspaceId,
        kind: 'article-analysis',
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
          sourceFooter: projectAnswerSourceFooter(exchange.refs, { evidence: exchange.evidenceGate }),
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
