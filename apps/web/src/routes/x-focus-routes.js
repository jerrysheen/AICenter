import { z } from 'zod';
import { parseContract } from '../../../../packages/contracts/src/errors.js';
import { json, readJson } from '../http/response.js';

const PageSwitchSchema = z.object({ enabled: z.boolean() }).strict();

export function createXFocusRoutes() {
  return [
    { method: 'GET', path: '/api/v1/feed/x-focus',
      handler({ response, services, identity }) {
        const view = services.xFocus?.view(identity?.device?.workspaceId || 'local');
        json(response, view ? 200 : 404, view ? { ok: true, ...view } : { ok: false, error: '推荐记录还没有准备好' });
      } },
    { method: 'POST', path: '/api/v1/feed/x-focus/auto-like', access: 'operator',
      async handler({ request, response, services, identity }) {
        const body = parseContract(PageSwitchSchema, await readJson(request));
        if (!services.xFocus) {
          json(response, 404, { ok: false, error: '推荐记录还没有准备好' });
          return;
        }
        const settings = services.xFocus.setPageEnabled(identity?.device?.workspaceId || 'local', body.enabled);
        json(response, 200, { ok: true, pageOn: settings.pageEnabled && !settings.suspended });
      } },
  ];
}
