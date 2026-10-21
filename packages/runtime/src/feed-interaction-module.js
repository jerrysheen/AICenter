import { X_LIKE_JOB_TYPE, X_NOT_INTERESTED_JOB_TYPE, X_UNLIKE_JOB_TYPE } from '../../contracts/src/feed-interaction.js';

export const feedInteractionManifest = {
  id: 'feed.interaction', version: '1.0.0', capabilities: ['feed.interaction.like', 'feed.interaction.unlike', 'feed.interaction.not-interested'], jobTypes: [X_LIKE_JOB_TYPE, X_UNLIKE_JOB_TYPE, X_NOT_INTERESTED_JOB_TYPE], sourceIds: [],
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
    [X_NOT_INTERESTED_JOB_TYPE]: async (input, context) => {
      const note = (output) => ({
        ...output,
        tweetId: input?.tweetId || '',
        contentItemId: input?.contentItemId || '',
        jobId: context.job?.id || '',
      });
      try {
        const output = await service.executeNotInterested(context.job.workspaceId, input);
        try { await hooks.onNotInterested?.(context.job.workspaceId, note(output)); }
        catch { /* the result still stands */ }
        return output;
      } catch (error) {
        const reason = String(error?.message || error?.name || '任务出错').trim() || '任务出错';
        try {
          await hooks.onNotInterested?.(context.job.workspaceId, note({ status: 'failed', reason }));
        } catch { /* the job failure still stands */ }
        throw error;
      }
    },
  };
}
