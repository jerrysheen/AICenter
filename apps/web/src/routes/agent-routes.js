import { parseCreateAgentRunInput, parsePageRequest } from '../../../../packages/contracts/src/index.js';
import { json, readJson } from '../http/response.js';

export function createAgentRoutes() {
  return [
    {
      method: 'GET', path: '/api/v1/agent/sessions',
      handler({ response, services, identity, url }) {
        const workspaceId = identity?.device?.workspaceId || 'local';
        const page = parsePageRequest({
          cursor: url.searchParams.get('cursor') || undefined,
          limit: url.searchParams.get('limit') || undefined,
        });
        const result = services.knowledge.listAiSessions(workspaceId, page);
        json(response, 200, { ok: true, ...result });
      },
    },
    {
      method: 'GET', path: /^\/api\/v1\/agent\/sessions\/([0-9a-f-]{36})$/i,
      handler({ response, services, identity, params }) {
        const workspaceId = identity?.device?.workspaceId || 'local';
        const detail = services.knowledge.getAiSession(workspaceId, params.values[0]);
        if (!detail) {
          json(response, 404, { ok: false, error: 'AI 记录不存在' });
          return;
        }
        json(response, 200, { ok: true, ...detail });
      },
    },
    {
      method: 'GET', path: /^\/api\/v1\/agent\/records\/([0-9a-f-]{36})$/i,
      handler({ response, services, identity, params }) {
        const workspaceId = identity?.device?.workspaceId || 'local';
        const run = services.knowledge.getAgentRun(workspaceId, params.values[0]);
        if (!run || (run.workspaceId && run.workspaceId !== workspaceId)) {
          json(response, 404, { ok: false, error: '问答记录不存在' });
          return;
        }
        json(response, 200, { ok: true, run });
      },
    },
    {
      method: 'POST', path: '/api/v1/agent/runs',
      async handler({ request, response, services, identity, events }) {
        const input = parseCreateAgentRunInput(await readJson(request));
        const workspaceId = identity?.device?.workspaceId || 'local';
        const session = services.knowledge.ensureQaSession({
          workspaceId,
          sessionId: input.sessionId,
          title: input.message,
        });
        const job = services.runtime.requestAgentRun({
          message: input.message,
          webMode: input.webMode,
          workspaceId,
          sessionId: session.id,
          references: input.references,
        });
        events.flush();
        json(response, 202, { ok: true, runId: job.id, sessionId: session.id, job });
      },
    },
    {
      method: 'GET', path: /^\/api\/v1\/agent\/runs\/([0-9a-f-]+)$/i,
      async handler({ response, services, identity, params }) {
        const payload = await services.runtime.getAgentRun(params.values[0]);
        if (!payload || (identity?.device && payload.job.workspaceId !== identity.device.workspaceId)) {
          json(response, 404, { ok: false, error: '问答任务不存在' });
          return;
        }
        json(response, 200, { ok: true, ...payload });
      },
    },
  ];
}
