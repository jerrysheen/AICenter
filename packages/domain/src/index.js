import { createFeedService } from './feed-service.js';
import { createIdentityService } from './identity-service.js';
import { createKnowledgeService } from './knowledge-service.js';
import { createRuntimeService } from './runtime-service.js';
import { createTradingService } from './trading-service.js';
import { createContextService } from './context-service.js';
import { createTaggingService } from './tagging-service.js';

export { createContextService, createFeedService, createIdentityService, createKnowledgeService, createRuntimeService, createTradingService, createTaggingService };
export { packFeedAiBatches } from './feed-ai-batch.js';
export { loadTagCatalog, projectTagCatalog, selectionModeFor } from './tag-catalog.js';
export { parseTagBatchOutput, extractTagBatchObject, tagBatchOutputComplete } from './tag-parser.js';
export { TAG_PROMPT_VERSION } from './tag-prompt.js';

export function createDomainServices({
  store, sourcePort, personalAssetPort, workspaceId = 'local', translationPort,
  agentProgressPort, fileKnowledgePort = null, tagCatalog = null, taggingPort = null,
}) {
  if (!store?.repositories) throw new Error('store repositories are required');
  const feed = createFeedService({
    legacyRepository: store,
    feedRepository: store.repositories.feed,
    sourcePort,
    translationPort,
  });
  const trading = createTradingService({
    tradingRepository: store.repositories.trading,
    sourcePort,
    personalAssetPort,
    workspaceId,
  });
  const knowledge = createKnowledgeService({
    legacyRepository: store,
    knowledgeRepository: store.repositories.knowledge,
    fileKnowledgePort,
  });
  const tagging = tagCatalog
    ? createTaggingService({
      catalog: tagCatalog,
      taggingRepository: store.repositories.tagging,
      taggingPort,
    })
    : null;
  return Object.freeze({
    identity: createIdentityService({ identityRepository: store }),
    feed,
    trading,
    knowledge,
    tagging,
    context: createContextService({ feedService: feed, tradingService: trading, knowledgeService: knowledge }),
    runtime: createRuntimeService({ runtimeRepository: store, agentProgressPort }),
    sources: sourcePort,
  });
}
