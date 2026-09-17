import { z } from 'zod';
import { EpochMillisSchema } from './common.js';

export const ProviderIdSchema = z.string().trim()
  .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/)
  .max(128);

export const SourceIdSchema = z.string().trim()
  .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/)
  .max(128);

export const SourceCategorySchema = z.enum(['market', 'content', 'search']);
export const SourceVisibilitySchema = z.enum(['public', 'internal']);
export const SourceViewKindSchema = z.enum([
  'market-board', 'quote-list', 'history-series', 'content-feed', 'search-results',
]);

export const SourceManifestSchema = z.object({
  id: SourceIdSchema,
  title: z.string().trim().min(1).max(128),
  category: SourceCategorySchema,
  providerId: ProviderIdSchema,
  visibility: SourceVisibilitySchema.default('public'),
  viewKind: SourceViewKindSchema,
  capabilities: z.array(z.enum(['read', 'refresh'])).min(1),
  refresh: z.object({ ttlMs: z.number().int().nonnegative().max(86_400_000) }).strict().optional(),
  guideRefs: z.array(z.string().trim().min(1).max(128)).max(32).default([]),
}).strict();

export const SourceSnapshotStatusSchema = z.enum(['ready', 'partial', 'unavailable']);

export const SourceSnapshotSchema = z.object({
  sourceId: SourceIdSchema,
  providerId: ProviderIdSchema,
  observedAt: EpochMillisSchema,
  status: SourceSnapshotStatusSchema,
  data: z.unknown(),
  warnings: z.array(z.string().trim().min(1).max(500)).max(32).default([]),
}).strict();
