import { createAuthorService } from './author-service.js';
import { createFeedService } from './feed-service.js';
import { createFeedInteractionService } from './feed-interaction-service.js';
import { createInformationTreeReader } from './information-tree-service.js';
import { createReadingHourService, readingHourSourceAccess } from './reading-hour-service.js';
import { createModelUsageService } from './model-usage-service.js';
import { createBambooUsageView } from './bamboo-usage-view.js';
import { createMediaIngestionService } from './media-ingestion-service.js';
import { createIdentityService } from './identity-service.js';
import { createKnowledgeService } from './knowledge-service.js';
import { createMarketStatisticsService } from './market-statistics-service.js';
import { createDailyBriefService } from './daily-brief-service.js';
import { createReportService } from './report-service.js';
import { createRuntimeService } from './runtime-service.js';
import { createTradingService } from './trading-service.js';
import { createDividendStrategyService } from './trading-strategies/strategy-service.js';
import { createContextService } from './context-service.js';
import { createTaggingService } from './tagging-service.js';
import { createQuantLabService } from './quant-lab-service.js';
import { createEtfWhaleReadService } from './etf-whale-service.js';
import { createEventQuoteSnapshotService } from './event-quote-snapshots.js';
import { createInvestorDiscussionService } from './investor-discussion.js';
import { createComputePriceService } from './compute-price-service.js';
import { createInferencexService } from './inferencex-service.js';
import { createApiTokenService } from './api-token-service.js';
import { createSouthboundReadService } from './southbound-service.js';
import { createNorthboundReadService } from './northbound-service.js';
import { createYoutubePodcastService } from './youtube-podcasts-service.js';
import { createXVideoService } from './x-video-service.js';
import { createXLinkService } from './x-link-service.js';
import { createHourlyCategoryService, hourlyCategoryEnabled } from './hourly-category.js';

export { createContextService, createDailyBriefService, createFeedService, createIdentityService, createKnowledgeService, createMarketStatisticsService, createMediaIngestionService, createReportService, createRuntimeService, createTradingService, createTaggingService };
export { buildDailyBriefCandidates } from './daily-brief-candidates.js';
export { createDividendStrategyService } from './trading-strategies/strategy-service.js';
export { createQuantLabService } from './quant-lab-service.js';
export { resolveDailyConfig, resolveDailyTimeContext, resolveDailyWindow, resolveReportDate } from './daily-window.js';
export { buildFactorSnapshot } from './market-factors/factor-engine.js';
export { resolveLoginCredential } from './identity-service.js';
export { buildContinuedWorkPackageBody, parseContinuedWorkPackageBody } from './knowledge-service.js';
export { computeFeedIdentityHash, feedItemIdentityHash } from './feed-identity.js';
export { packFeedAiBatches } from './feed-ai-batch.js';
export { collectLocalizationUnits, localizationItemId, needsZhLocalization } from './localize-texts.js';
export { loadTagCatalog, projectTagCatalog, selectionModeFor } from './tag-catalog.js';
export { applyResearchAddition, loadResearchCatalog, projectResearchTags, RESEARCH_TAG_PROMPT_VERSION, RESEARCH_RELEVANCE_PROMPT_VERSION } from './research-catalog.js';
export { createResearchRecallService } from './research-recall-service.js';
export { compareRecallMethods, scoreRecall, scoreRecallByStratum, splitLabeledSet } from './research-eval.js';
export { parseTagBatchOutput, extractTagBatchObject, tagBatchOutputComplete } from './tag-parser.js';
export { TAG_PROMPT_VERSION } from './tag-prompt.js';
export { classifyProcessRestart } from './process-restart.js';
export { resolveResearchProfile } from './research-profile.js';
export {
  FEED_FILTER_VERSION,
  buildFeedFilterQuestions,
  buildFeedFilterState,
  createFeedFilter,
  createFeedFilterFromEnv,
  decideFeedAdmissionFallback,
  decideFeedFilter,
  evaluateDeterministic,
  hasSubstantialText,
  parseFeedFilterAnswers,
  resolveFeedFilterConfig,
} from './feed-filter.js';
export {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
  decodeAttachmentData,
  projectAttachment,
  sniffImageMime,
} from './attachment.js';

