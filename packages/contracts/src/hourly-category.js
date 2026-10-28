import { z } from 'zod';
import { EntityIdSchema, EpochMillisSchema } from './common.js';

export const HOURLY_CATEGORY_FORMAT = 'hourly-category-v1';
export const UNTAGGED_CATEGORY_ID = '__untagged__';
export const HOURLY_CATEGORY_EVENT_MAX = 80;

export const HourlyCategoryIdSchema = z.string().trim().min(1).max(64)
  .regex(/^(?:[a-z][a-z0-9_]*|__untagged__)$/);

export const HourlyCategoryEventSchema = z.object({
  bullet: z.string().trim().min(1).max(400),
  sourceIds: z.array(z.string().trim().min(1).max(200)).min(1).max(40),
}).strict();

export const HourlyCategoryBlockSchema = z.object({
  id: HourlyCategoryIdSchema,
  label: z.string().trim().min(1).max(40),
  events: z.array(HourlyCategoryEventSchema).max(HOURLY_CATEGORY_EVENT_MAX),
  inputCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  model: z.string().max(80),
  promptHash: z.string().length(64),
  generatedAt: EpochMillisSchema,
  status: z.enum(['ready', 'failed']),
  error: z.string().max(200).optional(),
}).strict();

export const HourlyCategoryEditionSchema = z.object({
  formatVersion: z.literal(HOURLY_CATEGORY_FORMAT),
  id: z.string().trim().min(1).max(80),
  workspaceId: EntityIdSchema,
  window: z.object({
    startAt: EpochMillisSchema,
    endAt: EpochMillisSchema,
  }).strict(),
  status: z.enum(['ready', 'partial', 'failed', 'empty']),
  dualRun: z.literal(true),
  untaggedCount: z.number().int().nonnegative(),
  categories: z.array(HourlyCategoryBlockSchema).max(80),
  generatedAt: EpochMillisSchema,
}).strict();
