import type {LegacyBriefEditorialOutputSchema} from './report.js';
export type LegacyBriefEditorialOutput = z.infer<typeof LegacyBriefEditorialOutputSchema>;
import { z } from 'zod';
import type { LikeContentInputSchema, LikeResultSchema } from './feed-interaction.js';
export type LikeContentInput = z.infer<typeof LikeContentInputSchema>;
export type LikeResult = z.infer<typeof LikeResultSchema>;
import type { ModelUsageRecordSchema, ModelUsageQuerySchema, ModelTokenUsageSchema, ModelUsageViewSchema, ModelUsageRateSchema } from './model-usage.js';
export type ModelUsageView = z.infer<typeof ModelUsageViewSchema>;
export type ModelUsageRate = z.infer<typeof ModelUsageRateSchema>;
export type ModelUsageRecord = z.infer<typeof ModelUsageRecordSchema>;
export type ModelUsageQuery = z.infer<typeof ModelUsageQuerySchema>;
export type ModelTokenUsage = z.infer<typeof ModelTokenUsageSchema>;
import type { MediaSavedArticleQuerySchema } from './media.js';
export type MediaSavedArticleQuery = z.infer<typeof MediaSavedArticleQuerySchema>;
import type { BriefEditorialSchema, BriefEditorialOutputSchema } from './report.js';
export type BriefEditorial = z.infer<typeof BriefEditorialSchema>;
export type BriefEditorialOutput = z.infer<typeof BriefEditorialOutputSchema>;
import type { DailyBriefWindowQuerySchema, DailyBriefWindowSchema } from './report.js';
export type DailyBriefWindowQuery = z.infer<typeof DailyBriefWindowQuerySchema>;
export type DailyBriefWindow = z.infer<typeof DailyBriefWindowSchema>;
import type { HourlyDigestIndexQuerySchema, HourlyDigestIndexSchema } from './report.js';
export type HourlyDigestIndexQuery = z.infer<typeof HourlyDigestIndexQuerySchema>;
export type HourlyDigestIndex = z.infer<typeof HourlyDigestIndexSchema>;
import type {InformationEvidenceSchema, InformationItemSchema, HourlyDigestSchema, GenerateHourlyDigestInputSchema, InformationSearchInputSchema} from './report.js';
export type InformationEvidence = z.infer<typeof InformationEvidenceSchema>;
export type InformationItem = z.infer<typeof InformationItemSchema>;
export type HourlyDigest = z.infer<typeof HourlyDigestSchema>;
export type GenerateHourlyDigestInput = z.infer<typeof GenerateHourlyDigestInputSchema>;
export type InformationSearchInput = z.infer<typeof InformationSearchInputSchema>;
import type { FeedCaptureContextSchema, FeedValueInputSchema, FeedValueScoresSchema, FeedValueReferenceSchema, FeedValueCalibrationSchema, FeedValueDecisionSchema, FeedValueRefreshInputSchema } from './feed-value.js';
export type FeedValueRefreshInput = z.infer<typeof FeedValueRefreshInputSchema>;
export type FeedCaptureContext = z.infer<typeof FeedCaptureContextSchema>;
export type FeedValueInput = z.infer<typeof FeedValueInputSchema>;
export type FeedValueScores = z.infer<typeof FeedValueScoresSchema>;
export type FeedValueReference = z.infer<typeof FeedValueReferenceSchema>;
export type FeedValueCalibration = z.infer<typeof FeedValueCalibrationSchema>;
export type FeedValueDecision = z.infer<typeof FeedValueDecisionSchema>;
import type { FeedQualityScoresSchema, FeedQualityInputSchema, FeedQualityDecisionSchema } from './feed-quality.js';
export type FeedQualityScores = z.infer<typeof FeedQualityScoresSchema>;
export type FeedQualityInput = z.infer<typeof FeedQualityInputSchema>;
export type FeedQualityDecision = z.infer<typeof FeedQualityDecisionSchema>;
import type { MediaArticleTranslationSchema } from './media.js';
export type MediaArticleTranslation = z.infer<typeof MediaArticleTranslationSchema>;
import type { SourceAccountSchema, SubscriptionSchema, CaptureSchema, ContentItemSchema, UserItemStateSchema, FeedItemTranslationSchema, FeedIdentityFingerprintSchema } from './feed.js';
import type {
  InstrumentSchema, InstrumentAliasSchema, QuoteSnapshotSchema, PortfolioSchema, TransactionSchema,
  PersonalAssetDashboardSchema, PersonalAssetTypeSchema, PersonalAssetAccountSchema,
  PersonalAssetAccountViewSchema, PersonalAssetSnapshotSchema, PersonalAssetImportSchema,
  PersonalAssetImportResultSchema, HoldingLotSchema, HoldingsBoardSchema, PortfolioImportSchema,
  PortfolioImportResultSchema,
} from './trading.js';
import type {
  InspirationSchema, AiSessionSchema, AiSessionExchangeSchema, AiRunSchema,
  KnowledgeDocumentSchema, KnowledgeRevisionSchema, CreateInspirationInputSchema,
  AttachmentSchema, CreateAttachmentInputSchema,
  WorkPackageSchema, CreateWorkPackageInputSchema, ContinueWorkPackageInputSchema,
  WorkPackageGoalSchema, WorkPackageProgressSchema, WorkPackageParentTraceSchema,
  WorkPackageTraceSchema,
} from './knowledge.js';
import type {
  TaxonomyNodeSchema, TaxonomyCatalogSchema, TaxonomyAssignmentSchema, StructuredArtifactSchema,
  StructureJobInputSchema, StructureJobOutputSchema, SaveStructuredArtifactInputSchema,
} from './taxonomy.js';
import type { AiRunContextRefSchema, ContextReferenceSchema, PackReferencesInputSchema } from './context.js';
import type { AgentJobSchema, DomainEventSchema, CapabilityManifestSchema, WorkerJobConcurrencySchema, JobScheduleSchema } from './runtime.js';
import type {
  DailyReportSchema, DailyReportContentSchema, GenerateDailyReportInputSchema,
  DailyBriefCandidateSchema, DailyBriefModelInputSchema, DailyBriefModelOutputSchema, DailyBriefSchema,
  DailyMaterialSchema, DailyCoverageSchema, DailyEvidenceSchema, DailyTrackingQuestionSchema,
  DailyTrackingUpdateSchema, DailyAnalysisOutputSchema, DailyEditorialOutputSchema,
} from './report.js';
import type { StockFactorSnapshotSchema, StockStatisticsSchema } from './market-stats.js';
import type {
  TagDefinitionSchema, TagCatalogFileSchema, ResourceTaggingSchema, TagAnalyzeJobInputSchema,
} from './tagging.js';
import type {
  ProviderIdSchema, SourceIdSchema, SourceManifestSchema, SourceSnapshotSchema,
  ScheduledEventSchema, CalendarSourceViewSchema, OfficialReleaseSchema, OfficialReleaseSourceViewSchema,
  OfficialSourceDetailSchema, StaticSignalSourceHealthSchema, StaticSignalBoardSchema, PredictionMarketQuoteSchema,
  PredictionMarketSourceViewSchema, CryptoDerivativeQuoteSchema, CryptoDerivativesSourceViewSchema,
  StablecoinLiquidityMetricSchema, StablecoinLiquiditySourceViewSchema, MarketNativeSourceHealthSchema,
  MarketNativeBoardSchema,
} from './source.js';
import type {
  AgentToolReferenceSchema, AgentToolResultSchema, ContextBuildToolInputSchema,
  FeedSearchToolInputSchema, FeedTagSearchToolInputSchema, KnowledgeGetToolInputSchema, HoldingsRankToolInputSchema,
  StaticSignalsListToolInputSchema, OfficialSourceGetToolInputSchema, StockStatsToolInputSchema,
  AgentRunProgressStepSchema, ActiveAgentRunSchema, ReferenceInputSchema, CreateAgentRunInputSchema,
  AgentResearchModeSchema, AgentResearchProfileSchema, SaveStructuredArtifactToolInputSchema,
} from './agent.js';
import type {
  ArticleAnalysisSourceSchema, CreateArticleAnalysisInputSchema, ArticleAnalysisRunViewSchema,
} from './article-analysis.js';

