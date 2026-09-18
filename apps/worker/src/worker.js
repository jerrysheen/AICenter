import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createConfiguredBrowserRuntime, createDoubaoConnector, createDoubaoJsonlTagPort, createElucidGrokAgentClient, createGeminiAgentClient, createLocalKnowledgeFiles, createPersonalAssetService, createSearxngSearchProvider } from '../../../packages/connectors/src/index.js';
import { createStore } from '../../../packages/database/src/index.js';
import { createFeedService } from '../../../packages/domain/src/feed-service.js';
import { createKnowledgeService } from '../../../packages/domain/src/knowledge-service.js';
import { createTaggingService } from '../../../packages/domain/src/tagging-service.js';
import { createTradingService } from '../../../packages/domain/src/trading-service.js';
import { createContextService } from '../../../packages/domain/src/context-service.js';
import { resolveInstanceConfig } from '../../../packages/instance/src/index.js';
import { createAgentRuntime } from '../../../packages/runtime/src/agent-runtime.js';
import { agentRuntimeManifest, createAgentJobHandlers } from '../../../packages/runtime/src/agent-module.js';
import { knowledgeStructureManifest, createStructureJobHandlers } from '../../../packages/runtime/src/structure-module.js';
import { taggingManifest, createTaggingJobHandlers, readTagCatalogFile } from '../../../packages/runtime/src/tagging-module.js';
import { createJobRunner } from '../../../packages/runtime/src/job-runner.js';
import { createLocalToolRegistry } from '../../../packages/runtime/src/local-tools.js';
import { createAgentTraceLog } from '../../../packages/runtime/src/agent-trace-log.js';
import { createSourceHub, createSourceModuleRegistry } from '../../../packages/source/src/index.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(currentDirectory, '../../..');
resolveInstanceConfig({ repositoryRoot });

function createConfiguredAgentClient() {
  const provider = String(process.env.AI_CENTER_AGENT_PROVIDER || '').trim().toLowerCase();
  if (provider === 'gemini') return createGeminiAgentClient();
  if (provider === 'elucid-grok' || process.env.ELUCID_GROK_API_KEY || process.env.AI_CENTER_GROK_API_KEY) {
    return createElucidGrokAgentClient();
  }
  return createGeminiAgentClient();
}

function createOptionalSearchPort(explicit) {
  if (explicit !== undefined) return explicit;
  if (String(process.env.AI_CENTER_SEARCH_DISABLED || '').trim() === '1') return null;
  try {
    return createSearxngSearchProvider();
  } catch (error) {
    console.error('[worker] web.search 未启用：', error?.message || error);
    return null;
  }
}

