import { parseBrowserJson } from '../browser/browser-runtime.js';
import { normalizeFlashCopy } from '../flash-copy.js';

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
const JSON_TIMEOUT_MS = 30_000;
const NAVIGATE_TIMEOUT_MS = 90_000;

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

export const COMMENT_PREVIEW_LIMIT = 5;
const COMMENT_TEXT_MAX = 240;
const COMMENT_BLOCK_MARKER = '\n\n评论\n';

export function commentsUrl(statusId, count = COMMENT_PREVIEW_LIMIT) {
  const url = new URL('/statuses/comments.json', XUEQIU_PAGE_ORIGIN);
  url.searchParams.set('id', String(statusId));
  url.searchParams.set('count', String(Math.min(COMMENT_PREVIEW_LIMIT, Math.max(1, Number(count) || COMMENT_PREVIEW_LIMIT))));
  url.searchParams.set('page', '1');
  url.searchParams.set('asc', 'false');
  return url.toString();
}

export function commentsV3Url(statusId, count = COMMENT_PREVIEW_LIMIT) {
  const url = new URL('/statuses/v3/comments.json', XUEQIU_PAGE_ORIGIN);
  url.searchParams.set('id', String(statusId));
  url.searchParams.set('type', '4');
  url.searchParams.set('size', String(Math.min(COMMENT_PREVIEW_LIMIT, Math.max(1, Number(count) || COMMENT_PREVIEW_LIMIT))));
  url.searchParams.set('max_id', '-1');
  return url.toString();
}

export function textBeforeCommentBlock(value) {
  const body = String(value || '').replace(/\r\n/g, '\n').trim();
  const index = body.indexOf(COMMENT_BLOCK_MARKER);
  return index === -1 ? body : body.slice(0, index).trim();
}

export function appendCommentsToBody(text, comments, limit = COMMENT_PREVIEW_LIMIT) {
  const body = String(text || '').replace(/\r\n/g, '\n').trim();
  const parsedLimit = Math.min(COMMENT_PREVIEW_LIMIT, Math.max(1, Number(limit) || COMMENT_PREVIEW_LIMIT));
  const lines = [];
  for (const comment of comments || []) {
    const author = String(comment?.author || comment?.author_name || '').replace(/\s+/g, ' ').trim();
    let content = String(comment?.text || '').replace(/\s+/g, ' ').trim();
    if (!content) continue;
    if (content.length > COMMENT_TEXT_MAX) content = `${content.slice(0, COMMENT_TEXT_MAX)}…`;
    lines.push(author ? `· ${author}：${content}` : `· ${content}`);
    if (lines.length >= parsedLimit) break;
  }
  if (!lines.length) return body;
  const block = `评论\n${lines.join('\n')}`;
  if (body.includes(block)) return body;
  return body ? `${body}${COMMENT_BLOCK_MARKER}${lines.join('\n')}` : block;
}

export function extractXueqiuComments(payload, limit = COMMENT_PREVIEW_LIMIT) {
  const rows = xueqiuCommentRows(payload);
  if (!rows) return [];
  const parsedLimit = Math.min(COMMENT_PREVIEW_LIMIT, Math.max(1, Number(limit) || COMMENT_PREVIEW_LIMIT));
  const comments = [];
  for (const row of rows) {
    const text = stripXueqiuHtml(row?.text || row?.description || '');
    if (!text) continue;
    const author = String(row?.user?.screen_name || row?.user?.name || '').trim();
    comments.push({ author, text });
    if (comments.length >= parsedLimit) break;
  }
  return comments;
}

function xueqiuCommentRows(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (Array.isArray(payload.comments)) return payload.comments;
  if (Array.isArray(payload.list)) return payload.list;
  return null;
}

function commentStatusId(row) {
  const raw = String(row?.status_id || '');
  const id = raw.startsWith('livenews:') ? raw.slice('livenews:'.length) : raw;
  return /^\d+$/.test(id) ? id : '';
}

function replyCountOf(value) {
  if (value === null || value === undefined || value === '') return null;
  const count = Number(value);
  return Number.isFinite(count) ? count : null;
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
    reply_count: replyCountOf(item?.reply_count),
  };
}

export function mapLivenewsItem(item) {
  const id = String(item?.id || '').trim();
  const raw = stripXueqiuHtml(item?.text || item?.title || '');
  const copy = normalizeFlashCopy('', raw);
  const target = xueqiuAbsoluteUrl(item?.target) || (id ? `${XUEQIU_ORIGIN}/livenews/${id}` : XUEQIU_HOME_URL);
  return {
    status_id: id ? `livenews:${id}` : '',
    feed: 'livenews',
    kind: 'livenews',
    text: copy.body,
    title: copy.title,
    author_name: '雪球7x24',
    author_handle: '',
    source_url: target,
    published_at: Number(item?.created_at) || 0,
    reply_count: replyCountOf(item?.reply_count),
  };
}

function stepTimeout(deadlineAt, fallback = JSON_TIMEOUT_MS) {
  const limit = Math.max(1_000, Number(fallback) || JSON_TIMEOUT_MS);
  if (!Number.isFinite(Number(deadlineAt))) return limit;
  const remaining = Number(deadlineAt) - Date.now();
  if (remaining < 1_000) return 0;
  return Math.min(limit, remaining);
}

