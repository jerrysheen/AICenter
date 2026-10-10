import { createModelQuotaRepository } from './model-quota-repository.js';
import { createFeedRepository } from './feed-repository.js';
import { createInformationTreeRepository } from './information-tree-repository.js';
import { createModelUsageRepository } from './model-usage-repository.js';
import { createMediaRepository } from './media-repository.js';
import { createHardwarePriceRepository } from './hardware-price-repository.js';
import { createKnowledgeRepository } from './knowledge-repository.js';
import { createReportRepository } from './report-repository.js';
import { createStrategyRepository } from './strategy-repository.js';
import { createTaggingRepository } from './tagging-repository.js';
import { createResearchRecallRepository } from './research-recall-repository.js';
import { createTradingRepository } from './trading-repository.js';
import { createEtfWhaleRepository } from './etf-whale-repository.js';

export function createDomainRepositories(database, emitEvent) {
  return Object.freeze({
    informationTree: createInformationTreeRepository(database, emitEvent),
    modelUsage: createModelUsageRepository(database, emitEvent),
    modelQuota: createModelQuotaRepository(database, emitEvent),
    feed: createFeedRepository(database, emitEvent),
    media: createMediaRepository(database, emitEvent),
    hardwarePrices: createHardwarePriceRepository(database, emitEvent),
    trading: createTradingRepository(database, emitEvent),
    etfWhale: createEtfWhaleRepository(database, emitEvent),
    knowledge: createKnowledgeRepository(database, emitEvent),
    tagging: createTaggingRepository(database, emitEvent),
    research: createResearchRecallRepository(database, emitEvent),
    report: createReportRepository(database, emitEvent),
    strategy: createStrategyRepository(database, emitEvent),
  });
}
