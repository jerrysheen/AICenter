import { existsSync, readFileSync } from 'node:fs';
import { parseContract, TagAnalyzeJobInputSchema } from '../../contracts/src/index.js';
import { loadTagCatalog } from '../../domain/src/tag-catalog.js';

export const taggingManifest = Object.freeze({
  id: 'tagging.analyze',
  version: '1.0.0',
  capabilities: ['tagging.analyze'],
  jobTypes: ['tagging.analyze'],
});

export function readTagCatalogFile(filePath) {
  if (!filePath || !existsSync(filePath)) {
    throw new Error(`找不到 tag catalog：${filePath || ''}`);
  }
  return loadTagCatalog(readFileSync(filePath, 'utf8'));
}

function collectItems({ input, feedService, knowledgeService }) {
  const workspaceId = input.workspaceId || 'local';
  if (input.resourceType === 'content-item') {
    return feedService.listTaggableItems(workspaceId, {
      limit: input.limit,
      ids: input.resourceIds,
    });
  }
  return knowledgeService.listTaggableItems(workspaceId, input.resourceType, {
    limit: input.limit,
    ids: input.resourceIds,
  });
}

export function createTaggingJobHandlers({ taggingService, feedService, knowledgeService }) {
  if (!taggingService) throw new Error('tagging jobs require taggingService');
  return {
    'tagging.analyze': async (rawInput) => {
      const input = parseContract(TagAnalyzeJobInputSchema, rawInput || {});
      const items = collectItems({ input, feedService, knowledgeService });
      return taggingService.analyzeItems({
        workspaceId: input.workspaceId,
        resourceType: input.resourceType,
        items,
        force: input.force,
      });
    },
  };
}
