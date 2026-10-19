import { X_LIKE_JOB_TYPE, X_UNLIKE_JOB_TYPE } from '../../contracts/src/feed-interaction.js';

export const feedInteractionManifest = {
  id: 'feed.interaction', version: '1.0.0', capabilities: ['feed.interaction.like', 'feed.interaction.unlike'], jobTypes: [X_LIKE_JOB_TYPE, X_UNLIKE_JOB_TYPE], sourceIds: [],
};
export function createFeedInteractionJobHandlers(service, hooks = {}) {
  return {
    [X_LIKE_JOB_TYPE]: async (input, context) => {
      try {
        const output = await service.executeLike(context.job.workspaceId, input);
        if (input?.source === 'auto') {
          try { await hooks.onAutoLike?.(context.job.workspaceId, output); }
          catch { /* the like result still stands */ }
        }
        return output;
      } catch (error) {
        if (input?.source === 'auto') {
          const reason = String(error?.message || error?.name || '任务出错').trim() || '任务出错';
          try {
            await hooks.onAutoLike?.(context.job.workspaceId, {
              status: 'failed',
              reason,
              jobId: context.job?.id || '',
            });
          } catch { /* the job failure still stands */ }
        }
        throw error;
      }
    },
    [X_UNLIKE_JOB_TYPE]: (input, context) => service.executeUnlike(context.job.workspaceId, input),
  };
}
