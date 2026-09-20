import { createFeedService } from './feed-service.js';
import { createIdentityService } from './identity-service.js';
import { createKnowledgeService } from './knowledge-service.js';
import { createRuntimeService } from './runtime-service.js';
import { createTradingService } from './trading-service.js';
import { createContextService } from './context-service.js';
import { createTaggingService } from './tagging-service.js';

export { createContextService, createFeedService, createIdentityService, createKnowledgeService, createRuntimeService, createTradingService, createTaggingService };
export { resolveLoginCredential } from './identity-service.js';
export { buildContinuedWorkPackageBody, parseContinuedWorkPackageBody } from './knowledge-service.js';
export { computeFeedIdentityHash, feedItemIdentityHash } from './feed-identity.js';
export { packFeedAiBatches } from './feed-ai-batch.js';
export { collectLocalizationUnits, localizationItemId, needsZhLocalization } from './localize-texts.js';
export { loadTagCatalog, projectTagCatalog, selectionModeFor } from './tag-catalog.js';
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
  agentProgressPort, fileKnowledgePort = null, tagCatalog = null, taggingPort = null,
  restartPort = null,
  workPackageTracePort = null,
  attachmentStore = null,
  loginCredential = null,
  feedFilter = null,
}) {
  if (!store?.repositories) throw new Error('store repositories are required');
  const feed = createFeedService({
    legacyRepository: store,
    feedRepository: store.repositories.feed,
    sourcePort,
    translationPort,
    feedFilter,
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
  return Object.freeze({
    identity: createIdentityService({ identityRepository: store, loginCredential }),
    feed,
    trading,
    knowledge,
    tagging,
    context: createContextService({ feedService: feed, tradingService: trading, knowledgeService: knowledge }),
    runtime: createRuntimeService({ runtimeRepository: store, agentProgressPort, restartPort }),
    sources: sourcePort,
  });
}
