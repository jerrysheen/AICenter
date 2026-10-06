import { createHardwareArtifactStore } from '../../../packages/connectors/src/hardware-artifacts.js';
import { legacyPriceSnapshot } from '../../../packages/connectors/src/trendforce-prices.js';
import { createHardwarePriceService } from '../../../packages/domain/src/hardware-price-service.js';
import { createContentRoutingService } from '../../../packages/domain/src/content-routing-service.js';
import { loadMediaConfig } from '../../../packages/instance/src/media-config.js';
import { loadFeedValueCalibration,loadFeedValueScoreCache } from '../../../packages/instance/src/feed-value-config.js';
import {createFeedValueRefreshService} from '../../../packages/domain/src/feed-value-refresh-service.js';
import {feedValueRefreshManifest,createFeedValueRefreshJobHandlers} from '../../../packages/runtime/src/feed-value-refresh-module.js';
import { createMediaConnector } from '../../../packages/connectors/src/media/port.js';
import { createMediaBriefPort } from '../../../packages/runtime/src/media-brief-port.js';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createConfiguredBrowserRuntime, createCursorSessionPort, createDeepSeekSearchProvider, createDoubaoAuxiliarySearch, createElucidGrokAgentClient, createGeminiTagPort, createLauncherRestartPort, createLocalKnowledgeFiles, createPersonalAssetService, createTranslateService, createTypeSafeSystemOneClient } from '../../../packages/connectors/src/index.js';
import { createAgentQualityLayerFromEnv } from '../../../packages/runtime/src/agent-quality.js';
import { articleAnalysisManifest, createArticleAnalysisJobHandlers } from '../../../packages/runtime/src/article-analysis/article-analysis-module.js';
import { createAttachmentStore, createStore } from '../../../packages/database/src/index.js';
import { createFeedFilterFromEnv } from '../../../packages/domain/src/feed-filter.js';
import { resolveDailyConfig } from '../../../packages/domain/src/daily-window.js';
import { createFeedService } from '../../../packages/domain/src/feed-service.js';
import { createMediaIngestionService } from '../../../packages/domain/src/media-ingestion-service.js';
import { ensureMediaIndexSyncSchedule, MEDIA_ENRICH_JOB_TYPE } from '../../../packages/connectors/src/media/index.js';
import { createMediaEnrichJobHandlers } from '../../../packages/runtime/src/media-enrich-module.js';
import { createKnowledgeService } from '../../../packages/domain/src/knowledge-service.js';
import { createMarketStatisticsService } from '../../../packages/domain/src/market-statistics-service.js';
import { createReportService } from '../../../packages/domain/src/report-service.js';
import { createDividendStrategyService } from '../../../packages/domain/src/trading-strategies/strategy-service.js';
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
import { createScheduler } from '../../../packages/runtime/src/scheduler.js';
import { createDailyBriefService } from '../../../packages/domain/src/daily-brief-service.js';
import {createInformationDigestService} from '../../../packages/domain/src/information-digest-service.js';
import { createReportJobHandlers, ensureDailyReportSchedule, ensureHourlyDigestSchedule, reportDailyManifest } from '../../../packages/runtime/src/report-module.js';
import { createFeedAutomationJobHandlers, ensureDefaultContentSubscriptions, ensureFeedSubscriptionSyncSchedule, FEED_SUBSCRIPTIONS_SYNC_JOB_TYPE, FEED_SYNC_MAX_RUNTIME_MS, feedAutomationManifest, prepareFeedSyncEnqueue } from '../../../packages/runtime/src/feed-automation-module.js';
import { createStrategyJobHandlers, ensureDividendStrategySchedule, strategySnapshotManifest } from '../../../packages/runtime/src/strategy-module.js';
import { createQuantJobHandlers, quantLabManifest } from '../../../packages/runtime/src/quant-module.js';
import { QUANT_PREPARE_JOB_TYPE, QUANT_RUN_JOB_TYPE } from '../../../packages/contracts/src/index.js';
import { createLocalToolRegistry } from '../../../packages/runtime/src/local-tools.js';
import { createAgentTraceLog } from '../../../packages/runtime/src/agent-trace-log.js';
import { createWorkPackageTracePort } from '../../../packages/runtime/src/work-package-trace.js';
import { createSourceHub, createSourceModuleRegistry, readStaticSignalBoard } from '../../../packages/source/src/index.js';

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
  store.abandonRunningJobs?.([MEDIA_ENRICH_JOB_TYPE], 'Worker 已重启，未完成的正文任务需按保存状态继续');
  store.repositories?.media?.recoverBriefProcessing?.();
  store.abandonRunningJobs?.(
    [QUANT_PREPARE_JOB_TYPE, QUANT_RUN_JOB_TYPE],
    'Worker 已重启，未完成的量化任务不会自动重跑',
  );
  store.abandonRunningJobs?.(
    [FEED_SUBSCRIPTIONS_SYNC_JOB_TYPE],
    'Worker 已重启，未完成的订阅同步改由新的一轮执行',
  );
  store.discardQueuedJobs?.(
    FEED_SUBSCRIPTIONS_SYNC_JOB_TYPE,
    'Worker 重启时合并了积压的订阅同步',
  );
  store.repositories?.feed?.releaseOpenSubscriptionLeases?.();
  const webSearchPort = runtimeMode === 'local' || options.webSearchPort !== undefined
    ? createOptionalSearchPort(options.webSearchPort)
    : null;
  const browserRuntime = options.browserRuntime || createConfiguredBrowserRuntime({
    env: options.env || process.env,
    defaultBrowserId: instance.browserId,
  });
  let feedService;
  const typesafeClient = options.typesafeClient || createTypeSafeSystemOneClient({ env });
  const feedFilter = options.feedFilter !== undefined
    ? options.feedFilter
    : createFeedFilterFromEnv({ client: typesafeClient, env, calibration: loadFeedValueCalibration(instance) });
  const mediaService = options.mediaService || (store.repositories?.media
    ? createMediaIngestionService({
      mediaRepository: store.repositories.media,
      mediaPort: createMediaConnector({ ...loadMediaConfig(instance.configDirectory), browserRuntime, readSource: (...args) => sourcePort.read(...args) }),
      feedRepository: store.repositories.feed,
      feedFilter,
      taggingRepository: store.repositories.tagging,
    })
    : null);
  const hardwarePriceService = options.hardwarePriceService || createHardwarePriceService({repository:store.repositories.hardwarePrices,artifactStore:createHardwareArtifactStore({dataDirectory})});
  const contentRoutingPort = options.contentRoutingPort || createContentRoutingService({mediaService,hardwarePrices:hardwarePriceService,feedRepository:store.repositories.feed,legacyPricePort:legacyPriceSnapshot});
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
    mediaService,
    readTrendforceStored: workspaceId => mediaService.readFeed({channel:'tech',sourceKey:'trendforce',view:'all'},{workspaceId}),
    migrateTrendforce: workspaceId=>contentRoutingPort.migrate(workspaceId),
    hardwarePriceService,
  });
  const sourcePort = options.sourcePort || createSourceHub(registry);
  feedService = options.feedService || createFeedService({
    legacyRepository: store,
    feedRepository: store.repositories.feed,
    sourcePort,
    feedFilter,
    mediaPort: mediaService,
    contentRoutingPort,
    translationPort: options.translateService || createTranslateService(),
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
  const dailyConfig = options.dailyConfig || resolveDailyConfig(env);
  const marketStatistics = options.marketStatisticsService
    || (sourcePort?.read ? createMarketStatisticsService({ sourcePort }) : null);
  const dividendStrategy = options.dividendStrategyService || createDividendStrategyService({
    strategyRepository: store.repositories.strategy,
    basketPort: marketStatistics,
  });
  const reportService = options.reportService || createReportService({
    reportRepository: store.repositories.report,
    feedService,
    mediaPort: mediaService,
    tradingService,
    sourceReadinessPort:{notes() {
      const types=['media.sources.sync','feed.subscriptions.sync'];
      const recent=store.listJobs?.(100) || [];
      return types.flatMap(type=>{
        const job=recent.find(j=>j.type===type);
        if(!job) return [];
        if(['queued','running'].includes(job.status)) return [`${type} 同步尚在进行，使用冻结时已落库材料，不等待译文或标签`];
        if(job.status==='failed') return [`${type} 最近一次同步失败；不能解释成今天没有新增材料`];
        return [];
      });
    }},
    staticSignalPort: options.staticSignalPort || {
      readBoard: (input, readOptions) => readStaticSignalBoard(sourcePort, input, readOptions),
    },
    strategyPort: dividendStrategy,
    defaultConfig: dailyConfig,
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
    reportService,
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
    reportService,
    marketStatisticsService: marketStatistics,
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
  const informationService=options.informationService || createInformationDigestService({
    reportRepository:store.repositories.report,feedService,mediaPort:mediaService,agentRuntime,timezone:dailyConfig.timezone,
  });
  registry.register({
    manifest: reportDailyManifest,
    jobHandlers: options.reportJobHandlers || createReportJobHandlers({
      reportService,
      informationService,
      briefService: options.briefService || createDailyBriefService({
        reportRepository: store.repositories.report,
        agentRuntime,
        informationService,
      }),
    }),
  });
  registry.register({
    manifest: strategySnapshotManifest,
    jobHandlers: options.strategyJobHandlers || createStrategyJobHandlers({ strategyService: dividendStrategy }),
  });
  registry.register({
    manifest: quantLabManifest,
    jobHandlers: options.quantJobHandlers || createQuantJobHandlers({
      repositoryRoot,
      quantRoot: options.quantRoot || path.join(dataDirectory, 'quant'),
      env,
    }),
  });
  registry.register({
    manifest: feedAutomationManifest,
    jobHandlers: options.feedAutomationJobHandlers || createFeedAutomationJobHandlers({
      feedService,
      feedRepository: store.repositories.feed,
      taggingService,
    }),
  });
  if (mediaService) {
    registry.register({
      manifest: {
        id: 'media.index.enrich',
        version: '1.0.0',
        capabilities: ['media.enrich'],
        jobTypes: [MEDIA_ENRICH_JOB_TYPE],
        sourceIds: [],
      },
      jobHandlers: options.mediaEnrichJobHandlers || createMediaEnrichJobHandlers({
        mediaService,
        feedService,
        taggingService,
        briefPort: createMediaBriefPort(agentRuntime),
      }),
    });
  }
  registry.register({manifest:feedValueRefreshManifest,jobHandlers:createFeedValueRefreshJobHandlers({
    service:createFeedValueRefreshService({feedRepository:store.repositories.feed,mediaRepository:store.repositories.media,
      client:typesafeClient,model:loadFeedValueCalibration(instance)?.model || 'jev-1.13.0',scoreCache:loadFeedValueScoreCache(instance)}),
    onProgress:progress=>console.log('[feed.quality.refresh]',JSON.stringify(progress)),
  })});
  const handlers = options.handlers || registry.createJobHandlers();
  if (options.enableDefaultSchedules !== false) {
    ensureDailyReportSchedule(store, dailyConfig);
    ensureHourlyDigestSchedule(store);
    ensureDividendStrategySchedule(store);
    ensureFeedSubscriptionSyncSchedule(store);
    ensureMediaIndexSyncSchedule(store);
    ensureDefaultContentSubscriptions(store.repositories.feed);
  }
  const scheduler = options.scheduler || createScheduler({
    store,
    allowedJobTypes: Object.keys(handlers),
    pollIntervalMs: options.schedulePollIntervalMs || env.AI_CENTER_SCHEDULER_POLL_MS || 20_000,
    beforeEnqueue(schedule, at) {
      if (schedule.jobType !== FEED_SUBSCRIPTIONS_SYNC_JOB_TYPE) return true;
      return prepareFeedSyncEnqueue(store, at);
    },
  });
  const runner = createJobRunner({
    store,
    handlers,
    workerId: options.workerId || `${hostname()}-${process.pid}`,
    pollIntervalMs: options.pollIntervalMs || process.env.AI_CENTER_WORKER_POLL_MS,
    staleAfterMs,
    recoverEveryMs: options.recoverEveryMs || process.env.AI_CENTER_WORKER_RECOVER_MS,
    supersedeAfterMs: {
      [FEED_SUBSCRIPTIONS_SYNC_JOB_TYPE]: FEED_SYNC_MAX_RUNTIME_MS,
    },
    onSupersede() {
      store.repositories?.feed?.releaseOpenSubscriptionLeases?.(Date.now(), FEED_SYNC_MAX_RUNTIME_MS);
    },
    concurrency: options.concurrency || {
      workPackageDispatchLimit: options.workPackageConcurrency
        ?? process.env.AI_CENTER_WORKER_WORK_PACKAGE_CONCURRENCY,
      quantLabLimit: 1,
    },
    onError(error, job) {
      console.error(`[worker] ${job.type} ${job.id}:`, error);
    },
  });
  let runPromise = null;
  let schedulePromise = null;

  return {
    store,
    runner,
    scheduler,
    browserRuntime,
    start() {
      schedulePromise ||= scheduler.start();
      runPromise ||= runner.start();
      return runPromise;
    },
    async close() {
      scheduler.stop();
      runner.stop();
      try {
        await Promise.allSettled([schedulePromise, runPromise].filter(Boolean));
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
