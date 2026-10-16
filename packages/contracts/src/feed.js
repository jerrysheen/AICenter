import { z } from 'zod';
import {
  EntityIdSchema,
  EpochMillisSchema,
  HttpUrlSchema,
  MetadataSchema,
  NullableEpochMillisSchema,
  WorkspaceIdSchema,
} from './common.js';

export const SourceProviderSchema = z.enum(['manual', 'bilibili', 'x', 'youtube', 'rss', 'custom', 'trendforce', 'xueqiu', 'media']);
export const CaptureStatusSchema = z.enum(['captured', 'normalizing', 'ready', 'failed', 'ignored']);
export const ContentTypeSchema = z.enum(['post', 'article', 'video', 'audio', 'transcript', 'note']);

export const SourceAccountSchema = z.object({
  id: EntityIdSchema,
  workspaceId: WorkspaceIdSchema,
  provider: SourceProviderSchema,
  externalId: z.string().trim().min(1).max(256),
  handle: z.string().trim().max(256).default(''),
  displayName: z.string().trim().max(256).default(''),
  profileUrl: HttpUrlSchema.default(''),
  authMode: z.enum(['public', 'credential', 'browser-session']).default('public'),
  metadata: MetadataSchema,
  createdAt: EpochMillisSchema,
  updatedAt: EpochMillisSchema,
}).strict();

export const SubscriptionSchema = z.object({
  id: EntityIdSchema,
  workspaceId: WorkspaceIdSchema,
  sourceAccountId: EntityIdSchema,
  enabled: z.boolean(),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
  refreshIntervalMinutes: z.number().int().min(1).max(43_200),
  notificationPolicy: z.enum(['none', 'important', 'all']).default('none'),
  lastSyncAt: NullableEpochMillisSchema,
  nextSyncAt: NullableEpochMillisSchema,
  createdAt: EpochMillisSchema,
  updatedAt: EpochMillisSchema,
}).strict();

export const CaptureSchema = z.object({
  id: EntityIdSchema,
  workspaceId: WorkspaceIdSchema,
  provider: SourceProviderSchema,
  externalId: z.string().trim().min(1).max(512),
  sourceAccountId: EntityIdSchema.nullable(),
  sourceUrl: HttpUrlSchema.default(''),
  title: z.string().max(1_000).default(''),
  contentHash: z.string().trim().min(1).max(128),
  rawArtifactPath: z.string().trim().max(1_024).nullable(),
  status: CaptureStatusSchema,
  publishedAt: NullableEpochMillisSchema,
  capturedAt: EpochMillisSchema,
  metadata: MetadataSchema,
}).strict();

export const ContentItemSchema = z.object({
  id: EntityIdSchema,
  workspaceId: WorkspaceIdSchema,
  captureId: EntityIdSchema.nullable(),
  originType: z.enum(['manual', 'subscription', 'import', 'agent']),
  contentType: ContentTypeSchema,
  title: z.string().max(1_000).default(''),
  body: z.string().max(2_000_000).default(''),
  summary: z.string().max(20_000).default(''),
  sourceUrl: HttpUrlSchema.default(''),
  authorName: z.string().max(512).default(''),
  publishedAt: NullableEpochMillisSchema,
  createdAt: EpochMillisSchema,
  updatedAt: EpochMillisSchema,
}).strict();

export const UserItemStateSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  contentItemId: EntityIdSchema,
  isRead: z.boolean(),
  isSaved: z.boolean(),
  isHidden: z.boolean(),
  updatedAt: EpochMillisSchema,
}).strict();

export const PatchUserItemStateInputSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  contentItemId: EntityIdSchema,
  isRead: z.boolean().optional(),
  isSaved: z.boolean().optional(),
  isHidden: z.boolean().optional(),
}).strict().refine((value) => (
  value.isRead !== undefined || value.isSaved !== undefined || value.isHidden !== undefined
), { message: '至少更新一项阅读、收藏或隐藏状态' });

export const UpsertSourceAccountInputSchema = z.object({
  id: EntityIdSchema.optional(),
  workspaceId: WorkspaceIdSchema,
  provider: SourceProviderSchema,
  externalId: z.string().trim().min(1).max(256),
  handle: z.string().trim().max(256).default(''),
  displayName: z.string().trim().max(256).default(''),
  profileUrl: HttpUrlSchema.default(''),
  authMode: z.enum(['public', 'credential', 'browser-session']).default('public'),
  metadata: MetadataSchema,
}).strict();

export const UpsertSubscriptionInputSchema = z.object({
  id: EntityIdSchema.optional(),
  workspaceId: WorkspaceIdSchema,
  sourceAccountId: EntityIdSchema,
  enabled: z.boolean().default(true),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
  refreshIntervalMinutes: z.number().int().min(1).max(43_200).default(30),
  notificationPolicy: z.enum(['none', 'important', 'all']).default('none'),
  nextSyncAt: NullableEpochMillisSchema.default(null),
}).strict();

