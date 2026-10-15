import { ModelUsageQuerySchema, ModelUsageRateSchema, ModelUsageViewSchema,ModelUsageSummaryQuerySchema,ModelUsageSummarySchema,emptyTokenUsage } from '../../contracts/src/model-usage.js';
import { parseContract } from '../../contracts/src/errors.js';
export function parseModelUsageRates(value) {
  try { return ModelUsageRateSchema.array().parse(typeof value === 'string' ? JSON.parse(value) : value || []); }
  catch { return []; }
}
// Rates are explicit Instance input, never assumed current provider pricing.
export function estimateModelCost(record, rates = []) {
  if (record.completeness !== 'complete') return null;
  const rate = rates.find(rate => rate.provider === record.provider && rate.model === record.model);
  if (!rate || !rate.version || !rate.currency) return null;
  const keys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
  if (keys.some(key => !Number.isFinite(rate[key]) || rate[key] < 0)) return null;
  const usage = { ...record.usage };
  // Exact total and nonnegative buckets can prove omitted cache buckets are zero.
  // This proof affects pricing only; the reported absence remains null in the ledger.
  if (usage.inputTokens !== null && usage.outputTokens !== null && usage.totalTokens !== null) {
    const residual = usage.totalTokens - usage.inputTokens - usage.outputTokens - (usage.cacheReadTokens ?? 0) - (usage.cacheWriteTokens ?? 0);
    if (residual === 0) {
      if (usage.cacheReadTokens === null) usage.cacheReadTokens = 0;
      if (usage.cacheWriteTokens === null) usage.cacheWriteTokens = 0;
    }
  }
  if (keys.some(key => usage[key] === null)) return null;
  const amount = keys.reduce((sum, key) => sum + usage[key] * rate[key] / 1_000_000, 0);
  return Number.isFinite(amount) ? { amount, currency: rate.currency, rateVersion: rate.version } : null;
}
export function createModelUsageService({ repository, workspaceId = 'local', rates = [], getJob = null }) {
  const validatedRates = parseModelUsageRates(rates);
  return Object.freeze({
    record(value) { try { repository?.save(value); } catch { /* optional accounting */ } },
    summary(query={}) {
      const input=ModelUsageSummaryQuerySchema.parse(query),keys=Object.keys(emptyTokenUsage());
      const empty=()=>({requestCount:0,statusCounts:{pending:0,succeeded:0,failed:0,interrupted:0},tokens:Object.fromEntries(keys.map(k=>[k,{reported:0,unknownRequests:0}]))});
      const total=empty(),groups=new Map();
      for(const row of repository.summarize(workspaceId,input)){
        if(!groups.has(row.stage))groups.set(row.stage,{stage:row.stage,...empty()});
        for(const target of [total,groups.get(row.stage)]){target.requestCount+=row.requestCount;target.statusCounts[row.status]+=row.requestCount;
          for(const k of keys){target.tokens[k].reported+=row[k];target.tokens[k].unknownRequests+=row[`${k}Unknown`];}}
      }
      return ModelUsageSummarySchema.parse({...total,asOf:Date.now(),scope:{workspaceId,startAt:input.startAt ?? null,endAt:input.endAt ?? null,jobId:input.jobId ?? null,stage:input.stage ?? null},byStage:[...groups.values()]});
    },
    list(query = {}) {
      const rows = repository.list(workspaceId, parseContract(ModelUsageQuerySchema, query));
      // Provider routes are private accounting input; page contracts expose neutral request identities.
      return rows.map(({ provider, model, harnessSessionId, ...row }) => {
        const job = row.status === 'pending' && row.jobId ? getJob?.(row.jobId) : null;
        if (job && (job.status !== 'running' || job.attemptCount !== row.jobAttempt)) row.status = 'interrupted';
        return ModelUsageViewSchema.parse({ ...row,
          executionId: harnessSessionId, estimate: row.kind === 'request' ? estimateModelCost({ ...row, provider, model }, validatedRates) : null });
      });
    },
  });
}
