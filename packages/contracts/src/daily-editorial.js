import {z} from 'zod';

export const DAILY_EDITORIAL_VERSION = 'daily-editorial-v1';
export const DAILY_DIRECTIONS = ['finance', 'tech', 'policy', 'other'];

const id = z.string().min(1).max(2048);
const direction = z.enum(DAILY_DIRECTIONS);
const paragraph = z.string().trim().min(1).max(2000);

export const DailyEventSchema = z.object({
  eventId: id,
  title: z.string().trim().min(1).max(160),
  facts: z.array(paragraph).min(1).max(40),
  sourceNodeIds: z.array(id).min(1).max(80),
  status: z.enum(['occurred', 'planned', 'forecast', 'rumor', 'opinion', 'mixed']),
  direction,
  relatedEventIds: z.array(id).max(12).default([]),
  importanceLevel: z.enum(['core', 'related', 'other']),
  importanceReason: z.string().trim().min(1).max(300),
}).strict();

export const DailyRelationSchema = z.object({
  eventIds: z.array(id).min(2).max(8),
  type: z.enum(['same-event', 'shared-theme', 'complementary', 'contradictory', 'supported-impact', 'unverified-link']),
  certainty: z.enum(['stated', 'inferred', 'unverified']),
  reason: z.string().trim().min(1).max(400),
}).strict();

export const DailyEditorialSectionSchema = z.object({
  heading: z.string().trim().min(1).max(80),
  paragraphs: z.array(paragraph).min(1).max(500),
  eventIds: z.array(id).min(1),
  kind: z.enum(['lead', 'theme', 'other', 'watch']),
}).strict();

export const DailyDirectionArticleSchema = z.object({
  direction,
  title: z.string().trim().min(1).max(80),
  lead: paragraph,
  leadEventIds: z.array(id).min(1),
  sections: z.array(DailyEditorialSectionSchema).min(1),
}).strict();

export const DailyEditorialCoverageSchema = z.object({
  hourlyModuleCount: z.number().int().nonnegative(),
  informationNodeCount: z.number().int().nonnegative(),
  eventCount: z.number().int().nonnegative(),
  inBodyEventCount: z.number().int().nonnegative(),
  indexOnlyEventCount: z.number().int().nonnegative(),
  unprocessedCount: z.number().int().nonnegative(),
  incompleteHours: z.array(z.number().int()).max(24),
  pendingMaterialCount: z.number().int().nonnegative(),
  complete: z.boolean(),
}).strict();

export const DailyEditorialUsageSchema = z.object({
  calls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  cost: z.number().nonnegative().nullable(),
  model: z.string().trim().min(1).max(80),
}).strict();

export const DailyEditorialSchema = z.object({
  id,
  version: z.literal(DAILY_EDITORIAL_VERSION),
  reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  window: z.object({startAt: z.number().int(), endAt: z.number().int()}).strict(),
  timezone: z.string().trim().min(1).max(64),
  status: z.enum(['ready', 'partial', 'failed']),
  statusNote: z.string().trim().min(1).max(500),
  overview: paragraph.max(1200),
  events: z.array(DailyEventSchema).min(1),
  relations: z.array(DailyRelationSchema).max(40),
  articles: z.array(DailyDirectionArticleSchema).min(1).max(4),
  coverage: DailyEditorialCoverageSchema,
  usage: DailyEditorialUsageSchema,
  inputSnapshotHash: z.string().length(64),
  strategyVersion: z.literal(DAILY_EDITORIAL_VERSION),
  generatedAt: z.number().int(),
}).strict();
