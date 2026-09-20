import { parseBehaviorEvent, parseLoginInput, parsePairInput } from '../../../../packages/contracts/src/index.js';
import { json, readJson } from '../http/response.js';

export function createIdentityRoutes() {
  return [
    {
      method: 'POST', path: '/api/v1/session/login', access: 'public',
      async handler({ request, response, services, events, cookies, pairing, publicRequest }) {
        const rateLimit = pairing.allowAttempt(request, publicRequest);
        if (!rateLimit.allowed) {
          json(response, 429, { ok: false, error: '登录尝试过于频繁，请稍后重试' }, {
            'Retry-After': String(rateLimit.retryAfterSeconds),
          });
          return;
        }
        const input = parseLoginInput(await readJson(request));
        const result = services.identity.loginWithPassword(input);
        if (result.reason === 'disabled') {
          json(response, 503, { ok: false, error: '未启用账号登录' });
          return;
        }
        if (!result.ok) {
          json(response, 401, { ok: false, error: '账号或密码不正确' });
          return;
        }
        events.flush();
        json(response, 201, { ok: true, device: result.device }, {
          'Set-Cookie': cookies.authorize(result.token, publicRequest),
        });
      },
    },
    {
      method: 'POST', path: '/api/v1/pair', access: 'public',
      async handler({ request, response, services, events, cookies, pairing, publicRequest }) {
        const rateLimit = pairing.allowAttempt(request, publicRequest);
        if (!rateLimit.allowed) {
          json(response, 429, { ok: false, error: '配对尝试过于频繁，请稍后重试' }, {
            'Retry-After': String(rateLimit.retryAfterSeconds),
          });
          return;
        }
        const input = parsePairInput(await readJson(request));
        const result = services.identity.pairDevice(input, { requireSecret: publicRequest });
        if (!result) {
          json(response, 400, { ok: false, error: '配对码无效、已使用或已过期' });
          return;
        }
        events.flush();
        json(response, 201, { ok: true, device: result.device }, {
          'Set-Cookie': cookies.authorize(result.token, publicRequest),
        });
      },
    },
    {
      method: 'GET', path: '/api/v1/session', access: 'public',
      handler({ response, identity, appInfo, services }) {
        if (!identity) {
          json(response, 401, {
            ok: false,
            paired: false,
            loginAvailable: services.identity.loginAvailable(),
            error: '此设备尚未配对',
          });
          return;
        }
        json(response, 200, {
          ok: true,
          paired: true,
          role: identity.kind,
          device: identity.device,
          serverName: appInfo.serverName,
          version: appInfo.version,
        });
      },
    },
    {
      method: 'POST', path: '/api/v1/session/logout', access: 'public',
      handler({ response, identity, services, events, cookies }) {
        let revoked = false;
        if (identity?.kind === 'device' && identity.device) {
          revoked = services.identity.revokeDevice(identity.device.id);
          events.closeDevice(identity.device.id);
          events.flush();
        }
        json(response, 200, { ok: true, revoked }, { 'Set-Cookie': cookies.clear() });
      },
    },
    {
      method: 'GET', path: '/api/v1/pairing', access: 'desktop-public',
      forbidden: '只能在本机生成配对二维码',
      async handler({ response, services, pairing }) {
        const result = services.identity.createPairingCode(pairing.ttlMinutes);
        json(response, 200, {
          ok: true,
          code: result.code,
          expiresAt: result.expiresAt,
          candidates: await pairing.candidates(result),
        });
      },
    },
    {
      method: 'POST', path: '/api/v1/behavior',
      async handler({ request, response, identity, services }) {
        const event = parseBehaviorEvent(await readJson(request));
        services.identity.recordBehavior(event, identity.device?.id || null);
        json(response, 202, { ok: true });
      },
    },
    {
      method: 'GET', path: '/api/v1/metrics', access: 'desktop',
      forbidden: '验证指标仅在本机显示',
      handler({ response, services }) {
        json(response, 200, { ok: true, metrics: services.identity.getMetrics() });
      },
    },
    {
      method: 'GET', path: '/api/v1/devices', access: 'desktop',
      forbidden: '设备管理仅在本机开放',
      handler({ response, services }) {
        json(response, 200, { ok: true, devices: services.identity.listDevices() });
      },
    },
    {
      method: 'DELETE', path: /^\/api\/v1\/devices\/([0-9a-f-]+)$/i, access: 'desktop',
      forbidden: '设备管理仅在本机开放',
      handler({ response, services, events, params }) {
        const deviceId = params.values[0];
        const revoked = services.identity.revokeDevice(deviceId);
        events.flush();
        if (revoked) events.closeDevice(deviceId);
        json(response, revoked ? 200 : 404, { ok: revoked });
      },
    },
  ];
}
