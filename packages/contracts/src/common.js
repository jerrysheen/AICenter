import { z } from 'zod';

export const EntityIdSchema = z.string().trim().min(1).max(128);
export const WorkspaceIdSchema = EntityIdSchema;
export const EpochMillisSchema = z.number().int().nonnegative();
export const NullableEpochMillisSchema = EpochMillisSchema.nullable();
export const CurrencySchema = z.string().trim().regex(/^[A-Z]{3,8}$/, '货币代码格式不正确');
export const DecimalStringSchema = z.string().trim()
  .regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/, '必须使用十进制定点字符串');
export const NonNegativeDecimalStringSchema = DecimalStringSchema.refine(
  (value) => !value.startsWith('-'),
  '数值不能为负数',
);
export const HttpUrlSchema = z.union([z.literal(''), z.url().refine(
  (value) => value.startsWith('http://') || value.startsWith('https://'),
  '只支持 http 或 https 地址',
)]);
export const MetadataSchema = z.record(z.string(), z.unknown()).default({});

export const PageRequestSchema = z.object({
  cursor: z.string().trim().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();

export const PageInfoSchema = z.object({
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
}).strict();
