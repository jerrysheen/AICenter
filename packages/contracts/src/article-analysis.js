import { z } from 'zod';
import { EntityIdSchema, EpochMillisSchema, HttpUrlSchema } from './common.js';
import { AgentRunProgressStepSchema } from './agent.js';

export const ARTICLE_ANALYSIS_JOB_TYPE = 'ai.article.analyze';
export const ARTICLE_ANALYSIS_TASK_TYPE = 'article-analysis.reader.v1';

export const ArticleAnalysisStageSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
]);

export const ArticleAnalysisReferenceTypeSchema = z.enum(['content-item', 'inspiration', 'post']);

export const ArticleAnalysisReferenceSchema = z.object({
  resourceType: ArticleAnalysisReferenceTypeSchema,
  resourceId: z.string().trim().min(1).max(256),
}).strict();

export const ArticleAnalysisInlineSourceSchema = z.object({
  type: z.literal('inline'),
  title: z.string().trim().max(1_000).default(''),
  body: z.string().trim().min(1).max(200_000),
  sourceUrl: HttpUrlSchema.optional(),
  publishedAt: EpochMillisSchema.optional(),
}).strict();

export const ArticleAnalysisReferenceSourceSchema = z.object({
  type: z.literal('reference'),
  reference: ArticleAnalysisReferenceSchema,
}).strict();

export const ArticleAnalysisSourceSchema = z.discriminatedUnion('type', [
  ArticleAnalysisReferenceSourceSchema,
  ArticleAnalysisInlineSourceSchema,
]);

export const CreateArticleAnalysisInputSchema = z.object({
  source: ArticleAnalysisSourceSchema,
  sessionId: EntityIdSchema.optional(),
}).strict();

export const ArticleAnalysisJobInputSchema = CreateArticleAnalysisInputSchema.extend({
  workspaceId: EntityIdSchema.default('local'),
}).strict();

export const ArticleAnalysisRunViewSchema = z.object({
  runId: EntityIdSchema,
  sessionId: EntityIdSchema.or(z.literal('')).default(''),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
  stage: ArticleAnalysisStageSchema,
  progress: z.array(AgentRunProgressStepSchema).max(40).default([]),
  aiRunId: EntityIdSchema.optional(),
  outputText: z.string().max(40_000).optional(),
  error: z.unknown().optional(),
}).strict();
