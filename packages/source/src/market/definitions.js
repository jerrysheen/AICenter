import { z } from 'zod';
import { HistorySeriesSchema, IndexWeightSeriesSchema, MarketBoardViewSchema, MarketMetricSeriesSchema, QuoteListSchema, SymbolSearchSchema } from '../schemas.js';
import { projectMarketBoardForAI, marketBoardAiWarnings } from '../source-projections.js';

const BoardInputSchema = z.object({
  extra: z.string().max(400).default(''),
  extraUs: z.string().max(400).default(''),
  extraAsia: z.string().max(400).default(''),
  extraCn: z.string().max(400).default(''),
}).strict();

const EmptyInputSchema = z.object({}).strict();
const QuoteInputSchema = z.object({
  symbols: z.array(z.string().trim().min(1).max(64)).min(1).max(200),
}).strict();
const HistoryInputSchema = z.object({
  symbols: z.array(z.string().trim().min(1).max(64)).min(1).max(200),
  range: z.string().trim().min(1).max(16).default('3mo'),
  interval: z.string().trim().min(1).max(16).default('1d'),
  ohlc: z.boolean().default(false),
}).strict();
const SearchInputSchema = z.object({ query: z.string().trim().min(1).max(64) }).strict();
const MetricHistoryInputSchema = z.object({
  symbol: z.string().trim().min(1).max(64),
  range: z.enum(['1mo', '3mo', '6mo', '1y', '2y', '5y', 'max']).default('5y'),
}).strict();
const IndexWeightInputSchema = z.object({
  index: z.string().trim().regex(/^\d{6}(?:\.(?:SH|SZ|SS))?$/i),
  range: z.enum(['1y', '2y', '5y', 'max']).default('5y'),
}).strict();

const boardMeta = {
  overview: ['市场概览', ['read', 'refresh']],
  cn: ['A股', ['read', 'refresh']],
  us: ['美股市场', ['read', 'refresh']],
  asia: ['亚洲市场', ['read', 'refresh']],
  global: ['全球资产', ['read', 'refresh']],
};

export function createMarketSourceDefinitions(marketService) {
  if (!marketService) throw new Error('market source definitions require a market service');
  const boards = Object.entries(boardMeta).map(([board, [title, capabilities]]) => ({
    manifest: {
      id: `market.${board}`,
      title,
      category: 'market',
      providerId: 'market-composite',
      visibility: 'public',
      viewKind: 'market-board',
      capabilities,
      refresh: { ttlMs: board === 'overview' ? 0 : 20_000 },
      guideRefs: board === 'global'
        ? ['finance.metric.us10y', 'finance.metric.dxy', 'finance.metric.vix']
        : [],
    },
    inputSchema: BoardInputSchema,
    outputSchema: MarketBoardViewSchema,
    read(input, context) {
      return marketService.getBoard({ board, ...input, refresh: Boolean(context.refresh) });
    },
    observedAt: (data) => data.fetchedAt,
    status: (data) => data.mode === 'live' ? 'ready' : 'partial',
    warnings: (data) => marketBoardAiWarnings(data),
    projectForAI: projectMarketBoardForAI,
  }));
  return [
    ...boards,
    {
      manifest: { id: 'market.quotes', title: '行情报价', category: 'market', providerId: 'market-composite', visibility: 'internal', viewKind: 'quote-list', capabilities: ['read', 'refresh'], refresh: { ttlMs: 3_000 }, guideRefs: [] },
      inputSchema: QuoteInputSchema,
      outputSchema: QuoteListSchema,
      read: (input, context) => marketService.fetchQuotes
        ? marketService.fetchQuotes(input.symbols, { refresh: Boolean(context.refresh) })
        : [],
    },
    {
      manifest: { id: 'market.history', title: '历史行情', category: 'market', providerId: 'market-composite', visibility: 'internal', viewKind: 'history-series', capabilities: ['read', 'refresh'], refresh: { ttlMs: 20_000 }, guideRefs: [] },
      inputSchema: HistoryInputSchema,
      outputSchema: HistorySeriesSchema,
      read: (input, context) => marketService.fetchHistory
        ? marketService.fetchHistory(input.symbols, {
          range: input.range,
          interval: input.interval,
          ohlc: Boolean(input.ohlc),
          refresh: Boolean(context.refresh),
        })
        : [],
    },
    {
      manifest: { id: 'market.search', title: '标的搜索', category: 'market', providerId: 'yahoo', visibility: 'internal', viewKind: 'quote-list', capabilities: ['read'], refresh: { ttlMs: 60_000 }, guideRefs: [] },
      inputSchema: SearchInputSchema,
      outputSchema: SymbolSearchSchema,
      read: (input) => marketService.search(input.query),
    },
    {
      manifest: {
        id: 'market.metrics.history',
        title: '个股指标历史',
        category: 'market',
        providerId: 'market-composite',
        visibility: 'internal',
        viewKind: 'metric-series',
        capabilities: ['read'],
        refresh: { ttlMs: 6 * 60 * 60_000 },
        guideRefs: [],
      },
      inputSchema: MetricHistoryInputSchema,
      outputSchema: MarketMetricSeriesSchema,
      read: (input) => (marketService.fetchMetricHistory
        ? marketService.fetchMetricHistory(input.symbol, { range: input.range })
        : {
          symbol: String(input.symbol || '').toUpperCase(),
          range: input.range,
          status: 'unavailable',
          points: [],
          factors: [],
          warnings: ['指标历史不可用'],
        }),
    },
    {
      manifest: {
        id: 'market.index.weights',
        title: '指数成分权重',
        category: 'market',
        providerId: 'market-composite',
        visibility: 'internal',
        viewKind: 'index-weights',
        capabilities: ['read'],
        refresh: { ttlMs: 12 * 60 * 60_000 },
        guideRefs: [],
      },
      inputSchema: IndexWeightInputSchema,
      outputSchema: IndexWeightSeriesSchema,
      read: (input) => (marketService.fetchIndexWeights
        ? marketService.fetchIndexWeights(input.index, { range: input.range })
        : {
          index: String(input.index || '').replace(/\D/g, '').slice(0, 6) || '000000',
          range: input.range,
          status: 'unavailable',
          snapshots: [],
          warnings: ['指数权重不可用'],
        }),
    },
  ];
}
