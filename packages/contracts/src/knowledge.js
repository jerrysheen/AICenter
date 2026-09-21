import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EntityIdSchema, EpochMillisSchema, HttpUrlSchema, MetadataSchema, WorkspaceIdSchema } from './common.js';
import { AgentRunProgressStepSchema, ReferenceInputSchema } from './agent.js';
import { InspirationTypeSchema, KnowledgeTypeSchema } from './taxonomy.js';

export function workPackageTraceId(workPackageId) {
  const id = typeof workPackageId === 'string' ? workPackageId.trim() : '';
  return createHash('sha256').update(id).digest('hex').slice(0, 12);
}

const InspirationSourceUrlSchema = z.preprocess(
  (value) => typeof value === 'string' ? value.trim() : value,
  HttpUrlSchema.refine((value) => value.length <= 2048, '来源链接不能超过 2048 个字符'),
);

export const AttachmentMimeSchema = z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
export const AttachmentResourceTypeSchema = z.enum(['inspiration', 'work-package']);
export const AttachmentIdListSchema = z.array(EntityIdSchema).max(4);

export const AttachmentSchema = z.object({
  id: EntityIdSchema,
  mime: AttachmentMimeSchema,
  originalName: z.string().max(200).default(''),
  byteSize: z.number().int().positive().max(8 * 1024 * 1024),
  createdAt: EpochMillisSchema,
  url: z.string().trim().min(1).max(300),
}).strict();

export const CreateAttachmentInputSchema = z.object({
  mime: z.string().trim().max(64).default(''),
  originalName: z.string().trim().max(200).default(''),
  data: z.string().trim().min(1).max(16_000_000),
}).strict();

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
  attachments: z.array(AttachmentSchema).max(4).default([]),
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
  attachmentIds: AttachmentIdListSchema.default([]),
}).strict();

export const AiSessionKindSchema = z.enum(['question-answer', 'inspiration', 'article-analysis']);

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

export const WorkPackageStatusSchema = z.enum(['open', 'claimed', 'completed', 'failed', 'cancelled']);
export const RestartDecisionSchema = z.enum(['unknown', 'required', 'not_required']);

export const WorkPackageSchema = z.object({
  id: EntityIdSchema,
  workspaceId: WorkspaceIdSchema,
  inspirationId: EntityIdSchema,
  parentWorkPackageId: z.union([EntityIdSchema, z.literal('')]).default(''),
  title: z.string().max(200).default(''),
  body: z.string().trim().min(1).max(100_000),
  status: WorkPackageStatusSchema,
  restartRequired: RestartDecisionSchema,
  restartAppliedAt: EpochMillisSchema.nullable(),
  claimedBy: z.string().max(128).default(''),
  claimedAt: EpochMillisSchema.nullable(),
  claimExpiresAt: EpochMillisSchema.nullable(),
  completedAt: EpochMillisSchema.nullable(),
  resultSummary: z.string().max(2_000).default(''),
  cursorAgentId: z.string().max(200).default(''),
  cursorRunId: z.string().max(200).default(''),
  dispatchJobId: z.string().max(64).default(''),
  clientMutationId: z.string().max(128).default(''),
  createdAt: EpochMillisSchema,
  updatedAt: EpochMillisSchema,
  hashId: z.string().trim().regex(/^[0-9a-f]{12}$/).optional(),
  attachments: z.array(AttachmentSchema).max(4).default([]),
}).strict();

export const DispatchWorkPackageJobInputSchema = z.object({
  workspaceId: WorkspaceIdSchema.default('local'),
  workPackageId: EntityIdSchema,
}).strict();

export const WorkPackageTraceStepSchema = z.object({
  at: EpochMillisSchema,
  step: z.string().trim().min(1).max(64),
  status: z.enum(['started', 'done', 'failed']),
  summary: z.string().trim().max(500).default(''),
  paths: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
}).strict();

