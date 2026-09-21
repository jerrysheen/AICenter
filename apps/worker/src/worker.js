import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createConfiguredBrowserRuntime, createCursorSessionPort, createDeepSeekSearchProvider, createDoubaoAuxiliarySearch, createElucidGrokAgentClient, createGeminiTagPort, createLauncherRestartPort, createLocalKnowledgeFiles, createPersonalAssetService, createTypeSafeSystemOneClient } from '../../../packages/connectors/src/index.js';
import { createAgentQualityLayerFromEnv } from '../../../packages/runtime/src/agent-quality.js';
import { articleAnalysisManifest, createArticleAnalysisJobHandlers } from '../../../packages/runtime/src/article-analysis/article-analysis-module.js';
import { createAttachmentStore, createStore } from '../../../packages/database/src/index.js';
import { createFeedFilterFromEnv } from '../../../packages/domain/src/feed-filter.js';
import { createFeedService } from '../../../packages/domain/src/feed-service.js';
import { createKnowledgeService } from '../../../packages/domain/src/knowledge-service.js';
import { createTaggingService } from '../../../packages/domain/src/tagging-service.js';
import { createTradingService } from '../../../packages/domain/src/trading-service.js';
import { createContextService } from '../../../packages/domain/src/context-service.js';
import { resolveInstanceConfig } from '../../../packages/instance/src/index.js';
import { createAgentRuntime } from '../../../packages/runtime/src/agent-runtime.js';
import { agentRuntimeManifest, createAgentJobHandlers } from '../../../packages/runtime/src/agent-module.js';
import {
  createHarnessAgentRuntime,
  HARNESS_ELUCID_PROVIDER,
  parseHarnessToolIds,
  resolveAgentRuntimeMode,
  resolveHarnessLlm,
} from '../../../packages/harness/src/index.js';
import { knowledgeStructureManifest, createStructureJobHandlers } from '../../../packages/runtime/src/structure-module.js';
import { taggingManifest, createTaggingJobHandlers, readTagCatalogFile } from '../../../packages/runtime/src/tagging-module.js';
import { workPackageDispatchManifest, createWorkPackageJobHandlers } from '../../../packages/runtime/src/work-package-module.js';
import { createJobRunner } from '../../../packages/runtime/src/job-runner.js';
import { createLocalToolRegistry } from '../../../packages/runtime/src/local-tools.js';
import { createAgentTraceLog } from '../../../packages/runtime/src/agent-trace-log.js';
import { createWorkPackageTracePort } from '../../../packages/runtime/src/work-package-trace.js';
import { createSourceHub, createSourceModuleRegistry } from '../../../packages/source/src/index.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(currentDirectory, '../../..');
resolveInstanceConfig({ repositoryRoot });

function createConfiguredStructureLlm(env = process.env) {
  const llm = resolveHarnessLlm(env);
  if (llm.provider !== HARNESS_ELUCID_PROVIDER) return null;
  return createElucidGrokAgentClient({
    env,
    apiKey: llm.apiKey,
    apiRoot: llm.baseURL,
    model: llm.defaultModel,
    researchModel: llm.researchModel,
  });
}

function createOptionalSearchPort(explicit) {
  if (explicit !== undefined) return explicit;
  if (String(process.env.AI_CENTER_SEARCH_DISABLED || '').trim() === '1') return null;
  try {
    return createDeepSeekSearchProvider();
  } catch (error) {
    console.error('[worker] legacy search.web 未启用：', error?.message || error);
    return null;
  }
}

export function createOptionalAgentQuality(explicit, env = process.env, client) {
  if (explicit !== undefined) return explicit || null;
  try {
    return createAgentQualityLayerFromEnv({
      env,
      client: client && typeof client.evaluate === 'function'
        ? client
        : createTypeSafeSystemOneClient({ env }),
    });
  } catch (error) {
    console.error('[worker] Jev quality 未启用：', error?.message || error);
    return null;
  }
}

