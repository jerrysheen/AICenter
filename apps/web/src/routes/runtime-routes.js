import { json } from '../http/response.js';

export function createRuntimeRoutes() {
  return [
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
