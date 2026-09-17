import { z } from 'zod';
import { EntityIdSchema, EpochMillisSchema, WorkspaceIdSchema } from './common.js';

export const ContextReferenceSchema = z.object({
  resourceType: z.enum(['knowledge-revision', 'content-item', 'holdings-board']),
  resourceId: z.string().trim().min(1).max(256),
  revision: z.number().int().positive().nullable(),
  asOf: EpochMillisSchema.nullable(),
  label: z.string().trim().min(1).max(1_000),
}).strict();

export const BuildContextInputSchema = z.object({
  workspaceId: WorkspaceIdSchema.default('local'),
  query: z.string().trim().min(1).max(4_000),
  includeRecentFeed: z.boolean().optional(),
  includeTrading: z.boolean().optional(),
  limit: z.number().int().min(1).max(20).default(8),
}).strict();

export const AiRunContextRefSchema = z.object({
  id: EntityIdSchema,
  runId: EntityIdSchema,
  workspaceId: WorkspaceIdSchema,
  resourceType: z.string().trim().min(1).max(64),
  resourceId: z.string().trim().min(1).max(256),
  revision: z.number().int().positive().nullable(),
  asOf: EpochMillisSchema.nullable(),
  origin: z.enum(['selected', 'tool']).default('tool'),
  label: z.string().max(1_000).default(''),
  createdAt: EpochMillisSchema,
}).strict();
