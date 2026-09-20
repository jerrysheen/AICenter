import { createCapabilityRegistry } from '../../runtime/src/capability-registry.js';
import {
  createBilibiliJobHandlers, createBilibiliService, bilibiliConnectorManifest,
} from '../../connectors/src/bilibili/index.js';
import {
  createXJobHandlers, createTwitterService, xConnectorManifest,
} from '../../connectors/src/x/index.js';
import {
  createTrendForceJobHandlers, createTrendForceService, trendforceConnectorManifest,
} from '../../connectors/src/trendforce.js';
import { createOfficialSourcesClient } from '../../connectors/src/official-sources.js';
import { createMarketNativeClient } from '../../connectors/src/market-native.js';
import { createBilibiliSourceDefinition, createTrendForceSourceDefinition, createXSourceDefinition } from './content/definitions.js';
import { createMarketSourceDefinitions } from './market/definitions.js';
import { createMarketService } from './market/service.js';
import { createWebSearchSourceDefinition } from './search/definitions.js';
import { createOfficialSourceDetailDefinition, createStaticSignalSourceDefinitions } from './static/definitions.js';
import { createMarketNativeSourceDefinitions } from './static/market-native-definitions.js';

export function createSourceModuleRegistry(options = {}) {
  const registry = createCapabilityRegistry();
  const twitterService = options.twitterService || createTwitterService(options);
  const trendforceService = options.trendforceService || createTrendForceService(options);
  const bilibiliService = options.bilibiliService || createBilibiliService({
    ...options,
    browserRuntime: options.browserRuntime,
  });
  const marketService = options.marketService || createMarketService(options);
  const officialSources = options.officialSources || createOfficialSourcesClient(options);
  const marketNativeSources = options.marketNativeSources || createMarketNativeClient(options);
  registry.register({
    manifest: {
      id: 'system.health', version: '1.0.0', capabilities: ['runtime.healthcheck'],
      jobTypes: ['system.healthcheck'], sourceIds: [],
    },
    jobHandlers: {
      'system.healthcheck': async (_input, context) => {
        const checkedAt = Date.now();
        context.store.setProviderHealth('worker', 'healthy', '后台 Worker 可以领取并完成任务', {
          workerId: context.workerId,
        });
        if (typeof options.browserRuntime?.health === 'function') {
          const health = await options.browserRuntime.health();
          context.store.setProviderHealth(
            'browser',
            health.available ? 'healthy' : 'error',
            health.available
              ? `浏览器采集已连接 · ${options.browserRuntime.providerId || 'browser'}`
              : (health.daemonConnected
                ? 'Browser Extension 未连接'
                : 'Browser daemon 未连接'),
            {
              available: health.available,
              daemonConnected: health.daemonConnected,
              browserConnected: health.browserConnected,
              browsers: health.browsers,
              provider: options.browserRuntime.providerId || null,
            },
          );
        }
        return { ok: true, checkedAt, workerId: context.workerId };
      },
    },
  });
  registry.register({
    manifest: xConnectorManifest,
    jobHandlers: createXJobHandlers(options),
    sources: [createXSourceDefinition(twitterService)],
  });
  registry.register({
    manifest: bilibiliConnectorManifest,
    jobHandlers: createBilibiliJobHandlers(options),
    sources: [createBilibiliSourceDefinition(bilibiliService)],
  });
  registry.register({
    manifest: trendforceConnectorManifest,
    jobHandlers: createTrendForceJobHandlers(options),
    sources: [createTrendForceSourceDefinition(trendforceService)],
  });
  const marketSources = createMarketSourceDefinitions(marketService);
  registry.register({
    manifest: {
      id: 'connector.market', version: '1.0.0', capabilities: ['market.read'], jobTypes: [],
      sourceIds: marketSources.map((source) => source.manifest.id),
    },
    sources: marketSources,
  });
  const staticSignalSources = createStaticSignalSourceDefinitions(officialSources, options);
  const officialDetailSource = createOfficialSourceDetailDefinition(officialSources, options);
  registry.register({
    manifest: {
      id: 'connector.official-sources', version: '1.0.0', capabilities: ['static-signal.read'], jobTypes: [],
      sourceIds: [...staticSignalSources.map((source) => source.manifest.id), officialDetailSource.manifest.id],
    },
    sources: [...staticSignalSources, officialDetailSource],
  });
  const marketNativeDefinitions = createMarketNativeSourceDefinitions(marketNativeSources, options);
  registry.register({
    manifest: {
      id: 'connector.market-native', version: '1.0.0', capabilities: ['market-native.read'], jobTypes: [],
      sourceIds: marketNativeDefinitions.map((source) => source.manifest.id),
    },
    sources: marketNativeDefinitions,
  });
  if (options.webSearchPort?.search) {
    registry.register({
      manifest: {
        id: `connector.${options.webSearchPort.id || 'search'}`, version: '1.0.0', capabilities: ['search.web'], jobTypes: [],
        sourceIds: ['search.web'],
      },
      sources: [createWebSearchSourceDefinition(options.webSearchPort)],
    });
  }
  return registry;
}

export function createConnectorHandlers(options = {}) {
  return createSourceModuleRegistry(options).createJobHandlers();
}
