import { z } from 'zod';
import {
  EntityIdSchema, EpochMillisSchema, HttpUrlSchema, NullableEpochMillisSchema, WorkspaceIdSchema, CnTradingCalendarSchema,
} from './common.js';
import { OfficialReleaseSchema, ScheduledEventSchema } from './source.js';
import { DIVIDEND_STRATEGY_KEY, DividendRegimeSchema, DividendStrategyFactorsSchema } from './strategy.js';
import { MediaBriefSchema } from './media.js';

export const DailyWindowSchema = z.object({
  startAt: EpochMillisSchema,
  endAt: EpochMillisSchema,
}).strict();

export const DailyEvidenceSchema = z.object({
  materialId: z.string().min(1).max(512),
  paragraphId: z.string().min(1).max(128),
}).strict();
export const DailyMaterialSchema = z.object({
  id: z.string().min(1).max(512),
  sourceId: z.string().max(512),
  group: z.enum(['social', 'tech', 'macro', 'other', 'context']),
  kind: z.enum(['social', 'news', 'official', 'market', 'schedule', 'strategy', 'other']),
  title: z.string().max(1000), author: z.string().max(512), publisher: z.string().max(512),
  sourceUrl: z.string().max(2048), originUrl: z.string().max(2048),
  publishedAt: NullableEpochMillisSchema, updatedAt: NullableEpochMillisSchema,
  capturedAt: NullableEpochMillisSchema, obtainedAt: EpochMillisSchema,
  eventAt: EpochMillisSchema, late: z.boolean(),
  contentLevel: z.enum(['full', 'partial', 'summary_only', 'discovery', 'metadata']),
  version: z.string().max(128), hash: z.string().length(64),
  bodyHash: z.string().max(128).optional(),
  paragraphCount: z.number().int().nonnegative().max(2000).optional(),
  evidenceGroup: z.string().max(512).optional(),
  paragraphs: z.array(z.object({ id: z.string().max(128), text: z.string().max(20000), role: z.enum(['body', 'comment', 'summary', 'metadata']) }).strict()).max(2000),
  missing: z.array(z.string().max(500)).max(20),
  sourceRefs: z.array(z.object({ type: z.string().max(64), id: z.string().max(512), at: NullableEpochMillisSchema }).strict()).max(8),
}).strict();
export const DailyCoverageSchema = z.object({
  sourceId: z.string().max(512), group: z.string().max(32),
  sourceName: z.string().max(512).optional(),
  available: z.number().int().nonnegative(), included: z.number().int().nonnegative(),
  full: z.number().int().nonnegative(), summaryOnly: z.number().int().nonnegative(),
  omitted: z.number().int().nonnegative(), failed: z.number().int().nonnegative(),
  status: z.string().max(64), lastSyncAt: NullableEpochMillisSchema, note: z.string().max(1000),
  read: z.number().int().nonnegative().optional(), readParagraphs: z.number().int().nonnegative().optional(),
  unread: z.number().int().nonnegative().optional(),
}).strict();
export const DailyTrackingQuestionSchema = z.object({
  id: EntityIdSchema, question: z.string().trim().min(1).max(1000), enabled: z.boolean(),
  baseline: z.string().max(3000).default(''), pending: z.string().max(2000).default(''),
  updatedAt: EpochMillisSchema.optional(),
}).strict();
export const SaveDailyTrackingQuestionsSchema = z.object({ questions: z.array(DailyTrackingQuestionSchema).max(20) }).strict()
  .refine(v => new Set(v.questions.map(q => q.id)).size === v.questions.length, '问题ID不能重复');
