import { parseBuildContextInput } from '../../../../packages/contracts/src/index.js';
import { json, readJson } from '../http/response.js';

export function createContextRoutes() {
  return [{
    method: 'POST', path: '/api/v1/context',
    async handler({ request, response, services, identity }) {
      const input = parseBuildContextInput(await readJson(request));
      const workspaceId = identity?.device?.workspaceId || input.workspaceId;
      const context = await services.context.build({ ...input, workspaceId });
      json(response, 200, { ok: true, context });
    },
  }];
}
