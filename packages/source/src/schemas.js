import { z } from 'zod';

const NullableNumberSchema = z.number().finite().nullable();

export const MarketQuoteViewSchema = z.looseObject({
  symbol: z.string().trim().min(1).max(64),
  name: z.string().max(256).default(''),
  lastPrice: NullableNumberSchema,
  change: NullableNumberSchema.optional(),
  changePct: NullableNumberSchema.optional(),
  prevClose: NullableNumberSchema.optional(),
  currency: z.string().max(16).default(''),
  session: z.string().max(32).default('closed'),
  asOf: z.number().int().nonnegative().nullable().optional(),
});

const BreadthSchema = z.looseObject({
  advancers: z.number().int().nonnegative(),
  decliners: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
});

const MarketSectionSchema = z.looseObject({
  id: z.string().trim().min(1).max(64),
  title: z.string().max(128),
  indices: z.array(MarketQuoteViewSchema),
  gainers: z.array(MarketQuoteViewSchema),
  losers: z.array(MarketQuoteViewSchema),
});

export const MarketBoardViewSchema = z.looseObject({
  board: z.enum(['overview', 'us', 'asia', 'cn', 'global']),
  mode: z.enum(['live', 'partial']),
  fetchedAt: z.number().int().nonnegative(),
  session: z.string().max(32),
  focus: z.enum(['us', 'cn']).optional(),
  note: z.string().max(1_000),
  groups: z.array(z.string()),
  indices: z.array(MarketQuoteViewSchema),
  watchlist: z.array(MarketQuoteViewSchema),
  gainers: z.array(MarketQuoteViewSchema),
  losers: z.array(MarketQuoteViewSchema),
  breadth: z.union([BreadthSchema, z.record(z.string(), BreadthSchema)]),
  sections: z.array(MarketSectionSchema).optional(),
});

export const QuoteListSchema = z.array(z.looseObject({
  symbol: z.string().trim().min(1).max(64),
  lastPrice: NullableNumberSchema,
  prevClose: NullableNumberSchema,
  currency: z.string().max(16).optional(),
  session: z.string().max(32).optional(),
}));

export const HistorySeriesSchema = z.array(z.object({
  symbol: z.string().trim().min(1).max(64),
  points: z.array(z.object({
    at: z.number().int().nonnegative(),
    close: z.number().finite(),
  }).strict()).max(20_000),
}).strict()).max(200);

export const SymbolSearchSchema = z.array(z.object({
  symbol: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(256),
  type: z.enum(['EQUITY', 'ETF', 'INDEX']),
  exchange: z.string().max(128),
}).strict()).max(20);

export const ContentFeedItemSchema = z.looseObject({
  externalId: z.string().trim().min(1).max(512),
  title: z.string().max(1_000).default(''),
  body: z.string().max(2_000_000).default(''),
  summary: z.string().max(20_000).default(''),
  sourceUrl: z.string().url(),
  authorName: z.string().max(512).default(''),
  publishedAt: z.number().int().nonnegative().default(0),
});

export const ContentFeedViewSchema = z.looseObject({
  platform: z.enum(['x', 'bilibili', 'trendforce', 'xueqiu']),
  feed: z.string().trim().min(1).max(64),
  source: z.string().max(128),
  mode: z.enum(['empty', 'live', 'partial', 'cached', 'error', 'unavailable']),
  fetchedAt: z.number().int().nonnegative(),
  note: z.string().max(1_000),
  items: z.array(ContentFeedItemSchema),
});

export const WebSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(20).default(5),
}).strict();

export const WebSearchResultSchema = z.object({
  title: z.string(),
  url: z.string().url(),
  snippet: z.string().default(''),
  engine: z.string().default(''),
  publishedAt: z.string().datetime({ offset: true }).nullable().default(null),
}).strict();

export const WebSearchViewSchema = z.object({
  query: z.string(),
  available: z.boolean(),
  results: z.array(WebSearchResultSchema).max(20),
  observedAt: z.number().int().nonnegative(),
  note: z.string().max(1_000).default(''),
}).strict();