export const SaveCaptureInputSchema = z.object({
  id: EntityIdSchema.optional(),
  workspaceId: WorkspaceIdSchema,
  provider: SourceProviderSchema,
  externalId: z.string().trim().min(1).max(512),
  sourceAccountId: EntityIdSchema.nullable().default(null),
  sourceUrl: HttpUrlSchema.default(''),
  title: z.string().max(1_000).default(''),
  contentHash: z.string().trim().min(1).max(128),
  rawArtifactPath: z.string().trim().max(1_024).nullable().default(null),
  status: CaptureStatusSchema.default('captured'),
  publishedAt: NullableEpochMillisSchema.default(null),
  capturedAt: EpochMillisSchema.optional(),
  authorNativeId: z.string().trim().max(256).nullable().default(null),
  metadata: MetadataSchema,
}).strict();

export const SaveContentItemInputSchema = z.object({
  id: EntityIdSchema.optional(),
  workspaceId: WorkspaceIdSchema,
  captureId: EntityIdSchema.nullable().default(null),
  originType: z.enum(['manual', 'subscription', 'import', 'agent']),
  contentType: ContentTypeSchema,
  title: z.string().max(1_000).default(''),
  body: z.string().max(2_000_000).default(''),
  summary: z.string().max(20_000).default(''),
  sourceUrl: HttpUrlSchema.default(''),
  authorName: z.string().max(512).default(''),
  publishedAt: NullableEpochMillisSchema.default(null),
}).strict();

export const FEED_TRANSLATION_TEXT_MAX = 200_000;
export const FEED_TRANSLATION_OUTPUT_MAX = 200_000;

export const FeedItemTranslationSchema = z.object({
  itemId: EntityIdSchema,
  targetLang: z.enum(['zh', 'en']),
  sourceHash: z.string().trim().min(1).max(128),
  translatedText: z.string().trim().min(1).max(FEED_TRANSLATION_OUTPUT_MAX),
  engine: z.string().trim().max(32).default(''),
  updatedAt: EpochMillisSchema,
}).strict();

export const SaveFeedItemTranslationInputSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  itemId: EntityIdSchema,
  targetLang: z.enum(['zh', 'en']).default('zh'),
  sourceHash: z.string().trim().min(1).max(128),
  translatedText: z.string().trim().min(1).max(FEED_TRANSLATION_OUTPUT_MAX),
  engine: z.string().trim().max(32).default(''),
}).strict();

export const FeedAiPackedUnitSchema = z.object({
  itemId: EntityIdSchema,
  text: z.string().trim().min(1).max(FEED_TRANSLATION_TEXT_MAX),
  charCount: z.number().int().min(0),
  packedChars: z.number().int().min(0),
  truncatedForModel: z.boolean(),
  kind: z.enum(['feed-item', 'text']).default('feed-item'),
}).strict();

export const FeedAiBatchSchema = z.object({
  purpose: z.enum(['translate', 'analyze']),
  charBudget: z.number().int().min(500).max(50_000),
  totalChars: z.number().int().min(0),
  itemCount: z.number().int().min(1).max(50),
  units: z.array(FeedAiPackedUnitSchema).min(1).max(50),
}).strict();

export const FeedIdentityFingerprintSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  provider: SourceProviderSchema,
  identityHash: z.string().trim().min(1).max(128),
  externalId: z.string().trim().max(512).default(''),
  hiddenAt: NullableEpochMillisSchema,
  firstSeenAt: EpochMillisSchema,
  lastSeenAt: EpochMillisSchema,
}).strict();

export const UpsertFeedIdentityFingerprintInputSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  provider: SourceProviderSchema,
  identityHash: z.string().trim().min(1).max(128),
  externalId: z.string().trim().max(512).default(''),
  hiddenAt: NullableEpochMillisSchema.optional(),
}).strict();

export const FeedSubscriptionsSyncJobInputSchema = z.object({
  workspaceId: WorkspaceIdSchema.default('local'),
  limit: z.number().int().min(1).max(200).optional(),
  scheduledFor: EpochMillisSchema.optional(),
  scheduleKey: z.string().trim().min(1).max(128).optional(),
}).strict();

export const FeedSubscriptionSyncJobInputSchema = z.object({
  workspaceId: WorkspaceIdSchema.default('local'),
  subscriptionId: EntityIdSchema,
}).strict();

export const FeedItemsEnrichJobInputSchema = z.object({
  workspaceId: WorkspaceIdSchema.default('local'),
  resourceIds: z.array(EntityIdSchema).max(200).default([]),
  scheduledFor: EpochMillisSchema.optional(),
  scheduleKey: z.string().trim().min(1).max(128).optional(),
}).strict();

export const FeedTranslationJobInputSchema = z.object({
  workspaceId: WorkspaceIdSchema.default('local'),
  targetLang: z.enum(['zh', 'en']).default('zh'),
  items: z.array(z.object({
    id: z.string().trim().min(1).max(256),
    text: z.string().trim().min(1).max(FEED_TRANSLATION_TEXT_MAX),
  }).strict()).min(1).max(30),
}).strict().refine(value => new Set(value.items.map(item => item.id)).size === value.items.length, '翻译项目 ID 重复');
