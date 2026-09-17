import { z } from 'zod';
import { HistorySeriesSchema, MarketBoardViewSchema, QuoteListSchema, SymbolSearchSchema } from '../schemas.js';
import { projectMarketBoardForAI, marketBoardAiWarnings } from '../source-projections.js';

const BoardInputSchema = z.object({
  extra: z.string().max(400).default(''),
  extraUs: z.string().max(400).default(''),
  extraAsia: z.string().max(400).default(''),
}).strict();

const EmptyInputSchema = z.object({}).strict();
const QuoteInputSchema = z.object({
  symbols: z.array(z.string().trim().min(1).max(64)).min(1).max(200),
}).strict();
const HistoryInputSchema = z.object({
  symbols: z.array(z.string().trim().min(1).max(64)).min(1).max(200),
  range: z.string().trim().min(1).max(16).default('3mo'),
  interval: z.string().trim().min(1).max(16).default('1d'),
}).strict();
const SearchInputSchema = z.object({ query: z.string().trim().min(1).max(64) }).strict();

const boardMeta = {
  overview: ['市场概览', ['read', 'refresh']],
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
      refresh: { ttlMs: 20_000 },
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
      manifest: { id: 'market.quotes', title: '行情报价', category: 'market', providerId: 'market-composite', visibility: 'internal', viewKind: 'quote-list', capabilities: ['read', 'refresh'], refresh: { ttlMs: 20_000 }, guideRefs: [] },
      inputSchema: QuoteInputSchema,
      outputSchema: QuoteListSchema,
      read: (input, context) => marketService.fetchQuotes
        ? marketService.fetchQuotes(input.symbols, { refresh: Boolean(context.refresh) })
        : [],
    },
    {
      manifest: { id: 'market.history', title: '历史行情', category: 'market', providerId: 'yahoo', visibility: 'internal', viewKind: 'history-series', capabilities: ['read', 'refresh'], refresh: { ttlMs: 20_000 }, guideRefs: [] },
      inputSchema: HistoryInputSchema,
      outputSchema: HistorySeriesSchema,
      read: (input, context) => marketService.fetchHistory
        ? marketService.fetchHistory(input.symbols, { range: input.range, interval: input.interval, refresh: Boolean(context.refresh) })
        : [],
    },
    {
      manifest: { id: 'market.search', title: '标的搜索', category: 'market', providerId: 'yahoo', visibility: 'internal', viewKind: 'quote-list', capabilities: ['read'], refresh: { ttlMs: 60_000 }, guideRefs: [] },
      inputSchema: SearchInputSchema,
      outputSchema: SymbolSearchSchema,
      read: (input) => marketService.search(input.query),
    },
  ];
}
