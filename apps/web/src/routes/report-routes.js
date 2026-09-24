import {
  DailyReportDateQuerySchema,
  GenerateDailyBriefRequestSchema,
  GenerateDailyReportRequestSchema,
  parseContract,
} from '../../../../packages/contracts/src/index.js';
import { json, readJson } from '../http/response.js';

export function createReportRoutes() {
  return [
    {
      method: 'GET',
      path: '/api/v1/reports/daily/latest',
      handler({ response, services }) {
        json(response, 200, { ok: true, report: services.report.getLatestDailyReport('local') });
      },
    },
    {
      method: 'GET',
      path: '/api/v1/reports/daily',
      handler({ response, services, url }) {
        const query = parseContract(DailyReportDateQuerySchema, {
          date: url.searchParams.get('date') || '',
        });
        json(response, 200, { ok: true, report: services.report.getDailyReport('local', query.date) });
      },
    },
    {
      method: 'GET',
      path: '/api/v1/reports/daily/latest/brief',
      handler({ response, services }) {
        json(response, 200, { ok: true, brief: services.report.getLatestDailyBrief('local') });
      },
    },
    {
      method: 'GET',
      path: '/api/v1/reports/daily/brief',
      handler({ response, services, url }) {
        const query = parseContract(DailyReportDateQuerySchema, {
          date: url.searchParams.get('date') || '',
        });
        json(response, 200, { ok: true, brief: services.report.getDailyBrief('local', query.date) });
      },
    },
    {
      method: 'POST',
      path: '/api/v1/reports/daily/brief/generate',
      access: 'desktop',
      async handler({ request, response, services }) {
        const body = parseContract(GenerateDailyBriefRequestSchema, await readJson(request));
        const report = body.date
          ? services.report.getDailyReport('local', body.date)
          : services.report.getLatestDailyReport('local');
        if (!report) {
          json(response, 404, { ok: false, error: '日报不存在' });
          return;
        }
        const job = services.runtime.requestDailyBrief({ reportId: report.id });
        json(response, 202, { ok: true, job });
      },
    },
    {
      method: 'POST',
      path: '/api/v1/reports/daily/generate',
      access: 'desktop',
      async handler({ request, response, services }) {
        const body = parseContract(GenerateDailyReportRequestSchema, await readJson(request));
        const job = services.runtime.requestDailyReport({ reportDate: body.date });
        json(response, 202, { ok: true, job });
      },
    },
  ];
}
