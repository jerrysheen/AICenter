import { z } from 'zod';
import { EpochMillisSchema, HttpUrlSchema } from './common.js';

const RequiredHttpUrlSchema = HttpUrlSchema.refine((value) => value !== '', 'URL 不能为空');

export const ProviderIdSchema = z.string().trim()
  .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/)
  .max(128);

export const SourceIdSchema = z.string().trim()
  .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/)
  .max(128);

export const SourceCategorySchema = z.enum(['market', 'content', 'search', 'calendar', 'policy']);
export const SourceVisibilitySchema = z.enum(['public', 'internal']);
export const SourceViewKindSchema = z.enum([
  'market-board', 'quote-list', 'history-series', 'content-feed', 'search-results',
  'calendar', 'official-release', 'official-detail', 'prediction-market', 'crypto-derivatives', 'stablecoin-liquidity',
]);

const NullableDecimalStringSchema = z.string().trim()
  .regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/, '必须使用十进制定点字符串')
  .nullable();

export const PredictionMarketQuoteSchema = z.object({
  quoteId: z.string().trim().min(1).max(512),
  venue: z.enum(['polymarket', 'kalshi']),
  marketId: z.string().trim().min(1).max(512),
  marketQuestion: z.string().trim().min(1).max(2_000),
  outcome: z.string().trim().min(1).max(256),
  midPrice: NullableDecimalStringSchema,
  bestBid: NullableDecimalStringSchema,
  bestAsk: NullableDecimalStringSchema,
  spread: NullableDecimalStringSchema,
  lastPrice: NullableDecimalStringSchema,
  volume24h: NullableDecimalStringSchema,
  totalVolume: NullableDecimalStringSchema,
  liquidity: NullableDecimalStringSchema,
  openInterest: NullableDecimalStringSchema,
  endAt: EpochMillisSchema.nullable(),
  sourceUrl: RequiredHttpUrlSchema,
  observedAt: EpochMillisSchema,
}).strict();

export const PredictionMarketSourceViewSchema = z.object({
  available: z.boolean(),
  observedAt: EpochMillisSchema,
  sourceUrl: RequiredHttpUrlSchema,
  quotes: z.array(PredictionMarketQuoteSchema).max(500),
  note: z.string().trim().max(1_000).default(''),
}).strict();

export const CryptoDerivativeQuoteSchema = z.object({
  quoteId: z.string().trim().min(1).max(512),
  venue: z.literal('hyperliquid'),
  symbol: z.string().trim().min(1).max(64),
  markPrice: NullableDecimalStringSchema,
  midPrice: NullableDecimalStringSchema,
  oraclePrice: NullableDecimalStringSchema,
  previousDayPrice: NullableDecimalStringSchema,
  fundingRate: NullableDecimalStringSchema,
  openInterest: NullableDecimalStringSchema,
  openInterestUnit: z.literal('base-asset'),
  volume24h: NullableDecimalStringSchema,
  sourceUrl: RequiredHttpUrlSchema,
  observedAt: EpochMillisSchema,
}).strict();

export const CryptoDerivativesSourceViewSchema = z.object({
  available: z.boolean(),
  observedAt: EpochMillisSchema,
  sourceUrl: RequiredHttpUrlSchema,
  quotes: z.array(CryptoDerivativeQuoteSchema).max(200),
  note: z.string().trim().max(1_000).default(''),
}).strict();

export const StablecoinLiquidityMetricSchema = z.object({
  key: z.string().trim().min(1).max(128),
  label: z.string().trim().min(1).max(128),
  supplyUsd: NullableDecimalStringSchema,
  change1dUsd: NullableDecimalStringSchema,
  change7dUsd: NullableDecimalStringSchema,
  change30dUsd: NullableDecimalStringSchema,
}).strict();

export const StablecoinLiquiditySourceViewSchema = z.object({
  available: z.boolean(),
  observedAt: EpochMillisSchema,
  sourceUrl: RequiredHttpUrlSchema,
  total: StablecoinLiquidityMetricSchema,
  assets: z.array(StablecoinLiquidityMetricSchema).max(100),
  chains: z.array(StablecoinLiquidityMetricSchema).max(200),
  note: z.string().trim().max(1_000).default(''),
}).strict();

export const MarketNativeSourceHealthSchema = z.object({
  sourceId: SourceIdSchema,
  title: z.string().trim().min(1).max(128),
  viewKind: z.enum(['prediction-market', 'crypto-derivatives', 'stablecoin-liquidity']),
  status: z.enum(['ready', 'partial', 'unavailable']),
  observedAt: EpochMillisSchema.nullable(),
  note: z.string().trim().max(1_000).default(''),
}).strict();

