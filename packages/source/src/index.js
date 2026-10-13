export { createSourceHub, validateSourceDefinition } from './source-hub.js';
export { createSourceModuleRegistry, createConnectorHandlers } from './module-registry.js';
export { createMarketService } from './market/service.js';
export { DEFAULT_MARKET_CATALOG, MarketCatalogSchema, defaultMarketCatalogPath, readMarketCatalogFile, resolveMarketCatalog } from './market/catalog.js';
export * from './market/boards.js';
export { createMarketSourceDefinitions } from './market/definitions.js';
export { createXSourceDefinition, createBilibiliSourceDefinition, createTrendForceSourceDefinition, createXueqiuSourceDefinition } from './content/definitions.js';
export { createWebSearchSourceDefinition } from './search/definitions.js';
export {
  createStaticSignalSourceDefinitions, createOfficialSourceDetailDefinition, OfficialDetailInputSchema,
} from './static/definitions.js';
export {
  readStaticSignalBoard, readStaticSignalBoardSnapshot, projectStaticSignalBoard, emptyStaticSignalBoard,
  StaticSignalBoardInputSchema, createFailureStreakStore, installFailureStreakStore,
} from './static/board.js';
export { createStaticSignalBoardReader, STATIC_SIGNAL_BOARD_SNAPSHOT_KEY, STATIC_SIGNAL_BOARD_CACHE_TTL_MS } from './static/board-read.js';
export {
  createMarketBoardReader, emptyMarketBoard, marketBoardSnapshotKey, withExtraWatchlist,
  MARKET_BOARD_CACHE_TTL_MS, MARKET_BOARD_NAMES,
} from './market/board-read.js';
export {
  createMarketNativeSourceDefinitions,
  PredictionMarketInputSchema,
  CryptoDerivativesInputSchema,
  StablecoinLiquidityInputSchema,
} from './static/market-native-definitions.js';
export { readMarketNativeBoard, MarketNativeBoardInputSchema } from './static/market-native-board.js';
export {
  createMarketNativeBoardReader, emptyMarketNativeBoard, projectMarketNativeBoard,
  MARKET_NATIVE_BOARD_SNAPSHOT_KEY, MARKET_NATIVE_BOARD_CACHE_TTL_MS, MARKET_NATIVE_BOARD_CAPTURE_LIMIT,
} from './static/market-native-read.js';
export { projectMarketBoardForAI, projectGlobalMarketBoardForAI, projectOverviewMarketBoardForAI, marketBoardAiWarnings } from './source-projections.js';
