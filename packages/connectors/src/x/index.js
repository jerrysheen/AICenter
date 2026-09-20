export {
  createTwitterHomeClient,
  createTwitterService,
  explainXConnectorError,
  findXArticleUrl,
  mergeArticleIntoTweetText,
  normalizeTweetBody,
  normalizeXArticleUrl,
  normalizeXHomeFeed,
  parseTwitterHandle,
  tweetToFeedItem,
} from './home-timeline.js';

export const xConnectorManifest = {
  id: 'connector.x',
  version: '1.0.0',
  capabilities: ['feed.capture'],
  jobTypes: ['feed.x.sync'],
  sourceIds: ['content.x.home'],
};

export function createXJobHandlers(options = {}) {
  return {
    async 'feed.x.sync'(input, context) {
      if (typeof options.syncFeed !== 'function') {
        throw new Error('feed.x.sync 缺少 Worker 注入的 Feed Port');
      }
      const feed = await options.syncFeed('x', { ...(input || {}), refresh: true }, {
        workspaceId: context.job?.workspaceId || 'local',
      });
      context.store.setProviderHealth('x', feed.mode === 'live' ? 'healthy' : 'error', feed.note, {
        feed: feed.feed,
        tweetCount: feed.tweetCount,
      });
      return {
        ok: feed.mode !== 'error',
        mode: feed.mode,
        tweetCount: feed.tweetCount,
        note: feed.note,
      };
    },
  };
}
