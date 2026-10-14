import { clientTimingAllowed, createClientErrorGate, formatClientErrorLine, projectClientError, projectClientTiming, readAccessSummary } from '../http/access-log.js';
import { readDeployStatus } from '../http/deploy-status.js';
import { json, readJson } from '../http/response.js';

export function createRuntimeRoutes() {
  const allowClientError = createClientErrorGate();
  return [
    {
      method: 'GET', path: '/api/v1/runtime/access-summary',
      async handler({ request, response, authorizeDeviceCookie, accessLogDirectory, url }) {
        const device = authorizeDeviceCookie?.(request);
        if (!device) {
          json(response, 401, { ok: false, error: '此设备尚未配对' });
          return;
        }
        const summary = await readAccessSummary(accessLogDirectory, {
          date: url.searchParams.get('date') || '',
          since: url.searchParams.get('since') || '',
          top: url.searchParams.get('top') || '',
        });
        json(response, summary.ok ? 200 : 400, summary);
      },
    },
    {
      method: 'POST', path: '/api/v1/runtime/client-error',
      async handler({ request, response, identity }) {
        const key = identity?.deviceId || identity?.device?.id || identity?.kind || 'device';
        if (!allowClientError(key)) {
          response.writeHead(429, { 'Retry-After': '60' });
          response.end();
          return;
        }
        let body;
        try {
          body = await readJson(request, { maxBytes: 2048 });
        } catch {
          json(response, 400, { ok: false, error: '内容无效' });
          return;
        }
        const record = projectClientError(body);
        if (!record) {
          json(response, 400, { ok: false, error: '内容无效' });
          return;
        }
        console.log(formatClientErrorLine(record));
        response.writeHead(204);
        response.end();
      },
    },
    {
      method: 'POST', path: '/api/v1/runtime/client-timing', access: 'public',
      async handler({ request, response, accessLog }) {
        if (!clientTimingAllowed(request)) {
          response.writeHead(204);
          response.end();
          return;
        }
        let body;
        try {
          body = await readJson(request, { maxBytes: 4096 });
        } catch {
          json(response, 400, { ok: false, error: '计时内容无效' });
          return;
        }
        const record = projectClientTiming(body, request, { salt: accessLog?.salt || '', now: Date.now() });
        if (!record) {
          json(response, 400, { ok: false, error: '计时内容无效' });
          return;
        }
        if (accessLog?.acceptClientSample?.()) accessLog.writeClientTiming(record);
        response.writeHead(204);
        response.end();
      },
    },
    {
      method: 'GET', path: '/api/v1/runtime/deploy-status',
      handler({ request, response, authorizeDeviceCookie, deployStatusPath }) {
        const device = authorizeDeviceCookie?.(request);
        if (!device) {
          json(response, 401, { ok: false, error: '此设备尚未配对' });
          return;
        }
        json(response, 200, readDeployStatus(deployStatusPath));
      },
    },
    {
      method: 'GET', path: '/api/v1/runtime/model-usage', access: 'desktop',
      forbidden: '模型用量仅在本机显示',
      handler({ response, services, url }) {
        json(response, 200, { ok: true, records: services.modelUsage.list(Object.fromEntries(url.searchParams)) });
      },
    },
    {
      method: 'GET', path: '/api/v1/runtime', access: 'desktop',
      forbidden: '运行状态仅在本机显示',
      handler({ response, services }) {
        json(response, 200, { ok: true, runtime: services.runtime.getStatus() });
      },
    },
    {
      method: 'POST', path: '/api/v1/runtime/healthcheck', access: 'desktop',
      forbidden: '运行检查仅允许在本机发起',
      handler({ response, services, events }) {
        const job = services.runtime.requestHealthcheck();
        events.flush();
        json(response, 202, { ok: true, job });
      },
    },
    {
      method: 'GET', path: '/api/v1/runtime/jobs', access: 'desktop',
      forbidden: '任务状态仅在本机显示',
      handler({ response, services, url }) {
        json(response, 200, {
          ok: true,
          jobs: services.runtime.listJobs(Number(url.searchParams.get('limit') || 50)),
        });
      },
    },
    {
      method: 'POST', path: '/api/v1/runtime/restart',
      handler({ response, services }) {
        const restart = services.runtime.requestProcessRestart({ reason: 'manual' });
        json(response, 202, { ok: true, restart });
      },
    },
  ];
}
