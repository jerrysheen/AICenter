export { createSourceHub, validateSourceDefinition } from './source-hub.js';
export { createSourceModuleRegistry, createConnectorHandlers } from './module-registry.js';
export { createMarketService } from './market/service.js';
export { DEFAULT_MARKET_CATALOG, MarketCatalogSchema, defaultMarketCatalogPath, readMarketCatalogFile, resolveMarketCatalog } from './market/catalog.js';
export * from './market/boards.js';
export { createMarketSourceDefinitions } from './market/definitions.js';
export { createXSourceDefinition, createBilibiliSourceDefinition } from './content/definitions.js';
export { createWebSearchSourceDefinition } from './search/definitions.js';
export { projectMarketBoardForAI, projectGlobalMarketBoardForAI, projectOverviewMarketBoardForAI, marketBoardAiWarnings } from './source-projections.js';
