import { X_LIKE_JOB_TYPE, X_UNLIKE_JOB_TYPE } from '../../contracts/src/feed-interaction.js';

export const feedInteractionManifest = {
  id: 'feed.interaction', version: '1.0.0', capabilities: ['feed.interaction.like', 'feed.interaction.unlike'], jobTypes: [X_LIKE_JOB_TYPE, X_UNLIKE_JOB_TYPE], sourceIds: [],
};
export function createFeedInteractionJobHandlers(service, hooks = {}) {
  return {
    [X_LIKE_JOB_TYPE]: async (input, context) => {
      const output = await service.executeLike(context.job.workspaceId, input);
      if (input?.source === 'auto') {
        try { await hooks.onAutoLike?.(context.job.workspaceId, output); }
        catch { /* the like result still stands */ }
      }
      return output;
    },
    [X_UNLIKE_JOB_TYPE]: (input, context) => service.executeUnlike(context.job.workspaceId, input),
  };
}