export function createOptionalAuxiliarySearch(explicit, browserRuntime, env = process.env) {
  if (explicit !== undefined) return explicit || null;
  if (String(env.AI_CENTER_DOUBAO_SEARCH_DISABLED || '').trim() === '1') return null;
  if (!browserRuntime) return null;
  try {
    return createDoubaoAuxiliarySearch({ browserRuntime });
  } catch (error) {
    console.error('[worker] 补充检索未启用：', error?.message || error);
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
  const env = options.env || process.env;
  const runtimeMode = options.agentRuntime ? 'injected' : resolveAgentRuntimeMode(options, env);
  const restartPort = options.restartPort || createLauncherRestartPort({
    runtimeDirectory: instance.runtimeDirectory,
  });
  const store = options.store || createStore(instance.databasePath);
  const staleAfterMs = Number(options.staleAfterMs || process.env.AI_CENTER_WORKER_LEASE_MS) || 10 * 60_000;
  store.recoverStaleJobs(staleAfterMs);
  const webSearchPort = runtimeMode === 'local' || options.webSearchPort !== undefined
    ? createOptionalSearchPort(options.webSearchPort)
    : null;
  const browserRuntime = options.browserRuntime || createConfiguredBrowserRuntime({
    env: options.env || process.env,
    defaultBrowserId: instance.browserId,
  });
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
  const typesafeClient = options.typesafeClient || createTypeSafeSystemOneClient({ env });
  const feedFilter = options.feedFilter !== undefined
    ? options.feedFilter
    : createFeedFilterFromEnv({ client: typesafeClient, env });
  feedService = options.feedService || createFeedService({
    legacyRepository: store,
    feedRepository: store.repositories.feed,
    sourcePort,
    feedFilter,
  });
  const workPackageTracePort = options.workPackageTracePort || createWorkPackageTracePort({
    logDirectory: path.join(instance.runtimeDirectory, 'logs'),
    repositoryRoot,
  });
  const knowledgeService = options.knowledgeService || createKnowledgeService({
    legacyRepository: store,
    knowledgeRepository: store.repositories.knowledge,
    fileKnowledgePort: options.fileKnowledgePort || createLocalKnowledgeFiles({
      rootDirectory: instance.knowledgeDirectory,
    }),
    workPackageTracePort,
    attachmentStore: options.attachmentStore || createAttachmentStore({
      dataDirectory,
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
    taggingPort: options.taggingPort || createGeminiTagPort(),
  });
  const contextService = options.contextService || createContextService({
    feedService,
    tradingService,
    knowledgeService,
  });
  const structureLlm = options.structureLlm || options.agentClient || createConfiguredStructureLlm(env) || {
    async respond() {
      throw new Error('结构整理与问答共用 Harness LLM。当前未选择 elucid-grok，也没有可注入的整理模型。');
    },
  };
  const agentQuality = options.agentQuality !== undefined
    ? options.agentQuality
    : (options.store && !options.dataDirectory && !options.instanceConfig
      ? null
      : createOptionalAgentQuality(undefined, options.env || process.env, typesafeClient));
  if (agentQuality?.config) {
    console.log(`[worker] Jev quality prior=${agentQuality.config.priorMode} reviewer=${agentQuality.config.reviewerEnabled ? 'on' : 'off'} evidenceGate=${agentQuality.config.evidenceGateMode || 'off'}`);
  }
  const auxiliarySearch = runtimeMode === 'local'
    ? createOptionalAuxiliarySearch(
      options.auxiliarySearch,
      browserRuntime,
      options.env || process.env,
    )
    : (options.auxiliarySearch !== undefined ? options.auxiliarySearch || null : null);
  const agentTools = options.agentTools || createLocalToolRegistry({
    contextService, feedService, knowledgeService, tradingService, taggingService, sourcePort,
    includeLegacyWebSearch: runtimeMode === 'local',
  });
  if (runtimeMode === 'harness') {
    const ids = parseHarnessToolIds(options.harnessToolIds ?? env.AI_CENTER_HARNESS_TOOL_IDS, []);
    console.log(`[worker] agent runtime=harness tools=${ids.length ? ids.join(',') : 'all-visible'}`);
  } else if (runtimeMode === 'local') {
    console.log('[worker] agent runtime=local');
  }
  const agentRuntime = runtimeMode === 'harness'
    ? createHarnessAgentRuntime({
      tools: agentTools,
      quality: agentQuality,
      env,
      runtimeDirectory: instance.runtimeDirectory,
      createClient: options.createHarnessClient,
      allowedToolIds: options.harnessToolIds,
    })
    : (options.agentRuntime || createAgentRuntime({
      llm: structureLlm,
      auxiliarySearch,
      quality: agentQuality,
      tools: agentTools,
    }));
  const agentTraceLog = options.agentTraceLog
    || (options.store && !options.dataDirectory && !options.instanceConfig
      ? null
      : createAgentTraceLog({
        dataDirectory,
        logDirectory: instance.legacyLayout ? undefined : path.join(instance.runtimeDirectory, 'logs'),
        eventStore: store,
      }));
  registry.register({
    manifest: agentRuntimeManifest,
    jobHandlers: createAgentJobHandlers({ agentRuntime, knowledgeService, contextService, agentTraceLog, agentQuality }),
  });
  registry.register({
    manifest: articleAnalysisManifest,
    jobHandlers: options.articleAnalysisJobHandlers || createArticleAnalysisJobHandlers({
      agentRuntime,
      knowledgeService,
      feedService,
      agentTraceLog,
      agentQuality,
    }),
  });
  registry.register({
    manifest: knowledgeStructureManifest,
    jobHandlers: options.structureJobHandlers || createStructureJobHandlers({
      llm: structureLlm,
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
  registry.register({
    manifest: workPackageDispatchManifest,
    jobHandlers: options.workPackageJobHandlers || createWorkPackageJobHandlers({
      knowledgeService,
      cursorSessionPort: options.cursorSessionPort || createCursorSessionPort({
        workspace: repositoryRoot,
      }),
      requestProcessRestart: (input) => restartPort.requestRestart(input),
      workPackageTracePort,
    }),
  });
  const runner = createJobRunner({
    store,
    handlers: options.handlers || registry.createJobHandlers(),
    workerId: options.workerId || `${hostname()}-${process.pid}`,
    pollIntervalMs: options.pollIntervalMs || process.env.AI_CENTER_WORKER_POLL_MS,
    staleAfterMs,
    recoverEveryMs: options.recoverEveryMs || process.env.AI_CENTER_WORKER_RECOVER_MS,
    concurrency: options.concurrency || {
      workPackageDispatchLimit: options.workPackageConcurrency
        ?? process.env.AI_CENTER_WORKER_WORK_PACKAGE_CONCURRENCY,
    },
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
        try { await agentRuntime.close?.(); } catch {}
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