export type SourceAccount = z.infer<typeof SourceAccountSchema>;
export type Subscription = z.infer<typeof SubscriptionSchema>;
export type Capture = z.infer<typeof CaptureSchema>;
export type ContentItem = z.infer<typeof ContentItemSchema>;
export type UserItemState = z.infer<typeof UserItemStateSchema>;
export type FeedItemTranslation = z.infer<typeof FeedItemTranslationSchema>;
export type FeedIdentityFingerprint = z.infer<typeof FeedIdentityFingerprintSchema>;
export type Instrument = z.infer<typeof InstrumentSchema>;
export type InstrumentAlias = z.infer<typeof InstrumentAliasSchema>;
export type QuoteSnapshot = z.infer<typeof QuoteSnapshotSchema>;
export type Portfolio = z.infer<typeof PortfolioSchema>;
export type Transaction = z.infer<typeof TransactionSchema>;
export type PersonalAssetDashboard = z.infer<typeof PersonalAssetDashboardSchema>;
export type PersonalAssetType = z.infer<typeof PersonalAssetTypeSchema>;
export type PersonalAssetAccount = z.infer<typeof PersonalAssetAccountSchema>;
export type PersonalAssetAccountView = z.infer<typeof PersonalAssetAccountViewSchema>;
export type PersonalAssetSnapshot = z.infer<typeof PersonalAssetSnapshotSchema>;
export type PersonalAssetImport = z.infer<typeof PersonalAssetImportSchema>;
export type PersonalAssetImportResult = z.infer<typeof PersonalAssetImportResultSchema>;
export type HoldingLot = z.infer<typeof HoldingLotSchema>;
export type HoldingsBoard = z.infer<typeof HoldingsBoardSchema>;
export type PortfolioImport = z.infer<typeof PortfolioImportSchema>;
export type PortfolioImportResult = z.infer<typeof PortfolioImportResultSchema>;
export type Inspiration = z.infer<typeof InspirationSchema>;
export type CreateInspirationInput = z.infer<typeof CreateInspirationInputSchema>;
export type Attachment = z.infer<typeof AttachmentSchema>;
export type CreateAttachmentInput = z.infer<typeof CreateAttachmentInputSchema>;
export type WorkPackage = z.infer<typeof WorkPackageSchema>;
export type CreateWorkPackageInput = z.infer<typeof CreateWorkPackageInputSchema>;
export type ContinueWorkPackageInput = z.infer<typeof ContinueWorkPackageInputSchema>;
export type WorkPackageGoal = z.infer<typeof WorkPackageGoalSchema>;
export type WorkPackageProgress = z.infer<typeof WorkPackageProgressSchema>;
export type WorkPackageParentTrace = z.infer<typeof WorkPackageParentTraceSchema>;
export type WorkPackageTrace = z.infer<typeof WorkPackageTraceSchema>;
export type AiSession = z.infer<typeof AiSessionSchema>;
export type AiSessionExchange = z.infer<typeof AiSessionExchangeSchema>;
export type AiRun = z.infer<typeof AiRunSchema>;
export type KnowledgeDocument = z.infer<typeof KnowledgeDocumentSchema>;
export type KnowledgeRevision = z.infer<typeof KnowledgeRevisionSchema>;
export type TaxonomyNode = z.infer<typeof TaxonomyNodeSchema>;
export type TaxonomyCatalog = z.infer<typeof TaxonomyCatalogSchema>;
export type TaxonomyAssignment = z.infer<typeof TaxonomyAssignmentSchema>;
export type StructuredArtifact = z.infer<typeof StructuredArtifactSchema>;
export type StructureJobInput = z.infer<typeof StructureJobInputSchema>;
export type StructureJobOutput = z.infer<typeof StructureJobOutputSchema>;
export type SaveStructuredArtifactInput = z.infer<typeof SaveStructuredArtifactInputSchema>;
export type ContextReference = z.infer<typeof ContextReferenceSchema>;
export type AiRunContextRef = z.infer<typeof AiRunContextRefSchema>;
export type AgentJob = z.infer<typeof AgentJobSchema>;
export type JobSchedule = z.infer<typeof JobScheduleSchema>;
export type DailyReport = z.infer<typeof DailyReportSchema>;
export type DailyReportContent = z.infer<typeof DailyReportContentSchema>;
export type GenerateDailyReportInput = z.infer<typeof GenerateDailyReportInputSchema>;
export type DailyBriefCandidate = z.infer<typeof DailyBriefCandidateSchema>;
export type DailyBriefModelInput = z.infer<typeof DailyBriefModelInputSchema>;
export type DailyBriefModelOutput = z.infer<typeof DailyBriefModelOutputSchema>;
export type DailyBrief = z.infer<typeof DailyBriefSchema>;
export type DailyMaterial = z.infer<typeof DailyMaterialSchema>;
export type DailyCoverage = z.infer<typeof DailyCoverageSchema>;
export type DailyEvidence = z.infer<typeof DailyEvidenceSchema>;
export type DailyTrackingQuestion = z.infer<typeof DailyTrackingQuestionSchema>;
export type DailyTrackingUpdate = z.infer<typeof DailyTrackingUpdateSchema>;
export type DailyAnalysisOutput = z.infer<typeof DailyAnalysisOutputSchema>;
export type DailyEditorialOutput = z.infer<typeof DailyEditorialOutputSchema>;
export type StockFactorSnapshot = z.infer<typeof StockFactorSnapshotSchema>;
export type StockStatistics = z.infer<typeof StockStatisticsSchema>;
export type StockStatsToolInput = z.infer<typeof StockStatsToolInputSchema>;
export type DomainEvent = z.infer<typeof DomainEventSchema>;
export type CapabilityManifest = z.infer<typeof CapabilityManifestSchema>;
export type WorkerJobConcurrency = z.infer<typeof WorkerJobConcurrencySchema>;
export type TagDefinition = z.infer<typeof TagDefinitionSchema>;
export type TagCatalogFile = z.infer<typeof TagCatalogFileSchema>;
export type ResourceTagging = z.infer<typeof ResourceTaggingSchema>;
export type TagAnalyzeJobInput = z.infer<typeof TagAnalyzeJobInputSchema>;
export type ProviderId = z.infer<typeof ProviderIdSchema>;
export type SourceId = z.infer<typeof SourceIdSchema>;
export type SourceManifest = z.infer<typeof SourceManifestSchema>;
export type SourceSnapshot = z.infer<typeof SourceSnapshotSchema>;
export type ScheduledEvent = z.infer<typeof ScheduledEventSchema>;
export type CalendarSourceView = z.infer<typeof CalendarSourceViewSchema>;
export type OfficialRelease = z.infer<typeof OfficialReleaseSchema>;
export type OfficialReleaseSourceView = z.infer<typeof OfficialReleaseSourceViewSchema>;
export type OfficialSourceDetail = z.infer<typeof OfficialSourceDetailSchema>;
export type StaticSignalSourceHealth = z.infer<typeof StaticSignalSourceHealthSchema>;
export type StaticSignalBoard = z.infer<typeof StaticSignalBoardSchema>;
export type PredictionMarketQuote = z.infer<typeof PredictionMarketQuoteSchema>;
export type PredictionMarketSourceView = z.infer<typeof PredictionMarketSourceViewSchema>;
export type CryptoDerivativeQuote = z.infer<typeof CryptoDerivativeQuoteSchema>;
export type CryptoDerivativesSourceView = z.infer<typeof CryptoDerivativesSourceViewSchema>;
export type StablecoinLiquidityMetric = z.infer<typeof StablecoinLiquidityMetricSchema>;
export type StablecoinLiquiditySourceView = z.infer<typeof StablecoinLiquiditySourceViewSchema>;
export type MarketNativeSourceHealth = z.infer<typeof MarketNativeSourceHealthSchema>;
export type MarketNativeBoard = z.infer<typeof MarketNativeBoardSchema>;
export type AgentToolReference = z.infer<typeof AgentToolReferenceSchema>;
export type AgentToolResult = z.infer<typeof AgentToolResultSchema>;
export type ContextBuildToolInput = z.infer<typeof ContextBuildToolInputSchema>;
export type FeedSearchToolInput = z.infer<typeof FeedSearchToolInputSchema>;
export type FeedTagSearchToolInput = z.infer<typeof FeedTagSearchToolInputSchema>;
export type KnowledgeGetToolInput = z.infer<typeof KnowledgeGetToolInputSchema>;
export type HoldingsRankToolInput = z.infer<typeof HoldingsRankToolInputSchema>;
export type StaticSignalsListToolInput = z.infer<typeof StaticSignalsListToolInputSchema>;
export type OfficialSourceGetToolInput = z.infer<typeof OfficialSourceGetToolInputSchema>;
export type AgentRunProgressStep = z.infer<typeof AgentRunProgressStepSchema>;
export type ActiveAgentRun = z.infer<typeof ActiveAgentRunSchema>;
export type ReferenceInput = z.infer<typeof ReferenceInputSchema>;
export type PackReferencesInput = z.infer<typeof PackReferencesInputSchema>;
export type CreateAgentRunInput = z.infer<typeof CreateAgentRunInputSchema>;
export type AgentResearchMode = z.infer<typeof AgentResearchModeSchema>;
export type AgentResearchProfile = z.infer<typeof AgentResearchProfileSchema>;
export type SaveStructuredArtifactToolInput = z.infer<typeof SaveStructuredArtifactToolInputSchema>;
export type ArticleAnalysisSource = z.infer<typeof ArticleAnalysisSourceSchema>;
export type CreateArticleAnalysisInput = z.infer<typeof CreateArticleAnalysisInputSchema>;
export type ArticleAnalysisRunView = z.infer<typeof ArticleAnalysisRunViewSchema>;

