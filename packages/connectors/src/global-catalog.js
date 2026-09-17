// Phase-1 compatibility adapter. New code should consume MarketCatalog through
// packages/source; this module remains until user acceptance permits cleanup.
import { DEFAULT_MARKET_CATALOG } from '../../source/src/market/catalog.js';

export const GLOBAL_GROUPS = DEFAULT_MARKET_CATALOG.global.groups;
export const GLOBAL_WATCHLIST = DEFAULT_MARKET_CATALOG.global.watchlist;
