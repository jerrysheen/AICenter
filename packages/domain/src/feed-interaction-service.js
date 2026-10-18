import { ValidationError } from '../../contracts/src/index.js';
import { LikeContentInputSchema, LikeResultSchema, UnlikeContentInputSchema, UnlikeResultSchema, X_LIKE_JOB_TYPE, X_UNLIKE_JOB_TYPE } from '../../contracts/src/feed-interaction.js';

export function createFeedInteractionService({ feedRepository, runtimeRepository, likePort = null }) {
  function target(workspaceId, contentItemId) {
    const item = feedRepository.getContentItem(workspaceId, contentItemId);
    if (!item || item.provider !== 'x' || !/^\d{1,25}$/.test(item.externalId)) throw new ValidationError('只能点赞已保存的 X 推文');
    let url;
    try { url = new URL(item.sourceUrl); } catch { throw new ValidationError('推文原始链接无效'); }
    if (!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname) || url.protocol !== 'https:'
      || url.pathname.match(/\/status\/(\d+)(?:\/|$)/)?.[1] !== item.externalId) throw new ValidationError('推文 ID 与原始链接不一致');
    return item.externalId;
  }
  return Object.freeze({
    requestLike(workspaceId, input) {
      const value = LikeContentInputSchema.parse(input);
      target(workspaceId, value.contentItemId);
      const open = runtimeRepository.listOpenJobs(X_LIKE_JOB_TYPE).find(job => job.workspaceId === workspaceId);
      if (open && open.input.contentItemId !== value.contentItemId) throw new ValidationError('已有点赞正在处理，请稍后再试');
      if (runtimeRepository.listOpenJobs(X_UNLIKE_JOB_TYPE).some(job => job.workspaceId === workspaceId)) throw new ValidationError('已有点赞正在处理，请稍后再试');
      return open || runtimeRepository.createJob({ type: X_LIKE_JOB_TYPE, workspaceId, input: value, maxAttempts: 1, priority: 20 });
    },
    async executeLike(workspaceId, input) {
      const value = LikeContentInputSchema.parse(input);
      const postId = target(workspaceId, value.contentItemId);
      if (!likePort) return { status: 'unavailable', accountHandle: '', checkedAt: Date.now() };
      return LikeResultSchema.parse(await likePort.like(postId));
    },
    requestUnlike(workspaceId, input) {
      const value = UnlikeContentInputSchema.parse(input);
      target(workspaceId, value.contentItemId);
      const openLike = runtimeRepository.listOpenJobs(X_LIKE_JOB_TYPE).find(job => job.workspaceId === workspaceId);
      if (openLike) throw new ValidationError('已有点赞正在处理，请稍后再试');
      const open = runtimeRepository.listOpenJobs(X_UNLIKE_JOB_TYPE).find(job => job.workspaceId === workspaceId);
      if (open && open.input.contentItemId !== value.contentItemId) throw new ValidationError('已有取消点赞正在处理，请稍后再试');
      return open || runtimeRepository.createJob({ type: X_UNLIKE_JOB_TYPE, workspaceId, input: value, maxAttempts: 1, priority: 20 });
    },
    async executeUnlike(workspaceId, input) {
      const value = UnlikeContentInputSchema.parse(input);
      const postId = target(workspaceId, value.contentItemId);
      if (!likePort?.unlike) return { status: 'unavailable', accountHandle: '', checkedAt: Date.now() };
      return UnlikeResultSchema.parse(await likePort.unlike(postId));
    },
    getLikeJob(workspaceId, contentItemId, jobId) {
      const job = runtimeRepository.getJob(jobId);
      if (!job || job.workspaceId !== workspaceId || job.type !== X_LIKE_JOB_TYPE || job.input?.contentItemId !== contentItemId) return null;
      return { id: job.id, status: job.status, result: job.status === 'completed' ? LikeResultSchema.parse(job.output) : null };
    },
    getUnlikeJob(workspaceId, contentItemId, jobId) {
      const job = runtimeRepository.getJob(jobId);
      if (!job || job.workspaceId !== workspaceId || job.type !== X_UNLIKE_JOB_TYPE || job.input?.contentItemId !== contentItemId) return null;
      return { id: job.id, status: job.status, result: job.status === 'completed' ? UnlikeResultSchema.parse(job.output) : null };
    },
  });
}
