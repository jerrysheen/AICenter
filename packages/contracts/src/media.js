import { z } from 'zod';

const epoch = z.number().int().nonnegative().nullable();
export const MediaSavedArticleQuerySchema = z.object({externalId:z.string().trim().min(1).max(512)}).strict();
export const MediaContentLevelSchema = z.enum(['title_only', 'summary_only', 'discovery', 'partial', 'full']);
export const MediaParagraphSchema = z.object({ id: z.string().regex(/^p\d{4,}$/), text: z.string().min(1).max(100_000), kind: z.enum(['paragraph', 'heading', 'table', 'list', 'quote']) }).strict();
export const MediaFetchStateSchema = z.object({
  fetchStatus: z.enum(['pending', 'ready', 'partial', 'failed', 'policy_skipped', 'deferred']),
  httpStatus: z.number().int().nullable(), extractionReason: z.string().max(500),
  attemptCount: z.number().int().nonnegative(), lastAttemptAt: epoch, nextRetryAt: epoch,
  failureCount: z.number().int().nonnegative().default(0),
  responseBytes: z.number().int().nonnegative(), extractedBytes: z.number().int().nonnegative(),
  paragraphCount: z.number().int().nonnegative(), extractionMethod: z.string().max(128), extractorVersion: z.string().max(64),
  fetchedRevision: z.number().int().nonnegative(), etag: z.string().max(1000), lastModified: z.string().max(1000),
  finalUrl: z.string().max(2048), author: z.string().max(512), publishedAtRaw: z.string().max(128), updatedAtRaw: z.string().max(128),
  selectedReason: z.string().max(500), visualEvidenceRequired: z.boolean(),
}).strict();
export const MediaBriefSchema = z.object({
  bodyHash: z.string().regex(/^[a-f0-9]{64}$/), snapshotRevision: z.number().int().positive(), text: z.string().trim().min(150).max(300),
  evidence: z.array(z.object({ paragraphId: z.string(), quote: z.string().trim().min(1).max(1000) }).strict()).min(1).max(5), generatedAt: z.number().int().nonnegative(),
}).strict();
export const MediaArticleTranslationSchema = z.object({
  status: z.enum(['pending', 'partial', 'ready']), bodyHash: z.string().regex(/^[a-f0-9]{64}$/),
  snapshotRevision: z.number().int().positive(), title: z.string().max(8000),
  paragraphs: z.array(MediaParagraphSchema), completedChunks: z.number().int().nonnegative(),
  totalChunks: z.number().int().nonnegative(), updatedAt: epoch,
}).strict().refine(value => value.completedChunks <= value.totalChunks && (
  value.status === 'ready' ? value.completedChunks === value.totalChunks && value.totalChunks > 0 && Boolean(value.title) && value.paragraphs.length > 0 :
  value.status === 'partial' ? value.completedChunks > 0 && value.completedChunks < value.totalChunks : value.completedChunks === 0
), 'inconsistent full translation state');
export const MediaConfigSchema = z.object({
  version: z.literal(1), timeZone: z.string().default('Asia/Shanghai'), focusKeywords: z.array(z.string().min(1).max(100)).max(100).default([]),
  budget: z.object({
    // null means unlimited; numeric limits remain supported for older instances.
    maxNewMetadataPerDay: z.number().int().positive().nullable().default(null), maxSelectedBodiesPerDay: z.number().int().positive().nullable().default(null),
    maxBodyRequestsPerDay: z.number().int().positive().nullable().default(null), maxSourceRequestsPerDay: z.number().int().positive().nullable().default(null),
    maxBodyBytes: z.number().int().positive().max(100_000).default(100_000), maxFeedBytes: z.number().int().positive().max(2_097_152).default(2_097_152),
    maxActiveSources: z.number().int().positive().max(24).default(6), backfillHours: z.number().int().positive().default(48),
    maxFeedNodes: z.number().int().positive().default(20_000), maxCardsPerEdition: z.number().int().positive().default(10),
    perOriginConcurrency: z.literal(1).default(1), totalConcurrency: z.number().int().min(1).max(3).default(3),
  }).prefault({}),
  sources: z.array(z.object({
    sourceKey: z.string().regex(/^[a-z0-9]+$/), publisher: z.string(), channel: z.enum(['tech', 'macro', 'candidate']),
    transport: z.enum(['rss', 'html', 'vendor_api', 'existing_adapter']), probeUrl: z.url(),
    allowedHosts: z.array(z.string()), articleHosts: z.array(z.string()), redirectHosts: z.array(z.string()).default([]),
    trackingParams: z.array(z.string()).default([]), identityParams: z.array(z.string()).default([]),
    contentAccess: z.enum(['body', 'index', 'discovery']), detailDailyCap: z.number().int().nonnegative().max(8).nullable().default(null),
    refreshMinutes: z.number().int().positive(), deployment: z.enum(['first', 'later', 'licensed', 'existing', 'recheck', 'candidate']), enabled: z.boolean().default(false),
    flash: z.boolean().default(false),
    sourceId: z.string().regex(/^policy\.[a-z0-9.-]+$/).optional(),
    backfillHours: z.number().int().min(1).max(2160).optional(),
    publisherKey: z.string().regex(/^[a-z0-9]+$/).optional(),
    channelName: z.string().min(1).max(128).optional(),
    channelUrl: z.url().optional(),
    listSelector: z.string().min(1).max(256).optional(),
    sourceAliases: z.array(z.string().regex(/^[a-z0-9]+$/)).max(4).default([]),
    listReadMethod: z.enum(['http', 'browser']).optional(),
    bodyReadMethod: z.enum(['http', 'browser']).optional(),
    listUrls: z.array(z.url()).max(4).optional(),
    maxListCandidates: z.number().int().min(1).max(100).optional(),
    maxNewBodiesPerRound: z.number().int().min(1).max(80).optional(),
    minRequestIntervalMs: z.number().int().min(0).max(120_000).optional(),
    includeKeywords: z.array(z.string().trim().min(1).max(100)).max(60).optional(),
    excludeKeywords: z.array(z.string().trim().min(1).max(100)).max(60).optional(),
  }).strict()).max(41),
  discoveryPublishers: z.array(z.object({
    sourceKey: z.string().regex(/^[a-z0-9]+$/), publisher: z.string().min(1),
    articleHosts: z.array(z.string().min(1)).min(1), pathPrefixes: z.array(z.string().startsWith('/')).min(1),
    redirectHosts: z.array(z.string()).default([]), detailDailyCap: z.number().int().positive().max(8).nullable().default(null),
    bodyUseAcknowledged: z.boolean().default(false),
  }).strict()).max(10).default([]),
}).strict().refine(v => {
  const keys=[...v.sources.flatMap(s=>[s.sourceKey,...s.sourceAliases]),...v.discoveryPublishers.map(s=>s.sourceKey)];
  return new Set(keys).size===keys.length;
}, 'duplicate media source or alias');

export const MediaDiscoverySchema = z.object({
  workspaceId: z.string().min(1), externalId: z.string().min(1).max(400), sourceKey: z.string().regex(/^[a-z0-9]+$/),
  entryUrl: z.string().max(2048), listPosition: z.number().int().nonnegative().nullable(),
  firstSeenAt: z.number().int().nonnegative(), lastSeenAt: z.number().int().nonnegative(),
}).strict();