export const DailyTrackingUpdateSchema = z.object({
  questionId: EntityIdSchema,
  question: z.string().max(1000).optional(),
  status: z.enum(['supported', 'challenged', 'unchanged', 'no-new-evidence', 'insufficient', 'source-failed']),
  judgment: z.string().trim().min(1).max(3000), nextCheck: z.string().max(2000),
  evidence: z.array(DailyEvidenceSchema).max(30),
}).strict();
// Kept for persisted V2 stages and explicit legacy replay.
export const LegacyDailyAnalysisOutputSchema = z.object({
  analysis: z.string().max(8000), evidence: z.array(DailyEvidenceSchema).max(80),
  questions: z.array(z.string().max(500)).max(20),
}).strict();
export const DailyAnalysisOutputSchema = z.object({
  items: z.array(z.object({
    sentence: z.string().trim().min(1).max(300),
    evidence: z.array(DailyEvidenceSchema).min(1).max(30),
  }).strict()),
}).strict();
export const InformationEvidenceSchema = DailyEvidenceSchema.extend({
  snapshotId: EntityIdSchema,
  materialHash: z.string().length(64),
  materialVersion: z.string().min(1).max(128),
}).strict();
export const InformationItemSchema = z.object({
  id: EntityIdSchema,
  sentence: z.string().trim().min(1).max(300),
  evidence: z.array(InformationEvidenceSchema).min(1),
  occurredAt: EpochMillisSchema,
  processedAt: EpochMillisSchema,
  supersedes: z.array(EntityIdSchema).default([]),
}).strict();
export const HourStartSchema = EpochMillisSchema.refine(v => v % 3600000 === 0, '小时起点必须为整小时');
const BriefDirectionSchema = z.enum(['金融与市场','时事与政策','科技与产业','其他']);
export const BRIEF_DIRECTION_LABELS = Object.freeze({finance:'金融与市场',policy:'时事与政策',tech:'科技与产业',other:'其他'});
export const BRIEF_ARTICLE_VERSION = 'brief-editorial-v3';
const BriefModelTopicSchema = z.object({
  title:z.string().trim().min(1).max(120), body:z.string().trim().min(1).max(1600),
  itemIds:z.array(EntityIdSchema).min(1),
}).strict();
export const LegacyBriefEditorialOutputSchema = z.object({
  overview:z.string().trim().min(1).max(500), overviewItemIds:z.array(EntityIdSchema),
  directions:z.array(z.object({title:BriefDirectionSchema,topics:z.array(BriefModelTopicSchema).min(1).max(32)}).strict()).max(4),
}).strict();
const BriefArticleParagraphSchema=z.object({text:z.string().trim().min(1).max(1200),itemIds:z.array(EntityIdSchema).min(1)}).strict();
const BriefModelDirectionArticleSchema=z.object({
  key:z.enum(['finance','policy','tech','other']),label:BriefDirectionSchema,
  articleTitle:z.string().trim().min(1).max(120),lead:BriefArticleParagraphSchema,
  sections:z.array(z.object({heading:z.string().trim().max(120).optional(),paragraphs:z.array(BriefArticleParagraphSchema).min(1).max(8)}).strict()).min(1).max(10),
}).strict().refine(d=>BRIEF_DIRECTION_LABELS[d.key]===d.label,'方向身份与标签不匹配');
export const BriefEditorialOutputSchema=z.object({
  overview:z.string().trim().min(1).max(500),overviewItemIds:z.array(EntityIdSchema),
  directions:z.array(BriefModelDirectionArticleSchema).max(4),
}).strict();
const BriefArticleSavedParagraphSchema=BriefArticleParagraphSchema.extend({id:EntityIdSchema,evidence:z.array(InformationEvidenceSchema).min(1),occurredAt:EpochMillisSchema}).strict();
const BriefSavedDirectionArticleSchema=z.object({
  key:z.enum(['finance','policy','tech','other']),label:BriefDirectionSchema,id:EntityIdSchema,
  articleTitle:z.string().trim().min(1).max(120),lead:BriefArticleSavedParagraphSchema,
  sections:z.array(z.object({heading:z.string().trim().max(120).optional(),paragraphs:z.array(BriefArticleSavedParagraphSchema).min(1).max(8)}).strict()).min(1).max(10),
}).strict().refine(d=>BRIEF_DIRECTION_LABELS[d.key]===d.label,'方向身份与标签不匹配');
export const BriefEditorialSchema = z.union([
  z.object({status:z.literal('ready'),version:z.literal(BRIEF_ARTICLE_VERSION),inputVersion:z.string().length(64),
    overview:z.string().trim().min(1).max(500),overviewItemIds:z.array(EntityIdSchema),overviewEvidence:z.array(InformationEvidenceSchema),
    directions:z.array(BriefSavedDirectionArticleSchema).max(4),
  }).strict(),
  z.object({status:z.literal('ready'),version:z.string().min(1).max(64),
    overview:z.string().trim().min(1).max(500),overviewItemIds:z.array(EntityIdSchema),overviewEvidence:z.array(InformationEvidenceSchema),
    directions:z.array(z.object({title:BriefDirectionSchema,topics:z.array(BriefModelTopicSchema.extend({
      id:EntityIdSchema,evidence:z.array(InformationEvidenceSchema).min(1),occurredAt:EpochMillisSchema,
    }).strict()).min(1).max(32)}).strict()).max(4),
  }).strict().refine(v=>v.version!==BRIEF_ARTICLE_VERSION,'新版必须使用方向文章结构'),
  z.object({status:z.literal('failed'),version:z.string().min(1).max(64),message:z.string().min(1).max(300)}).strict(),
]);
export const HourlyDigestSchema = z.object({
  id: EntityIdSchema, window: DailyWindowSchema,
  timezone: z.string().min(1).max(64),
  frozenAt: EpochMillisSchema, generatedAt: EpochMillisSchema,
  flowVersion: z.string().min(1).max(64), materialVersion: z.string().length(64),
  items: z.array(InformationItemSchema),
  editorial: BriefEditorialSchema.optional(),
  coverage: z.array(DailyCoverageSchema), warnings: z.array(z.string().max(1000)),
}).strict();
export const GenerateHourlyDigestInputSchema = z.object({
  workspaceId: WorkspaceIdSchema.optional(), hourStart: HourStartSchema.optional(),
  mode:z.enum(['resume','rewrite']).optional(),snapshotId:EntityIdSchema.optional(),
  scheduledFor: EpochMillisSchema.optional(), scheduleKey: z.string().max(128).optional(),
}).strict().refine(v=>(v.mode!=='rewrite' || v.hourStart!==undefined) && (!v.snapshotId || v.mode==='rewrite'),'重编须指定小时，快照仅用于rewrite模式');
export const GenerateHourlyDigestRequestSchema = z.object({hourStart: HourStartSchema.optional(),mode:z.enum(['resume','rewrite']).optional(),snapshotId:EntityIdSchema.optional()}).strict()
  .refine(v=>(v.mode!=='rewrite' || v.hourStart!==undefined) && (!v.snapshotId || v.mode==='rewrite'),'重编须指定小时，快照仅用于rewrite模式');