export function createDomainServices({
  store, sourcePort, personalAssetPort, workspaceId = 'local', translationPort,
  dataDirectory = null, env = process.env,
  agentProgressPort, fileKnowledgePort = null, tagCatalog = null, taggingPort = null,
  restartPort = null,
  workPackageTracePort = null,
  attachmentStore = null,
  loginCredential = null,
  feedFilter = null,
  mediaService = null,
  hardwarePriceService = null,
  contentRoutingPort = null,
  dailyConfig = null,
  staticSignalPort = null,
  holdingsQuotePort = null,
  marketBoardPort = null,
  quantRoot = null,
  modelUsageRates = [],
  informationPipeline = 'legacy',
  onContentReady = null,
  flashSources = null,
  analysisSkillCatalog = null,
  parityDirectory = '',
  youtubeConfigPath = '',
}) {
  if (!store?.repositories) throw new Error('store repositories are required');
  const media = mediaService || (store.repositories.media
    ? createMediaIngestionService({
      mediaRepository: store.repositories.media,
      feedRepository: store.repositories.feed,
      taggingRepository: store.repositories.tagging,
      feedFilter,
      flashSources,
    })
    : null);
  const authorQualityRule = feedFilter?.config?.mode === 'enforce' && feedFilter.config.rule === 'all-three-0.60'
    ? 'all-three-0.60'
    : '';
  const authors = store.repositories.authors
    ? createAuthorService({
      authorRepository: store.repositories.authors,
      feedRepository: store.repositories.feed,
      qualityRule: authorQualityRule,
    })
    : null;
  const feed = createFeedService({
    legacyRepository: store,
    feedRepository: store.repositories.feed,
    sourcePort,
    translationPort,
    feedFilter,
    mediaPort: media,
    contentRoutingPort,
    onContentReady,
    flashSources,
    taggingRepository: store.repositories.tagging,
    normalizedArticlePort:informationPipeline==='tree-v3' ? createInformationTreeReader({repository:store.repositories.informationTree,pipeline:informationPipeline}) : null,
  });
  const trading = createTradingService({
    tradingRepository: store.repositories.trading,
    sourcePort,
    personalAssetPort,
    holdingsQuotePort,
    marketBoardPort,
    workspaceId,
  });
  const knowledge = createKnowledgeService({
    legacyRepository: store,
    knowledgeRepository: store.repositories.knowledge,
    fileKnowledgePort,
    workPackageTracePort,
    attachmentStore,
  });
  const tagging = tagCatalog
    ? createTaggingService({
      catalog: tagCatalog,
      taggingRepository: store.repositories.tagging,
      taggingPort,
    })
    : null;
  const resolvedDailyConfig = dailyConfig || resolveDailyConfig({});
  const marketStatistics = sourcePort?.read ? createMarketStatisticsService({ sourcePort }) : null;
  const strategy = store.repositories.strategy
    ? createDividendStrategyService({
      strategyRepository: store.repositories.strategy,
      basketPort: marketStatistics,
    })
    : null;
  const report = createReportService({
    reportRepository: store.repositories.report,
    feedService: feed,
    tradingService: trading,
    mediaPort: media,
    staticSignalPort,
    strategyPort: strategy,
    defaultConfig: resolvedDailyConfig,
  });
  return Object.freeze({
    informationTree: createInformationTreeReader({repository:store.repositories.informationTree,timezone:resolvedDailyConfig.timezone,pipeline:informationPipeline,catalog:tagCatalog || {}}),
    hourlyCategory: store.repositories.hourlyCategory
      ? createHourlyCategoryService({
        repository: store.repositories.hourlyCategory,
        catalog: tagCatalog?.tags ? tagCatalog : { tags: [] },
        enabled: hourlyCategoryEnabled(env),
      })
      : null,
    readingHour: createReadingHourService({
      repository:store.repositories.informationTree,
      enabled: env.AI_CENTER_READING_HOUR === '1',
      env,
      ...readingHourSourceAccess({ feed: store.repositories.feed, media: store.repositories.media }),
    }),
    modelUsage: createModelUsageService({ repository: store.repositories.modelUsage, workspaceId, rates: modelUsageRates, getJob: id => store.getJob(id) }),
    bambooUsage: createBambooUsageView({ directory: dataDirectory, env }),
    identity: createIdentityService({ identityRepository: store, loginCredential }),
    feed,
    authors,
    feedInteraction: createFeedInteractionService({ feedRepository: store.repositories.feed, runtimeRepository: store }),
    media,
    hardwarePrices: hardwarePriceService,
    trading,
    knowledge,
    tagging,
    context: createContextService({ feedService: feed, tradingService: trading, knowledgeService: knowledge, reportService: report }),
    runtime: createRuntimeService({
      runtimeRepository: store,
      agentProgressPort,
      restartPort,
      feedFilterConfig:feedFilter?.config || null,
      dailyConfig: resolvedDailyConfig,
      analysisSkillCatalog,
      dataDirectory,
      env,
    }),
    report,
    marketStatistics,
    strategy,
    sources: sourcePort,
    quant: createQuantLabService({
      quantRoot,
      listJobs: () => store.listJobs?.(100) || [],
    }),
    etfWhale: createEtfWhaleReadService({
      repository: store.repositories.etfWhale,
      parityDirectory,
    }),
    eventQuotes: store.repositories.eventQuotes
      ? createEventQuoteSnapshotService({ repository: store.repositories.eventQuotes })
      : null,
    investorDiscussion: store.repositories.investorDiscussion
      ? createInvestorDiscussionService({
        repository: store.repositories.investorDiscussion,
        listOpenJobs: (type) => store.listOpenJobs?.(type) || [],
        timeZone: env.AI_CENTER_INVESTOR_DIGEST_TIMEZONE || 'Asia/Shanghai',
      })
      : null,
    computePrices: store.repositories.computePrices
      ? createComputePriceService({ repository: store.repositories.computePrices })
      : null,
    inferencex: store.repositories.inferencex
      ? createInferencexService({ repository: store.repositories.inferencex })
      : null,
    southbound: store.repositories.southbound
      ? createSouthboundReadService({
        repository: store.repositories.southbound,
        snapshots: store.repositories.runtimeSnapshots,
      })
      : null,
    northbound: store.repositories.northbound
      ? createNorthboundReadService({ repository: store.repositories.northbound })
      : null,
    apiTokens: createApiTokenService({
      repository: store.repositories.apiTokens,
      ratePerMinute: env.AI_CENTER_API_TOKEN_RATE_PER_MINUTE,
      logRetentionDays: env.AI_CENTER_API_TOKEN_LOG_RETENTION_DAYS,
    }),
    youtubePodcasts: store.repositories.youtubePodcasts
      ? createYoutubePodcastService({
        repository: store.repositories.youtubePodcasts,
        store,
        configPath: youtubeConfigPath,
        env,
      })
      : null,
    xVideos: store.repositories.xVideos
      ? createXVideoService({
        repository: store.repositories.xVideos,
        feedRepository: store.repositories.feed,
        store,
        env,
      })
      : null,
    xLinks: store.repositories.xLinks
      ? createXLinkService({
        repository: store.repositories.xLinks,
        feedRepository: store.repositories.feed,
        store,
        env,
      })
      : null,
  });
}