async function loadStatusComments(session, statusId, deadlineAt) {
  const primaryTimeout = stepTimeout(deadlineAt);
  if (!primaryTimeout) return [];
  try {
    const primary = await fetchJsonFromSession(session, commentsUrl(statusId), primaryTimeout);
    const primaryRows = xueqiuCommentRows(primary);
    if (primaryRows) return extractXueqiuComments({ comments: primaryRows });
  } catch {
    // 旧评论接口失败时改走 v3。
  }
  const fallbackTimeout = stepTimeout(deadlineAt);
  if (!fallbackTimeout) return [];
  const fallback = await fetchJsonFromSession(session, commentsV3Url(statusId), fallbackTimeout);
  const fallbackRows = xueqiuCommentRows(fallback);
  return extractXueqiuComments(fallbackRows ? { comments: fallbackRows } : null);
}

async function fetchJsonFromSession(session, url, timeoutMs = JSON_TIMEOUT_MS) {
  const limit = Math.max(1_000, Number(timeoutMs) || JSON_TIMEOUT_MS);
  const payload = await session.fetchJson(url, { headers: jsonHeaders(), timeoutMs: limit });
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

  function stopped(signal, deadlineAt) {
    return Boolean(signal?.aborted) || (Number.isFinite(Number(deadlineAt)) && Date.now() >= Number(deadlineAt));
  }

  async function collect(feed, limit, excludeExternalIds, signal, deadlineAt) {
    const parsedFeed = normalizeXueqiuFeed(feed);
    const parsedLimit = Math.min(50, Math.max(1, Number(limit) || 50));
    const excluded = new Set((excludeExternalIds || []).map((id) => String(id || '')).filter(Boolean));

    return runtime.withSession({ purpose: `xueqiu-${parsedFeed}`, focused: false }, async (session) => {
      let stoppedEarly = stopped(signal, deadlineAt);
      const halt = () => {
        if (!stopped(signal, deadlineAt)) return false;
        stoppedEarly = true;
        return true;
      };
      if (halt()) {
        return {
          source: 'browser_runtime_home', feed: parsedFeed, logged_in: false, login_wall: false,
          error: 'deadline', deadline: true, page_title: '', page_url: XUEQIU_HOME_URL, items: [],
        };
      }
      const pageTimeout = Number.isFinite(Number(deadlineAt))
        ? stepTimeout(deadlineAt, JSON_TIMEOUT_MS)
        : NAVIGATE_TIMEOUT_MS;
      if (!pageTimeout) {
        return {
          source: 'browser_runtime_home', feed: parsedFeed, logged_in: false, login_wall: false,
          error: 'deadline', deadline: true, page_title: '', page_url: XUEQIU_HOME_URL, items: [],
        };
      }
      try {
        await session.navigate(`${XUEQIU_PAGE_ORIGIN}/hq`, { timeoutMs: pageTimeout });
      } catch (error) {
        if (!Number.isFinite(Number(deadlineAt))) throw error;
        return {
          source: 'browser_runtime_home', feed: parsedFeed, logged_in: false, login_wall: false,
          error: 'deadline', deadline: true, page_title: '', page_url: XUEQIU_HOME_URL, items: [],
        };
      }
      if (!halt()) await wait(1_200);
      const inspectTimeout = stepTimeout(deadlineAt, JSON_TIMEOUT_MS);
      let inspect = { logged_in: false, title: '', url: XUEQIU_HOME_URL };
      if (!halt() && inspectTimeout) {
        try {
          inspect = await session.evaluate(buildLoginInspectExpression(), { timeoutMs: inspectTimeout });
        } catch {
          stoppedEarly = true;
        }
      } else if (!inspectTimeout) {
        stoppedEarly = true;
      }
      if (stoppedEarly && !inspect?.logged_in) {
        return {
          source: 'browser_runtime_home', feed: parsedFeed, logged_in: false, login_wall: false,
          error: 'deadline', deadline: true, page_title: inspect?.title || '',
          page_url: inspect?.url || XUEQIU_HOME_URL, items: [],
        };
      }
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
        if (halt()) break;
        const fetchTimeout = stepTimeout(deadlineAt, JSON_TIMEOUT_MS);
        if (!fetchTimeout) { stoppedEarly = true; break; }
        const url = parsedFeed === 'livenews'
          ? livenewsUrl(maxId, DEFAULT_PAGE_SIZE)
          : timelineUrl(userGroupIdForFeed(parsedFeed), maxId);
        let data;
        try {
          data = await fetchJsonFromSession(session, url, fetchTimeout);
        } catch {
          stoppedEarly = true;
          lastError = 'deadline';
          break;
        }
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

      for (const row of items) {
        if (halt()) break;
        const commentTimeout = stepTimeout(deadlineAt, JSON_TIMEOUT_MS);
        if (!commentTimeout) { stoppedEarly = true; break; }
        const statusId = commentStatusId(row);
        if (!statusId || row.reply_count === 0) continue;
        try {
          const comments = await loadStatusComments(session, statusId, deadlineAt);
          row.text = appendCommentsToBody(row.text, comments);
        } catch {
          // 评论接口失败时保留帖子正文。
        }
        await wait(120);
      }
      for (const row of items) delete row.reply_count;

      return {
        source: 'browser_runtime_home',
        feed: parsedFeed,
        logged_in: loggedIn || parsedFeed === 'livenews',
        login_wall: false,
        error: items.length ? '' : (stoppedEarly ? 'deadline' : lastError),
        deadline: stoppedEarly,
        page_title: inspect?.title || '',
        page_url: inspect?.url || XUEQIU_HOME_URL,
        items: items.slice(0, parsedLimit),
      };
    });
  }

  return {
    async fetchHomeTimeline(input = {}) {
      return collect(input.feed, input.limit, input.excludeExternalIds, input.signal, input.deadlineAt);
    },
  };
}
