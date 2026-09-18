import { z } from 'zod';
import {
  CryptoDerivativesSourceViewSchema,
  PredictionMarketSourceViewSchema,
  StablecoinLiquiditySourceViewSchema,
} from '../../../contracts/src/index.js';

const CsvListSchema = z.preprocess((value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return value;
}, z.array(z.string().trim().min(1).max(128)).max(32));

export const PredictionMarketInputSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(12),
  query: z.string().trim().max(120).default(''),
  series: CsvListSchema.default([]),
}).strict();

export const CryptoDerivativesInputSchema = z.object({
  symbols: CsvListSchema.default(['BTC', 'ETH']),
}).strict();

export const StablecoinLiquidityInputSchema = z.object({
  assets: CsvListSchema.default(['USDT', 'USDC']),
  chains: CsvListSchema.default(['Ethereum', 'Solana', 'Tron', 'Base', 'Hyperliquid L1']),
}).strict();

const SOURCE_SPECS = Object.freeze([
  {
    id: 'market-native.prediction.polymarket', title: 'Polymarket 事件报价', providerId: 'polymarket',
    viewKind: 'prediction-market', method: 'polymarket', ttlMs: 60_000,
    inputSchema: PredictionMarketInputSchema, outputSchema: PredictionMarketSourceViewSchema,
    sourceUrl: 'https://gamma-api.polymarket.com/markets',
  },
  {
    id: 'market-native.prediction.kalshi', title: 'Kalshi 事件报价', providerId: 'kalshi',
    viewKind: 'prediction-market', method: 'kalshi', ttlMs: 60_000,
    inputSchema: PredictionMarketInputSchema, outputSchema: PredictionMarketSourceViewSchema,
    sourceUrl: 'https://external-api.kalshi.com/trade-api/v2/events',
  },
  {
    id: 'market-native.derivatives.hyperliquid', title: 'Hyperliquid 永续状态', providerId: 'hyperliquid',
    viewKind: 'crypto-derivatives', method: 'hyperliquid', ttlMs: 15_000,
    inputSchema: CryptoDerivativesInputSchema, outputSchema: CryptoDerivativesSourceViewSchema,
    sourceUrl: 'https://app.hyperliquid.xyz/trade',
  },
  {
    id: 'market-native.liquidity.stablecoins', title: '稳定币流动性', providerId: 'defillama',
    viewKind: 'stablecoin-liquidity', method: 'stablecoins', ttlMs: 21_600_000,
    inputSchema: StablecoinLiquidityInputSchema, outputSchema: StablecoinLiquiditySourceViewSchema,
    sourceUrl: 'https://defillama.com/stablecoins',
  },
]);

function unavailable(spec, observedAt, error) {
  const note = `市场原生来源暂不可读取：${String(error?.message || error || 'unavailable').replace(/\s+/g, ' ').slice(0, 300)}`;
  if (spec.viewKind === 'stablecoin-liquidity') {
    const empty = (key, label) => ({
      key, label, supplyUsd: null, change1dUsd: null, change7dUsd: null, change30dUsd: null,
    });
    return {
      available: false, observedAt, sourceUrl: spec.sourceUrl,
      total: empty('total', 'Total stablecoin supply'), assets: [], chains: [], note,
    };
  }
  return { available: false, observedAt, sourceUrl: spec.sourceUrl, quotes: [], note };
}

export function createMarketNativeSourceDefinitions(client, options = {}) {
  if (!client) throw new TypeError('market-native source definitions require a client');
  const now = options.now || (() => Date.now());
  return SOURCE_SPECS.map((spec) => ({
    manifest: {
      id: spec.id, title: spec.title, category: 'market', providerId: spec.providerId,
      visibility: 'public', viewKind: spec.viewKind, capabilities: ['read', 'refresh'],
      refresh: { ttlMs: spec.ttlMs }, guideRefs: [],
    },
    inputSchema: spec.inputSchema,
    outputSchema: spec.outputSchema,
    async read(input) {
      try { return await client[spec.method](input); }
      catch (error) { return unavailable(spec, now(), error); }
    },
    observedAt: (data) => data.observedAt,
    status: (data) => !data.available ? 'unavailable' : data.note ? 'partial' : 'ready',
    warnings: (data) => data.note ? [data.note] : [],
    projectForAI(data) { return data; },
  }));
}
