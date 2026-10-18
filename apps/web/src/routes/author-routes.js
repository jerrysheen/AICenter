import { authorViewEnabled } from '../../../../packages/domain/src/authors.js';
import { json } from '../http/response.js';

function workspaceIdFrom(identity) {
  return identity?.device?.workspaceId || 'local';
}

function disabled(response) {
  json(response, 404, { ok: false, error: '作者视图未开启' });
}

function authorIdFrom(params) {
  return params?.values?.[0] || '';
}

export function createAuthorRoutes() {
  return [
    {
      method: 'GET',
      path: '/api/v1/authors',
      handler({ url, response, services, identity }) {
        if (!authorViewEnabled() || !services.authors) {
          disabled(response);
          return;
        }
        const platform = url.searchParams.get('platform') || 'all';
        const cursor = url.searchParams.get('cursor') || '';
        const page = services.authors.list({
          workspaceId: workspaceIdFrom(identity),
          platform,
          cursor,
        });
        json(response, 200, { ok: true, ...page });
      },
    },
    {
      method: 'GET',
      path: /^\/api\/v1\/authors\/([^/]+)\/items$/,
      handler({ url, response, services, identity, params }) {
        if (!authorViewEnabled() || !services.authors) {
          disabled(response);
          return;
        }
        const query = url.searchParams;
        const page = services.authors.items(workspaceIdFrom(identity), authorIdFrom(params), {
          read: query.get('read') === 'read' ? 'read' : 'unread',
          cursor: query.get('cursor') || '',
          limit: Number(query.get('limit')) || undefined,
        });
        if (!page) {
          json(response, 404, { ok: false, error: '作者不存在' });
          return;
        }
        json(response, 200, { ok: true, ...page });
      },
    },
    {
      method: 'POST',
      path: /^\/api\/v1\/authors\/([^/]+)\/read-all$/,
      async handler({ response, services, identity, params }) {
        if (!authorViewEnabled() || !services.authors) {
          disabled(response);
          return;
        }
        const result = await services.authors.readAll(workspaceIdFrom(identity), authorIdFrom(params));
        if (!result) {
          json(response, 404, { ok: false, error: '作者不存在' });
          return;
        }
        json(response, 200, { ok: true, ...result });
      },
    },
    {
      method: 'PUT',
      path: /^\/api\/v1\/authors\/([^/]+)\/follow$/,
      handler({ response, services, identity, params }) {
        if (!authorViewEnabled() || !services.authors) {
          disabled(response);
          return;
        }
        const author = services.authors.follow(workspaceIdFrom(identity), authorIdFrom(params), true);
        if (!author) {
          json(response, 404, { ok: false, error: '作者不存在' });
          return;
        }
        json(response, 200, { ok: true, author });
      },
    },
    {
      method: 'DELETE',
      path: /^\/api\/v1\/authors\/([^/]+)\/follow$/,
      handler({ response, services, identity, params }) {
        if (!authorViewEnabled() || !services.authors) {
          disabled(response);
          return;
        }
        const author = services.authors.follow(workspaceIdFrom(identity), authorIdFrom(params), false);
        if (!author) {
          json(response, 404, { ok: false, error: '作者不存在' });
          return;
        }
        json(response, 200, { ok: true, author });
      },
    },
    {
      method: 'GET',
      path: /^\/api\/v1\/authors\/([^/]+)$/,
      handler({ response, services, identity, params }) {
        if (!authorViewEnabled() || !services.authors) {
          disabled(response);
          return;
        }
        const author = services.authors.get(workspaceIdFrom(identity), authorIdFrom(params));
        if (!author || author.kind === 'system') {
          json(response, 404, { ok: false, error: '作者不存在' });
          return;
        }
        json(response, 200, { ok: true, author });
      },
    },
  ];
}
