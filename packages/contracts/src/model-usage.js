import { z } from 'zod';
export const emptyTokenUsage = () => ({ inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, totalTokens: null });
export function normalizeTokenUsage(value = {}) {
  return Object.fromEntries(Object.keys(emptyTokenUsage()).map(key => [key,
    Number.isSafeInteger(value[key]) && value[key] >= 0 ? value[key] : null]));
}
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
export const ModelTokenUsageSchema = z.object({
  inputTokens: count, outputTokens: count, cacheReadTokens: count,
  cacheWriteTokens: count, reasoningTokens: count, totalTokens: count,
}).strict();
export const ModelUsageRecordSchema = z.object({
  id: z.string().min(1).max(256), workspaceId: z.string().min(1).max(128),
  kind: z.enum(['request', 'turn']), jobId: z.string().max(256), jobAttempt: count,
  stage: z.string().max(128), applicationSessionId: z.string().max(256),
  harnessSessionId: z.string().max(256), turn: count, step: count, attempt: count,
  provider: z.string().max(128), model: z.string().max(128),
  status: z.enum(['pending', 'succeeded', 'failed', 'interrupted']),
  completeness: z.enum(['complete', 'partial', 'missing']),
  usage: ModelTokenUsageSchema, occurredAt: z.number().int().nonnegative(),
  supplierAmount: z.number().nonnegative().finite().nullable(),
  supplierCurrency: z.string().max(16).nullable(),
}).strict();
export const ModelUsageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
  jobId: z.string().max(256).optional(),
}).strict();
export const ModelUsageRateSchema = z.object({
  provider: z.string().min(1).max(128), model: z.string().min(1).max(128),
  version: z.string().min(1).max(128), currency: z.string().regex(/^[A-Z]{3,8}$/),
  inputTokens: z.number().finite().nonnegative(), outputTokens: z.number().finite().nonnegative(),
  cacheReadTokens: z.number().finite().nonnegative(), cacheWriteTokens: z.number().finite().nonnegative(),
}).strict();
export const ModelUsageSummaryQuerySchema=z.object({
  startAt:z.number().int().nonnegative().optional(),endAt:z.number().int().positive().optional(),
  jobId:z.string().min(1).max(256).optional(),stage:z.string().min(1).max(128).optional(),
}).strict().refine(v=>v.startAt===undefined || v.endAt===undefined || v.endAt>v.startAt,'用量窗口须左闭右开');
export const ModelUsageToolInputSchema=z.object({
  timeRange:z.enum(['all','today','yesterday','last-24h','last-48h']).default('all'),
  jobId:z.string().min(1).max(256).optional(),stage:z.string().min(1).max(128).optional(),
}).strict();
const summaryCount=z.number().int().nonnegative();
const tokenBucket=z.object({reported:summaryCount,unknownRequests:summaryCount}).strict();
const usageTotals=z.object({requestCount:summaryCount,statusCounts:z.object({pending:summaryCount,succeeded:summaryCount,failed:summaryCount,interrupted:summaryCount}).strict(),
  tokens:z.object(Object.fromEntries(Object.keys(emptyTokenUsage()).map(k=>[k,tokenBucket]))).strict()}).strict();
export const ModelUsageSummarySchema=usageTotals.extend({asOf:summaryCount,
  scope:z.object({workspaceId:z.string(),startAt:summaryCount.nullable(),endAt:summaryCount.nullable(),jobId:z.string().nullable(),stage:z.string().nullable()}).strict(),
  byStage:z.array(usageTotals.extend({stage:z.string()}).strict()),
}).strict();
export const ModelUsageViewSchema = ModelUsageRecordSchema.omit({ provider: true, model: true, harnessSessionId: true }).extend({
  executionId: z.string().max(256),
  estimate: z.object({ amount: z.number().finite().nonnegative(), currency: z.string(), rateVersion: z.string() }).strict().nullable(),
}).strict();
