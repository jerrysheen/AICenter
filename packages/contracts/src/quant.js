import { z } from 'zod';

export const QUANT_PREPARE_JOB_TYPE = 'quant.lab.prepare';
export const QUANT_RUN_JOB_TYPE = 'quant.lab.run';

export const QuantRunOptionsSchema = z.object({
  topk: z.number().int().min(1).max(20).default(5),
  nDrop: z.number().int().min(0).max(19).default(1),
}).strict().superRefine((value, context) => {
  if (value.nDrop >= value.topk) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['nDrop'],
      message: 'n_drop 必须小于 topk',
    });
  }
});

export const QuantRunJobInputSchema = z.object({
  experimentId: z.string().uuid(),
  topk: z.number().int().min(1).max(20),
  nDrop: z.number().int().min(0).max(19),
}).strict().superRefine((value, context) => {
  if (value.nDrop >= value.topk) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['nDrop'],
      message: 'n_drop 必须小于 topk',
    });
  }
});

export const QuantDayQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict();
