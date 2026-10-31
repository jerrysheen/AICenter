import { z } from 'zod';

const decimal = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/);
const quoteDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const epoch = z.number().int().nonnegative();
const label = z.string().trim().min(1).max(200);

export const InferenceConditionSchema = z.object({
  model: label,
  hardware: label,
  framework: label,
  precision: label,
  isl: z.number().finite().nonnegative(),
  osl: z.number().finite().nonnegative(),
  disagg: z.boolean(),
  specMethod: label,
  benchmarkType: label,
  date: quoteDate,
  sourceUrl: z.string().url().max(2048),
}).strict();

export const InferenceAvailabilityRowSchema = InferenceConditionSchema;

export const InferenceBenchmarkRowSchema = InferenceConditionSchema.extend({
  tokensPerSecondPerGpu: decimal.nullable(),
  citationEligible: z.literal(true),
  investmentUse: z.literal('not_a_conclusion'),
}).strict();

export const InferenceCheckSchema = z.object({
  sourceKey: z.enum(['availability', 'benchmarks']),
  quoteDate,
  lastCheckedAt: epoch,
  lastChangedAt: epoch,
  status: z.enum(['ready', 'unchanged', 'empty', 'rejected']),
  note: z.string().max(500),
}).strict();

export const InferenceBoardSchema = z.object({
  note: z.string().max(500),
  availability: z.array(InferenceAvailabilityRowSchema).max(800),
  benchmarks: z.array(InferenceBenchmarkRowSchema).max(800),
  checks: z.array(InferenceCheckSchema).max(8),
}).strict();

export const INFERENCE_BOARD_NOTE = '只读跑分条件。缺条件的观测不入库。tokens/s 不是投资结论。';
