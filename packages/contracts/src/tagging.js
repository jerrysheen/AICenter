import { z } from 'zod';
import { EntityIdSchema, EpochMillisSchema, WorkspaceIdSchema } from './common.js';

export const TagIdSchema = z.string().trim().min(1).max(64)
  .regex(/^[a-z][a-z0-9_]*$/, 'tag id 必须是小写字母、数字或下划线');

export const TagResourceTypeSchema = z.enum(['content-item', 'inspiration', 'knowledge', 'media-index']);
export const TagSelectionModeSchema = z.enum(['multi', 'single']);

export const TagDefinitionSchema = z.object({
  id: TagIdSchema,
  name: z.string().trim().min(1).max(40),
  level: z.number().int().min(1).max(8).optional(),
  parent_id: TagIdSchema.nullable().optional(),
  keywords: z.array(z.string().trim().min(1).max(64)).max(24).default([]),
  description:z.string().max(300).optional(),
}).strict();

export const TagCatalogFileSchema = z.object({
  version: z.string().trim().min(1).max(64),
  tags: z.array(TagDefinitionSchema).min(1).max(500),
  reading:z.object({version:z.string().min(1).max(64),groupByTag:z.record(TagIdSchema,TagIdSchema),primaryLocks:z.record(z.string(),TagIdSchema.nullable()).default({}),
    directionByTag:z.record(TagIdSchema,z.enum(['finance','policy','tech','other'])).optional(),
    reclassification:z.object({fromVersion:z.string().length(64),keywords:z.array(z.string().min(1)).min(1)}).optional()}).optional(),
}).strict();

export const TagCatalogProjectionSchema = z.object({
  id: TagIdSchema,
  name: z.string().trim().min(1).max(40),
  parent_id: TagIdSchema.nullable(),
  keywords: z.array(z.string().trim().min(1).max(64)).max(24),
  description: z.string().max(300).optional(),
}).strict();

export const TagTextItemSchema = z.object({
  id: EntityIdSchema,
  text: z.string().trim().min(1).max(20_000).optional(),
  title: z.string().max(1_000).optional(),
  summary: z.string().max(20_000).optional(),
  body: z.string().max(2_000_000).optional(),
  source: z.string().trim().max(32).optional(),
  author: z.string().trim().max(512).optional(),
}).strict();

export const ResourceTaggingSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  resourceType: TagResourceTypeSchema,
  resourceId: EntityIdSchema,
  tags: z.array(TagIdSchema).max(64),
  tagCatalogVersion: z.string().trim().min(1).max(64),
  promptVersion: z.string().trim().min(1).max(64),
  model: z.string().trim().max(64).default(''),
  truncatedForModel: z.boolean().default(false),
  analyzedAt: EpochMillisSchema,
}).strict();

export const SaveResourceTaggingInputSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  resourceType: TagResourceTypeSchema,
  resourceId: EntityIdSchema,
  tags: z.array(TagIdSchema).max(64),
  tagCatalogVersion: z.string().trim().min(1).max(64),
  promptVersion: z.string().trim().min(1).max(64),
  model: z.string().trim().max(64).default(''),
  truncatedForModel: z.boolean().default(false),
  analyzedAt: EpochMillisSchema.optional(),
}).strict();

export const TagAnalyzeJobInputSchema = z.object({
  workspaceId: WorkspaceIdSchema.default('local'),
  resourceType: TagResourceTypeSchema.default('content-item'),
  resourceIds: z.array(EntityIdSchema).max(500).default([]),
  force: z.boolean().default(false),
  limit: z.number().int().min(1).max(500).default(200),
}).strict();
