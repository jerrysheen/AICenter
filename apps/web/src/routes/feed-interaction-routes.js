import { LikeRequestSchema, LikeContentInputSchema } from '../../../../packages/contracts/src/feed-interaction.js';
import { parseContract } from '../../../../packages/contracts/src/errors.js';
import { json, readJson } from '../http/response.js';

export function createFeedInteractionRoutes() {
  return [
    { method: 'POST', path: /^\/api\/v1\/content-items\/([0-9a-f-]{36})\/x-like$/i,
      async handler({ request, response, services, identity, params, events }) {
        parseContract(LikeRequestSchema, await readJson(request));
        const input = parseContract(LikeContentInputSchema, { contentItemId: params.values[0] });
        const job = services.feedInteraction.requestLike(identity?.device?.workspaceId || 'local', input);
        events.flush();
        json(response, 202, { ok: true, jobId: job.id });
      } },
    { method: 'GET', path: /^\/api\/v1\/content-items\/([0-9a-f-]{36})\/x-like\/([0-9a-f-]{36})$/i,
      handler({ response, services, identity, params }) {
        const job = services.feedInteraction.getLikeJob(identity?.device?.workspaceId || 'local', params.values[0], params.values[1]);
        json(response, job ? 200 : 404, job ? { ok: true, job } : { ok: false, error: '点赞任务不存在' });
      } },
  ];
}
