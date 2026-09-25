import { createReadStream } from 'node:fs';
import { parseContract, QuantDayQuerySchema, QuantRunOptionsSchema } from '../../../../packages/contracts/src/index.js';
import { json, readJson } from '../http/response.js';

export function createQuantRoutes() {
  return [
    {
      method: 'GET',
      path: '/api/v1/quant/lab',
      access: 'desktop',
      handler({ response, services }) {
        json(response, 200, { ok: true, lab: services.quant.list() });
      },
    },
    {
      method: 'POST',
      path: '/api/v1/quant/prepare',
      access: 'desktop',
      async handler({ response, services }) {
        const job = services.runtime.requestQuantPrepare();
        json(response, 202, { ok: true, jobId: job.id, status: job.status });
      },
    },
    {
      method: 'POST',
      path: '/api/v1/quant/experiments',
      access: 'desktop',
      async handler({ request, response, services }) {
        const body = await readJson(request);
        const options = parseContract(QuantRunOptionsSchema, {
          topk: body.topk == null || body.topk === '' ? 5 : Number(body.topk),
          nDrop: body.nDrop == null || body.nDrop === '' ? 1 : Number(body.nDrop),
        });
        const job = services.runtime.requestQuantRun(options);
        json(response, 202, {
          ok: true,
          jobId: job.id,
          experimentId: job.input.experimentId,
          status: job.status,
        });
      },
    },
    {
      method: 'GET',
      path: /^\/api\/v1\/quant\/experiments\/([0-9a-f-]{36})\/days\/(\d{4}-\d{2}-\d{2})$/i,
      access: 'desktop',
      handler({ response, services, params }) {
        const query = parseContract(QuantDayQuerySchema, { date: params.values[1] });
        const day = services.quant.day(params.values[0], query.date);
        if (!day) {
          json(response, 404, { ok: false, error: '找不到这个实验' });
          return;
        }
        json(response, 200, { ok: true, day });
      },
    },
    {
      method: 'GET',
      path: /^\/api\/v1\/quant\/experiments\/([0-9a-f-]{36})\/report$/i,
      access: 'desktop',
      handler({ response, services, params }) {
        const file = services.quant.reportPath(params.values[0]);
        if (!file) {
          json(response, 404, { ok: false, error: '这份实验还没有报告' });
          return;
        }
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        createReadStream(file).pipe(response);
      },
    },
  ];
}
