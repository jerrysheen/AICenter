import { z } from 'zod';
import { EntityIdSchema, EpochMillisSchema, HttpUrlSchema, MetadataSchema, WorkspaceIdSchema } from './common.js';
import { ReferenceInputSchema } from './agent.js';
import { InspirationTypeSchema, KnowledgeTypeSchema } from './taxonomy.js';

const InspirationSourceUrlSchema = z.preprocess(
  (value) => typeof value === 'string' ? value.trim() : value,
  HttpUrlSchema.refine((value) => value.length <= 2048, '来源链接不能超过 2048 个字符'),
);

export const InspirationSchema = z.object({
  id: EntityIdSchema,
  workspaceId: WorkspaceIdSchema,
  title: z.string().max(200).default(''),
  body: z.string().trim().min(1).max(100_000),
  inspirationType: z.union([InspirationTypeSchema, z.literal('')]).default(''),
  status: z.enum(['inbox', 'processing', 'promoted', 'archived']),
  pinned: z.boolean(),
  sourceType: z.string().max(64).default(''),
  sourceId: z.string().max(256).default(''),
  sourceUrl: InspirationSourceUrlSchema.default(''),
  sourceTitle: z.string().max(500).default(''),
  captureChannel: z.enum(['web', 'harmony-share', 'harmony-local', 'feed', 'agent', 'import']).default('web'),
  sourceApp: z.string().max(200).default(''),
  clientMutationId: z.string().max(128).default(''),
  capturedAt: EpochMillisSchema,
  createdAt: EpochMillisSchema,
  updatedAt: EpochMillisSchema,
  archivedAt: EpochMillisSchema.nullable(),
}).strict();

export const CreateInspirationInputSchema = z.object({
  title: z.string().trim().max(200).default(''),
  body: z.string().trim().min(1).max(100_000),
  inspirationType: z.union([InspirationTypeSchema, z.literal('')]).default(''),
  wantAi: z.boolean().default(false),
  sourceType: z.string().trim().max(64).default(''),
  sourceId: z.string().trim().max(256).default(''),
  sourceUrl: InspirationSourceUrlSchema.default(''),
  sourceTitle: z.string().trim().max(500).default(''),
  captureChannel: z.enum(['web', 'harmony-share', 'harmony-local', 'feed', 'agent', 'import']).default('web'),
  sourceApp: z.string().trim().max(200).default(''),
  clientMutationId: z.string().trim().max(128).default(''),
  capturedAt: EpochMillisSchema.optional(),
}).strict();

export const AiSessionKindSchema = z.enum(['question-answer', 'inspiration']);

export const AiSessionSchema = z.object({
  id: EntityIdSchema,
  workspaceId: WorkspaceIdSchema,
  kind: AiSessionKindSchema,
  title: z.string().trim().min(1).max(200),
  preview: z.string().max(2_000),
  sourceType: z.string().max(64),
  sourceId: z.string().max(128),
  runCount: z.number().int().nonnegative(),
  createdAt: EpochMillisSchema,
  updatedAt: EpochMillisSchema,
}).strict();

export const AiSessionExchangeSchema = z.object({
  id: EntityIdSchema,
  question: z.string(),
  answer: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
  providerId: z.string().max(128),
  modelId: z.string().max(128),
  createdAt: EpochMillisSchema,
  completedAt: EpochMillisSchema.nullable(),
}).strict();

export const AiRunSchema = z.object({
  id: EntityIdSchema,
  workspaceId: WorkspaceIdSchema,
  sessionId: EntityIdSchema.or(z.literal('')),
  sourceType: z.string().trim().min(1).max(64),
  sourceId: EntityIdSchema,
  taskType: z.string().trim().min(1).max(128),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
  providerId: z.string().max(128),
  modelId: z.string().max(128),
  inputHash: z.string().max(128),
  inputText: z.string(),
  outputText: z.string(),
  output: z.unknown().nullable(),
  error: z.unknown().nullable(),
  createdAt: EpochMillisSchema,
  completedAt: EpochMillisSchema.nullable(),
}).strict();

export const KnowledgeDocumentSchema = z.object({
  id: EntityIdSchema,
  workspaceId: WorkspaceIdSchema,
  title: z.string().trim().min(1).max(1_000),
  knowledgeType: z.union([KnowledgeTypeSchema, z.literal('')]).default(''),
  currentRevision: z.number().int().positive(),
  status: z.enum(['draft', 'active', 'archived']),
  metadata: MetadataSchema,
  createdAt: EpochMillisSchema,
  updatedAt: EpochMillisSchema,
}).strict();

export const KnowledgeRevisionSchema = z.object({
  id: EntityIdSchema,
  knowledgeId: EntityIdSchema,
  revision: z.number().int().positive(),
  title: z.string().trim().min(1).max(1_000),
  body: z.string().max(2_000_000),
  createdByType: z.enum(['user', 'agent', 'import']),
  createdById: EntityIdSchema.nullable(),
  createdAt: EpochMillisSchema,
}).strict();

export const CreateKnowledgeRevisionInputSchema = KnowledgeRevisionSchema.omit({
  id: true,
  revision: true,
  createdAt: true,
}).extend({ id: EntityIdSchema.optional() }).strict();

export const CreateKnowledgeDocumentInputSchema = z.object({
  id: EntityIdSchema.optional(),
  workspaceId: WorkspaceIdSchema,
  title: z.string().trim().min(1).max(1_000),
  body: z.string().max(2_000_000),
  createdByType: z.enum(['user', 'agent', 'import']),
  createdById: EntityIdSchema.nullable().default(null),
  knowledgeType: z.union([KnowledgeTypeSchema, z.literal('')]).default(''),
  source: z.string().trim().min(1).max(64).optional(),
  sourceNoteId: EntityIdSchema.nullable().optional(),
  metadata: MetadataSchema,
}).strict();

export const CreateInspirationFromRunInputSchema = z.object({
  runId: EntityIdSchema,
  instruction: z.string().trim().max(2_000).default(''),
  body: z.string().trim().max(4_000).optional(),
}).strict();

export const CreateKnowledgeFromRunInputSchema = z.object({
  runId: EntityIdSchema,
  instruction: z.string().trim().max(2_000).default(''),
}).strict();

export const CreateKnowledgeFromUserInputSchema = z.object({
  title: z.string().trim().min(1).max(1_000),
  body: z.string().trim().min(1).max(2_000_000),
  sourceRefs: z.array(ReferenceInputSchema).max(8).default([]),
}).strict();

export const KnowledgeMentionQuerySchema = z.object({
  q: z.string().trim().max(200).default(''),
  limit: z.number().int().min(1).max(20).default(8),
}).strict();

export const KnowledgeMentionSchema = z.object({
  resourceType: z.literal('knowledge-revision'),
  resourceId: z.string().trim().min(1).max(256),
  revision: z.number().int().positive().nullable(),
  label: z.string().trim().min(1).max(200),
  kind: z.string().trim().min(1).max(64),
  preview: z.string().trim().max(400),
}).strict();
