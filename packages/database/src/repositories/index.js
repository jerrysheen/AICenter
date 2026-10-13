import { createModelQuotaRepository } from './model-quota-repository.js';
import { createFeedRepository } from './feed-repository.js';
import { createInformationTreeRepository } from './information-tree-repository.js';
import { createModelUsageRepository } from './model-usage-repository.js';
import { createMediaRepository } from './media-repository.js';
import { createComputePriceRepository } from './compute-price-repository.js';
import { createHardwarePriceRepository } from './hardware-price-repository.js';
import { createKnowledgeRepository } from './knowledge-repository.js';
import { createReportRepository } from './report-repository.js';
import { createStrategyRepository } from './strategy-repository.js';
import { createTaggingRepository } from './tagging-repository.js';
import { createResearchRecallRepository } from './research-recall-repository.js';
import { createTradingRepository } from './trading-repository.js';
import { createEtfWhaleRepository } from './etf-whale-repository.js';
import { createEventQuoteRepository } from './event-quote-repository.js';
import { createInvestorDiscussionRepository } from './investor-discussion-repository.js';
import { createApiTokenRepository } from './api-token-repository.js';
import { createRuntimeSnapshotRepository } from './runtime-snapshot-repository.js';

export function createDomainRepositories(database, emitEvent) {
  return Object.freeze({
    informationTree: createInformationTreeRepository(database, emitEvent),
    modelUsage: createModelUsageRepository(database, emitEvent),
    modelQuota: createModelQuotaRepository(database, emitEvent),
    feed: createFeedRepository(database, emitEvent),
    media: createMediaRepository(database, emitEvent),
    hardwarePrices: createHardwarePriceRepository(database, emitEvent),
    computePrices: createComputePriceRepository(database),
    trading: createTradingRepository(database, emitEvent),
    etfWhale: createEtfWhaleRepository(database, emitEvent),
    eventQuotes: createEventQuoteRepository(database, emitEvent),
    investorDiscussion: createInvestorDiscussionRepository(database, emitEvent),
    apiTokens: createApiTokenRepository(database),
    runtimeSnapshots: createRuntimeSnapshotRepository(database),
    knowledge: createKnowledgeRepository(database, emitEvent),
    tagging: createTaggingRepository(database, emitEvent),
    research: createResearchRecallRepository(database, emitEvent),
    report: createReportRepository(database, emitEvent),
    strategy: createStrategyRepository(database, emitEvent),
  });
}
