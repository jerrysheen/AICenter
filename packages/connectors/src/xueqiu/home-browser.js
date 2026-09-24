import { parseBrowserJson } from '../browser/browser-runtime.js';

export const XUEQIU_HOME_URL = 'https://xueqiu.com/';
export const XUEQIU_ORIGIN = 'https://xueqiu.com';
// xueqiu.com/hq 会跳到 www。页面在 www 上时，再请求 apex 会被浏览器当成跨源并直接失败。
const XUEQIU_PAGE_ORIGIN = 'https://www.xueqiu.com';

const FEEDS = {
  following: { userGroupId: -1, label: '关注' },
  featured: { userGroupId: -2, label: '精选' },
  livenews: { userGroupId: null, label: '7x24' },
};

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGES = 8;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeXueqiuFeed(value) {
  const key = String(value || 'following').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (key === 'featured' || key === 'selected' || key === 'jingxuan') return 'featured';
  if (key === 'livenews' || key === '7x24' || key === 'live' || key === 'news') return 'livenews';
  return 'following';
}

export function xueqiuFeedLabel(feed) {
  return FEEDS[normalizeXueqiuFeed(feed)]?.label || '关注';
}

export function userGroupIdForFeed(feed) {
  return FEEDS[normalizeXueqiuFeed(feed)]?.userGroupId ?? -1;
}

export function stripXueqiuHtml(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function xueqiuAbsoluteUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('//')) return `https:${raw}`;
  if (raw.startsWith('/')) return `${XUEQIU_ORIGIN}${raw}`;
  return '';
}

export function explainXueqiuApiError(data, fallback = '雪球接口返回错误') {
  if (!data || typeof data !== 'object') return fallback;
  const text = String(data.error_description || data.errorDescription || data.message || data.error || '').trim();
  const code = String(data.error_code || data.errorCode || '').trim();
  if (/登录|未登录|重新登录|400016/.test(`${text}${code}`)) {
    return '采集浏览器尚未登录雪球。请先在 https://xueqiu.com/ 登录关注账号，再抓取关注或精选。';
  }
  return text || (code ? `雪球返回 ${code}` : fallback);
}

export function isXueqiuLoginError(data) {
  const text = explainXueqiuApiError(data, '');
  return /尚未登录雪球/.test(text);
}

export function timelineUrl(userGroupId, maxId = -1) {
  const url = new URL('/v4/statuses/system/home_timeline.json', XUEQIU_PAGE_ORIGIN);
  url.searchParams.set('source', 'user');
  url.searchParams.set('usergroup_id', String(userGroupId));
  if (Number(maxId) > 0) url.searchParams.set('max_id', String(maxId));
  return url.toString();
}

export function livenewsUrl(maxId = -1, count = DEFAULT_PAGE_SIZE) {
  const url = new URL('/statuses/livenews/list.json', XUEQIU_PAGE_ORIGIN);
  url.searchParams.set('since_id', '-1');
  url.searchParams.set('count', String(Math.min(30, Math.max(1, Number(count) || DEFAULT_PAGE_SIZE))));
  if (Number(maxId) > 0) url.searchParams.set('max_id', String(maxId));
  else url.searchParams.set('max_id', '-1');
  return url.toString();
}

export function buildLoginInspectExpression() {
  return `(() => {
    const text = document.body ? (document.body.innerText || "") : "";
    const hasUserCookie = /(?:^|; )(?:u|xq_is_login)=/.test(document.cookie || "");
    const loggedIn = hasUserCookie
      || Boolean(document.querySelector('a[href*="/setting"]'))
      || Boolean(document.querySelector('[class*="user-avatar"], [class*="Nav_avatar"]'));
    const loginCta = /马上登录|立即登录|登录\\/注册|登录后查看/.test(text);
    return {
      title: document.title || "",
      url: location.href,
      login_wall: loginCta && !loggedIn,
      logged_in: loggedIn,
    };
  })()`;
}

function jsonHeaders() {
  return {
    Accept: 'application/json, text/plain, */*',
    Referer: `${XUEQIU_PAGE_ORIGIN}/`,
    'X-Requested-With': 'XMLHttpRequest',
  };
}

export function extractTimelineItems(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const rows = payload.home_timeline || payload.statuses || payload.list || [];
  return Array.isArray(rows) ? rows : [];
}

export function extractLivenewsItems(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const rows = payload.items || payload.list || [];
  return Array.isArray(rows) ? rows : [];
}

export function mapTimelineStatus(item, feed) {
  const id = String(item?.id || item?.status_id || '').trim();
  const user = item?.user || {};
  const handle = String(user.screen_name || user.name || '').trim();
  const retweet = item?.retweeted_status;
  const main = stripXueqiuHtml(item?.text || item?.description || item?.title || '');
  const quoted = retweet
    ? stripXueqiuHtml(`${retweet.user?.screen_name || ''}: ${retweet.text || retweet.description || ''}`)
    : '';
  const body = [main, quoted].filter(Boolean).join('\n\n');
  const target = xueqiuAbsoluteUrl(item?.target)
    || (id ? `${XUEQIU_ORIGIN}/${user.id || 'n'}/${id}` : XUEQIU_HOME_URL);
  const publishedAt = Number(item?.created_at) || 0;
  return {
    status_id: id,
    feed,
    kind: 'status',
    text: body,
    title: stripXueqiuHtml(item?.title || '') || body.slice(0, 48),
    author_name: handle || '雪球',
    author_handle: handle ? `@${handle}` : '',
    source_url: target,
    published_at: publishedAt,
  };
}

