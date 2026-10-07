import { X_LIKE_JOB_TYPE } from '../../contracts/src/feed-interaction.js';

export const feedInteractionManifest = {
  id: 'feed.interaction', version: '1.0.0', capabilities: ['feed.interaction.like'], jobTypes: [X_LIKE_JOB_TYPE], sourceIds: [],
};
export function createFeedInteractionJobHandlers(service) {
  return { [X_LIKE_JOB_TYPE]: (input, context) => service.executeLike(context.job.workspaceId, input) };
}
