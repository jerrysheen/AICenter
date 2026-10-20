import { json, readJson } from '../http/response.js';

function workspaceIdFrom(identity) {
  return identity?.device?.workspaceId || 'local';
}

export function createXVideoRoutes() {
  return [
    {
      method: 'POST',
      path: '/api/v1/x-videos/article',
      access: 'operator',
      async handler({ request, response, services, identity, events }) {
        const body = await readJson(request);
        const result = services.xVideos.enqueue(workspaceIdFrom(identity), body || {});
        events?.flush?.();
        const status = result.status === 'disabled' ? 409 : result.status === 'invalid' ? 400 : 202;
        json(response, result.status === 'ready' ? 200 : status, { ok: result.status !== 'disabled' && result.status !== 'invalid', ...result });
      },
    },
    {
      method: 'GET',
      path: /^\/api\/v1\/x-videos\/(\d{5,25})\/article$/,
      handler({ response, services, identity, params }) {
        const article = services.xVideos.status(workspaceIdFrom(identity), params.values[0]);
        if (!article) {
          json(response, 404, { ok: false, error: '这篇没有长视频整理' });
          return;
        }
        json(response, 200, { ok: true, ...article });
      },
    },
    {
      method: 'GET',
      path: /^\/api\/v1\/x-videos\/(\d{5,25})$/,
      handler({ response, services, identity, params }) {
        const article = services.xVideos.get(workspaceIdFrom(identity), params.values[0]);
        if (!article) {
          json(response, 404, { ok: false, error: '这篇还没有整理好' });
          return;
        }
        json(response, 200, { ok: true, article });
      },
    },
  ];
}
