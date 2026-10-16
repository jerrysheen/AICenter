import { z } from 'zod';
import { ContentFeedViewSchema } from '../schemas.js';

function persistedSource({
  providerId,
  sourceId,
  sourceInput,
  autoRefresh,
  refreshIntervalMinutes,
  externalId,
  displayName,
  profileUrl,
  authMode,
  emptyNote,
}) {
  return {
    providerId,
    emptyNote,
    ...(refreshIntervalMinutes ? { refreshIntervalMinutes } : {}),
    sourceAccount: {
      externalId,
      displayName,
      profileUrl,
      authMode,
      metadata: {
        sourceId,
        sourceInput,
        autoRefresh,
      },
    },
  };
}

const XInputSchema = z.object({
  feed: z.enum(['for-you', 'following']).default('for-you'),
  limit: z.coerce.number().int().min(1).max(50).default(50),
}).strict();

const BilibiliInputSchema = z.object({
  feed: z.literal('imports').default('imports'),
  url: z.string().max(2048).default(''),
}).strict();

export function defaultAutoRefreshProjections() {
  const unused = { getFeed() { return { items: [] }; } };
  const x = createXSourceDefinition(unused);
  const xueqiu = createXueqiuSourceDefinition(unused);
  return [
    x.persistence({ feed: 'following', limit: 50 }),
    x.persistence({ feed: 'for-you', limit: 50 }),
    xueqiu.persistence({ feed: 'following', limit: 50 }),
    xueqiu.persistence({ feed: 'featured', limit: 50 }),
    xueqiu.persistence({ feed: 'livenews', limit: 50 }),
  ];
}

