import {
  createXueqiuHomeBrowserClient,
  explainXueqiuApiError,
  normalizeXueqiuFeed,
  xueqiuFeedLabel,
} from './home-browser.js';

export {
  XUEQIU_HOME_URL,
  createXueqiuHomeBrowserClient,
  explainXueqiuApiError,
  extractLivenewsItems,
  extractTimelineItems,
  livenewsUrl,
  mapLivenewsItem,
  mapTimelineStatus,
  normalizeXueqiuFeed,
  stripXueqiuHtml,
  timelineUrl,
  userGroupIdForFeed,
  xueqiuAbsoluteUrl,
  xueqiuFeedLabel,
} from './home-browser.js';

const DEFAULT_LIMIT = 50;
const DEFAULT_TTL_MS = 60_000;

export const xueqiuConnectorManifest = {
  id: 'connector.xueqiu',
  version: '1.0.0',
  capabilities: ['feed.capture'],
  jobTypes: ['feed.xueqiu.sync'],
  sourceIds: ['content.xueqiu.home'],
};

export function xueqiuToFeedItem(row, options = {}) {
  const feed = normalizeXueqiuFeed(row.feed || options.feed);
  const externalId = String(row.status_id || row.externalId || '').trim();
  const body = String(row.text || row.body || '').trim();
  const title = String(row.title || '').trim() || (body ? `${body.slice(0, 48)}${body.length > 48 ? '…' : ''}` : '雪球动态');
  const sourceUrl = String(row.source_url || row.sourceUrl || '').trim() || 'https://xueqiu.com/';
  return {
    id: externalId ? `xueqiu:${externalId}` : `xueqiu:${feed}:${sourceUrl}`,
    workspaceId: options.workspaceId || 'local',
    platform: 'xueqiu',
    externalId,
    authorName: String(row.author_name || row.authorName || '雪球').trim(),
    authorHandle: String(row.author_handle || row.authorHandle || '').trim(),
    title,
    summary: body.slice(0, 160),
    body,
    sourceUrl,
    publishedAt: Number(row.published_at || row.publishedAt) || 0,
    processing: '',
    subscriptionId: '',
    captureId: '',
  };
}

export function explainXueqiuConnectorError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/尚未登录|login_required/i.test(message)) {
    return '采集浏览器尚未登录雪球。请先在 https://xueqiu.com/ 登录关注账号，再抓取关注或精选。';
  }
  if (/Browser|bsk|daemon|未连接/i.test(message)) {
    return message || 'BrowserSkill 未连接，无法打开已登录的雪球页。';
  }
  return message || '雪球时间线加载失败';
}

export function createXueqiuHomeClient(options = {}) {
  if (typeof options.fetchHomeTimeline === 'function') {
    return { fetchHomeTimeline: options.fetchHomeTimeline };
  }
  if (options.xueqiu) return options.xueqiu;
  if (options.browserRuntime?.withSession) {
    return createXueqiuHomeBrowserClient(options);
  }
  return {
    async fetchHomeTimeline() {
      throw new Error('雪球采集需要 browserRuntime（BrowserSkill）。');
    },
  };
}

export function createXueqiuService(options = {}) {
  const client = options.xueqiu || createXueqiuHomeClient(options);
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now || (() => Date.now());
  const cache = new Map();
  const pending = new Map();

  async function cached(key, loader) {
    const hit = cache.get(key);
    const timestamp = now();
    if (hit && timestamp - hit.at < ttlMs) return hit.payload;
    if (pending.has(key)) return pending.get(key);
    const task = Promise.resolve().then(loader).then((payload) => {
      cache.set(key, { at: now(), payload });
      return payload;
    }).finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  }

  async function getFeed({
    feed = 'following',
    limit = DEFAULT_LIMIT,
    bypassCache = false,
    excludeExternalIds = [],
  } = {}) {
    const parsedFeed = normalizeXueqiuFeed(feed);
    const parsedLimit = Math.min(DEFAULT_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));
    const excluded = [...new Set((excludeExternalIds || []).map((id) => String(id || '')).filter(Boolean))];
    const load = async () => {
      try {
        const result = await client.fetchHomeTimeline({
          feed: parsedFeed,
          limit: parsedLimit,
          excludeExternalIds: excluded,
        });
        const loginRequired = result.error === 'login_required';
        const items = loginRequired ? [] : (result.items || []).map((row) => xueqiuToFeedItem(row, { feed: parsedFeed }));
        const note = loginRequired
          ? explainXueqiuConnectorError('login_required')
          : result.error && !items.length
            ? explainXueqiuApiError({ error_description: result.error }, result.error)
            : `已登录浏览器 · ${xueqiuFeedLabel(parsedFeed)} · ${items.length} 条`;
        return {
          platform: 'xueqiu',
          workspaceId: 'local',
          feed: parsedFeed,
          handle: '',
          source: result.source || 'browser_runtime_home',
          mode: loginRequired || (!items.length && result.error) ? 'error' : (items.length ? 'live' : 'partial'),
          loggedIn: Boolean(result.logged_in),
          tweetCount: items.length,
          fetchedAt: now(),
          note,
          items,
        };
      } catch (error) {
        return {
          platform: 'xueqiu',
          workspaceId: 'local',
          feed: parsedFeed,
          handle: '',
          source: 'browser_runtime_home',
          mode: 'error',
          loggedIn: false,
          tweetCount: 0,
          fetchedAt: now(),
          note: explainXueqiuConnectorError(error),
          items: [],
        };
      }
    };
    if (bypassCache) return load();
    return cached(`home:${parsedFeed}:${parsedLimit}`, load);
  }

  return { getFeed, normalizeXueqiuFeed };
}

export function createXueqiuJobHandlers(options = {}) {
  return {
    async 'feed.xueqiu.sync'(input, context) {
      if (typeof options.syncFeed !== 'function') {
        throw new Error('feed.xueqiu.sync 缺少 Worker 注入的 Feed Port');
      }
      const feed = await options.syncFeed('xueqiu', { ...(input || {}), refresh: true }, {
        workspaceId: context.job?.workspaceId || 'local',
      });
      context.store.setProviderHealth('xueqiu', feed.mode === 'live' ? 'healthy' : 'error', feed.note, {
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
