import { z } from 'zod';
import type { SourceAccountSchema, SubscriptionSchema, CaptureSchema, ContentItemSchema, UserItemStateSchema, FeedItemTranslationSchema } from './feed.js';
import type {
  InstrumentSchema, InstrumentAliasSchema, QuoteSnapshotSchema, PortfolioSchema, TransactionSchema,
  PersonalAssetDashboardSchema, HoldingLotSchema, HoldingsBoardSchema, PortfolioImportSchema,
  PortfolioImportResultSchema,
} from './trading.js';
import type {
  InspirationSchema, AiSessionSchema, AiSessionExchangeSchema, AiRunSchema,
  KnowledgeDocumentSchema, KnowledgeRevisionSchema, CreateInspirationInputSchema,
} from './knowledge.js';
import type {
  TaxonomyNodeSchema, TaxonomyCatalogSchema, TaxonomyAssignmentSchema, StructuredArtifactSchema,
  StructureJobInputSchema, StructureJobOutputSchema, SaveStructuredArtifactInputSchema,
} from './taxonomy.js';
import type { AiRunContextRefSchema, ContextReferenceSchema } from './context.js';
import type { AgentJobSchema, DomainEventSchema, CapabilityManifestSchema } from './runtime.js';
import type {
  TagDefinitionSchema, TagCatalogFileSchema, ResourceTaggingSchema, TagAnalyzeJobInputSchema,
} from './tagging.js';
import type { ProviderIdSchema, SourceIdSchema, SourceManifestSchema, SourceSnapshotSchema } from './source.js';
import type {
  AgentToolReferenceSchema, AgentToolResultSchema, ContextBuildToolInputSchema,
  FeedSearchToolInputSchema, FeedTagSearchToolInputSchema, KnowledgeGetToolInputSchema, HoldingsRankToolInputSchema,
  AgentRunProgressStepSchema, ReferenceInputSchema, CreateAgentRunInputSchema,
  SaveStructuredArtifactToolInputSchema,
} from './agent.js';

export type SourceAccount = z.infer<typeof SourceAccountSchema>;
export type Subscription = z.infer<typeof SubscriptionSchema>;
export type Capture = z.infer<typeof CaptureSchema>;
export type ContentItem = z.infer<typeof ContentItemSchema>;
export type UserItemState = z.infer<typeof UserItemStateSchema>;
export type FeedItemTranslation = z.infer<typeof FeedItemTranslationSchema>;
export type Instrument = z.infer<typeof InstrumentSchema>;
export type InstrumentAlias = z.infer<typeof InstrumentAliasSchema>;
export type QuoteSnapshot = z.infer<typeof QuoteSnapshotSchema>;
export type Portfolio = z.infer<typeof PortfolioSchema>;
export type Transaction = z.infer<typeof TransactionSchema>;
export type PersonalAssetDashboard = z.infer<typeof PersonalAssetDashboardSchema>;
export type HoldingLot = z.infer<typeof HoldingLotSchema>;
export type HoldingsBoard = z.infer<typeof HoldingsBoardSchema>;
export type PortfolioImport = z.infer<typeof PortfolioImportSchema>;
export type PortfolioImportResult = z.infer<typeof PortfolioImportResultSchema>;
export type Inspiration = z.infer<typeof InspirationSchema>;
export type CreateInspirationInput = z.infer<typeof CreateInspirationInputSchema>;
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
export type TagDefinition = z.infer<typeof TagDefinitionSchema>;
export type TagCatalogFile = z.infer<typeof TagCatalogFileSchema>;
export type ResourceTagging = z.infer<typeof ResourceTaggingSchema>;
export type TagAnalyzeJobInput = z.infer<typeof TagAnalyzeJobInputSchema>;
export type ProviderId = z.infer<typeof ProviderIdSchema>;
export type SourceId = z.infer<typeof SourceIdSchema>;
export type SourceManifest = z.infer<typeof SourceManifestSchema>;
export type SourceSnapshot = z.infer<typeof SourceSnapshotSchema>;
export type AgentToolReference = z.infer<typeof AgentToolReferenceSchema>;
export type AgentToolResult = z.infer<typeof AgentToolResultSchema>;
export type ContextBuildToolInput = z.infer<typeof ContextBuildToolInputSchema>;
export type FeedSearchToolInput = z.infer<typeof FeedSearchToolInputSchema>;
export type FeedTagSearchToolInput = z.infer<typeof FeedTagSearchToolInputSchema>;
export type KnowledgeGetToolInput = z.infer<typeof KnowledgeGetToolInputSchema>;
export type HoldingsRankToolInput = z.infer<typeof HoldingsRankToolInputSchema>;
export type AgentRunProgressStep = z.infer<typeof AgentRunProgressStepSchema>;
export type ReferenceInput = z.infer<typeof ReferenceInputSchema>;
export type CreateAgentRunInput = z.infer<typeof CreateAgentRunInputSchema>;
export type SaveStructuredArtifactToolInput = z.infer<typeof SaveStructuredArtifactToolInputSchema>;
