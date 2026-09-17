import { createXHomeBrowserClient } from './home-browser.js';

const DEFAULT_LIMIT = 50;
const DEFAULT_TTL_MS = 60_000;

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function normalizeTweetBody(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+(https?:\/\/[^\s]+)/g, '\n$1')
    .replace(/([^\s\n])(https?:\/\/[^\s]+)/g, '$1\n$2')
    .trim();
}

export function parseTwitterHandle(value) {
  const raw = text(value);
  if (!raw) return '';
  const fromUrl = raw.match(/(?:twitter|x)\.com\/([^/?#]+)/i);
  const handle = (fromUrl ? fromUrl[1] : raw).replace(/^@/, '').trim();
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return '';
  if (['home', 'i', 'intent', 'search', 'explore'].includes(handle.toLowerCase())) return '';
  return handle;
}

export function normalizeXHomeFeed(value) {
  const key = String(value || 'for-you').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (['following', 'latest', 'chronological'].includes(key)) return 'following';
  return 'for-you';
}

export function explainXConnectorError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/451/.test(message) || /unavailable for legal reasons/i.test(message)) {
    return 'X 返回 HTTPS 451（地区/法律限制）。请关掉 twitter.com 页面，改用 https://x.com/home 登录后再拉取。';
  }
  return message || 'X 时间线加载失败';
}

export function tweetToFeedItem(tweet, options = {}) {
  const tweetId = text(tweet.tweetId || tweet.tweet_id);
  const handle = parseTwitterHandle(tweet.authorHandle || tweet.author_handle || '');
  const body = normalizeTweetBody(tweet.text || tweet.body);
  const sourceUrl = text(tweet.tweetUrl || tweet.tweet_url)
    || (tweetId && handle ? `https://x.com/${handle}/status/${tweetId}` : '')
    || (tweetId ? `https://x.com/i/status/${tweetId}` : '');
  const publishedAt = Number(tweet.publishedAt)
    || (Number.isFinite(Number(tweet.published_timestamp)) ? Number(tweet.published_timestamp) * 1000 : 0)
    || (tweet.published_at ? Date.parse(tweet.published_at) || 0 : 0);
  const authorName = text(tweet.authorName || tweet.author_name, handle ? `@${handle}` : 'X');
  return {
    id: tweetId ? `x:${tweetId}` : `x:${handle}:${sourceUrl}`,
    workspaceId: options.workspaceId || 'local',
    platform: 'x',
    externalId: tweetId,
    authorName,
    authorHandle: handle ? `@${handle}` : '',
    title: body ? `${body.slice(0, 48)}${body.length > 48 ? '…' : ''}` : 'X 动态',
    summary: body.slice(0, 160),
    body,
    sourceUrl,
    publishedAt,
    processing: '',
    subscriptionId: '',
    captureId: '',
  };
}

export function createTwitterHomeClient(options = {}) {
  if (typeof options.fetchHomeTimeline === 'function') {
    return { fetchHomeTimeline: options.fetchHomeTimeline };
  }
  if (options.twitter) return options.twitter;
  if (options.browserRuntime?.withSession) {
    return createXHomeBrowserClient(options);
  }
  return {
    async fetchHomeTimeline() {
      throw new Error('X 采集需要 browserRuntime（BrowserSkill）。');
    },
  };
}

export function createTwitterService(options = {}) {
  const twitter = options.twitter || createTwitterHomeClient(options);
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

  async function getFeed({ feed = 'for-you', limit = DEFAULT_LIMIT, bypassCache = false } = {}) {
    const parsedFeed = normalizeXHomeFeed(feed);
    const parsedLimit = Math.min(DEFAULT_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));
    const load = async () => {
      try {
        const result = await twitter.fetchHomeTimeline({
          feed: parsedFeed,
          limit: parsedLimit,
        });
        const blocked = /451/.test(`${result.page_title || ''} ${result.page_url || ''} ${result.error || ''}`);
        const items = blocked ? [] : (result.tweets || []).map((tweet) => tweetToFeedItem(tweet, { feed: parsedFeed }));
        const loginRequired = result.error === 'login_required';
        const note = blocked
          ? explainXConnectorError(new Error('HTTPS 451'))
          : loginRequired
            ? '采集浏览器尚未登录 X。请先在 https://x.com/home 登录，再拉取 50 条。'
            : result.error && !items.length
              ? explainXConnectorError(result.error)
              : `已登录浏览器时间线 · ${parsedFeed === 'following' ? '正在关注' : '为你推荐'} · ${items.length} 条`;
        return {
          platform: 'x',
          workspaceId: 'local',
          feed: parsedFeed,
          handle: '',
          source: result.source || 'browser_runtime_home',
          mode: blocked || loginRequired || (!items.length && result.error) ? 'error' : (items.length ? 'live' : 'partial'),
          loggedIn: Boolean(result.logged_in),
          tweetCount: items.length,
          fetchedAt: now(),
          note,
          items,
        };
      } catch (error) {
        return {
          platform: 'x',
          workspaceId: 'local',
          feed: parsedFeed,
          handle: '',
          source: 'browser_runtime_home',
          mode: 'error',
          loggedIn: false,
          tweetCount: 0,
          fetchedAt: now(),
          note: explainXConnectorError(error),
          items: [],
        };
      }
    };
    if (bypassCache) return load();
    return cached(`home:${parsedFeed}:${parsedLimit}`, load);
  }

  return { getFeed, normalizeXHomeFeed };
}
