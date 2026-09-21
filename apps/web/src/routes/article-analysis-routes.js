import { parseCreateArticleAnalysisInput } from '../../../../packages/contracts/src/index.js';
import { json, readJson } from '../http/response.js';

export function createArticleAnalysisRoutes() {
  return [
    {
      method: 'POST', path: '/api/v1/article-analysis/runs',
      async handler({ request, response, services, identity, events }) {
        const input = parseCreateArticleAnalysisInput(await readJson(request));
        const workspaceId = identity?.device?.workspaceId || 'local';
        const title = input.source.type === 'inline'
          ? (input.source.title || input.source.body)
          : '文章分析';
        const session = services.knowledge.ensureArticleAnalysisSession({
          workspaceId,
          sessionId: input.sessionId,
          title,
        });
        const job = services.runtime.requestArticleAnalysis({
          source: input.source,
          workspaceId,
          sessionId: session.id,
        });
        events.flush();
        json(response, 202, {
          ok: true,
          runId: job.id,
          sessionId: session.id,
          status: job.status,
          phase: 'queued',
        });
      },
    },
    {
      method: 'GET', path: /^\/api\/v1\/article-analysis\/runs\/([0-9a-f-]+)$/i,
      async handler({ response, services, identity, params }) {
        const payload = await services.runtime.getArticleAnalysisRun(params.values[0]);
        if (!payload || (identity?.device && payload.workspaceId && payload.workspaceId !== identity.device.workspaceId)) {
          json(response, 404, { ok: false, error: '文章分析任务不存在' });
          return;
        }
        json(response, 200, { ok: true, ...payload });
      },
    },
  ];
}
