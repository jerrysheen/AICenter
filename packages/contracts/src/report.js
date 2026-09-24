import { z } from 'zod';
import {
  EntityIdSchema, EpochMillisSchema, HttpUrlSchema, NullableEpochMillisSchema, WorkspaceIdSchema,
} from './common.js';
import { OfficialReleaseSchema, ScheduledEventSchema } from './source.js';
import { DIVIDEND_STRATEGY_KEY, DividendRegimeSchema, DividendStrategyFactorsSchema } from './strategy.js';

export const DailyWindowSchema = z.object({
  startAt: EpochMillisSchema,
  endAt: EpochMillisSchema,
}).strict();

export const DailyNewsItemSchema = z.object({
  id: EntityIdSchema,
  title: z.string().max(1_000),
  summary: z.string().max(500),
  sourceUrl: HttpUrlSchema,
  authorName: z.string().max(512),
  publishedAt: NullableEpochMillisSchema,
  createdAt: EpochMillisSchema,
  capturedAt: NullableEpochMillisSchema,
  eventAt: EpochMillisSchema,
}).strict();

const NullableFiniteSchema = z.number().finite().nullable();

export const DailyMarketQuoteSchema = z.object({
  symbol: z.string().max(64),
  name: z.string().max(256),
  lastPrice: NullableFiniteSchema,
  changePct: NullableFiniteSchema,
  asOf: NullableEpochMillisSchema,
}).strict();

export const DailyMarketBoardSnapshotSchema = z.object({
  board: z.enum(['cn', 'global']),
  mode: z.enum(['live', 'partial', 'unavailable']),
  fetchedAt: NullableEpochMillisSchema,
  asOf: NullableEpochMillisSchema,
  indices: z.array(DailyMarketQuoteSchema).max(12),
  note: z.string().max(1_000),
}).strict();

export const DailyStrategyFactSchema = z.object({
  strategyKey: z.literal(DIVIDEND_STRATEGY_KEY),
  asOf: EpochMillisSchema,
  regime: DividendRegimeSchema,
  factors: DividendStrategyFactorsSchema,
}).strict();

export const DailyReportContentSchema = z.object({
  reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: z.string().trim().min(1).max(64),
  window: DailyWindowSchema,
  upcomingWindow: DailyWindowSchema,
  generatedAt: EpochMillisSchema,
  news: z.array(DailyNewsItemSchema).max(500),
  officialReleases: z.array(OfficialReleaseSchema).max(200),
  upcoming: z.array(ScheduledEventSchema).max(200),
  market: z.object({
    cn: DailyMarketBoardSnapshotSchema,
    global: DailyMarketBoardSnapshotSchema,
  }).strict(),
  strategy: DailyStrategyFactSchema.nullable().optional(),
  warnings: z.array(z.string().trim().min(1).max(500)).max(50),
}).strict();

export const DailyReportSourceRefSchema = z.object({
  type: z.enum(['content-item', 'scheduled-event', 'official-release', 'market-snapshot', 'strategy-snapshot']),
  id: z.string().trim().min(1).max(512),
  at: NullableEpochMillisSchema,
}).strict();

export const DailyReportSchema = z.object({
  id: EntityIdSchema,
  workspaceId: WorkspaceIdSchema,
  reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.enum(['ready', 'partial']),
  content: DailyReportContentSchema,
  sourceRefs: z.array(DailyReportSourceRefSchema).max(1_000),
  createdAt: EpochMillisSchema,
  updatedAt: EpochMillisSchema,
}).strict();

export const GenerateDailyReportInputSchema = z.object({
  workspaceId: WorkspaceIdSchema.optional(),
  reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  cutoffHour: z.number().int().min(0).max(23).optional(),
  cutoffMinute: z.number().int().min(0).max(59).optional(),
  scheduledFor: EpochMillisSchema.optional(),
  scheduleKey: z.string().trim().min(1).max(128).optional(),
  newsLimit: z.number().int().min(1).max(500).optional(),
}).strict();

export const GenerateDailyReportRequestSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict();

export const DailyReportDateQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict();

export const DailyBriefCandidateTypeSchema = z.enum([
  'news',
  'official-release',
  'upcoming-event',
  'market',
  'strategy',
  'strategy-transition',
]);

export const DailyBriefCandidateSchema = z.object({
  id: z.string().trim().min(1).max(256),
  type: DailyBriefCandidateTypeSchema,
  occurredAt: EpochMillisSchema,
  title: z.string().max(1_000),
  summary: z.string().max(240),
  sourceRefs: z.array(DailyReportSourceRefSchema).max(8),
  data: z.record(z.string(), z.any()),
}).strict();

export const DailyBriefModelCandidateSchema = DailyBriefCandidateSchema.omit({ sourceRefs: true });

export const DailyBriefModelInputSchema = z.object({
  reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  candidateCount: z.number().int().nonnegative(),
  includedCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  candidates: z.array(DailyBriefModelCandidateSchema).max(120),
}).strict();

export const DailyBriefModelItemSchema = z.object({
  candidateId: z.string().trim().min(1).max(256),
  headline: z.string().trim().min(1).max(120),
  whyItMatters: z.string().trim().min(1).max(400),
  watchNext: z.string().trim().min(1).max(240),
}).strict();

export const DailyBriefModelOutputSchema = z.object({
  overview: z.string().trim().min(1).max(500),
  items: z.array(DailyBriefModelItemSchema).max(8),
}).strict();

export const DailyBriefItemSchema = z.object({
  candidateId: z.string().trim().min(1).max(256),
  type: DailyBriefCandidateTypeSchema,
  headline: z.string().trim().min(1).max(120),
  whyItMatters: z.string().trim().min(1).max(400),
  watchNext: z.string().trim().min(1).max(240),
  occurredAt: EpochMillisSchema,
  sourceRefs: z.array(DailyReportSourceRefSchema).max(8),
}).strict();

export const DailyBriefSchema = z.object({
  id: EntityIdSchema,
  reportId: EntityIdSchema,
  reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  generatedAt: EpochMillisSchema,
  overview: z.string().trim().min(1).max(500),
  items: z.array(DailyBriefItemSchema).max(8),
  providerId: z.string().trim().max(128),
  modelId: z.string().trim().max(128),
  sourceReportUpdatedAt: EpochMillisSchema,
}).strict();

export const GenerateDailyBriefInputSchema = z.object({
  workspaceId: WorkspaceIdSchema.optional(),
  reportId: EntityIdSchema,
}).strict();

export const GenerateDailyBriefRequestSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict();
