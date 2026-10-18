import { createAudioTranscriptionRoutes } from './audio-transcription-routes.js';
import { createEventRoutes } from './event-routes.js';
import { createInvestorDiscussionRoutes } from './investor-discussion-routes.js';
import { createAgentRoutes } from './agent-routes.js';
import { createArticleAnalysisRoutes } from './article-analysis-routes.js';
import { createContextRoutes } from './context-routes.js';
import { createHardwarePriceRoutes } from './hardware-price-routes.js';
import { createComputePriceRoutes } from './compute-price-routes.js';
import { createFeedRoutes } from './feed-routes.js';
import { createFeedInteractionRoutes } from './feed-interaction-routes.js';
import { createXFocusRoutes } from './x-focus-routes.js';
import { createIdentityRoutes } from './identity-routes.js';
import { createApiTokenRoutes } from './api-token-routes.js';
import { createKnowledgeRoutes } from './knowledge-routes.js';
import { createRuntimeRoutes } from './runtime-routes.js';
import { createHomeRoutes } from './home-routes.js';
import { createReportRoutes } from './report-routes.js';
import { createStrategyRoutes } from './strategy-routes.js';
import { createQuantRoutes } from './quant-routes.js';
import { createEtfWhaleRoutes } from './etf-whale-routes.js';
import { createSystemRoutes } from './system-routes.js';
import { createTradingRoutes } from './trading-routes.js';
import { createSourceRoutes } from './source-routes.js';
import { createTaggingRoutes } from './tagging-routes.js';

export function createApiRoutes({ slots, offthread = null } = {}) {
  return [
    ...createSystemRoutes(),
    ...createIdentityRoutes(),
    ...createApiTokenRoutes(),
    ...createRuntimeRoutes(),
    ...createSourceRoutes(),
    ...createXFocusRoutes(),
    ...createFeedRoutes({ slots, offthread }),
    ...createFeedInteractionRoutes(),
    ...createHardwarePriceRoutes({ slots, offthread }),
    ...createComputePriceRoutes(),
    ...createKnowledgeRoutes(),
    ...createTaggingRoutes(),
    ...createContextRoutes(),
    ...createAgentRoutes(),
    ...createArticleAnalysisRoutes(),
    ...createTradingRoutes(),
    ...createHomeRoutes({ slots }),
    ...createReportRoutes({ slots, offthread }),
    ...createStrategyRoutes(),
    ...createQuantRoutes(),
    ...createEtfWhaleRoutes(),
    ...createAudioTranscriptionRoutes(),
    ...createEventRoutes(),
    ...createInvestorDiscussionRoutes(),
  ];
}