export const HourlyDigestQuerySchema = z.object({hourStart: HourStartSchema}).strict();
export const HourlySnapshotQuerySchema = z.object({snapshotId: EntityIdSchema}).strict();
export const HourlyDigestIndexQuerySchema = z.object({startAt: EpochMillisSchema, endAt: EpochMillisSchema}).strict()
  .refine(v => v.endAt > v.startAt && v.endAt-v.startAt <= 7*86400000, '时间窗口必须大于0且不超过7天');
export const HourlyDigestIndexSchema = z.object({
  timezone: z.string().min(1).max(64),
  hours: z.array(z.object({
    hourStart: HourStartSchema, id: EntityIdSchema.nullable(), generatedAt: NullableEpochMillisSchema,
    itemCount: z.number().int().nonnegative(),
    status: z.enum(['running', 'failed', 'completed', 'not-started']), updatedAt: EpochMillisSchema,
    readable:z.boolean().optional(),draftId:EntityIdSchema.nullable().optional(),draftItemCount:z.number().int().nonnegative().optional(),
    phase:z.enum(['not-started','queued-extraction','extracting','queued-editing','editing','draft','ready','empty','failed']).optional(),
    failureStage:z.enum(['extraction','editing','unknown']).optional(),
    failureReason:z.enum(['queue-timeout','execution-timeout','model-error','budget','invalid-output','interrupted','other']).optional(),
    queueMs:z.number().int().nonnegative().optional(),executionMs:z.number().int().nonnegative().optional(),
    unread: z.number().int().nonnegative(), failed: z.number().int().nonnegative(),
  }).strict()),
}).strict();
export const InformationSearchInputSchema = z.object({
  startAt: EpochMillisSchema, endAt: EpochMillisSchema,
  query: z.string().trim().max(300).default(''),
  limit: z.number().int().min(1).max(100).default(40),
  offset: z.number().int().nonnegative().default(0),
}).strict().refine(v => v.endAt > v.startAt && v.endAt-v.startAt <= 7*86400000, '时间窗口必须大于0且不超过7天');
export const InformationEvidenceInputSchema = InformationEvidenceSchema;
export const InformationEditorialOutputSchema = z.object({
  items: z.array(z.object({sentence:z.string().trim().min(1).max(300),itemIds:z.array(EntityIdSchema).min(1)}).strict()),
}).strict();
export const DailyEditorialOutputSchema = z.object({
  overview: z.string().trim().min(1).max(500),
  sections: z.array(z.object({
    title: z.string().trim().min(1).max(120), body: z.string().trim().min(1).max(6000),
    evidence: z.array(DailyEvidenceSchema).min(1).max(30),
  }).strict()).max(12),
  nextWatch: z.string().max(4000), limitations: z.string().max(2000),
}).strict();

