import {attachDailyProcessLog} from '../../../packages/runtime/src/process-log.js';
import { audioTranscriptionManifest, createAudioTranscriptionJobHandlers } from '../../../packages/runtime/src/audio-transcription-job.js';
import {createGeminiArticleAdmission,startGeminiQuotaProbe} from '../../../packages/runtime/src/gemini-article-admission.js';
import {resolveGoogleHourlyAdmissionModels} from '../../../packages/harness/src/llm-route.js';
import { backfillUntranslatedFeedTranslations, createFeedTranslationChunkStore, createFeedTranslationJobHandlers, demoteQueuedHashTranslationJobsBatched, feedTranslationManifest, fillUncoveredTranslations, formatTranslationBackfillLog, repairEllipsisLeadTexts, retireYoutubeTranslationJobsBatched, translationBackfillConcurrency, translationGapFillIntervalMs, translationGapFillLimit, translationStartupBackfillLimit } from '../../../packages/runtime/src/feed-translation-module.js';
import { createHardwareArtifactStore } from '../../../packages/connectors/src/hardware-artifacts.js';
import { legacyPriceSnapshot } from '../../../packages/connectors/src/trendforce-prices.js';
import { createHardwarePriceService } from '../../../packages/domain/src/hardware-price-service.js';
import { createContentRoutingService } from '../../../packages/domain/src/content-routing-service.js';
import { loadMediaConfig } from '../../../packages/instance/src/media-config.js';
import { loadResolvedFlashSources } from '../../../packages/domain/src/flash-sources.js';
import { loadFeedValueCalibration,loadFeedValueScoreCache } from '../../../packages/instance/src/feed-value-config.js';
import {createFeedValueRefreshService,resolveBambooRefresh} from '../../../packages/domain/src/feed-value-refresh-service.js';
import {feedValueRefreshManifest,createFeedValueRefreshJobHandlers} from '../../../packages/runtime/src/feed-value-refresh-module.js';
import { createMediaConnector } from '../../../packages/connectors/src/media/port.js';
import { createMediaBriefPort } from '../../../packages/runtime/src/media-brief-port.js';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../../../packages/runtime/src/is-main.js';
import { existsSync, rmSync } from 'node:fs';
import { createAnalysisSkillCatalog, createBambooStartLuxClient, createConfiguredBrowserRuntime, createCursorSessionPort, createDeepSeekSearchProvider, createDoubaoAuxiliarySearch, createElucidGrokAgentClient, createGeminiTagPort, createLauncherRestartPort, createLocalKnowledgeFiles, createPersonalAssetService, createTranslateService, createTypeSafeSystemOneClient } from '../../../packages/connectors/src/index.js';
import { createAgentQualityLayerFromEnv } from '../../../packages/runtime/src/agent-quality.js';
import { articleAnalysisManifest, createArticleAnalysisJobHandlers } from '../../../packages/runtime/src/article-analysis/article-analysis-module.js';
import { createAttachmentStore, createStore } from '../../../packages/database/src/index.js';
import { createFeedFilterFromEnv, resolveFeedFilterConfig } from '../../../packages/domain/src/feed-filter.js';
import { openJevClient, resolveJevEnabled } from '../../../packages/domain/src/jev-enabled.js';
import { openClassificationClient, resolveClassificationProvider } from '../../../packages/domain/src/classification-provider.js';
import { resolveDailyConfig } from '../../../packages/domain/src/daily-window.js';
import { createFeedService } from '../../../packages/domain/src/feed-service.js';
import { createFeedInteractionService } from '../../../packages/domain/src/feed-interaction-service.js';
import { createXLikeBrowserPort } from '../../../packages/connectors/src/x/like-browser.js';
import { feedInteractionManifest, createFeedInteractionJobHandlers } from '../../../packages/runtime/src/feed-interaction-module.js';
import { loadXFocusConfig } from '../../../packages/domain/src/x-focus.js';
import { createAnalysisFocusCache, createXFocusScorer } from '../../../packages/domain/src/x-focus-score.js';
import { createXFocusService } from '../../../packages/domain/src/x-auto-like.js';
import { createMediaIngestionService,mediaResourceId } from '../../../packages/domain/src/media-ingestion-service.js';
import { ensureMediaIndexSyncSchedule, enqueueMediaIndexEnrich, MEDIA_ENRICH_JOB_TYPE } from '../../../packages/connectors/src/media/index.js';
import { loadTwkrFlags } from '../../../packages/connectors/src/twkr-sources.js';
import { createTwkrJobHandlers, ensureTwkrSchedules, prepareTwkrEnqueue, TWKR_NEWS_JOB_TYPE, TWKR_REVENUE_JOB_TYPE } from '../../../packages/runtime/src/twkr-job.js';
import { createYoutubePodcastJobHandlers, ensureYoutubeArticleSchedule, ensureYoutubePodcastSchedule, YOUTUBE_ARTICLE_JOB_TYPE, YOUTUBE_PODCAST_JOB_TYPE } from '../../../packages/runtime/src/youtube-podcasts-job.js';
import { X_VIDEO_ARTICLE_JOB_TYPE } from '../../../packages/domain/src/x-video-articles.js';
import { X_LINK_ARTICLE_JOB_TYPE } from '../../../packages/domain/src/x-link-articles.js';
import { loadXLinkPublisherIndex } from '../../../packages/domain/src/x-link-service.js';
import { createXLinkArticleJobHandlers } from '../../../packages/runtime/src/x-link-article-job.js';
import { youtubePodcastLimits } from '../../../packages/domain/src/youtube-podcasts.js';
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
  createHarnessExecutionRuntime,
  HARNESS_ELUCID_PROVIDER,
  parseHarnessToolIds,
  resolveAgentRuntimeMode,
  resolveHarnessLlm,
} from '../../../packages/harness/src/index.js';
import { knowledgeStructureManifest, createStructureJobHandlers } from '../../../packages/runtime/src/structure-module.js';
import { taggingManifest, createTaggingJobHandlers, readTagCatalogFile } from '../../../packages/runtime/src/tagging-module.js';
import { workPackageDispatchManifest, createWorkPackageJobHandlers } from '../../../packages/runtime/src/work-package-module.js';
import { createJobRunner, deadLocalWorkerLock, formatJobLoopDelay, formatStartupStep, shouldLogJobLoopDelay } from '../../../packages/runtime/src/job-runner.js';
import { mainThreadWatchdogEnabled, startMainThreadWatchdog } from '../../../packages/runtime/src/main-thread-watchdog.js';
import { installWorkerLogStamps } from '../../../packages/runtime/src/worker-log.js';
import { createScheduler } from '../../../packages/runtime/src/scheduler.js';
import { createDailyBriefService } from '../../../packages/domain/src/daily-brief-service.js';
import {createInformationDigestService} from '../../../packages/domain/src/information-digest-service.js';
import {createInformationTreeService} from '../../../packages/domain/src/information-tree-service.js';
import {loadInformationTreeSkills,loadArticleNormalizeSkills} from '../../../packages/runtime/src/information-tree/skills.js';
import {createTreeMaterialPort} from '../../../packages/domain/src/information-tree-materials.js';
import {informationTreeManifest,createInformationTreeJobHandlers,enqueueTreePreparation,prioritizeRecentTreePreparation} from '../../../packages/runtime/src/information-tree-module.js';
import {createReadingHourService, readingHourSourceAccess} from '../../../packages/domain/src/reading-hour-service.js';
import {createModelUsageService} from '../../../packages/domain/src/model-usage-service.js';
import { allowHourlyScheduleEnqueue, createReportJobHandlers, ensureDailyReportCatchupSchedule, ensureDailyReportSchedule, ensureHourlyDigestSchedule, hourlyReportDisabled, releaseOpenHourlyJobs, reportDailyManifest } from '../../../packages/runtime/src/report-module.js';
import { boundedInt } from '../../../packages/domain/src/report-reliability.js';
import { createResearchRecallJobHandlers, researchRecallManifest } from '../../../packages/runtime/src/research-recall-module.js';
import { createResearchRelevanceJudge, createResearchTagJudge } from '../../../packages/runtime/src/research-judges.js';
import { createResearchRecallService } from '../../../packages/domain/src/research-recall-service.js';
import { createFeedAutomationJobHandlers, ensureDefaultContentSubscriptions, ensureFeedSubscriptionSyncSchedule, FEED_SUBSCRIPTION_SYNC_JOB_TYPE, FEED_SUBSCRIPTIONS_SYNC_JOB_TYPE, feedAutomationManifest, feedSyncSourceTimeoutMs, prepareFeedSyncEnqueue } from '../../../packages/runtime/src/feed-automation-module.js';
import { createStrategyJobHandlers, ensureDividendStrategySchedule, strategySnapshotManifest } from '../../../packages/runtime/src/strategy-module.js';
import { createQuantJobHandlers, quantLabManifest } from '../../../packages/runtime/src/quant-module.js';
import { ensureEtfWhaleSchedule } from '../../../packages/runtime/src/etf-whale-schedule.js';
import { createEtfWhaleJobHandlers, etfWhaleManifest } from '../../../packages/runtime/src/etf-whale-sync.js';
import { createSouthboundJobHandlers, ensureSouthboundSchedules, prepareSouthboundEnqueue, SOUTHBOUND_JOB_TYPE, southboundManifest } from '../../../packages/runtime/src/southbound-job.js';
import { createEventQuoteSnapshotJobHandlers, ensureEventQuoteSnapshotSchedule, eventQuoteSnapshotManifest } from '../../../packages/runtime/src/event-quote-snapshot-job.js';
import { lookupStoredPolymarketOutcomes } from '../../../packages/domain/src/polymarket-alerts.js';
import { createPolymarketWatchlistJobHandlers, ensurePolymarketWatchlistSchedule, polymarketWatchlistManifest } from '../../../packages/runtime/src/polymarket-watchlist-job.js';
import { createPolymarketDiscoveryJobHandlers, ensurePolymarketDiscoverySchedule, polymarketDiscoveryManifest } from '../../../packages/runtime/src/polymarket-discovery-job.js';
import { createPolymarketReleaseJobHandlers, ensurePolymarketReleaseSchedule, polymarketReleaseManifest } from '../../../packages/runtime/src/polymarket-release-job.js';
import { createPolymarketGammaClient } from '../../../packages/connectors/src/polymarket-gamma.js';
import { loadPolymarketWatchlist, polymarketLegacyEnabled } from '../../../packages/connectors/src/polymarket-watchlist.js';
import { readStoredPolymarketView } from '../../../packages/domain/src/polymarket-series.js';
import { createInvestorDiscussionJobHandlers, ensureInvestorDiscussionSchedule, investorDiscussionManifest } from '../../../packages/runtime/src/investor-discussion-job.js';
import { ensureTrendForcePriceSchedules } from '../../../packages/runtime/src/trendforce-price-schedule.js';
import { computePriceManifest, createComputePriceJobHandlers, ensureComputePriceSchedules } from '../../../packages/runtime/src/compute-price-job.js';
import { authorStatsManifest, createAuthorStatsJobHandlers, ensureAuthorStatsSchedule } from '../../../packages/runtime/src/author-stats-job.js';
import { QUANT_PREPARE_JOB_TYPE, QUANT_RUN_JOB_TYPE } from '../../../packages/contracts/src/index.js';
import { createLocalToolRegistry } from '../../../packages/runtime/src/local-tools.js';
import { createAgentTraceLog } from '../../../packages/runtime/src/agent-trace-log.js';
import { createWorkPackageTracePort } from '../../../packages/runtime/src/work-package-trace.js';
import { createFailureStreakStore, createSourceHub, createSourceModuleRegistry, installFailureStreakStore, readStaticSignalBoard } from '../../../packages/source/src/index.js';
import { createMemorySnapshotCache } from '../../../packages/runtime/src/snapshot-cache.js';
import {
  createHomeBootstrapCompose, createReportViewCapture, createWebSnapshotJobHandlers, ensureFeedListSchedule, ensureHardwarePriceSchedule, ensureHoldingsMarketSchedule, ensureHomeBootstrapSchedule, ensureMarketBoardsSchedule,
  ensureMarketNativeBoardSchedule, ensureReportViewSchedule, ensureStaticSignalBoardSchedule,
  enqueueHardwarePriceSnapshotFromEvents,
  HOLDINGS_MARKET_SNAPSHOT_KEY, webSnapshotManifest,
} from '../../../packages/runtime/src/web-snapshot-jobs.js';

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
  const bamboo = resolveClassificationProvider(env) === 'bamboo';
  if (!resolveJevEnabled(env) && !bamboo) return null;
  try {
    return createAgentQualityLayerFromEnv({
      env,
      client: client && typeof client.evaluate === 'function'
        ? client
        : (bamboo ? createBambooStartLuxClient({ env }) : createTypeSafeSystemOneClient({ env })),
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

function createStartupClock(startedAt = Date.now()) {
  let mark = startedAt;
  return (name) => {
    const now = Date.now();
    console.log(formatStartupStep(name, now - mark));
    mark = now;
  };
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
  try {
    rmSync(path.join(dataDirectory, 'tmp', 'youtube-podcasts'), { recursive: true, force: true });
  } catch (error) {
    console.error(`[worker] 清理 YouTube 播客临时目录失败：${error?.message || error}`);
  }
  installFailureStreakStore(createFailureStreakStore({
    filePath: path.join(dataDirectory, 'static-source-failure-streaks.json'),
  }));
  const env = options.env || process.env;
  const runtimeMode = options.agentRuntime ? 'injected' : resolveAgentRuntimeMode(options, env);
  const restartPort = options.restartPort || createLauncherRestartPort({
    runtimeDirectory: instance.runtimeDirectory,
  });
  let store = options.store || null;
  if (!store) {
    const openedAt = Date.now();
    store = createStore(instance.databasePath);
    console.log(formatStartupStep('database', Date.now() - openedAt));
  }
  const startupStep = createStartupClock();
  const workerId = options.workerId || `${hostname()}-${process.pid}`;
  const staleAfterMs = Number(options.staleAfterMs || process.env.AI_CENTER_WORKER_LEASE_MS) || 10 * 60_000;
  const jobMaxRunningMs = boundedInt(env.AI_CENTER_JOB_MAX_RUNNING_MS, 45 * 60_000, 60_000, 6 * 60 * 60_000);
  const maxRunningMsByType = {
    'report.information.prepare': boundedInt(env.AI_CENTER_PREPARE_MAX_RUNNING_MS, 30 * 60_000, 60_000, 6 * 60 * 60_000),
    'report.hourly.extract': boundedInt(env.AI_CENTER_HOURLY_MAX_RUNNING_MS, 45 * 60_000, 60_000, 6 * 60 * 60_000),
    'report.daily.generate': boundedInt(env.AI_CENTER_DAILY_MAX_RUNNING_MS, 90 * 60_000, 60_000, 6 * 60 * 60_000),
    [FEED_SUBSCRIPTIONS_SYNC_JOB_TYPE]: 60_000,
    [FEED_SUBSCRIPTION_SYNC_JOB_TYPE]: feedSyncSourceTimeoutMs(env.AI_CENTER_FEED_SYNC_SOURCE_TIMEOUT_MS) + 30_000,
    'media.index.enrich': boundedInt(env.AI_CENTER_MEDIA_ENRICH_MAX_RUNNING_MS, 8 * 60_000, 60_000, 30 * 60_000),
    [YOUTUBE_PODCAST_JOB_TYPE]: youtubePodcastLimits(env).roundMs,
    [YOUTUBE_ARTICLE_JOB_TYPE]: youtubePodcastLimits(env).roundMs,
    [X_VIDEO_ARTICLE_JOB_TYPE]: youtubePodcastLimits(env).roundMs,
    [TWKR_NEWS_JOB_TYPE]: 25_000,
    [TWKR_REVENUE_JOB_TYPE]: 70_000,
  };
  store.recoverStaleJobs(staleAfterMs, Date.now(), {
    maxRunningMs: jobMaxRunningMs,
    maxRunningMsByType,
    ownerStale: (lockedBy) => deadLocalWorkerLock(lockedBy),
  });
  startupStep('recover-stale');
  try {
    store.repositories?.informationTree?.releaseAll?.();
  } catch (error) {
    console.error(`[worker] 清理浓缩树租约失败：${error?.message || error}`);
  }
  startupStep('release-tree');
  if (hourlyReportDisabled(env)) {
    const cancelled = releaseOpenHourlyJobs(store, env);
    console.log(`[worker] 小时报已停用（AI_CENTER_HOURLY_DISABLED=1），已取消 ${cancelled} 个未完成任务`);
  }
  startupStep('hourly-jobs');
  store.abandonRunningJobs?.([MEDIA_ENRICH_JOB_TYPE], 'Worker 已重启，未完成的正文任务需按保存状态继续');
  startupStep('abandon-media');
  store.repositories?.media?.recoverBriefProcessing?.();
  startupStep('media-brief');
  store.abandonRunningJobs?.(
    [QUANT_PREPARE_JOB_TYPE, QUANT_RUN_JOB_TYPE],
    'Worker 已重启，未完成的量化任务不会自动重跑',
  );
  startupStep('abandon-quant');
  store.abandonRunningJobs?.(
    [FEED_SUBSCRIPTIONS_SYNC_JOB_TYPE, FEED_SUBSCRIPTION_SYNC_JOB_TYPE],
    'Worker 已重启，未完成的订阅同步改由新的一轮执行',
  );
  startupStep('abandon-feed-sync');
  store.discardQueuedJobs?.(
    FEED_SUBSCRIPTIONS_SYNC_JOB_TYPE,
    'Worker 重启时合并了积压的订阅同步',
  );
  startupStep('discard-subscription-sync');
  store.repositories?.feed?.releaseOpenSubscriptionLeases?.();
  startupStep('release-subscription-leases');
  const webSearchPort = runtimeMode === 'local' || options.webSearchPort !== undefined
    ? createOptionalSearchPort(options.webSearchPort)
    : null;
  const browserRuntime = options.browserRuntime || createConfiguredBrowserRuntime({
    env: options.env || process.env,
    defaultBrowserId: instance.browserId,
  });
  let feedService;
  const xFocusHooks = { scoreCards: null, afterIngest: null, recordLike: null };
  let xFocusConfig = null;
  try { xFocusConfig = options.xFocusConfig || loadXFocusConfig(instance.configDirectory); }
  catch (error) { console.log(`[worker] x-focus ${String(error?.message || error).slice(0, 160)}`); }
  const feedFilterConfig = resolveFeedFilterConfig(env);
  const typesafeClient = openJevClient(env, options.typesafeClient, createTypeSafeSystemOneClient);
  const focusLog = (message) => console.log(message);
  const classificationClient = openClassificationClient(env, {
    typesafeClient,
    ...(options.classificationClient !== undefined ? { explicit: options.classificationClient } : {}),
    createBamboo: (opts) => createBambooStartLuxClient({ ...opts, log: focusLog }),
  });
  if (resolveClassificationProvider(env) === 'bamboo') {
    console.log(`[worker] classification provider=bamboo model=${classificationClient?.modelId || '-'} available=${classificationClient?.available?.() ? 1 : 0}`);
  }
  const feedFilter = options.feedFilter !== undefined
    ? options.feedFilter
    : createFeedFilterFromEnv({
      client: classificationClient,
      env,
      calibration: loadFeedValueCalibration(instance),
      xFocusConfig,
      log: focusLog,
      usageDirectory: dataDirectory,
    });
  const mediaConfig = loadMediaConfig(instance.configDirectory);
  const flashSources = options.flashSources || loadResolvedFlashSources({ configDirectory: instance.configDirectory, env, mediaSources: mediaConfig.sources });
  const mediaService = options.mediaService || (store.repositories?.media
    ? createMediaIngestionService({
      mediaRepository: store.repositories.media,
      mediaPort: createMediaConnector({ ...mediaConfig, browserRuntime, readSource: (...args) => sourcePort.read(...args) }),
      feedRepository: store.repositories.feed,
      feedFilter,
      taggingRepository: store.repositories.tagging,
      flashSources,
    })
    : null);
  const hardwarePriceService = options.hardwarePriceService || createHardwarePriceService({repository:store.repositories.hardwarePrices,artifactStore:createHardwareArtifactStore({dataDirectory})});
  const contentRoutingPort = options.contentRoutingPort || createContentRoutingService({mediaService,hardwarePrices:hardwarePriceService,feedRepository:store.repositories.feed,legacyPricePort:legacyPriceSnapshot});
  const legacyPolymarket = polymarketLegacyEnabled(env);
  const polymarketWatchlist = options.polymarketWatchlist || loadPolymarketWatchlist(path.join(instance.configDirectory, 'polymarket-watchlist.json'));
  const polymarketClient = options.polymarketClient || createPolymarketGammaClient({
    fetch: options.fetch,
    minIntervalMs: polymarketWatchlist.fetch.minIntervalMs,
    batchSize: polymarketWatchlist.fetch.batchSize,
  });
  const registry = options.moduleRegistry || createSourceModuleRegistry({
    twitterService: options.twitterService,
    bilibiliService: options.bilibiliService,
    marketService: options.marketService,
    officialSources: options.officialSources,
    marketNativeSources: options.marketNativeSources,
    env,
    polymarketQuotes: legacyPolymarket || !store.repositories?.polymarket
      ? undefined
      : () => readStoredPolymarketView(store.repositories.polymarket, Date.now(), {
        staleAfterMs: polymarketWatchlist.fetch.staleAfterMinutes * 60_000,
      }),
    webSearchPort,
    browserRuntime,
    marketCatalog: options.marketCatalog,
    marketCatalogPath: instance.marketCatalogPath,
    syncFeed: (...args) => feedService.getExternalFeed(...args),
    mediaService,
    readTrendforceStored: workspaceId => mediaService.readFeed({channel:'tech',sourceKey:'trendforce',view:'all'},{workspaceId}),
    migrateTrendforce: workspaceId=>contentRoutingPort.migrate(workspaceId),
    hardwarePriceService,
    scoreHomeCards: (cards, context) => xFocusHooks.scoreCards?.(cards, context) ?? null,
    focusKeywords: (xFocusConfig?.directions || []).flatMap((direction) => direction.keywords || []),
  });
  const sourcePort = options.sourcePort || createSourceHub(registry);
  const feedInteraction = createFeedInteractionService({
    feedRepository: store.repositories.feed, runtimeRepository: store,
    likePort: options.xLikePort !== undefined ? options.xLikePort : browserRuntime?.withSession ? createXLikeBrowserPort({ browserRuntime }) : null,
  });
  registry.register({ manifest: feedInteractionManifest, jobHandlers: createFeedInteractionJobHandlers(feedInteraction, {
    onAutoLike: (workspaceId, output) => xFocusHooks.recordLike?.(workspaceId, output),
  }) });
  const translateService = options.translateService || (options.feedService ? null : createTranslateService({
    env,
    quotaRepository: store.repositories.modelQuota,
    chunkStore: createFeedTranslationChunkStore(store.repositories.feed),
  }));
  feedService = options.feedService || createFeedService({
    legacyRepository: store,
    feedRepository: store.repositories.feed,
    sourcePort,
    feedFilter,
    mediaPort: mediaService,
    contentRoutingPort,
    onContentReady:env.AI_CENTER_INFORMATION_PIPELINE==='tree-v3' ? ({workspaceId,sourceIds})=>enqueueTreePreparation(store,workspaceId,sourceIds) : null,
    onXIngest: (context) => xFocusHooks.afterIngest?.(context),
    flashSources,
    translationPort: translateService,
  });
  registry.register({ manifest: feedTranslationManifest, jobHandlers: createFeedTranslationJobHandlers({ feedService, feed: store.repositories.feed }) });
  registry.register({
    manifest: audioTranscriptionManifest,
    jobHandlers: options.audioTranscriptionJobHandlers || createAudioTranscriptionJobHandlers({
      dataDirectory,
      env,
      quotaRepository: store.repositories.modelQuota,
    }),
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
  const holdingsQuoteCache = createMemorySnapshotCache({
    read: () => store.repositories.runtimeSnapshots.readSnapshot('local', HOLDINGS_MARKET_SNAPSHOT_KEY),
  });
  const tradingService = options.tradingService || createTradingService({
    tradingRepository: store.repositories.trading,
    sourcePort,
    holdingsQuotePort: {
      read: (readOptions) => holdingsQuoteCache.get(readOptions),
    },
    personalAssetPort: options.personalAssetService || createPersonalAssetService({
      dataDirectory,
      workbookPath: instance.assetWorkbookPath,
    }),
  });
  const dailyConfig = options.dailyConfig || resolveDailyConfig(env.AI_CENTER_ARTICLE_NORMALIZE==='1' && !env.AI_CENTER_DAILY_RUN_MINUTE ? {...env,AI_CENTER_DAILY_RUN_MINUTE:'30'} : env);
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
      const types=['media.sources.sync','feed.subscriptions.sync','feed.subscription.sync'];
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
      : createOptionalAgentQuality(undefined, options.env || process.env, classificationClient));
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
    modelUsageService:createModelUsageService({repository:store.repositories.modelUsage,workspaceId:'local',getJob:id=>store.getJob(id)}),
    includeLegacyWebSearch: runtimeMode === 'local',
  });
  if (runtimeMode === 'harness') {
    const ids = parseHarnessToolIds(options.harnessToolIds ?? env.AI_CENTER_HARNESS_TOOL_IDS, []);
    console.log(`[worker] agent runtime=harness tools=${ids.length ? ids.join(',') : 'all-visible'}`);
  } else if (runtimeMode === 'local') {
    console.log('[worker] agent runtime=local');
  }
  const quotaUsage=store.repositories.modelUsage;
  const articleAdmission=env.AI_CENTER_ARTICLE_NORMALIZE==='1' && env.AI_CENTER_HARNESS_ARTICLE_PROVIDER==='google' ? createGeminiArticleAdmission({repository:store.repositories.modelQuota,usage:quotaUsage,env}) : null;
  const hourlyAdmission=env.AI_CENTER_HARNESS_HOURLY_PROVIDER==='google' ? createGeminiArticleAdmission({repository:store.repositories.modelQuota,usage:quotaUsage,env,models:resolveGoogleHourlyAdmissionModels(env),allowFallback:false,modelOrder:'least-used'}) : null;
  const agentRuntime = runtimeMode === 'harness'
    ? createHarnessExecutionRuntime({
      articleAdmission,
      hourlyAdmission,
      tools: agentTools,
      quality: agentQuality,
      env,
      runtimeDirectory: instance.runtimeDirectory,
      createClient: options.createHarnessClient,
      allowedToolIds: options.harnessToolIds,
      usageLedger: { record: value => store.repositories?.modelUsage?.save(value) },
    })
    : (options.agentRuntime || createAgentRuntime({
      llm: structureLlm,
      auxiliarySearch,
      quality: agentQuality,
      tools: agentTools,
    }));
  if (xFocusConfig) {
    const scorer = createXFocusScorer({
      config: xFocusConfig,
      env,
      agentRuntime,
      cache: createAnalysisFocusCache(store.repositories.report),
      log: focusLog,
    });
    const autoLike = createXFocusService({
      config: xFocusConfig,
      env,
      feedRepository: store.repositories.feed,
      runtimeRepository: store,
      snapshots: store.repositories.runtimeSnapshots,
      reportRepository: store.repositories.report,
      scorer,
      requestLike: (workspaceId, input) => feedInteraction.requestLike(workspaceId, input),
      log: focusLog,
    });
    xFocusHooks.scoreCards = (cards, context) => scorer.scoreCards(cards, context);
    xFocusHooks.afterIngest = async ({ workspaceId }) => {
      await autoLike.rescoreKeywords(workspaceId);
      autoLike.refreshDrift(workspaceId);
      await autoLike.dispatch(workspaceId);
    };
    xFocusHooks.recordLike = (workspaceId, output) => autoLike.recordAutoLike(workspaceId, output);
  }
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
    jobHandlers: createAgentJobHandlers({
      agentRuntime, knowledgeService, contextService, agentTraceLog, agentQuality,
      analysisSkillCatalog: options.analysisSkillCatalog !== undefined
        ? options.analysisSkillCatalog
        : createAnalysisSkillCatalog({ rootDirectory: path.join(repositoryRoot, 'config/analysis-skills') }),
    }),
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
  const treeEnabled=env.AI_CENTER_INFORMATION_PIPELINE==='tree-v3';
  const articleStrategy=treeEnabled && env.AI_CENTER_ARTICLE_NORMALIZE==='1';
  const articleNormalizePort=articleStrategy ? {async prepareInformation(input) {return {queued:enqueueTreePreparation(store,input.workspaceId || 'local',input.sourceIds || []).length};}} : null;
  const treeCatalog=treeEnabled ? options.tagCatalog || readTagCatalogFile(existsSync(instance.tagCatalogPath) ? instance.tagCatalogPath : path.join(repositoryRoot,'config/tags.default.json')) : null;
  const treeMaterials=treeEnabled ? createTreeMaterialPort({feedService,mediaService,flashSources}) : null;
  const treeService=treeEnabled ? createInformationTreeService({repository:store.repositories.informationTree,reportRepository:store.repositories.report,
    feedService,mediaPort:mediaService,agentRuntime,articleStrategy,budgetReady:articleAdmission?.policy.accountMode ? ()=>articleAdmission.nextReadyAt(env.AI_CENTER_HARNESS_ARTICLE_MODEL || 'gemini-3.1-flash-lite')<=Date.now() : null,skills:articleStrategy ? loadArticleNormalizeSkills() : loadInformationTreeSkills(),timezone:dailyConfig.timezone,
    catalog:treeCatalog,flashSources,
    candidatePort:treeMaterials?.candidates,materialPort:treeMaterials?.materials,
    primaryTag:(_workspaceId,m)=>Object.hasOwn(treeCatalog.reading?.primaryLocks || {},m.id) ? {locked:true,tagId:treeCatalog.reading.primaryLocks[m.id]} : undefined,
    tagHints:(workspaceId,m)=>{
      const ref=m.sourceRefs?.find(r=>r.type==='media-body' || r.type==='content-item');if(!ref)return [];
      const row=store.repositories.tagging.listTaggings(workspaceId,ref.type==='media-body' ? 'media-index' : 'content-item',[ref.type==='media-body' ? mediaResourceId(ref.id) : ref.id])[0];
      if(row && (row.tagCatalogVersion!==treeCatalog.version || row.analyzedAt<(m.updatedAt || 0)))return undefined;
      return row?.tags || [];
    },
    generationConfig:Object.fromEntries([...(articleStrategy ? ['article-normalize'] : []),'hourly-brief','daily-analysis'].map(task=>{const route=resolveHarnessLlm(env,{closedTask:task});return [task==='article-normalize' ? 'information' : task,{provider:route.provider,model:route.model,protocol:route.protocol,...(route.execution ? {execution:route.execution} : {})}];})),
    hourlyModels:env.AI_CENTER_HARNESS_HOURLY_PROVIDER==='google' ? resolveGoogleHourlyAdmissionModels(env) : [],
    rankHourlyModels:hourlyAdmission ? (models)=>hourlyAdmission.rankModels(models) : undefined,
    hourlyAttemptCap:boundedInt(env.AI_CENTER_HOURLY_MAX_ATTEMPTS, 4, 1, 12),
    prepAttemptCap:boundedInt(env.AI_CENTER_INFORMATION_PREP_ATTEMPTS, 3, 1, 10),
    upstreamRetries:boundedInt(env.AI_CENTER_HOURLY_UPSTREAM_RETRIES, 3, 0, 6),
    budget:{dailyTimeoutMs:boundedInt(env.AI_CENTER_DAILY_MODEL_TIMEOUT_MS, 360_000, 30_000, 900_000), dailyTotalMs:boundedInt(env.AI_CENTER_DAILY_TOTAL_MS, 60 * 60_000, 60_000, 3 * 60 * 60_000)},
  }) : null;
  const informationService=options.informationService || treeService || createInformationDigestService({
    reportRepository:store.repositories.report,feedService,mediaPort:mediaService,agentRuntime,timezone:dailyConfig.timezone,
  });
  if(treeService)registry.register({manifest:informationTreeManifest,jobHandlers:createInformationTreeJobHandlers(treeService,{candidates:treeMaterials.candidates,refreshMinute:articleStrategy ? 30 : null,env})});
  registry.register({
    manifest: reportDailyManifest,
    jobHandlers: options.reportJobHandlers || createReportJobHandlers({
      reportService,
      informationService,
      treeService,dailyConfig,env,
      readingHour: createReadingHourService({
        repository: store.repositories.informationTree,
        reportRepository: store.repositories.report,
        agentRuntime,
        enabled: env.AI_CENTER_READING_HOUR === '1',
        client: classificationClient,
        catalogIds: new Set((treeCatalog?.tags || []).map((tag) => tag.id)),
        feedRepository: store.repositories.feed,
        flashSources,
        env,
        ...readingHourSourceAccess({ feed: store.repositories.feed, media: store.repositories.media }),
      }),
      beforeHourly:treeService ? (input)=>prioritizeRecentTreePreparation(store,treeMaterials.candidates,input.workspaceId || 'local') : null,
      briefService: options.briefService || createDailyBriefService({
        reportRepository: store.repositories.report,
        agentRuntime,
        informationService,
      }),
    }),
  });
  if (env.AI_CENTER_RESEARCH_RECALL === 'on') {
    const recallClient = resolveClassificationProvider(env) === 'bamboo' ? classificationClient : typesafeClient;
    const liveJudges = recallClient?.available?.()
      ? { tagJudge: createResearchTagJudge(recallClient), relevanceJudge: createResearchRelevanceJudge(recallClient) }
      : { tagJudge: null, relevanceJudge: null };
    registry.register({
      manifest: researchRecallManifest,
      jobHandlers: createResearchRecallJobHandlers(createResearchRecallService({
        repository: store.repositories.research,
        feedRepository: store.repositories.feed,
        mediaRepository: store.repositories.media,
        informationRepository: store.repositories.informationTree,
        modelId: recallClient?.modelId || '',
        ...liveJudges,
      })),
    });
  }
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
    manifest: southboundManifest,
    jobHandlers: options.southboundJobHandlers || createSouthboundJobHandlers({
      repository: store.repositories.southbound,
      northboundRepository: store.repositories.northbound,
      store,
      env,
    }),
  });
  registry.register({
    manifest: etfWhaleManifest,
    jobHandlers: options.etfWhaleJobHandlers || createEtfWhaleJobHandlers({
      repository: store.repositories.etfWhale,
      dataDirectory,
    }),
  });
  registry.register({
    manifest: webSnapshotManifest,
    jobHandlers: options.webSnapshotJobHandlers || createWebSnapshotJobHandlers({
      sourcePort,
      repository: store.repositories.runtimeSnapshots,
      tradingRepository: store.repositories.trading,
      feedService,
      feedRepository: store.repositories.feed,
      hardwarePriceService,
      composeHomeBootstrap: createHomeBootstrapCompose({
        store,
        report: reportService,
        env,
        timezone: dailyConfig.timezone,
        pipeline: treeEnabled ? 'tree-v3' : 'legacy',
      }),
      captureReportViews: createReportViewCapture({
        store,
        env,
        timezone: dailyConfig.timezone,
        pipeline: treeEnabled ? 'tree-v3' : 'legacy',
      }),
      env,
      keepPolymarketOrder: !legacyPolymarket,
    }),
  });
  if (store.repositories?.polymarket) {
    const polymarketJobOptions = {
      client: polymarketClient,
      repository: store.repositories.polymarket,
      config: polymarketWatchlist,
      now: options.now,
      lookupTranslations: (labels) => lookupStoredPolymarketOutcomes(store.repositories.feed, labels),
    };
    registry.register({
      manifest: polymarketWatchlistManifest,
      jobHandlers: options.polymarketWatchlistJobHandlers || createPolymarketWatchlistJobHandlers(polymarketJobOptions),
    });
    registry.register({
      manifest: polymarketDiscoveryManifest,
      jobHandlers: options.polymarketDiscoveryJobHandlers || createPolymarketDiscoveryJobHandlers(polymarketJobOptions),
    });
    registry.register({
      manifest: polymarketReleaseManifest,
      jobHandlers: options.polymarketReleaseJobHandlers || createPolymarketReleaseJobHandlers({ ...polymarketJobOptions, store }),
    });
  }
  registry.register({
    manifest: eventQuoteSnapshotManifest,
    jobHandlers: options.eventQuoteSnapshotJobHandlers || createEventQuoteSnapshotJobHandlers({
      repository: store.repositories.eventQuotes,
      sourcePort,
    }),
  });
  if (store.repositories.computePrices) {
    registry.register({
      manifest: computePriceManifest,
      jobHandlers: options.computePriceJobHandlers || createComputePriceJobHandlers({
        repository: store.repositories.computePrices,
        fetch: options.fetch,
        now: options.now,
      }),
    });
  }
  if (store.repositories.investorDiscussion) {
    registry.register({
      manifest: investorDiscussionManifest,
      jobHandlers: options.investorDiscussionJobHandlers || createInvestorDiscussionJobHandlers({
        repository: store.repositories.investorDiscussion,
        browserRuntime,
        env,
        client: options.investorDiscussionClient,
        summarize: options.investorDiscussionSummarize,
        label: options.investorDiscussionLabel,
        quotaRepository: store.repositories.modelQuota,
        repositoryRoot,
      }),
    });
  }
  registry.register({
    manifest: feedAutomationManifest,
    jobHandlers: options.feedAutomationJobHandlers || createFeedAutomationJobHandlers({
      treeEnabled,articleNormalizePort,
      feedService,
      feedRepository: store.repositories.feed,
      taggingService,
    }),
  });
  const twkrFlags = loadTwkrFlags(path.join(instance.configDirectory, 'twkr-sources.json'));
  registry.register({
    manifest: {
      id: 'feed.twkr',
      version: '1.0.0',
      capabilities: ['feed.twkr'],
      jobTypes: [TWKR_NEWS_JOB_TYPE, TWKR_REVENUE_JOB_TYPE],
      sourceIds: [],
    },
    jobHandlers: options.twkrJobHandlers || createTwkrJobHandlers({
      mediaService,
      revenueRepository: store.repositories.twseRevenue,
      env,
      flags: twkrFlags,
      enqueueTranslation: enqueueMediaIndexEnrich,
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
        treeEnabled,articleNormalizePort,
      }),
    });
  }
  registry.register({
    manifest: {
      id: 'youtube.podcasts',
      version: '1.0.0',
      capabilities: ['youtube.podcasts.sync', YOUTUBE_ARTICLE_JOB_TYPE, X_VIDEO_ARTICLE_JOB_TYPE],
      jobTypes: [YOUTUBE_PODCAST_JOB_TYPE, YOUTUBE_ARTICLE_JOB_TYPE, X_VIDEO_ARTICLE_JOB_TYPE],
      sourceIds: [],
    },
    jobHandlers: options.youtubePodcastJobHandlers || createYoutubePodcastJobHandlers({
      repository: store.repositories.youtubePodcasts,
      xVideoRepository: store.repositories.xVideos,
      feedRepository: store.repositories.feed,
      quotaRepository: store.repositories.modelQuota,
      configPath: path.join(instance.configDirectory, 'youtube-podcasts.json'),
      dataDirectory,
      env,
      browserRuntime,
      store,
    }),
  });
  registry.register({
    manifest: {
      id: 'x.links.article',
      version: '1.0.0',
      capabilities: [X_LINK_ARTICLE_JOB_TYPE],
      jobTypes: [X_LINK_ARTICLE_JOB_TYPE],
      sourceIds: [],
    },
    jobHandlers: options.xLinkArticleJobHandlers || createXLinkArticleJobHandlers({
      repository: store.repositories.xLinks,
      publishers: loadXLinkPublisherIndex(),
      quotaRepository: store.repositories.modelQuota,
      env,
    }),
  });
  registry.register({
    manifest: authorStatsManifest,
    jobHandlers: options.authorStatsJobHandlers || createAuthorStatsJobHandlers({
      authorRepository: store.repositories.authors,
      onProgress: (progress) => console.log('[authors.stats.recompute]', JSON.stringify(progress)),
    }),
  });
  const bambooRefresh = resolveBambooRefresh(env, feedFilterConfig.classificationProvider);
  registry.register({manifest:feedValueRefreshManifest,jobHandlers:createFeedValueRefreshJobHandlers({
    service:createFeedValueRefreshService({feedRepository:store.repositories.feed,mediaRepository:store.repositories.media,
      client:classificationClient,
      model:feedFilterConfig.classificationProvider==='bamboo'
        ? (classificationClient?.modelId || 'startlux-decision-27b-autothink')
        : (loadFeedValueCalibration(instance)?.model || 'jev-1.13.0'),
      scoreCache:loadFeedValueScoreCache(instance),flashSources,
      jevEnabled:feedFilterConfig.jevEnabled,classificationProvider:feedFilterConfig.classificationProvider,
      bambooRefresh:bambooRefresh.enabled,bambooRefreshMax:bambooRefresh.max,
      fallback:feedFilterConfig.fallback,xFocusConfig,xFocusMin:feedFilterConfig.xFocusMin}),
    onProgress:progress=>console.log('[feed.quality.refresh]',JSON.stringify(progress)),
  })});
  const handlers = options.handlers || registry.createJobHandlers();
  startupStep('services');
  if (options.enableDefaultSchedules !== false) {
    ensureDailyReportSchedule(store, dailyConfig);
    ensureDailyReportCatchupSchedule(store, dailyConfig);
    ensureHourlyDigestSchedule(store,Date.now(),{minute:articleStrategy ? 30 : 0,env});
    ensureDividendStrategySchedule(store);
    ensureFeedSubscriptionSyncSchedule(store);
    ensureMediaIndexSyncSchedule(store);
    ensureEventQuoteSnapshotSchedule(store);
    ensureStaticSignalBoardSchedule(store);
    ensureHoldingsMarketSchedule(store);
    ensureMarketBoardsSchedule(store);
    ensureMarketNativeBoardSchedule(store);
    if (store.repositories?.polymarket) {
      ensurePolymarketWatchlistSchedule(store, polymarketWatchlist, Date.now(), { enabled: !legacyPolymarket });
      ensurePolymarketDiscoverySchedule(store, polymarketWatchlist, Date.now(), { enabled: !legacyPolymarket });
      ensurePolymarketReleaseSchedule(store, polymarketWatchlist, Date.now(), { enabled: !legacyPolymarket });
    }
    ensureFeedListSchedule(store);
    ensureHardwarePriceSchedule(store, Date.now(), env);
    ensureHomeBootstrapSchedule(store);
    ensureReportViewSchedule(store);
    ensureInvestorDiscussionSchedule(store, env);
    ensureTrendForcePriceSchedules(store, env);
    ensureTwkrSchedules(store, { env, flags: twkrFlags });
    ensureComputePriceSchedules(store, env);
    ensureAuthorStatsSchedule(store, env);
    ensureYoutubePodcastSchedule(store, env);
    ensureYoutubeArticleSchedule(store, env);
    ensureEtfWhaleSchedule(store, env);
    ensureSouthboundSchedules(store, env);
    ensureDefaultContentSubscriptions(store.repositories.feed);
  }
  startupStep('schedules');
  const scheduler = options.scheduler || createScheduler({
    store,
    allowedJobTypes: Object.keys(handlers),
    pollIntervalMs: options.schedulePollIntervalMs || env.AI_CENTER_SCHEDULER_POLL_MS || 20_000,
    beforeEnqueue(schedule, at) {
      if (!allowHourlyScheduleEnqueue(schedule, env)) return false;
      if (schedule.jobType === TWKR_NEWS_JOB_TYPE || schedule.jobType === TWKR_REVENUE_JOB_TYPE) {
        return prepareTwkrEnqueue(store, schedule);
      }
      if (schedule.jobType === SOUTHBOUND_JOB_TYPE) return prepareSouthboundEnqueue(store, schedule);
      if (schedule.jobType !== FEED_SUBSCRIPTIONS_SYNC_JOB_TYPE) return true;
      return prepareFeedSyncEnqueue(store, at);
    },
  });
  const runner = createJobRunner({
    store,
    handlers,
    workerId,
    pollIntervalMs: options.pollIntervalMs || process.env.AI_CENTER_WORKER_POLL_MS,
    staleAfterMs,
    maxRunningMs: jobMaxRunningMs,
    maxRunningMsByType,
    recoverEveryMs: options.recoverEveryMs || process.env.AI_CENTER_WORKER_RECOVER_MS,
    readyAt:articleAdmission?.policy.accountMode ? {'report.information.prepare':()=>articleAdmission.nextReadyAt(env.AI_CENTER_HARNESS_ARTICLE_MODEL || 'gemini-3.1-flash-lite')} : {},
    concurrency: options.concurrency || {
      workPackageDispatchLimit: options.workPackageConcurrency
        ?? process.env.AI_CENTER_WORKER_WORK_PACKAGE_CONCURRENCY,
      quantLabLimit: 1,
      informationPreparationLimit: articleAdmission?.policy.concurrency || 1,
      translationLimit: Number(env.AI_CENTER_WORKER_TRANSLATION_CONCURRENCY || 5),
    },
    translationBackfillCap: translationBackfillConcurrency(
      env.AI_CENTER_TRANSLATION_BACKFILL_CONCURRENCY,
      Number(env.AI_CENTER_WORKER_TRANSLATION_CONCURRENCY || 5),
    ),
    onError(error, job) {
      const stack = error instanceof Error ? error.stack : '';
      console.error(`[worker] ${job.type} ${job.id}: ${stack || error?.message || error}`);
    },
    onJobEnd(job, delay) {
      const maxMs = Math.round(Number(delay?.maxMs) || 0);
      if (!shouldLogJobLoopDelay(maxMs)) return;
      console.log(formatJobLoopDelay(job, delay));
    },
    onClaimError(error) {
      const stack = error instanceof Error ? error.stack : '';
      console.error(`[worker] claim failed: ${stack || error?.message || error}`);
    },
    watchdogMs: options.watchdogMs ?? process.env.AI_CENTER_JOB_LOOP_WATCHDOG_MS,
  });
  let runPromise = null;
  let schedulePromise = null;
  let quotaProbe = null;
  let translationBackfill = null;
  let translationGapTimer = null;
  let translationGapRunning = false;
  let translationGapCursor = null;
  let hardwarePriceTimer = null;
  let hardwarePriceEventId = 0;
  const hardwarePriceRefresh = options.enableDefaultSchedules !== false;
  const mainThreadWatchdog = startMainThreadWatchdog({
    enabled: mainThreadWatchdogEnabled(env),
    tasks: () => runner.runningTasks(),
  });
  let startupMaintenanceStarted = false;

  async function runDeferredTranslationStartup() {
    const deferredStep = createStartupClock();
    try {
      const retired = await retireYoutubeTranslationJobsBatched(store, 'local');
      console.log(`[worker] youtube-translation retired=${retired.cancelled} split=${retired.split}`);
    } catch (error) {
      console.error('[worker] youtube-translation retire failed:', error instanceof Error ? error.message : error);
    }
    deferredStep('youtube-retire');
    try {
      const demoted = await demoteQueuedHashTranslationJobsBatched(store, 'local');
      console.log(`[worker] translation-flood demoted=${demoted}`);
    } catch (error) {
      console.error('[worker] translation-flood failed:', error instanceof Error ? error.message : error);
    }
    deferredStep('translation-demote');
    const backfillLimit = translationStartupBackfillLimit(env.AI_CENTER_TRANSLATION_BACKFILL_LIMIT);
    const gapLimit = translationGapFillLimit(env.AI_CENTER_TRANSLATION_GAP_FILL_LIMIT);
    const gapInterval = translationGapFillIntervalMs(env.AI_CENTER_TRANSLATION_GAP_FILL_INTERVAL_MS);
    const runGapFill = async () => {
      if (translationGapRunning || gapLimit === 0) return;
      translationGapRunning = true;
      try {
        const result = await fillUncoveredTranslations({
          store,
          feedService,
          mediaService,
          workspaceId: 'local',
          limit: gapLimit,
          excludeSourceIds: [...(flashSources?.ids || [])],
          cursor: translationGapCursor,
        });
        translationGapCursor = result.cursor || null;
        console.log(`[worker] translation-gap-fill enqueued=${result.enqueued} limit=${gapLimit} scanned=${result.scanned} media=${result.media} feed=${result.feed}`);
      } catch (error) {
        console.error('[worker] translation-gap-fill failed:', error instanceof Error ? error.message : error);
      } finally {
        translationGapRunning = false;
      }
    };
    try {
      const repaired = repairEllipsisLeadTexts({ store, workspaceId: 'local', limit: backfillLimit });
      console.log(`[worker] ellipsis-lead bodies=${repaired.bodies} translations=${repaired.translations}`);
    } catch (error) {
      console.error('[worker] ellipsis-lead failed:', error instanceof Error ? error.message : error);
    }
    deferredStep('ellipsis-lead');
    translationBackfill ||= backfillUntranslatedFeedTranslations({
      store,
      feedService,
      workspaceId: 'local',
      limit: backfillLimit,
      excludeSourceIds: [...(flashSources?.ids || [])],
    }).then((result) => {
      const enqueued = Array.isArray(result?.jobs) ? result.jobs.length : 0;
      console.log(formatTranslationBackfillLog(result?.summary, { enqueued, limit: backfillLimit }));
    }).catch((error) => {
      console.error('[worker] translation-backfill failed:', error instanceof Error ? error.message : error);
    }).then(() => {
      if (gapLimit > 0 && gapInterval > 0) return runGapFill();
      return null;
    });
    deferredStep('translation-backfill');
    if (gapLimit > 0 && gapInterval > 0 && !translationGapTimer) {
      translationGapTimer = setInterval(() => { runGapFill(); }, gapInterval);
      translationGapTimer.unref?.();
    }
  }

  return {
    store,
    runner,
    scheduler,
    browserRuntime,
    start() {
      const startupStep = createStartupClock();
      quotaProbe ||= startGeminiQuotaProbe([articleAdmission, hourlyAdmission].filter(Boolean), { env });
      startupStep('quota-probe');
      schedulePromise ||= scheduler.start();
      startupStep('scheduler');
      runPromise ||= runner.start();
      startupStep('runner');
      const backfillCap = translationBackfillConcurrency(
        env.AI_CENTER_TRANSLATION_BACKFILL_CONCURRENCY,
        Number(env.AI_CENTER_WORKER_TRANSLATION_CONCURRENCY || 5),
      );
      console.log(`[worker] translation-slots limit=${Number(env.AI_CENTER_WORKER_TRANSLATION_CONCURRENCY || 5)} backfillCap=${backfillCap}`);
      if (!startupMaintenanceStarted) {
        startupMaintenanceStarted = true;
        setImmediate(() => {
          try { store.repositories.feed.startFeedSearchIndex?.(); }
          catch (error) {
            console.error('[worker] feed-search index failed:', error instanceof Error ? error.message : error);
          }
          runDeferredTranslationStartup().catch((error) => {
            console.error('[worker] startup maintenance failed:', error instanceof Error ? error.message : error);
          });
        });
      }
      if (hardwarePriceRefresh && !hardwarePriceTimer) {
        hardwarePriceEventId = store.latestEventId?.() ?? 0;
        hardwarePriceTimer = setInterval(() => {
          try {
            const events = store.listEvents(hardwarePriceEventId, 200);
            if (!events.length) return;
            hardwarePriceEventId = events.at(-1).id;
            enqueueHardwarePriceSnapshotFromEvents(store, events);
          } catch (error) {
            console.error('[worker] hardware-price-refresh failed:', error instanceof Error ? error.message : error);
          }
        }, 5_000);
        hardwarePriceTimer.unref?.();
      }
      return runPromise;
    },
    async close() {
      mainThreadWatchdog.stop();
      if (translationGapTimer) clearInterval(translationGapTimer);
      translationGapTimer = null;
      if (hardwarePriceTimer) clearInterval(hardwarePriceTimer);
      hardwarePriceTimer = null;
      quotaProbe?.stop();
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
  const instance = resolveInstanceConfig({ repositoryRoot });
  attachDailyProcessLog({directory: process.env.AI_CENTER_LOG_DIR || path.join(instance.dataDirectory, 'logs'), name: process.env.AI_CENTER_LOG_NAME || 'worker'});
  installWorkerLogStamps();
  const worker = createAiCenterWorker();
  console.log(`AI Center worker ${worker.runner.workerId}`);
  const healthStarted = Date.now();
  try {
    const health = await worker.browserRuntime?.health?.();
    if (health) {
      console.log(`[worker] browser provider=${worker.browserRuntime.providerId} daemon=${health.daemonConnected} extension=${health.browserConnected} browsers=${health.browsers}`);
    }
  } catch (error) {
    console.error('[worker] browser health failed:', error instanceof Error ? error.message : error);
  }
  console.log(formatStartupStep('browser-health', Date.now() - healthStarted));
  const runPromise = worker.start();
  const shutdown = async () => {
    await worker.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await runPromise;
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
