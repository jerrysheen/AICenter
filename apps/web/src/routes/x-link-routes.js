import { json, readJson } from '../http/response.js';

function workspaceIdFrom(identity) {
  return identity?.device?.workspaceId || 'local';
}

export function createXLinkRoutes() {
  return [
    {
      method: 'POST',
      path: '/api/v1/x-links/article',
      access: 'operator',
      async handler({ request, response, services, identity, events }) {
        if (!services.xLinks) {
          json(response, 503, { ok: false, error: '外链正文未配置' });
          return;
        }
        const body = await readJson(request);
        const result = services.xLinks.enqueue(workspaceIdFrom(identity), body || {});
        events?.flush?.();
        const status = result.status === 'disabled' ? 409 : result.status === 'invalid' ? 400 : 202;
        json(response, result.status === 'ready' ? 200 : status, { ok: result.eligible !== false && result.status !== 'invalid', ...result });
      },
    },
    {
      method: 'GET',
      path: /^\/api\/v1\/x-links\/(\d{5,25})\/article$/,
      handler({ response, services, identity, params }) {
        const article = services.xLinks?.status(workspaceIdFrom(identity), params.values[0]);
        if (!article) {
          json(response, 404, { ok: false, error: '这篇没有外链正文' });
          return;
        }
        json(response, 200, { ok: true, ...article });
      },
    },
    {
      method: 'GET',
      path: /^\/api\/v1\/x-links\/(\d{5,25})$/,
      handler({ response, services, identity, params }) {
        const article = services.xLinks?.get(workspaceIdFrom(identity), params.values[0]);
        if (!article) {
          json(response, 404, { ok: false, error: '这篇还没有中文正文' });
          return;
        }
        json(response, 200, { ok: true, ...article });
      },
    },
  ];
}