export function createAiCenterWorker(options = {}) {
  const instance = options.instanceConfig || resolveInstanceConfig({
    repositoryRoot,
    env: options.env || process.env,
    overrides: {
      instanceRoot: options.instanceRoot,
      instanceId: options.instanceId,
      dataDirectory: options.dataDirectory,
      knowledgeDirectory: options.knowledgeDirectory,
      configDirectory: options.configDirectory,
      importsDirectory: options.importsDirectory,
      runtimeDirectory: options.runtimeDirectory,
      assetWorkbookPath: options.assetWorkbookPath,
      browserId: options.browserId,
    },
  });
  const dataDirectory = instance.dataDirectory;
  const store = options.store || createStore(instance.databasePath);
  const staleAfterMs = Number(options.staleAfterMs || process.env.AI_CENTER_WORKER_LEASE_MS) || 10 * 60_000;
  store.recoverStaleJobs(staleAfterMs);
  const webSearchPort = createOptionalSearchPort(options.webSearchPort);
  const browserRuntime = options.browserRuntime || createConfiguredBrowserRuntime({
    env: options.env || process.env,
    defaultBrowserId: instance.browserId,
  });
  const doubao = options.doubaoConnector || (browserRuntime
    ? createDoubaoConnector({ browserRuntime })
    : null);
  let feedService;
  const registry = options.moduleRegistry || createSourceModuleRegistry({
    twitterService: options.twitterService,
    bilibiliService: options.bilibiliService,
    marketService: options.marketService,
    officialSources: options.officialSources,
    marketNativeSources: options.marketNativeSources,
    webSearchPort,
    browserRuntime,
    marketCatalog: options.marketCatalog,
    marketCatalogPath: instance.marketCatalogPath,
    syncFeed: (...args) => feedService.getExternalFeed(...args),
  });
  const sourcePort = options.sourcePort || createSourceHub(registry);
  feedService = options.feedService || createFeedService({
    legacyRepository: store,
    feedRepository: store.repositories.feed,
    sourcePort,
  });
  const knowledgeService = options.knowledgeService || createKnowledgeService({
    legacyRepository: store,
    knowledgeRepository: store.repositories.knowledge,
    fileKnowledgePort: options.fileKnowledgePort || createLocalKnowledgeFiles({
      rootDirectory: instance.knowledgeDirectory,
    }),
  });
  const tradingService = options.tradingService || createTradingService({
    tradingRepository: store.repositories.trading,
    sourcePort,
    personalAssetPort: options.personalAssetService || createPersonalAssetService({
      dataDirectory,
      workbookPath: instance.assetWorkbookPath,
    }),
  });
  const taggingService = options.taggingService || createTaggingService({
    catalog: options.tagCatalog || readTagCatalogFile(
      existsSync(instance.tagCatalogPath) ? instance.tagCatalogPath : path.join(repositoryRoot, 'config/tags.default.json'),
    ),
    taggingRepository: store.repositories.tagging,
    taggingPort: options.taggingPort || (doubao
      ? createDoubaoJsonlTagPort({ queue: doubao.queue })
      : null),
  });
  const contextService = options.contextService || createContextService({
    feedService,
    tradingService,
    knowledgeService,
  });
  const agentClient = options.agentClient || createConfiguredAgentClient();
  const agentRuntime = options.agentRuntime || createAgentRuntime({
    llm: agentClient,
    tools: options.agentTools || createLocalToolRegistry({
      contextService, feedService, knowledgeService, tradingService, taggingService, sourcePort,
    }),
  });
  const agentTraceLog = options.agentTraceLog
    || (options.store && !options.dataDirectory && !options.instanceConfig
      ? null
      : createAgentTraceLog({
        dataDirectory,
        logDirectory: instance.legacyLayout ? undefined : path.join(instance.runtimeDirectory, 'logs'),
      }));
  registry.register({
    manifest: agentRuntimeManifest,
    jobHandlers: createAgentJobHandlers({ agentRuntime, knowledgeService, contextService, agentTraceLog }),
  });
  registry.register({
    manifest: knowledgeStructureManifest,
    jobHandlers: options.structureJobHandlers || createStructureJobHandlers({
      llm: agentClient,
      knowledgeService,
      contextService,
    }),
  });
  registry.register({
    manifest: taggingManifest,
    jobHandlers: options.taggingJobHandlers || createTaggingJobHandlers({
      taggingService,
      feedService,
      knowledgeService,
    }),
  });
  const runner = createJobRunner({
    store,
    handlers: options.handlers || registry.createJobHandlers(),
    workerId: options.workerId || `${hostname()}-${process.pid}`,
    pollIntervalMs: options.pollIntervalMs || process.env.AI_CENTER_WORKER_POLL_MS,
    staleAfterMs,
    recoverEveryMs: options.recoverEveryMs || process.env.AI_CENTER_WORKER_RECOVER_MS,
    onError(error, job) {
      console.error(`[worker] ${job.type} ${job.id}:`, error);
    },
  });
  let runPromise = null;

  return {
    store,
    runner,
    browserRuntime,
    start() {
      runPromise ||= runner.start();
      return runPromise;
    },
    async close() {
      runner.stop();
      try {
        await runPromise;
      } finally {
        store.close();
      }
    },
  };
}

async function main() {
  const worker = createAiCenterWorker();
  console.log(`AI Center worker ${worker.runner.workerId}`);
  try {
    const health = await worker.browserRuntime?.health?.();
    if (health) {
      console.log(`[worker] browser provider=${worker.browserRuntime.providerId} daemon=${health.daemonConnected} extension=${health.browserConnected} browsers=${health.browsers}`);
    }
  } catch (error) {
    console.error('[worker] browser health failed:', error instanceof Error ? error.message : error);
  }
  const runPromise = worker.start();
  const shutdown = async () => {
    await worker.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await runPromise;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
