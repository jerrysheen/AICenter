import {
  InvestorDiscussionDateSchema,
  InvestorDiscussionGenerateRequestSchema,
  parseContract,
} from '../../../../packages/contracts/src/index.js';
import { json, readJson } from '../http/response.js';

export function createInvestorDiscussionRoutes() {
  return [
    {
      method: 'GET',
      path: '/api/v1/investor-discussion',
      handler({ response, services, url }) {
        const raw = url.searchParams.get('date') || '';
        const date = raw ? parseContract(InvestorDiscussionDateSchema, raw) : undefined;
        const result = date
          ? services.investorDiscussion.latest('local', date)
          : services.investorDiscussion.latest('local');
        json(response, 200, { ok: true, ...result });
      },
    },
    {
      method: 'POST',
      path: '/api/v1/investor-discussion',
      access: 'desktop',
      forbidden: '生成股民讨论日摘只在本机开放',
      async handler({ request, response, services }) {
        const body = parseContract(InvestorDiscussionGenerateRequestSchema, await readJson(request));
        const job = services.runtime.requestInvestorDiscussion({
          digestDate: body.date,
          retryFailed: body.retryFailed === true,
        });
        json(response, 202, { ok: true, jobId: job.id, status: job.status, date: body.date || null });
      },
    },
  ];
}
