import { z } from 'zod';
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
import type { AgentJobSchema, DomainEventSchema, CapabilityManifestSchema, WorkerJobConcurrencySchema } from './runtime.js';
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
  StaticSignalsListToolInputSchema, OfficialSourceGetToolInputSchema,
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