import type {HardwareQuoteRowSchema,HardwarePriceSnapshotInputSchema,HardwarePriceListQuerySchema,ImportedMediaArticleSchema} from './hardware-prices.js';
export type HardwareQuoteRow=z.infer<typeof HardwareQuoteRowSchema>;
export type HardwarePriceSnapshotInput=z.infer<typeof HardwarePriceSnapshotInputSchema>;
export type HardwarePriceListQuery=z.infer<typeof HardwarePriceListQuerySchema>;
export type ImportedMediaArticle=z.infer<typeof ImportedMediaArticleSchema>;

import type {HardwareQuoteViewSchema,HardwareSnapshotViewSchema,HardwarePriceListViewSchema,HardwarePriceDetailViewSchema,HardwarePriceSnapshotViewSchema} from "./hardware-prices.js";
export type HardwareQuoteView=z.infer<typeof HardwareQuoteViewSchema>;
export type HardwareSnapshotView=z.infer<typeof HardwareSnapshotViewSchema>;
import type {TreeNodeSchema,TreeEditionSchema,InformationOutputSchema,TreeModulesOutputSchema,PrepareTreeInformationInputSchema} from './information-tree.js';
export type PrepareTreeInformationInput=z.infer<typeof PrepareTreeInformationInputSchema>;
export type InformationTreeNode=z.infer<typeof TreeNodeSchema>;
export type InformationTreeEdition=z.infer<typeof TreeEditionSchema>;
export type InformationOutput=z.infer<typeof InformationOutputSchema>;
export type InformationTreeModulesOutput=z.infer<typeof TreeModulesOutputSchema>;
export type HardwarePriceListView=z.infer<typeof HardwarePriceListViewSchema>;
export type HardwarePriceDetailView=z.infer<typeof HardwarePriceDetailViewSchema>;
export type HardwarePriceSnapshotView=z.infer<typeof HardwarePriceSnapshotViewSchema>;
import type {ModelUsageToolInputSchema,ModelUsageSummarySchema} from './model-usage.js';
export type ModelUsageToolInput=z.infer<typeof ModelUsageToolInputSchema>;
export type ModelUsageSummary=z.infer<typeof ModelUsageSummarySchema>;

import type {ArticleOutputSchema} from './information-tree.js';
export type ArticleNormalizeOutput=z.infer<typeof ArticleOutputSchema>;
