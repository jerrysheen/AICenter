// Phase-1 compatibility adapter. New code should consume MarketCatalog through
// packages/source; this module remains until user acceptance permits cleanup.
import { DEFAULT_MARKET_CATALOG } from '../../source/src/market/catalog.js';

export const US_GROUPS = DEFAULT_MARKET_CATALOG.us.groups;
export const US_INDICES = DEFAULT_MARKET_CATALOG.us.indices;
export const US_WATCHLIST = DEFAULT_MARKET_CATALOG.us.watchlist;
