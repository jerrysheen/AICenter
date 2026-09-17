import { z } from 'zod';
import { EntityIdSchema, EpochMillisSchema } from './common.js';
import { SaveStructuredArtifactInputSchema, TaxonomyKeySchema } from './taxonomy.js';

export const AgentWebModeSchema = z.enum(['off', 'fallback', 'always']);

// Write tools persist through Domain Service; models still cannot pass source IDs.
export const ReferenceResourceTypeSchema = z.enum([
  'content-item',
  'post',
  'inspiration',
  'knowledge-revision',
  'ai-run',
]);

export const ReferenceInputSchema = z.object({
  resourceType: ReferenceResourceTypeSchema,
  resourceId: z.string().trim().min(1).max(256),
  revision: z.number().int().positive().optional(),
}).strict();

export const CreateAgentRunInputSchema = z.object({
  message: z.string().trim().min(1).max(4_000),
  webMode: AgentWebModeSchema.default('off'),
  sessionId: EntityIdSchema.optional(),
  references: z.array(ReferenceInputSchema).max(8).default([]),
}).strict();

export const AgentRunProgressStatusSchema = z.enum(['done', 'active', 'error']);

export const AgentRunProgressStepSchema = z.object({
  at: EpochMillisSchema,
  event: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(240),
  detail: z.string().trim().max(120).default(''),
  status: AgentRunProgressStatusSchema,
  toolId: z.string().trim().min(1).max(64).nullable(),
  round: z.number().int().nonnegative().nullable(),
}).strict();

export const AgentContextRefOriginSchema = z.enum(['selected', 'tool']);

export const AgentToolReferenceSchema = z.object({
  resourceType: z.string().trim().min(1).max(64),
  resourceId: z.string().trim().min(1).max(256),
  revision: z.number().int().positive().nullable(),
  asOf: EpochMillisSchema.nullable(),
  label: z.string().trim().min(1).max(1_000),
  origin: AgentContextRefOriginSchema.default('tool'),
}).strict();

export const AgentToolResultSchema = z.object({
  data: z.custom((value) => value !== undefined, '工具结果必须包含 data'),
  refs: z.array(AgentToolReferenceSchema).max(200),
  observedAt: EpochMillisSchema,
  warnings: z.array(z.string().trim().min(1).max(1_000)).max(100),
}).strict();

const ToolLimitSchema = z.number().int().min(1).max(20);

export const ContextBuildToolInputSchema = z.object({
  query: z.string().trim().min(1).max(4_000).optional(),
  limit: ToolLimitSchema.default(8),
}).strict();

export const FeedSearchToolInputSchema = z.object({
  query: z.string().trim().min(1).max(4_000),
  limit: ToolLimitSchema.default(8),
}).strict();

export const FeedTimeRangeSchema = z.enum(['all', 'today', 'yesterday', 'last-24h', 'last-48h']);

export const FeedTagSearchToolInputSchema = z.object({
  tag: z.string().trim().min(1).max(64),
  timeRange: FeedTimeRangeSchema.default('all'),
  platforms: z.array(z.string().trim().min(1).max(32)).max(16).default([]),
  limit: ToolLimitSchema.default(20),
}).strict();

export const KnowledgeSearchToolInputSchema = z.object({
  query: z.string().trim().max(4_000).default(''),
  taxonomy: z.array(TaxonomyKeySchema).max(8).default([]),
  limit: ToolLimitSchema.default(8),
}).strict().superRefine((value, ctx) => {
  if (!value.query && !value.taxonomy.length) {
    ctx.addIssue({ code: 'custom', path: ['query'], message: '需要检索词或 taxonomy' });
  }
});

export const KnowledgeGetToolInputSchema = z.object({
  knowledgeId: EntityIdSchema,
}).strict();

export const WebSearchToolInputSchema = z.object({
  query: z.string().trim().min(1).max(4_000),
  limit: ToolLimitSchema.default(5),
}).strict();

export const EmptyAgentToolInputSchema = z.object({}).strict();

export const SaveStructuredArtifactToolInputSchema = SaveStructuredArtifactInputSchema;

export const HoldingsRankToolInputSchema = z.object({
  metric: z.enum(['dayPnlPct', 'dayPnlCny', 'positionPnlPct', 'positionPnlCny']).default('dayPnlPct'),
  limit: ToolLimitSchema.default(5),
}).strict();