export function createXSourceDefinition(service) {
  return {
    manifest: { id: 'content.x.home', title: 'X 首页', category: 'content', providerId: 'x', visibility: 'public', viewKind: 'content-feed', capabilities: ['read', 'refresh'], refresh: { ttlMs: 60_000 }, guideRefs: [] },
    inputSchema: XInputSchema,
    outputSchema: ContentFeedViewSchema,
    read: async (input, context) => {
      const {priceSnapshots:_prices,...feed}=await service.getFeed({...input,bypassCache:Boolean(context.refresh),excludeExternalIds:context.excludeExternalIds,signal:context.signal,deadlineAt:context.deadlineAt});return feed;
    },
    observedAt: (data) => data.fetchedAt,
    status: (data) => data.mode === 'error' ? 'unavailable' : data.mode === 'partial' ? 'partial' : 'ready',
    warnings: (data) => ['error', 'unavailable'].includes(data.mode) ? [data.note] : [],
    persistence: (input) => persistedSource({
      providerId: 'x',
      sourceId: 'content.x.home',
      sourceInput: { feed: input.feed },
      autoRefresh: true,
      refreshIntervalMinutes: 30,
      externalId: `x:home:${input.feed}`,
      displayName: 'X 首页',
      profileUrl: 'https://x.com/home',
      authMode: 'browser-session',
      emptyNote: '还没有缓存。点抓取关注或抓取推荐会写入来源并去重保留。',
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
    persistence: () => persistedSource({
      providerId: 'bilibili',
      sourceId: 'content.bilibili.import',
      sourceInput: { feed: 'imports' },
      autoRefresh: false,
      externalId: 'bilibili:imports',
      displayName: 'B站链接',
      profileUrl: 'https://www.bilibili.com',
      authMode: 'browser-session',
      emptyNote: '还没有缓存。贴一条 B 站链接后会写入来源并按 BV 去重。',
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
    read: async (input, context) => {
      const {priceSnapshots:_prices,...view}=await service.getFeed({...input,bypassCache:Boolean(context.refresh),excludeExternalIds:context.excludeExternalIds,signal:context.signal,deadlineAt:context.deadlineAt});
      return view;
    },
    observedAt: (data) => data.fetchedAt,
    status: (data) => data.mode === 'error' ? 'unavailable' : data.mode === 'partial' ? 'partial' : 'ready',
    warnings: (data) => ['error', 'unavailable'].includes(data.mode) ? [data.note] : [],
    persistence: (input) => persistedSource({
      providerId: 'xueqiu',
      sourceId: 'content.xueqiu.home',
      sourceInput: { feed: input.feed },
      autoRefresh: true,
      refreshIntervalMinutes: 30,
      externalId: `xueqiu:home:${input.feed}`,
      displayName: input.feed === 'livenews' ? '雪球7x24' : input.feed === 'featured' ? '雪球精选' : '雪球关注',
      profileUrl: 'https://xueqiu.com/',
      authMode: 'browser-session',
      emptyNote: '还没有缓存。点抓取关注、精选或 7x24 会写入来源并去重保留。',
    }),
  };
}

import { HardwarePriceSnapshotInputSchema } from '../../../contracts/src/hardware-prices.js';
const TrendForceInputSchema = z.object({
  feed: z.literal('public').default('public'),
}).strict();

const MediaInputSchema = z.object({
  channel: z.enum(['tech', 'macro']).default('tech'),
}).strict();

export function createMediaSourceDefinition(service) {
  return {
    manifest: {
      id: 'content.media.articles',
      title: '媒体资讯',
      category: 'content',
      providerId: 'media',
      visibility: 'public',
      viewKind: 'content-feed',
      capabilities: ['read', 'refresh'],
      refresh: { ttlMs: 120_000 },
      guideRefs: [],
    },
    inputSchema: MediaInputSchema,
    outputSchema: ContentFeedViewSchema,
    read: (input,context) => service.readFeed(input,{workspaceId:context.workspaceId || 'local'}),
    observedAt: (data) => data.fetchedAt,
    status: (data) => data.mode === 'empty' ? 'partial' : 'ready',
    warnings: (data) => data.mode === 'empty' ? [data.note] : [],
    persistence: (input) => persistedSource({
      providerId: 'media',
      sourceId: 'content.media.articles',
      sourceInput: { channel: input.channel },
      autoRefresh: false,
      refreshIntervalMinutes: 120,
      externalId: `media:articles:${input.channel}`,
      displayName: input.channel === 'macro' ? '宏观与国际' : '产业科技',
      profileUrl: '',
      authMode: 'public',
      emptyNote: '来源默认关闭。主机探针确认后才启用第一批 RSS。',
    }),
  };
}

export function createTrendForceSourceDefinition(service, options = {}) {
  return {
    manifest: { id: 'content.trendforce.public', title: 'TrendForce', category: 'content', providerId: 'trendforce', visibility: 'public', viewKind: 'content-feed', capabilities: ['read', 'refresh'], refresh: { ttlMs: 600_000 }, guideRefs: [] },
    inputSchema: TrendForceInputSchema,
    outputSchema: ContentFeedViewSchema,
    read: async (input, context) => {
      if(options.readTrendforceStored)return options.readTrendforceStored(context.workspaceId || 'local');
      const {priceSnapshots:_prices,...view}=await service.getFeed({...input,bypassCache:Boolean(context.refresh),excludeExternalIds:context.excludeExternalIds});
      return view;
    },
    observedAt: (data) => data.fetchedAt,
    status: (data) => data.mode === 'error' ? 'unavailable' : data.mode === 'partial' ? 'partial' : 'ready',
    warnings: (data) => ['error', 'unavailable'].includes(data.mode) ? [data.note] : [],
    persistence: () => persistedSource({
      providerId: 'trendforce',
      sourceId: 'content.trendforce.public',
      sourceInput: { feed: 'public' },
      autoRefresh: true,
      refreshIntervalMinutes: 120,
      externalId: 'trendforce:public',
      displayName: 'TrendForce',
      profileUrl: 'https://www.trendforce.com.tw/insights',
      authMode: 'public',
      emptyNote: '还没有缓存。抓取后会写入公开洞察全文、会员报告索引和最新价表。',
    }),
  };
}

export function createTrendForceCollectionDefinition(service) {
  return {manifest:{id:'content.trendforce.collection',title:'TrendForce 采集',category:'content',providerId:'trendforce',visibility:'internal',viewKind:'content-feed',capabilities:['read','refresh'],refresh:{ttlMs:600000},guideRefs:[]},
    inputSchema:TrendForceInputSchema,outputSchema:ContentFeedViewSchema.extend({priceSnapshots: z.array(HardwarePriceSnapshotInputSchema).default([])}),
    read:(input,context)=>service.getFeed({...input,bypassCache:Boolean(context.refresh),excludeExternalIds:context.excludeExternalIds || []}),observedAt:data=>data.fetchedAt,
    status:data=>data.mode==='error'?'unavailable':data.mode==='partial'?'partial':'ready',warnings:data=>data.mode==='error'?[data.note]:[]};
}
