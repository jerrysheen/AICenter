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
export { readStaticSignalBoard, StaticSignalBoardInputSchema } from './static/board.js';
export {
  createMarketNativeSourceDefinitions,
  PredictionMarketInputSchema,
  CryptoDerivativesInputSchema,
  StablecoinLiquidityInputSchema,
} from './static/market-native-definitions.js';
export { readMarketNativeBoard, MarketNativeBoardInputSchema } from './static/market-native-board.js';
export { projectMarketBoardForAI, projectGlobalMarketBoardForAI, projectOverviewMarketBoardForAI, marketBoardAiWarnings } from './source-projections.js';
