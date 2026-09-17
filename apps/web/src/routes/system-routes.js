import { json } from '../http/response.js';

export function createSystemRoutes() {
  return [{
    method: 'GET',
    path: '/api/v1/health',
    access: 'public',
    handler({ response, appInfo, publicRequest }) {
      json(response, 200, {
        ok: true,
        service: 'ai-center',
        version: appInfo.version,
        serverName: publicRequest ? 'AI Center' : appInfo.serverName,
        now: Date.now(),
      });
    },
  }];
}
