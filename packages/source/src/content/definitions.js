import { z } from 'zod';
import { ContentFeedViewSchema } from '../schemas.js';

const XInputSchema = z.object({
  feed: z.enum(['for-you', 'following']).default('for-you'),
  limit: z.coerce.number().int().min(1).max(50).default(50),
}).strict();

const BilibiliInputSchema = z.object({
  feed: z.literal('imports').default('imports'),
  url: z.string().max(2048).default(''),
}).strict();

export function createXSourceDefinition(service) {
  return {
    manifest: { id: 'content.x.home', title: 'X 首页', category: 'content', providerId: 'x', visibility: 'public', viewKind: 'content-feed', capabilities: ['read', 'refresh'], refresh: { ttlMs: 60_000 }, guideRefs: [] },
    inputSchema: XInputSchema,
    outputSchema: ContentFeedViewSchema,
    read: (input, context) => service.getFeed({
      ...input,
      bypassCache: Boolean(context.refresh),
      excludeExternalIds: context.excludeExternalIds,
    }),
    observedAt: (data) => data.fetchedAt,
    status: (data) => data.mode === 'error' ? 'unavailable' : data.mode === 'partial' ? 'partial' : 'ready',
    warnings: (data) => ['error', 'unavailable'].includes(data.mode) ? [data.note] : [],
    persistence: (input) => ({
      providerId: 'x',
      emptyNote: '还没有缓存。点抓取关注或抓取推荐会写入来源并去重保留。',
      sourceAccount: { externalId: `x:home:${input.feed}`, displayName: 'X 首页', profileUrl: 'https://x.com/home', authMode: 'browser-session' },
    }),
  };
}

export function createBilibiliSourceDefinition(service) {
  return {
    manifest: { id: 'content.bilibili.import', title: 'B站链接', category: 'content', providerId: 'bilibili', visibility: 'public', viewKind: 'content-feed', capabilities: ['read', 'refresh'], guideRefs: [] },
    inputSchema: BilibiliInputSchema,
    outputSchema: ContentFeedViewSchema,
    read: (input, context) => service.getFeed({ ...input, refresh: Boolean(context.refresh) }),
    observedAt: (data) => data.fetchedAt,
    status: (data) => data.mode === 'error' ? 'unavailable' : data.mode === 'unavailable' ? 'partial' : 'ready',
    warnings: (data) => ['error', 'unavailable'].includes(data.mode) ? [data.note] : [],
    persistence: () => ({
      providerId: 'bilibili',
      emptyNote: '还没有缓存。贴一条 B 站链接后会写入来源并按 BV 去重。',
      sourceAccount: { externalId: 'bilibili:imports', displayName: 'B站链接', profileUrl: 'https://www.bilibili.com', authMode: 'browser-session' },
    }),
  };
}

const XueqiuInputSchema = z.object({
  feed: z.enum(['following', 'featured', 'livenews']).default('following'),
  limit: z.coerce.number().int().min(1).max(50).default(50),
}).strict();

export function createXueqiuSourceDefinition(service) {
  return {
    manifest: { id: 'content.xueqiu.home', title: '雪球首页', category: 'content', providerId: 'xueqiu', visibility: 'public', viewKind: 'content-feed', capabilities: ['read', 'refresh'], refresh: { ttlMs: 60_000 }, guideRefs: [] },
    inputSchema: XueqiuInputSchema,
    outputSchema: ContentFeedViewSchema,
    read: (input, context) => service.getFeed({
      ...input,
      bypassCache: Boolean(context.refresh),
      excludeExternalIds: context.excludeExternalIds,
    }),
    observedAt: (data) => data.fetchedAt,
    status: (data) => data.mode === 'error' ? 'unavailable' : data.mode === 'partial' ? 'partial' : 'ready',
    warnings: (data) => ['error', 'unavailable'].includes(data.mode) ? [data.note] : [],
    persistence: (input) => ({
      providerId: 'xueqiu',
      emptyNote: '还没有缓存。点抓取关注、精选或 7x24 会写入来源并去重保留。',
      sourceAccount: {
        externalId: `xueqiu:home:${input.feed}`,
        displayName: input.feed === 'livenews' ? '雪球7x24' : input.feed === 'featured' ? '雪球精选' : '雪球关注',
        profileUrl: 'https://xueqiu.com/',
        authMode: 'browser-session',
      },
    }),
  };
}

const TrendForceInputSchema = z.object({
  feed: z.literal('public').default('public'),
}).strict();

export function createTrendForceSourceDefinition(service) {
  return {
    manifest: { id: 'content.trendforce.public', title: 'TrendForce', category: 'content', providerId: 'trendforce', visibility: 'public', viewKind: 'content-feed', capabilities: ['read', 'refresh'], refresh: { ttlMs: 600_000 }, guideRefs: [] },
    inputSchema: TrendForceInputSchema,
    outputSchema: ContentFeedViewSchema,
    read: (input, context) => service.getFeed({
      ...input,
      bypassCache: Boolean(context.refresh),
      excludeExternalIds: context.excludeExternalIds,
    }),
    observedAt: (data) => data.fetchedAt,
    status: (data) => data.mode === 'error' ? 'unavailable' : data.mode === 'partial' ? 'partial' : 'ready',
    warnings: (data) => ['error', 'unavailable'].includes(data.mode) ? [data.note] : [],
    persistence: () => ({
      providerId: 'trendforce',
      emptyNote: '还没有缓存。抓取后会写入公开洞察全文、会员报告索引和最新价表。',
      sourceAccount: { externalId: 'trendforce:public', displayName: 'TrendForce', profileUrl: 'https://www.trendforce.com.tw/insights', authMode: 'public' },
    }),
  };
}
