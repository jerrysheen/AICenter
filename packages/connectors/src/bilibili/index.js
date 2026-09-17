import { fetchBilibiliAiSubtitle, videoToFeedItem } from './subtitle.js';
import { createTranscriptFormatService } from './format.js';

export {
  chooseAiZhSubtitle,
  extractBilibiliInput,
  extractBvid,
  fetchBilibiliAiSubtitle,
  resolveBvid,
  subtitleBodyToText,
  videoToFeedItem,
} from './subtitle.js';
export { createTranscriptFormatService, looksLikeMarkdown, unwrapMarkdownFence } from './format.js';

export const bilibiliConnectorManifest = {
  id: 'connector.bilibili',
  version: '1.0.0',
  capabilities: ['feed.capture'],
  jobTypes: ['feed.bilibili.sync'],
  sourceIds: ['content.bilibili.import'],
};

export function createBilibiliClient(options = {}) {
  if (typeof options.fetchBilibiliAiSubtitle === 'function') {
    return { fetchBilibiliAiSubtitle: options.fetchBilibiliAiSubtitle };
  }
  return {
    fetchBilibiliAiSubtitle(input) {
      return fetchBilibiliAiSubtitle(input, {
        ...options,
        browserRuntime: options.browserRuntime,
      });
    },
  };
}

export function createBilibiliService(options = {}) {
  const client = options.client || createBilibiliClient(options);
  const formatter = options.formatter || createTranscriptFormatService(options);
  const now = options.now || (() => Date.now());

  async function getFeed({ url = '', refresh = false } = {}) {
    const fetchedAt = now();
    if (!refresh || !String(url || '').trim()) {
      return {
        platform: 'bilibili',
        workspaceId: 'local',
        feed: 'imports',
        handle: '',
        source: 'browser_runtime_player',
        mode: 'empty',
        loggedIn: false,
        tweetCount: 0,
        fetchedAt,
        note: '贴一条 B 站视频链接后，会用已登录浏览器只抓 AI 中文字幕。',
        items: [],
      };
    }

    const result = await client.fetchBilibiliAiSubtitle(url);
    if (result.status === 'ok' && result.fullText) {
      const item = videoToFeedItem(result);
      let formatEngine = 'passthrough';
      try {
        const formatted = await formatter.formatTranscript(result.fullText, {
          title: result.title,
          owner: result.owner,
        });
        if (formatted?.text) {
          item.body = formatted.text;
          item.summary = formatted.text.slice(0, 160);
          formatEngine = formatted.engine || 'passthrough';
        }
      } catch (error) {
        formatEngine = 'passthrough';
        console.error('[bilibili] transcript format failed:', error instanceof Error ? error.message : error);
      }
      item.originalText = result.fullText;
      item.formatEngine = formatEngine;
      return {
        platform: 'bilibili',
        workspaceId: 'local',
        feed: 'imports',
        handle: '',
        source: 'browser_runtime_player',
        mode: 'live',
        loggedIn: true,
        tweetCount: 1,
        fetchedAt,
        note: formatEngine === 'gemini'
          ? `已抓取 AI 中文字幕并整理排版 · ${result.title || result.bvid}`
          : `已抓取 AI 中文字幕 · ${result.title || result.bvid}`,
        items: [item],
      };
    }

    const missing = result.status === 'subtitle_unavailable' || result.error === '没有';
    return {
      platform: 'bilibili',
      workspaceId: 'local',
      feed: 'imports',
      handle: '',
      source: 'browser_runtime_player',
      mode: missing ? 'unavailable' : 'error',
      loggedIn: result.status !== 'error' || result.errorType !== 'browser_unavailable',
      tweetCount: 0,
      fetchedAt,
      note: missing ? '没有' : (result.error || 'B 站字幕抓取失败'),
      items: [],
    };
  }

  return { getFeed };
}

export function createBilibiliJobHandlers(options = {}) {
  return {
    async 'feed.bilibili.sync'(input, context) {
      if (typeof options.syncFeed !== 'function') {
        throw new Error('feed.bilibili.sync 缺少 Worker 注入的 Feed Port');
      }
      const feed = await options.syncFeed('bilibili', { ...(input || {}), refresh: Boolean(input?.url) }, {
        workspaceId: context.job?.workspaceId || 'local',
      });
      context.store.setProviderHealth('bilibili', feed.mode === 'live' ? 'healthy' : 'error', feed.note, {
        feed: feed.feed,
        tweetCount: feed.tweetCount,
      });
      return {
        ok: feed.mode === 'live' || feed.mode === 'unavailable' || feed.mode === 'cached' || feed.mode === 'empty',
        mode: feed.mode,
        tweetCount: feed.tweetCount,
        note: feed.note,
      };
    },
  };
}