function clipProgressText(value, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function projectWorkPackageTimeline(steps = [], { live = false } = {}) {
  const rows = Array.isArray(steps) ? steps : [];
  return rows.slice(-40).map((step, index, list) => {
    const last = index === list.length - 1;
    let status = 'done';
    if (step?.status === 'failed') status = 'error';
    else if (step?.status === 'started' && live && last) status = 'active';
    const summary = clipProgressText(step?.summary, 240);
    const label = summary || clipProgressText(step?.step, 240) || 'step';
    const paths = Array.isArray(step?.paths) ? step.paths.filter(Boolean).join(', ') : '';
    const detail = summary && step?.step
      ? clipProgressText(paths || step.step, 120)
      : clipProgressText(paths, 120);
    return AgentRunProgressStepSchema.parse({
      at: Number(step?.at) || 0,
      event: `work.${String(step?.step || 'step').slice(0, 48)}`,
      label,
      detail,
      status,
      toolId: null,
      round: index,
    });
  });
}

export const WorkPackageGoalSchema = z.object({
  objective: z.string().trim().min(1).max(100_000),
  parentWorkPackageId: z.union([EntityIdSchema, z.literal('')]).default(''),
  createdAt: EpochMillisSchema,
}).strict();

export const WorkPackageProgressSchema = z.object({
  status: WorkPackageStatusSchema,
  summary: z.string().trim().max(2_000).default(''),
  updatedAt: EpochMillisSchema,
}).strict();

export const WorkPackageParentTraceSchema = z.object({
  workPackageId: EntityIdSchema,
  hashId: z.string().trim().regex(/^[0-9a-f]{12}$/),
  goal: WorkPackageGoalSchema.nullable().default(null),
  progress: WorkPackageProgressSchema.nullable().default(null),
  steps: z.array(WorkPackageTraceStepSchema).max(200).default([]),
  timeline: z.array(AgentRunProgressStepSchema).max(40).default([]),
}).strict();

export const WorkPackageTraceSchema = z.object({
  hashId: z.string().trim().regex(/^[0-9a-f]{12}$/),
  workPackageId: EntityIdSchema,
  relativeDir: z.string().max(500).default(''),
  prompt: z.string().default(''),
  goal: WorkPackageGoalSchema.nullable().default(null),
  progress: WorkPackageProgressSchema.nullable().default(null),
  steps: z.array(WorkPackageTraceStepSchema).default([]),
  timeline: z.array(AgentRunProgressStepSchema).max(40).default([]),
  parentTrace: WorkPackageParentTraceSchema.nullable().default(null),
}).strict();

export const CreateWorkPackageInputSchema = z.object({
  title: z.string().trim().max(200).default(''),
  body: z.string().trim().min(1).max(100_000),
  parentWorkPackageId: z.union([EntityIdSchema, z.literal('')]).default(''),
  sourceUrl: InspirationSourceUrlSchema.default(''),
  sourceTitle: z.string().trim().max(500).default(''),
  captureChannel: z.enum(['web', 'harmony-share', 'harmony-local', 'feed', 'agent', 'import']).default('web'),
  sourceApp: z.string().trim().max(200).default(''),
  clientMutationId: z.string().trim().max(128).default(''),
  capturedAt: EpochMillisSchema.optional(),
  attachmentIds: AttachmentIdListSchema.default([]),
}).strict();

export const ContinueWorkPackageInputSchema = z.object({
  body: z.string().trim().min(1).max(100_000),
  attachmentIds: AttachmentIdListSchema.optional(),
}).strict();

export const ClaimWorkPackageInputSchema = z.object({
  id: EntityIdSchema.optional(),
  claimedBy: z.string().trim().min(1).max(128).default('cursor-session'),
  leaseMs: z.number().int().min(60_000).max(14_400_000).default(1_800_000),
}).strict();

export const CompleteWorkPackageInputSchema = z.object({
  resultSummary: z.string().trim().max(2_000).default(''),
  changedPaths: z.array(z.string().trim().min(1).max(500)).max(200).default([]),
  restartRequired: RestartDecisionSchema.optional(),
}).strict();

export const FailWorkPackageInputSchema = z.object({
  resultSummary: z.string().trim().min(1).max(2_000),
}).strict();

export const WorkPackageListQuerySchema = z.object({
  status: z.enum(['open', 'claimed', 'completed', 'failed', 'cancelled', 'active', 'all']).default('active'),
}).strict();

export const NotifyWorkPackageInputSchema = z.object({
  id: EntityIdSchema.optional(),
}).strict();
