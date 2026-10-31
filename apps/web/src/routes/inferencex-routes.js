import { json } from '../http/response.js';

const workspace = (identity) => identity?.device?.workspaceId || 'local';

export function createInferencexRoutes() {
  return [
    {
      method: 'GET',
      path: '/api/v1/inferencex',
      handler({ response, services, identity }) {
        if (!services.inferencex) {
          json(response, 503, { ok: false, error: 'InferenceX 尚未就绪' });
          return;
        }
        json(response, 200, { ok: true, ...services.inferencex.list(workspace(identity)) });
      },
    },
  ];
}
