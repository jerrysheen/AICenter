import { createFeedRepository } from './feed-repository.js';
import { createKnowledgeRepository } from './knowledge-repository.js';
import { createTaggingRepository } from './tagging-repository.js';
import { createTradingRepository } from './trading-repository.js';

export function createDomainRepositories(database, emitEvent) {
  return Object.freeze({
    feed: createFeedRepository(database, emitEvent),
    trading: createTradingRepository(database, emitEvent),
    knowledge: createKnowledgeRepository(database, emitEvent),
    tagging: createTaggingRepository(database, emitEvent),
  });
}
