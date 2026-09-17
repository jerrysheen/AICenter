import { z } from 'zod';
import { EntityIdSchema, EpochMillisSchema, WorkspaceIdSchema } from './common.js';

export const TaxonomyDimensionSchema = z.enum([
  'domain',
  'topic',
  'industry',
  'market',
  'asset-class',
  'lens',
  'platform',
  'project',
]);

export const TaxonomyKeySchema = z.string().trim().min(3).max(160)
  .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/, 'taxonomy key 格式不正确')
  .refine((key) => TaxonomyDimensionSchema.options.includes(key.split('.')[0]), 'taxonomy key 必须以合法 dimension 开头');

export const InspirationTypeSchema = z.enum(['observation', 'hypothesis', 'question', 'idea']);
export const KnowledgeTypeSchema = z.enum(['fact', 'mechanism', 'thesis', 'framework', 'case', 'procedure']);
export const StructuredArtifactTargetSchema = z.enum(['inspiration', 'knowledge']);
export const TaxonomyResourceTypeSchema = z.enum(['inspiration', 'knowledge']);
export const TaxonomyAssignedBySchema = z.enum(['ai', 'user', 'system']);
export const TaxonomyProposalStatusSchema = z.enum(['pending', 'accepted', 'rejected']);

export const TaxonomyNodeSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  key: TaxonomyKeySchema,
  dimension: TaxonomyDimensionSchema,
  name: z.string().trim().min(1).max(80),
  parentKey: TaxonomyKeySchema.nullable(),
  description: z.string().max(500).default(''),
  status: z.enum(['active', 'disabled']).default('active'),
  createdBy: z.enum(['system', 'user']).default('system'),
  sortOrder: z.number().int(),
  createdAt: EpochMillisSchema,
  updatedAt: EpochMillisSchema,
}).strict();

export const TaxonomyCatalogNodeSchema = z.object({
  key: TaxonomyKeySchema,
  name: z.string().trim().min(1).max(80),
  parentKey: TaxonomyKeySchema.nullable(),
  description: z.string().max(500).default(''),
  sortOrder: z.number().int().nonnegative(),
}).strict();

export const TaxonomyCatalogSchema = z.object({
  version: z.literal(1),
  nodes: z.array(TaxonomyCatalogNodeSchema).max(5_000),
}).strict().superRefine((catalog, ctx) => {
  const keys = new Set();
  for (const [index, node] of catalog.nodes.entries()) {
    if (keys.has(node.key)) {
      ctx.addIssue({ code: 'custom', path: ['nodes', index, 'key'], message: 'taxonomy key 不能重复' });
    }
    keys.add(node.key);
  }
  for (const [index, node] of catalog.nodes.entries()) {
    if (node.parentKey && !keys.has(node.parentKey)) {
      ctx.addIssue({ code: 'custom', path: ['nodes', index, 'parentKey'], message: 'taxonomy parentKey 不存在' });
    }
    if (node.parentKey && node.parentKey.split('.')[0] !== node.key.split('.')[0]) {
      ctx.addIssue({ code: 'custom', path: ['nodes', index, 'parentKey'], message: 'taxonomy 父子节点必须属于同一 dimension' });
    }
  }
});

export const TaxonomyAssignmentSchema = z.object({
  key: TaxonomyKeySchema,
  primary: z.boolean().default(false),
  confidence: z.number().min(0).max(1).nullable().default(null),
}).strict();

export const TaxonomyProposalSchema = z.object({
  dimension: TaxonomyDimensionSchema,
  key: TaxonomyKeySchema,
  name: z.string().trim().min(1).max(80),
  parentKey: TaxonomyKeySchema,
  reason: z.string().trim().min(1).max(500),
}).strict();

export const StructuredArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  target: StructuredArtifactTargetSchema,
  title: z.string().trim().min(1).max(200),
  contentType: z.string().trim().min(1).max(32),
  bodyMarkdown: z.string().trim().min(1).max(80_000),
  taxonomy: z.array(TaxonomyAssignmentSchema).max(16).default([]),
  taxonomyProposals: z.array(TaxonomyProposalSchema).max(1).default([]),
}).strict().superRefine((value, ctx) => {
  const allowed = value.target === 'inspiration' ? InspirationTypeSchema.options : KnowledgeTypeSchema.options;
  if (!allowed.includes(value.contentType)) {
    ctx.addIssue({ code: 'custom', path: ['contentType'], message: 'contentType 与 target 不匹配' });
  }
  const seenPrimary = new Set();
  for (const item of value.taxonomy) {
    const dimension = item.key.split('.')[0];
    if (!item.primary) continue;
    if (seenPrimary.has(dimension)) {
      ctx.addIssue({ code: 'custom', path: ['taxonomy'], message: '同一 dimension 只能有一个 primary' });
      return;
    }
    seenPrimary.add(dimension);
  }
});

export const StructureJobInputSchema = z.object({
  target: StructuredArtifactTargetSchema,
  workspaceId: WorkspaceIdSchema,
  sourceRunId: EntityIdSchema,
  instruction: z.string().trim().max(2_000).default(''),
}).strict();

export const StructureJobTaxonomyViewSchema = z.object({
  key: TaxonomyKeySchema,
  name: z.string().trim().min(1).max(80),
  parentName: z.string().trim().max(80).nullable(),
  dimension: TaxonomyDimensionSchema,
  primary: z.boolean(),
}).strict();

export const StructureJobOutputSchema = z.object({
  resourceType: TaxonomyResourceTypeSchema,
  resourceId: EntityIdSchema,
  title: z.string().trim().min(1).max(200),
  contentType: z.string().trim().min(1).max(32),
  taxonomy: z.array(StructureJobTaxonomyViewSchema).max(16).default([]),
  proposalCount: z.number().int().nonnegative().default(0),
}).strict();

export const SaveStructuredArtifactInputSchema = z.object({
  target: StructuredArtifactTargetSchema,
  title: z.string().trim().min(1).max(200),
  contentType: z.string().trim().min(1).max(32),
  bodyMarkdown: z.string().trim().min(1).max(80_000),
  taxonomy: z.array(TaxonomyAssignmentSchema).max(16).default([]),
  taxonomyProposals: z.array(TaxonomyProposalSchema).max(1).default([]),
}).strict();