export const MarketNativeBoardSchema = z.object({
  generatedAt: EpochMillisSchema,
  predictionMarkets: z.array(PredictionMarketQuoteSchema).max(1_000),
  cryptoDerivatives: z.array(CryptoDerivativeQuoteSchema).max(200),
  stablecoinLiquidity: StablecoinLiquiditySourceViewSchema.nullable(),
  sourceHealth: z.array(MarketNativeSourceHealthSchema).max(64),
}).strict();

export const StaticSignalCountrySchema = z.enum(['US', 'CN']);
export const StaticSignalScheduleBasisSchema = z.enum(['official-calendar', 'official-rule']);
export const StaticSignalTimePrecisionSchema = z.enum(['exact', 'date', 'unknown']);
export const ScheduledEventStatusSchema = z.enum([
  'scheduled', 'tentative', 'rescheduled', 'cancelled', 'suspended', 'tba', 'published',
]);
export const ScheduledEventTypeSchema = z.enum([
  'economic-release', 'central-bank-meeting', 'central-bank-speech',
  'government-meeting', 'statistical-release', 'other',
]);

export const ScheduledEventSchema = z.object({
  eventId: z.string().trim().min(1).max(512),
  country: StaticSignalCountrySchema,
  authority: z.string().trim().min(1).max(256),
  eventType: ScheduledEventTypeSchema,
  title: z.string().trim().min(1).max(1_000),
  scheduledAt: EpochMillisSchema.nullable(),
  scheduledEndAt: EpochMillisSchema.nullable().default(null),
  referencePeriod: z.string().trim().max(256).nullable().default(null),
  status: ScheduledEventStatusSchema,
  scheduleBasis: StaticSignalScheduleBasisSchema,
  timePrecision: StaticSignalTimePrecisionSchema,
  sourceUrl: RequiredHttpUrlSchema,
  observedAt: EpochMillisSchema,
}).strict();

export const CalendarSourceViewSchema = z.object({
  available: z.boolean(),
  observedAt: EpochMillisSchema,
  sourceUrl: RequiredHttpUrlSchema,
  events: z.array(ScheduledEventSchema).max(5_000),
  note: z.string().trim().max(1_000).default(''),
}).strict();

export const OfficialDocumentTypeSchema = z.enum([
  'executive-order', 'memorandum', 'proclamation', 'rule', 'proposed-rule', 'notice',
  'presidential-document', 'press-release', 'speech', 'testimony', 'board-meeting',
  'policy-document', 'announcement', 'statistical-release', 'other',
]);

export const OfficialReleaseSchema = z.object({
  releaseId: z.string().trim().min(1).max(512),
  country: StaticSignalCountrySchema,
  authority: z.string().trim().min(1).max(256),
  documentType: OfficialDocumentTypeSchema,
  title: z.string().trim().min(1).max(1_000),
  publishedAt: EpochMillisSchema,
  timePrecision: StaticSignalTimePrecisionSchema,
  effectiveAt: EpochMillisSchema.nullable().default(null),
  documentNumber: z.string().trim().max(256).nullable().default(null),
  sourceUrl: RequiredHttpUrlSchema,
  observedAt: EpochMillisSchema,
}).strict();

export const OfficialReleaseSourceViewSchema = z.object({
  available: z.boolean(),
  observedAt: EpochMillisSchema,
  sourceUrl: RequiredHttpUrlSchema,
  releases: z.array(OfficialReleaseSchema).max(5_000),
  note: z.string().trim().max(1_000).default(''),
}).strict();

export const OfficialSourceDetailSchema = z.object({
  available: z.boolean(),
  sourceUrl: RequiredHttpUrlSchema,
  title: z.string().trim().max(1_000).default(''),
  officialSummary: z.string().trim().max(10_000).default(''),
  bodyText: z.string().trim().max(50_000).default(''),
  publishedAt: EpochMillisSchema.nullable().default(null),
  observedAt: EpochMillisSchema,
  truncated: z.boolean().default(false),
  note: z.string().trim().max(1_000).default(''),
}).strict();

export const StaticSignalSourceHealthSchema = z.object({
  sourceId: SourceIdSchema,
  title: z.string().trim().min(1).max(128),
  category: z.enum(['calendar', 'policy']),
  status: z.enum(['ready', 'partial', 'unavailable']),
  observedAt: EpochMillisSchema.nullable(),
  note: z.string().trim().max(1_000).default(''),
}).strict();

export const StaticSignalBoardSchema = z.object({
  generatedAt: EpochMillisSchema,
  upcoming: z.array(ScheduledEventSchema).max(10_000),
  releases: z.array(OfficialReleaseSchema).max(10_000),
  sourceHealth: z.array(StaticSignalSourceHealthSchema).max(128),
}).strict();

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