export const DailyNewsItemSchema = z.object({
  id: EntityIdSchema,
  title: z.string().max(1_000),
  summary: z.string().max(500),
  generatedBrief: MediaBriefSchema.optional(),
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
  calendar: CnTradingCalendarSchema.optional(),
  board: z.enum(['cn', 'global']),
  mode: z.enum(['live', 'partial', 'unavailable']),
  fetchedAt: NullableEpochMillisSchema,
  asOf: NullableEpochMillisSchema,
  indices: z.array(DailyMarketQuoteSchema).max(100),
  observations: z.array(z.record(z.string(), z.any())).max(300).optional(),
  groups: z.array(z.any()).max(100).optional(),
  stale: z.boolean().optional(), afterWindow: z.boolean().optional(),
  note: z.string().max(1_000),
}).strict();

export const DailyStrategyFactSchema = z.object({
  strategyKey: z.literal(DIVIDEND_STRATEGY_KEY),
  asOf: EpochMillisSchema,
  regime: DividendRegimeSchema,
  factors: DividendStrategyFactorsSchema,
}).strict();

export const DailyReportContentSchema = z.object({
  schemaVersion: z.literal(2).optional(),
  frozenAt: EpochMillisSchema.optional(), materialVersion: z.string().max(128).optional(),
  generationKey: z.string().max(128).optional(),
  materials: z.array(DailyMaterialSchema).max(10000).optional(),
  coverage: z.array(DailyCoverageSchema).max(200).optional(),
  tracking: z.array(z.object({
    question: DailyTrackingQuestionSchema, previous: DailyTrackingUpdateSchema.nullable(), previousDate: z.string().nullable(),
    previousRevision: NullableEpochMillisSchema.optional(),
    previousEvidence: z.array(z.object({reference:DailyEvidenceSchema,hash:z.string().max(128),version:z.string().max(128),sourceUrl:z.string().max(2048),excerpt:z.string().max(1000)}).strict()).max(6).optional(),
    previousEvidenceOmitted:z.number().int().nonnegative().optional(),
  }).strict()).max(20).optional(),
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
  type: z.enum(['content-item', 'scheduled-event', 'official-release', 'market-snapshot', 'strategy-snapshot', 'media-body']),
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
  newsLimit: z.number().int().min(1).max(3000).optional(),
  requestKey: z.string().max(128).optional(),
  catchup: z.number().int().optional(),
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
  summary: z.string().max(300),
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
  body: z.string().max(6000).optional(),
  evidence: z.array(DailyEvidenceSchema).max(30).optional(),
  candidateId: z.string().trim().min(1).max(256),
  type: DailyBriefCandidateTypeSchema,
  headline: z.string().trim().min(1).max(120),
  whyItMatters: z.string().trim().min(1).max(400),
  watchNext: z.string().trim().min(1).max(240),
  occurredAt: EpochMillisSchema,
  sourceRefs: z.array(DailyReportSourceRefSchema).max(60),
}).strict();

export const DailyBriefSchema = z.object({
  editorial: BriefEditorialSchema.optional(),
  informationItems: z.array(InformationItemSchema).optional(),
  hourlySnapshots: z.array(EntityIdSchema).optional(),
  schemaVersion: z.literal(2).optional(), flowVersion: z.string().max(64).optional(),
  materialVersion: z.string().max(128).optional(), frozenAt: EpochMillisSchema.optional(),
  sections: z.array(z.object({ id: z.string().max(256), title: z.string().max(120), body: z.string().max(6000), evidence: z.array(DailyEvidenceSchema).max(30) }).strict()).max(12).optional(),
  trackingUpdates: z.array(DailyTrackingUpdateSchema).max(20).optional(),
  coverage: z.array(DailyCoverageSchema).max(200).optional(),
  nextWatch: z.string().max(4000).optional(), limitations: z.string().max(2000).optional(),
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

export const DailyBriefIndexItemSchema = z.object({
  reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  overview: z.string().trim().min(1).max(500),
  itemCount: z.number().int().nonnegative(),
  generatedAt: EpochMillisSchema,
}).strict();

export const GenerateDailyBriefInputSchema = z.object({
  workspaceId: WorkspaceIdSchema.optional(),
  reportId: EntityIdSchema,
  catchup: z.boolean().optional(),
  mode: z.enum(['resume', 'rewrite']).optional(),
  requestKey: z.string().max(128).optional(),
  sourceReportUpdatedAt: EpochMillisSchema.optional(),
}).strict();

export const GenerateDailyBriefRequestSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  mode: z.enum(['refresh', 'rewrite', 'resume']).optional(),
}).strict();
export const DailyBriefWindowQuerySchema = DailyReportDateQuerySchema.extend({revision: EpochMillisSchema}).strict();
export const DailyBriefWindowSchema = z.object({window: DailyWindowSchema.nullable(), timezone: z.string().min(1).max(64).nullable()}).strict();
