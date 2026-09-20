import {
  parseClaimWorkPackageInput,
  parseCompleteWorkPackageInput,
  parseContinueWorkPackageInput,
  parseCreateAttachmentInput,
  parseCreateInspirationFromRunInput,
  parseCreateKnowledgeFromRunInput,
  parseCreateKnowledgeFromUserInput,
  parseCreateWorkPackageInput,
  parseFailWorkPackageInput,
  parseKnowledgeMentionQuery,
  parseNoteInput,
  parseNotifyWorkPackageInput,
  parseWorkPackageListQuery,
} from '../../../../packages/contracts/src/index.js';
import { json, readJson, sendBytes } from '../http/response.js';

const STRUCTURE_JOB_TYPES = new Set(['inspiration.from-run', 'knowledge.from-run']);

function enqueueStructureJob({ services, identity, events, target, runId, instruction }) {
  const workspaceId = identity?.device?.workspaceId || 'local';
  const input = services.knowledge.prepareStructureFromRun({
    workspaceId, runId, target, instruction,
  });
  const job = services.runtime.requestStructureFromRun(input);
  events.flush();
  return job;
}

const ATTACHMENT_JSON_MAX_BYTES = 12 * 1024 * 1024;

export function createKnowledgeRoutes() {
  return [
    {
      method: 'POST', path: '/api/v1/attachments',
      async handler({ request, response, services, identity }) {
        const workspaceId = identity?.device?.workspaceId || 'local';
        const input = parseCreateAttachmentInput(await readJson(request, { maxBytes: ATTACHMENT_JSON_MAX_BYTES }));
        const attachment = services.knowledge.createAttachment({ workspaceId, ...input });
        json(response, 201, { ok: true, attachment });
      },
    },
    {
      method: 'GET', path: /^\/api\/v1\/attachments\/([0-9a-f-]{36})$/i,
      handler({ response, services, identity, params }) {
        const workspaceId = identity?.device?.workspaceId || 'local';
        const attachment = services.knowledge.getAttachment(workspaceId, params.values[0]);
        if (!attachment) json(response, 404, { ok: false, error: '附件不存在' });
        else json(response, 200, { ok: true, attachment });
      },
    },
    {
      method: 'GET', path: /^\/api\/v1\/attachments\/([0-9a-f-]{36})\/content$/i,
      handler({ response, services, identity, params }) {
        const workspaceId = identity?.device?.workspaceId || 'local';
        const file = services.knowledge.readAttachmentFile(workspaceId, params.values[0]);
        if (!file) {
          json(response, 404, { ok: false, error: '附件不存在' });
          return;
        }
        sendBytes(response, file.bytes, file.mime);
      },
    },
    {
      method: 'GET', path: '/api/v1/notes',
      handler({ response, services, url }) {
        json(response, 200, {
          ok: true,
          notes: services.knowledge.listInspirations(url.searchParams.get('status') || 'inbox'),
        });
      },
    },
    {
      method: 'POST', path: '/api/v1/notes',
      async handler({ request, response, services, events }) {
        const note = services.knowledge.createInspiration(parseNoteInput(await readJson(request)));
        events.flush();
        json(response, 201, { ok: true, note });
      },
    },
    {
      method: 'GET', path: /^\/api\/v1\/notes\/([0-9a-f-]{36})$/i,
      handler({ response, services, identity, params }) {
        const workspaceId = identity?.device?.workspaceId || 'local';
        const note = services.knowledge.getInspiration(workspaceId, params.values[0]);
        if (!note) json(response, 404, { ok: false, error: '灵感不存在' });
        else json(response, 200, { ok: true, note });
      },
    },
    {
      method: 'POST', path: '/api/v1/notes/from-run',
      async handler({ request, response, services, identity, events }) {
        const input = parseCreateInspirationFromRunInput(await readJson(request));
        const job = enqueueStructureJob({
          services, identity, events, target: 'inspiration',
          runId: input.runId, instruction: input.instruction,
        });
        json(response, 202, { ok: true, jobId: job.id, job });
      },
    },
    {
      method: 'POST', path: /^\/api\/v1\/notes\/([0-9a-f-]+)\/archive$/i,
      handler({ response, services, events, params }) {
        const note = services.knowledge.archiveInspiration(params.values[0]);
        events.flush();
        if (!note) json(response, 404, { ok: false, error: '灵感不存在' });
        else json(response, 200, { ok: true, note });
      },
    },
    {
      method: 'POST', path: /^\/api\/v1\/notes\/([0-9a-f-]+)\/pin$/i,
      handler({ response, services, params }) {
        const note = services.knowledge.toggleInspirationPin(params.values[0]);
        if (!note) json(response, 404, { ok: false, error: '灵感不存在' });
        else json(response, 200, { ok: true, note });
      },
    },
    {
      method: 'DELETE', path: /^\/api\/v1\/notes\/([0-9a-f-]+)$/i,
      handler({ response, services, params }) {
        const deleted = services.knowledge.deleteInspiration(params.values[0]);
        json(response, deleted ? 200 : 404, { ok: deleted });
      },
    },
    {
      method: 'GET', path: '/api/v1/work-packages',
      handler({ response, services, identity, url }) {
        const workspaceId = identity?.device?.workspaceId || 'local';
        const query = parseWorkPackageListQuery({ status: url.searchParams.get('status') || 'active' });
        json(response, 200, {
          ok: true,
          workPackages: services.knowledge.listWorkPackages(workspaceId, query.status),
        });
      },
    },
    {
      method: 'POST', path: '/api/v1/work-packages',
      async handler({ request, response, services, identity, events }) {
        const workspaceId = identity?.device?.workspaceId || 'local';
        const workPackage = services.knowledge.createWorkPackage(
          parseCreateWorkPackageInput(await readJson(request)),
          workspaceId,
        );
        events.flush();
        json(response, 201, { ok: true, workPackage, note: workPackage.note });
      },
    },
    {
      method: 'POST', path: '/api/v1/work-packages/notify',
      async handler({ request, response, services, identity, events }) {
        const workspaceId = identity?.device?.workspaceId || 'local';
        const notified = services.knowledge.notifyWorkPackages(
          workspaceId,
          parseNotifyWorkPackageInput(await readJson(request).catch(() => ({}))),
        );
        const jobs = [];
        for (const pack of notified.workPackages || []) {
          if (pack.status === 'completed' || pack.status === 'failed' || pack.status === 'cancelled') continue;
          if (pack.cursorAgentId || pack.dispatchJobId) continue;
          const job = services.runtime.requestWorkPackageDispatch({
            workspaceId,
            workPackageId: pack.id,
          });
          services.knowledge.attachCursorSession(workspaceId, pack.id, { dispatchJobId: job.id });
          jobs.push({ id: job.id, type: job.type });
        }
        events.flush();
        json(response, 200, { ok: true, ...notified, jobs });
      },
    },
    {
      method: 'POST', path: '/api/v1/work-packages/claim', access: 'desktop',
      async handler({ request, response, services, events }) {
        const input = parseClaimWorkPackageInput(await readJson(request).catch(() => ({})));
        const workPackage = services.knowledge.claimWorkPackage('local', input);
        events.flush();
        json(response, 200, { ok: true, workPackage });
      },
    },
    {
      method: 'GET', path: /^\/api\/v1\/work-packages\/([0-9a-f-]{36})$/i,
      handler({ response, services, identity, params }) {
        const workspaceId = identity?.device?.workspaceId || 'local';
        const workPackage = services.knowledge.getWorkPackage(workspaceId, params.values[0]);
        if (!workPackage) json(response, 404, { ok: false, error: '工作包不存在' });
        else json(response, 200, { ok: true, workPackage });
      },
    },
    {
      method: 'GET', path: /^\/api\/v1\/work-packages\/([0-9a-f-]{36})\/trace$/i,
      handler({ response, services, identity, params }) {
        const workspaceId = identity?.device?.workspaceId || 'local';
        const trace = services.knowledge.getWorkPackageTrace(workspaceId, params.values[0]);
        if (!trace) json(response, 404, { ok: false, error: '工作包不存在' });
        else json(response, 200, { ok: true, trace });
      },
    },
    {
      method: 'POST', path: /^\/api\/v1\/work-packages\/([0-9a-f-]{36})\/continue$/i,
      async handler({ request, response, services, identity, events, params }) {
        const workspaceId = identity?.device?.workspaceId || 'local';
        const input = parseContinueWorkPackageInput(await readJson(request));
        const workPackage = services.knowledge.continueWorkPackage(workspaceId, params.values[0], input);
        const jobs = [];
        if (workPackage.status !== 'completed' && workPackage.status !== 'failed' && workPackage.status !== 'cancelled') {
          const job = services.runtime.requestWorkPackageDispatch({
            workspaceId,
            workPackageId: workPackage.id,
          });
          services.knowledge.attachCursorSession(workspaceId, workPackage.id, { dispatchJobId: job.id });
          jobs.push({ id: job.id, type: job.type });
        }
        events.flush();
        json(response, 201, { ok: true, workPackage, note: workPackage.note, jobs });
      },
    },
    {
      method: 'POST', path: /^\/api\/v1\/work-packages\/([0-9a-f-]{36})\/complete$/i, access: 'desktop',
      async handler({ request, response, services, events, params }) {
        const body = await readJson(request).catch(() => ({}));
        const input = parseCompleteWorkPackageInput(body);
        const workPackage = services.knowledge.completeWorkPackage('local', params.values[0], {
          ...input,
          claimedBy: String(body?.claimedBy || 'cursor-local').trim() || 'cursor-local',
        });
        events.flush();
        json(response, 200, { ok: true, workPackage, restart: workPackage.restart });
      },
    },
    {
      method: 'POST', path: /^\/api\/v1\/work-packages\/([0-9a-f-]{36})\/fail$/i, access: 'desktop',
      async handler({ request, response, services, events, params }) {
        const body = await readJson(request);
        const input = parseFailWorkPackageInput(body);
        const workPackage = services.knowledge.failWorkPackage('local', params.values[0], {
          ...input,
          claimedBy: String(body?.claimedBy || 'cursor-local').trim() || 'cursor-local',
        });
        events.flush();
        json(response, 200, { ok: true, workPackage });
      },
    },
    {
      method: 'GET', path: '/api/v1/knowledge',
      handler({ response, services }) {
        json(response, 200, { ok: true, items: services.knowledge.listLegacyKnowledge() });
      },
    },
    {
      method: 'GET', path: /^\/api\/v1\/knowledge\/documents\/(.+)$/i,
      handler({ response, services, identity, params }) {
        const workspaceId = identity?.device?.workspaceId || 'local';
        const knowledgeId = decodeURIComponent(params.values[0] || '').trim();
        const item = knowledgeId ? services.knowledge.getDocumentForView(workspaceId, knowledgeId) : null;
        if (!item) json(response, 404, { ok: false, error: '知识文档不存在' });
        else json(response, 200, { ok: true, item });
      },
    },
    {
      method: 'GET', path: '/api/v1/knowledge/mentions',
      handler({ response, services, identity, url }) {
        const workspaceId = identity?.device?.workspaceId || 'local';
        const input = parseKnowledgeMentionQuery({
          q: url.searchParams.get('q') || '',
          limit: url.searchParams.get('limit') || undefined,
        });
        json(response, 200, {
          ok: true,
          items: services.knowledge.listMentions(workspaceId, input.q, input.limit),
        });
      },
    },
    {
      method: 'DELETE', path: /^\/api\/v1\/knowledge\/([0-9a-f-]+)$/i,
      handler({ response, services, identity, events, params }) {
        const workspaceId = identity?.device?.workspaceId || 'local';
        const deleted = services.knowledge.deleteDocument(workspaceId, params.values[0]);
        events.flush();
        json(response, deleted ? 200 : 404, { ok: deleted });
      },
    },
    {
      method: 'POST', path: '/api/v1/knowledge',
      async handler({ request, response, services, identity, events }) {
        const input = parseCreateKnowledgeFromUserInput(await readJson(request));
        const workspaceId = identity?.device?.workspaceId || 'local';
        const item = services.knowledge.createDocumentFromUser({ workspaceId, ...input });
        events.flush();
        json(response, 201, { ok: true, item });
      },
    },
    {
      method: 'POST', path: '/api/v1/knowledge/from-run',
      async handler({ request, response, services, identity, events }) {
        const input = parseCreateKnowledgeFromRunInput(await readJson(request));
        const job = enqueueStructureJob({
          services, identity, events, target: 'knowledge',
          runId: input.runId, instruction: input.instruction,
        });
        json(response, 202, { ok: true, jobId: job.id, job });
      },
    },
    {
      method: 'GET', path: '/api/v1/taxonomy',
      handler({ response, services, identity }) {
        const workspaceId = identity?.device?.workspaceId || 'local';
        json(response, 200, { ok: true, nodes: services.knowledge.listTaxonomy(workspaceId) });
      },
    },
    {
      method: 'GET', path: /^\/api\/v1\/knowledge\/jobs\/([0-9a-f-]+)$/i,
      handler({ response, services, identity, params }) {
        const job = services.runtime.getJob(params.values[0]);
        const workspaceId = identity?.device?.workspaceId || 'local';
        if (!job || job.workspaceId !== workspaceId || !STRUCTURE_JOB_TYPES.has(job.type)) {
          json(response, 404, { ok: false, error: '整理任务不存在' });
          return;
        }
        json(response, 200, { ok: true, jobId: job.id, status: job.status, job });
      },
    },
  ];
}
