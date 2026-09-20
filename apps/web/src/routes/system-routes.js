import { json } from '../http/response.js';

async function uiRevisionPayload(uiAssets) {
  return {
    revision: uiAssets?.getRevision ? await uiAssets.getRevision() : '',
    generatedAt: Date.now(),
  };
}

export function createSystemRoutes() {
  return [{
    method: 'GET',
    path: '/api/v1/health',
    access: 'public',
    async handler({ response, appInfo, publicRequest, uiAssets }) {
      const ui = await uiRevisionPayload(uiAssets);
      json(response, 200, {
        ok: true,
        service: 'ai-center',
        version: appInfo.version,
        serverName: publicRequest ? 'AI Center' : appInfo.serverName,
        now: ui.generatedAt,
        uiRevision: ui.revision,
      });
    },
  }, {
    method: 'GET',
    path: '/api/v1/ui/revision',
    access: 'public',
    async handler({ response, uiAssets }) {
      const ui = await uiRevisionPayload(uiAssets);
      json(response, 200, {
        ok: true,
        revision: ui.revision,
        generatedAt: ui.generatedAt,
      });
    },
  }];
}
