import { CreateApiTokenInputSchema, parseContract } from '../../../../packages/contracts/src/index.js';
import { json, readJson } from '../http/response.js';

function actor(identity) {
  return {
    workspaceId: identity?.device?.workspaceId || 'local',
    deviceId: identity?.kind === 'device' ? identity.device?.id || null : null,
  };
}

export function createApiTokenRoutes() {
  return [
    {
      method: 'GET',
      path: '/api/v1/api-tokens',
      access: 'operator',
      handler({ response, services, identity }) {
        const { workspaceId } = actor(identity);
        json(response, 200, { ok: true, tokens: services.apiTokens.list(workspaceId) });
      },
    },
    {
      method: 'POST',
      path: '/api/v1/api-tokens',
      access: 'operator',
      async handler({ request, response, services, identity }) {
        const body = parseContract(CreateApiTokenInputSchema, await readJson(request));
        const { workspaceId, deviceId } = actor(identity);
        const issued = services.apiTokens.issue({ name: body.name, workspaceId, deviceId });
        json(response, 201, { ok: true, token: issued.token, secret: issued.secret });
      },
    },
    {
      method: 'DELETE',
      path: /^\/api\/v1\/api-tokens\/([0-9a-f-]{36})$/i,
      access: 'operator',
      handler({ response, services, params }) {
        const revoked = services.apiTokens.revoke(params.values[0]);
        json(response, revoked ? 200 : 404, {
          ok: revoked,
          error: revoked ? undefined : '令牌不存在或已撤销',
        });
      },
    },
  ];
}
