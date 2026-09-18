import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const directory = path.dirname(fileURLToPath(import.meta.url));
export const defaultMarketCatalogPath = path.resolve(directory, '../../../../config/markets.default.json');

const CatalogItemSchema = z.object({
  symbol: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(128),
  group: z.string().trim().min(1).max(64),
  summary: z.string().trim().max(500).default(''),
}).strict();

const GlobalCatalogItemSchema = CatalogItemSchema.extend({
  yahoo: z.string().trim().min(1).max(64),
  market: z.enum(['cn', 'hk', 'us', 'global']),
  assetClass: z.enum(['equity', 'index', 'fx', 'rate', 'metal', 'energy', 'future', 'crypto', 'fund', 'cash']),
  currency: z.string().trim().regex(/^[A-Z]{3,8}$/),
}).strict();

const EquitySectionSchema = z.object({
  groups: z.array(z.string().trim().min(1).max(64)).min(1).max(64),
  indices: z.array(CatalogItemSchema).max(32),
  watchlist: z.array(CatalogItemSchema).max(500),
}).strict();

const EMPTY_CN_SECTION = Object.freeze({
  groups: ['全部', '自选'],
  indices: [],
  watchlist: [],
});

export const MarketCatalogSchema = z.object({
  version: z.literal(1),
  us: EquitySectionSchema,
  asia: EquitySectionSchema,
  cn: EquitySectionSchema.default(EMPTY_CN_SECTION),
  global: z.object({
    groups: z.array(z.string().trim().min(1).max(64)).min(1).max(64),
    watchlist: z.array(GlobalCatalogItemSchema).max(500),
  }).strict(),
}).strict().superRefine((catalog, ctx) => {
  for (const [sectionName, section] of Object.entries(catalog)) {
    if (sectionName === 'version') continue;
    const items = [...(section.indices || []), ...(section.watchlist || [])];
    const seen = new Set();
    for (const item of items) {
      const key = `${item.symbol.toUpperCase()}::${item.group}`;
      if (seen.has(key)) {
        ctx.addIssue({ code: 'custom', path: [sectionName, 'watchlist'], message: `重复的市场标的: ${item.symbol} / ${item.group}` });
        return;
      }
      seen.add(key);
      if (!section.groups.includes(item.group) && item.group !== '指数') {
        ctx.addIssue({ code: 'custom', path: [sectionName, 'groups'], message: `未声明的市场分组: ${item.group}` });
        return;
      }
    }
  }
});

export function readMarketCatalogFile(filePath = defaultMarketCatalogPath, options = {}) {
  const readFile = options.readFileSync || readFileSync;
  const text = readFile(path.resolve(filePath), 'utf8');
  return Object.freeze(MarketCatalogSchema.parse(JSON.parse(text)));
}

export function resolveMarketCatalog(configuredPath, options = {}) {
  const exists = options.existsSync || existsSync;
  const fallbackPath = options.fallbackPath || defaultMarketCatalogPath;
  const selected = configuredPath && exists(configuredPath) ? configuredPath : fallbackPath;
  return readMarketCatalogFile(selected, options);
}

export const DEFAULT_MARKET_CATALOG = readMarketCatalogFile(defaultMarketCatalogPath);
