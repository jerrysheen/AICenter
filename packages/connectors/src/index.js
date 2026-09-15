export { ConnectorProcessError, createJsonProcessAdapter } from './process-json-adapter.js';
export { createYahooClient, quoteFromSpark, parseMarketSession } from './yahoo.js';
export { createMarketService } from './market-service.js';
export { buildAsiaMarketBoard, buildOverviewBoard, buildUsMarketBoard, parseAsiaExtraSymbols, parseUsExtraSymbols } from './market-boards.js';
export { US_GROUPS, US_INDICES, US_WATCHLIST } from './us-catalog.js';
export { ASIA_GROUPS, ASIA_INDICES, ASIA_WATCHLIST } from './asia-catalog.js';

export function createConnectorHandlers() {
  return {
    'system.healthcheck': async (_input, context) => {
      const checkedAt = Date.now();
      context.store.setProviderHealth('worker', 'healthy', '后台 Worker 可以领取并完成任务', {
        workerId: context.workerId,
      });
      return { ok: true, checkedAt, workerId: context.workerId };
    },
  };
}
