import { parseTagAnalyzeInput } from '../../../../packages/contracts/src/index.js';
import { json, readJson } from '../http/response.js';

export function createTaggingRoutes() {
  return [
    {
      method: 'GET', path: '/api/v1/tags',
      handler({ response, services }) {
        if (!services.tagging) {
          json(response, 503, { ok: false, error: '标注服务未配置' });
          return;
        }
        json(response, 200, { ok: true, catalog: services.tagging.listCatalog() });
      },
    },
    {
      method: 'GET', path: '/api/v1/tagging',
      handler({ response, services, url, identity }) {
        if (!services.tagging) {
          json(response, 503, { ok: false, error: '标注服务未配置' });
          return;
        }
        const workspaceId = identity?.device?.workspaceId || 'local';
        const resourceType = url.searchParams.get('resourceType') || 'content-item';
        const resourceId = url.searchParams.get('resourceId') || '';
        const resourceIds = url.searchParams.getAll('resourceId');
        if (resourceId && resourceIds.length <= 1) {
          json(response, 200, {
            ok: true,
            tagging: services.tagging.getTagging(workspaceId, resourceType, resourceId),
          });
          return;
        }
        json(response, 200, {
          ok: true,
          items: services.tagging.listTaggings(workspaceId, resourceType, resourceIds),
        });
      },
    },
    {
      method: 'POST', path: '/api/v1/tagging/analyze',
      async handler({ request, response, services, identity, events }) {
        if (!services.runtime?.requestTagAnalyze) {
          json(response, 503, { ok: false, error: '标注任务未注册' });
          return;
        }
        const workspaceId = identity?.device?.workspaceId || 'local';
        const input = parseTagAnalyzeInput({
          ...(await readJson(request)),
          workspaceId,
        });
        const job = services.runtime.requestTagAnalyze(input);
        events.flush();
        json(response, 202, { ok: true, jobId: job.id, job });
      },
    },
    {
      method: 'GET', path: /^\/api\/v1\/tagging\/jobs\/([0-9a-f-]+)$/i,
      handler({ response, services, identity, params }) {
        const job = services.runtime.getJob(params.values[0]);
        const workspaceId = identity?.device?.workspaceId || 'local';
        if (!job || job.workspaceId !== workspaceId || job.type !== 'tagging.analyze') {
          json(response, 404, { ok: false, error: '标注任务不存在' });
          return;
        }
        json(response, 200, { ok: true, jobId: job.id, status: job.status, job });
      },
    },
  ];
}