export function mapLivenewsItem(item) {
  const id = String(item?.id || '').trim();
  const body = stripXueqiuHtml(item?.text || item?.title || '');
  const target = xueqiuAbsoluteUrl(item?.target) || (id ? `${XUEQIU_ORIGIN}/livenews/${id}` : XUEQIU_HOME_URL);
  return {
    status_id: id ? `livenews:${id}` : '',
    feed: 'livenews',
    kind: 'livenews',
    text: body,
    title: body.slice(0, 48),
    author_name: '雪球7x24',
    author_handle: '',
    source_url: target,
    published_at: Number(item?.created_at) || 0,
  };
}

async function fetchJsonFromSession(session, url) {
  const payload = await session.fetchJson(url, { headers: jsonHeaders(), timeoutMs: 30_000 });
  const data = parseBrowserJson(payload);
  if (payload.status && payload.status >= 400) {
    if (data.error_description || data.error || data.error_code) return data;
    throw new Error(`雪球 HTTP ${payload.status}`);
  }
  return data;
}

export function createXueqiuHomeBrowserClient(options = {}) {
  const runtime = options.browserRuntime;
  const wait = options.delay || delay;
  if (!runtime?.withSession) {
    throw new Error('雪球采集需要 browserRuntime（BrowserSkill）。');
  }

  async function collect(feed, limit, excludeExternalIds) {
    const parsedFeed = normalizeXueqiuFeed(feed);
    const parsedLimit = Math.min(50, Math.max(1, Number(limit) || 50));
    const excluded = new Set((excludeExternalIds || []).map((id) => String(id || '')).filter(Boolean));

    return runtime.withSession({ purpose: `xueqiu-${parsedFeed}`, focused: false }, async (session) => {
      await session.navigate(`${XUEQIU_PAGE_ORIGIN}/hq`, { timeoutMs: 90_000 });
      await wait(1_200);
      const inspect = await session.evaluate(buildLoginInspectExpression());
      const loggedIn = Boolean(inspect?.logged_in);
      if (!loggedIn && parsedFeed !== 'livenews') {
        return {
          source: 'browser_runtime_home',
          feed: parsedFeed,
          logged_in: false,
          login_wall: true,
          error: 'login_required',
          page_title: inspect?.title || '',
          page_url: inspect?.url || XUEQIU_HOME_URL,
          items: [],
        };
      }

      const items = [];
      let maxId = -1;
      let lastError = '';
      for (let page = 0; page < MAX_PAGES && items.length < parsedLimit; page += 1) {
        const url = parsedFeed === 'livenews'
          ? livenewsUrl(maxId, DEFAULT_PAGE_SIZE)
          : timelineUrl(userGroupIdForFeed(parsedFeed), maxId);
        const data = await fetchJsonFromSession(session, url);
        if (data.error_description || data.error_code) {
          lastError = explainXueqiuApiError(data);
          if (isXueqiuLoginError(data) && parsedFeed !== 'livenews') {
            return {
              source: 'browser_runtime_home',
              feed: parsedFeed,
              logged_in: false,
              login_wall: true,
              error: 'login_required',
              page_title: inspect?.title || '',
              page_url: inspect?.url || XUEQIU_HOME_URL,
              items: [],
            };
          }
          break;
        }
        const batch = parsedFeed === 'livenews'
          ? extractLivenewsItems(data).map(mapLivenewsItem)
          : extractTimelineItems(data).map((row) => mapTimelineStatus(row, parsedFeed));
        let added = 0;
        for (const row of batch) {
          if (!row.status_id || excluded.has(row.status_id)) continue;
          if (items.some((item) => item.status_id === row.status_id)) continue;
          items.push(row);
          added += 1;
          if (items.length >= parsedLimit) break;
        }
        const nextMax = Number(data.next_max_id);
        if (!Number.isFinite(nextMax) || nextMax <= 0 || !batch.length || added === 0) break;
        maxId = nextMax;
      }

      return {
        source: 'browser_runtime_home',
        feed: parsedFeed,
        logged_in: loggedIn || parsedFeed === 'livenews',
        login_wall: false,
        error: items.length ? '' : lastError,
        page_title: inspect?.title || '',
        page_url: inspect?.url || XUEQIU_HOME_URL,
        items: items.slice(0, parsedLimit),
      };
    });
  }

  return {
    async fetchHomeTimeline(input = {}) {
      return collect(input.feed, input.limit, input.excludeExternalIds);
    },
  };
}
