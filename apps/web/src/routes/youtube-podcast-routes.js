import { json } from '../http/response.js';

function workspaceIdFrom(identity) {
  return identity?.device?.workspaceId || 'local';
}

export function createYoutubePodcastRoutes() {
  return [
    {
      method: 'GET',
      path: '/api/v1/youtube-podcasts',
      handler({ response, services, identity }) {
        json(response, 200, { ok: true, ...services.youtubePodcasts.list(workspaceIdFrom(identity)) });
      },
    },
    {
      method: 'POST',
      path: '/api/v1/youtube-podcasts/sync',
      access: 'operator',
      handler({ response, services, identity, events }) {
        const result = services.youtubePodcasts.enqueue(workspaceIdFrom(identity));
        events?.flush?.();
        const status = result.status === 'disabled' ? 409 : 202;
        json(response, status, { ok: result.status !== 'disabled', ...result });
      },
    },
    {
      method: 'GET',
      path: /^\/api\/v1\/youtube-podcasts\/([A-Za-z0-9_-]{6,})\/article$/,
      handler({ response, services, identity, params }) {
        const article = services.youtubePodcasts.status(workspaceIdFrom(identity), params.values[0]);
        if (!article) {
          json(response, 404, { ok: false, error: '没有这一集' });
          return;
        }
        json(response, 200, { ok: true, ...article });
      },
    },
    {
      method: 'GET',
      path: /^\/api\/v1\/youtube-podcasts\/([A-Za-z0-9_-]{6,})$/,
      handler({ response, services, identity, params }) {
        const episode = services.youtubePodcasts.get(workspaceIdFrom(identity), params.values[0]);
        if (!episode) {
          json(response, 404, { ok: false, error: '没有这一集' });
          return;
        }
        json(response, 200, { ok: true, episode });
      },
    },
  ];
}
