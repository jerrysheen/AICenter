// Phase-1 compatibility adapter. New code should consume MarketCatalog through
// packages/source; this module remains until user acceptance permits cleanup.
import { DEFAULT_MARKET_CATALOG } from '../../source/src/market/catalog.js';

export const ASIA_GROUPS = DEFAULT_MARKET_CATALOG.asia.groups;
export const ASIA_INDICES = DEFAULT_MARKET_CATALOG.asia.indices;
export const ASIA_WATCHLIST = DEFAULT_MARKET_CATALOG.asia.watchlist;
