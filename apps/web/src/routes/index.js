import { createEventRoutes } from './event-routes.js';
import { createAgentRoutes } from './agent-routes.js';
import { createContextRoutes } from './context-routes.js';
import { createFeedRoutes } from './feed-routes.js';
import { createIdentityRoutes } from './identity-routes.js';
import { createKnowledgeRoutes } from './knowledge-routes.js';
import { createRuntimeRoutes } from './runtime-routes.js';
import { createSystemRoutes } from './system-routes.js';
import { createTradingRoutes } from './trading-routes.js';
import { createSourceRoutes } from './source-routes.js';
import { createTaggingRoutes } from './tagging-routes.js';

export function createApiRoutes() {
  return [
    ...createSystemRoutes(),
    ...createIdentityRoutes(),
    ...createRuntimeRoutes(),
    ...createSourceRoutes(),
    ...createFeedRoutes(),
    ...createKnowledgeRoutes(),
    ...createTaggingRoutes(),
    ...createContextRoutes(),
    ...createAgentRoutes(),
    ...createTradingRoutes(),
    ...createEventRoutes(),
  ];
}
