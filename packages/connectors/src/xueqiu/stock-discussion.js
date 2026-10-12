import { parseBrowserJson } from '../browser/browser-runtime.js';
import {
  buildLoginInspectExpression,
  explainXueqiuApiError,
  isXueqiuLoginError,
  stripXueqiuHtml,
  xueqiuAbsoluteUrl,
} from './home-browser.js';

const PAGE_ORIGIN = 'https://www.xueqiu.com';
const PAGE_SIZE = 20;

export class XueqiuLoginRequiredError extends Error {
  constructor(message = '采集浏览器尚未登录雪球。请先在 https://xueqiu.com/ 登录后再生成股民讨论日摘。') {
    super(message);
    this.name = 'XueqiuLoginRequiredError';
    this.code = 'login_required';
  }
}

export class XueqiuVerificationError extends Error {
  constructor(message = '雪球返回验证页。请在采集浏览器里完成验证后再生成，本次已停止，不会继续重试。') {
    super(message);
    this.name = 'XueqiuVerificationError';
    this.code = 'verification_required';
  }
}

const BODY_KIND_LABEL = {
  html: 'HTML',
  verify: '验证页',
  waf: 'WAF 挑战',
  empty: '空体',
  truncated: '截断',
};

export function discussionBodyPreview(text, limit = 120) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function classifyDiscussionBody(text) {
  const body = String(text || '').trim();
  if (!body) return 'empty';
  const flat = body.replace(/\s+/g, ' ');
  if (/acw_sc__v2|acw_sc__v3|arg1\s*=|aliyun_waf/i.test(flat)) return 'waf';
  if (/验证码|滑动验证|安全验证|访问验证|请完成验证|captcha|nocaptcha|滑块/i.test(flat)) return 'verify';
  if (body.startsWith('{') || body.startsWith('[')) {
    try {
      JSON.parse(body);
      return 'json';
    } catch {
      return 'truncated';
    }
  }
  if (/^</.test(body) || /<!doctype|<html|<\/html>/i.test(body)) return 'html';
  return 'truncated';
}

export function discussionBodyKindLabel(kind) {
  return BODY_KIND_LABEL[kind] || '不是 JSON';
}

export function isPinnedDiscussionStatus(item) {
  if (!item || typeof item !== 'object') return false;
  if (item.pinned === true || item.is_top === true || item.isTop === true || item.sticky === true) return true;
  if (item.top === true || item.top === 1 || item.top === '1') return true;
  if (item.mark === 1 || item.mark === '1' || item.mark === 'top' || item.mark === 'pinned') return true;
  return /置顶/.test(String(item.mark_desc || item.title || ''));
}

export function wafBackoffMs(random = Math.random) {
  const roll = Math.min(1, Math.max(0, Number(random()) || 0));
  return Math.round(20_000 + roll * 20_000);
}

export function discussionTimestamp(value) {
  const stamp = Number(value);
  if (!Number.isFinite(stamp) || stamp <= 0) return 0;
  // Xueqiu status created_at is epoch milliseconds (~1.7e12).
  // Values in the unix-seconds range are scaled; tiny fixtures stay as given.
  if (stamp >= 1e9 && stamp < 1e12) return Math.round(stamp * 1000);
  return stamp;
}

function resolveDiscussionWindow(options = {}) {
  const since = Number(options.since ?? options.startAt);
  const until = Number(options.until ?? options.endAt);
  if (!Number.isFinite(since) || !Number.isFinite(until) || until <= since) {
    throw new Error('讨论日期窗口无效');
  }
  return { since, until };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonHeaders() {
  return {
    Accept: 'application/json, text/plain, */*',
    Referer: `${PAGE_ORIGIN}/`,
    'X-Requested-With': 'XMLHttpRequest',
  };
}

export function stockDiscussionUrl(symbol, page = 1, count = PAGE_SIZE) {
  const url = new URL('/query/v1/symbol/search/status.json', PAGE_ORIGIN);
  url.searchParams.set('symbol', String(symbol || '').trim());
  url.searchParams.set('count', String(count));
  url.searchParams.set('page', String(page));
  url.searchParams.set('sort', 'time');
  url.searchParams.set('type', '11');
  return url.toString();
}

export function discussionSearchUrl(query, page = 1, count = PAGE_SIZE) {
  const url = new URL('/query/v1/search/status.json', PAGE_ORIGIN);
  url.searchParams.set('q', String(query || '').trim());
  url.searchParams.set('count', String(count));
  url.searchParams.set('page', String(page));
  url.searchParams.set('sort', 'time');
  url.searchParams.set('source', 'all');
  return url.toString();
}

export function discussionCommentsV3Url(statusId, maxId = -1, size = PAGE_SIZE) {
  const url = new URL('/statuses/v3/comments.json', PAGE_ORIGIN);
  url.searchParams.set('id', String(statusId));
  url.searchParams.set('type', '4');
  url.searchParams.set('size', String(size));
  const cursor = Number(maxId);
  url.searchParams.set('max_id', String(Number.isFinite(cursor) && cursor > 0 ? cursor : -1));
  return url.toString();
}

export function discussionCommentsUrl(statusId, count = PAGE_SIZE) {
  const url = new URL('/statuses/comments.json', PAGE_ORIGIN);
  url.searchParams.set('id', String(statusId));
  url.searchParams.set('count', String(count));
  url.searchParams.set('page', '1');
  url.searchParams.set('asc', 'false');
  return url.toString();
}

export function discardDiscussionStatus(item) {
  if (!item || typeof item !== 'object') return true;
  if (item.retweeted_status) return true;
  const retweetId = Number(item.retweet_status_id || item.retweeted_status_id || 0);
  if (Number.isFinite(retweetId) && retweetId > 0) return true;
  if (/转发/.test(String(item.mark || item.flags || ''))) return true;
  const text = stripXueqiuHtml(item.text || item.description || item.title || '').replace(/\s+/g, ' ').trim();
  if (!text) return true;
  if (/^(?:回复\s*@|\/\/@)/.test(text)) return true;
  if (/^转发(?:\s|$|@|：|:)/.test(text)) return true;
  const own = text.replace(/\s*\/\/@[\s\S]*$/, '').trim();
  return !own;
}

function statusRows(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const rows = payload.list || payload.statuses || payload.home_timeline || [];
  return Array.isArray(rows) ? rows : [];
}

function commentRows(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.comments)) return payload.comments;
  if (Array.isArray(payload.list)) return payload.list;
  return [];
}

export function mapDiscussionStatus(item) {
  if (isPinnedDiscussionStatus(item) || discardDiscussionStatus(item)) return null;
  const id = String(item?.id || '').trim();
  if (!/^\d+$/.test(id)) return null;
  const user = item?.user || {};
  const text = stripXueqiuHtml(item?.text || item?.description || item?.title || '');
  const userId = user.id ? String(user.id) : '';
  const url = xueqiuAbsoluteUrl(item?.target) || (userId ? `https://xueqiu.com/${userId}/${id}` : '');
  return {
    id,
    text,
    title: stripXueqiuHtml(item?.title || '') || text.slice(0, 48),
    author: String(user.screen_name || user.name || '').trim(),
    url,
    createdAt: discussionTimestamp(item?.created_at),
    replyCount: Number(item?.reply_count) || 0,
    likeCount: discussionLikeCount(item),
  };
}

export function mapDiscussionComment(row, post) {
  const id = String(row?.id || '').trim();
  if (!/^\d+$/.test(id)) return null;
  const text = stripXueqiuHtml(row?.text || row?.description || '');
  if (!text) return null;
  return {
    id,
    postId: post?.id || '',
    text,
    author: String(row?.user?.screen_name || row?.user?.name || '').trim(),
    createdAt: discussionTimestamp(row?.created_at),
    url: post?.url || '',
    likeCount: discussionLikeCount(row),
  };
}

function discussionLikeCount(item) {
  const like = Number(item?.like_count);
  const fav = Number(item?.fav_count);
  if (Number.isFinite(like) && like > 0) return like;
  if (Number.isFinite(fav) && fav > 0) return fav;
  return 0;
}

export function assertDiscussionPayload(data) {
  if (data && typeof data === 'object' && isXueqiuLoginError(data)) throw new XueqiuLoginRequiredError();
  if (data?.error_code || data?.error_description || (typeof data?.error === 'string' && data.error)) {
    throw new Error(explainXueqiuApiError(data));
  }
  return data;
}

function retryable(error) {
  if (error?.code === 'login_required' || error?.code === 'verification_required') return false;
  const status = Number(error?.status);
  if (status === 429 || status >= 500) return true;
  return /超时|429|502|503|504|ECONN|网络|fetch failed|HTTP 5/i.test(String(error?.message || ''));
}

async function withRetry(fn, { retries, wait, intervalMs }) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return assertDiscussionPayload(await fn());
    } catch (error) {
      if (error?.code === 'login_required' || error?.code === 'verification_required') throw error;
      last = error;
      if (attempt >= retries || !retryable(error)) throw error;
      const backoff = Math.min(30_000, (intervalMs || 500) * (2 ** attempt));
      await wait(backoff);
    }
  }
  throw last;
}

function inWindow(at, since, until) {
  return Number(at) >= since && Number(at) < until;
}

async function pullPages({ request, urlFor, mapRow, rowsOf, since, until, maxPages }) {
  const items = new Map();
  let truncated = false;
  for (let page = 1; page <= maxPages; page += 1) {
    const data = await request(urlFor(page));
    const raw = rowsOf(data);
    if (!raw.length) break;
    const usable = raw.filter((item) => !isPinnedDiscussionStatus(item));
    if (!usable.length) continue;
    const batch = usable.map(mapRow).filter(Boolean);
    for (const row of batch) {
      if (row.createdAt && !inWindow(row.createdAt, since, until)) continue;
      if (!items.has(row.id)) items.set(row.id, row);
    }
    const dated = batch.filter((row) => row.createdAt > 0);
    const pageBeforeWindow = dated.length > 0 && dated.every((row) => row.createdAt < since);
    if (pageBeforeWindow) break;
    if (page === maxPages) truncated = true;
  }
  return { items, truncated };
}

export function createRequestPacer({ wait, intervalMs, jitterMs = 0, random = Math.random }) {
  let last = 0;
  return async function paced(fn) {
    const swing = jitterMs ? (random() * 2 - 1) * jitterMs : 0;
    const gap = last ? intervalMs + swing - (Date.now() - last) : 0;
    if (gap > 0) await wait(gap);
    try {
      return await fn();
    } finally {
      last = Date.now();
    }
  };
}

function nextCommentCursor(payload, current) {
  const next = Number(payload?.next_max_id);
  if (!Number.isFinite(next) || next <= 0 || next === current) return 0;
  return next;
}

async function pullPostComments({ request, post, since, until, maxRounds }) {
  const items = new Map();
  const absorb = (data) => {
    const batch = commentRows(data).map((row) => mapDiscussionComment(row, post)).filter(Boolean);
    for (const row of batch) {
      if (row.createdAt && !inWindow(row.createdAt, since, until)) continue;
      if (!items.has(row.id)) items.set(row.id, row);
    }
    return batch;
  };
  let maxId = -1;
  for (let round = 0; round < maxRounds; round += 1) {
    let data;
    try {
      data = await request(discussionCommentsV3Url(post.id, maxId));
    } catch (error) {
      if (error?.code === 'login_required' || error?.code === 'verification_required') throw error;
      if (round !== 0) throw error;
      absorb(await request(discussionCommentsUrl(post.id)));
      break;
    }
    const batch = absorb(data);
    if (!batch.length) break;
    const next = nextCommentCursor(data, maxId);
    if (!next) break;
    maxId = next;
  }
  return items;
}

function commentTargets(posts, commentPosts) {
  const limit = Math.max(0, Number(commentPosts) || 0);
  if (!limit) return [];
  const groups = new Map();
  for (const post of posts.values()) {
    const key = post.symbol || '__search__';
    const list = groups.get(key) || [];
    list.push(post);
    groups.set(key, list);
  }
  const selected = [];
  const seen = new Set();
  for (const group of groups.values()) {
    const ranked = group
      .filter((post) => post.replyCount > 0)
      .sort((left, right) => (right.replyCount - left.replyCount) || left.id.localeCompare(right.id));
    for (const post of ranked.slice(0, limit)) {
      if (seen.has(post.id)) continue;
      seen.add(post.id);
      selected.push(post);
    }
  }
  return selected;
}

export async function collectDiscussionTarget(options) {
  const target = options.target;
  const { since, until } = resolveDiscussionWindow(options);
  const maxPages = Math.max(1, Number(options.maxPages) || 8);
  const maxCommentPages = Math.max(1, Number(options.maxCommentPages) || 5);
  const commentPosts = options.commentPosts === undefined ? 15 : Math.max(0, Number(options.commentPosts) || 0);
  const request = options.request;
  const queries = [
    ...(target.symbols || []).map((symbol) => ({ kind: 'symbol', label: symbol, symbol })),
    ...(target.keywords || []).map((keyword) => ({ kind: 'search', label: keyword, keyword })),
  ];
  const posts = new Map();
  const failures = [];
  let truncated = false;
  for (const query of queries) {
    try {
      const pulled = await pullPages({
        request,
        since,
        until,
        maxPages,
        urlFor: (page) => (query.kind === 'symbol'
          ? stockDiscussionUrl(query.symbol, page)
          : discussionSearchUrl(query.keyword, page)),
        mapRow: mapDiscussionStatus,
        rowsOf: statusRows,
      });
      if (pulled.truncated) truncated = true;
      for (const post of pulled.items.values()) {
        if (query.kind === 'search') {
          const blob = `${post.title}\n${post.text}`;
          if (query.keyword && !blob.includes(query.keyword)) continue;
        }
        if (!posts.has(post.id)) posts.set(post.id, { ...post, symbol: query.kind === 'symbol' ? query.symbol : '' });
      }
    } catch (error) {
      if (error?.code === 'login_required' || error?.code === 'verification_required') throw error;
      failures.push({ label: query.label, reason: String(error?.message || error) });
    }
  }
  const selected = commentTargets(posts, commentPosts);
  const comments = new Map();
  for (const post of selected) {
    try {
      const pulled = await pullPostComments({ request, post, since, until, maxRounds: maxCommentPages });
      for (const comment of pulled.values()) {
        if (!comments.has(comment.id)) comments.set(comment.id, comment);
      }
    } catch (error) {
      if (error?.code === 'login_required' || error?.code === 'verification_required') throw error;
      failures.push({ label: `${post.id} 评论`, reason: String(error?.message || error) });
    }
  }
  const commentClaimed = selected.reduce((sum, post) => sum + (post.replyCount || 0), 0);
  const allFailed = queries.length > 0 && failures.length >= queries.length && posts.size === 0;
  return {
    ok: !allFailed && failures.length === 0,
    partial: failures.length > 0 && posts.size > 0,
    failed: allFailed,
    reason: failures.map((item) => `${item.label}: ${item.reason}`).join('；'),
    posts: [...posts.values()],
    comments: [...comments.values()],
    truncated,
    commentClaimed,
    commentsPartial: selected.length > 0,
    failures,
  };
}

export async function collectDiscussionTargets(targets, options) {
  const wait = options.wait || delay;
  const intervalMs = Math.max(0, Number(options.intervalMs) || 0);
  const jitterMs = Math.max(0, Number(options.intervalJitterMs) || 0);
  const retries = Math.max(0, Number(options.retries) || 0);
  const paced = options.request || createRequestPacer({
    wait, intervalMs, jitterMs, random: options.random,
  });
  const request = (url) => paced(() => withRetry(() => options.fetchJson(url), { retries, wait, intervalMs }));
  const results = [];
  for (const target of targets) {
    results.push(await collectDiscussionTarget({ ...options, target, request }));
  }
  return results;
}

function rejectUnparsedBody(payload, url, logger) {
  const text = String(payload?.text || '');
  const kind = classifyDiscussionBody(text);
  const status = Number(payload?.status) || 0;
  logger?.warn?.(`[investor-discussion] 雪球响应无法解析 status=${status} url=${url} length=${text.length} kind=${kind} head=${discussionBodyPreview(text)}`);
  if (kind === 'verify' || kind === 'waf') {
    throw new XueqiuVerificationError(kind === 'waf'
      ? '雪球返回 WAF 挑战。请在采集浏览器里打开雪球后再生成，本次已停止。'
      : undefined);
  }
  const error = new Error(`雪球响应是${discussionBodyKindLabel(kind)}`);
  error.code = 'invalid_body';
  error.kind = kind;
  error.status = status;
  throw error;
}

async function fetchDiscussionJson(session, url, logger, pace = {}) {
  const wait = pace.wait || delay;
  const random = pace.random || Math.random;
  for (let attempt = 0; attempt <= 2; attempt += 1) {
    const payload = await session.fetchJson(url, { headers: jsonHeaders(), timeoutMs: 30_000 });
    let data;
    try {
      data = parseBrowserJson(payload);
    } catch {
      const kind = classifyDiscussionBody(payload?.text);
      if (kind === 'waf' && attempt < 2) {
        const text = String(payload?.text || '');
        logger?.warn?.(`[investor-discussion] 雪球 WAF 挑战，重新打开行情页后重试 status=${Number(payload?.status) || 0} url=${url} length=${text.length} kind=waf head=${discussionBodyPreview(text)}`);
        await wait(wafBackoffMs(random));
        await session.navigate(`${PAGE_ORIGIN}/hq`, { timeoutMs: 90_000 });
        continue;
      }
      rejectUnparsedBody(payload, url, logger);
    }
    if (payload.status && payload.status >= 400) {
      if (isXueqiuLoginError(data)) throw new XueqiuLoginRequiredError();
      const error = new Error(explainXueqiuApiError(data, `雪球 HTTP ${payload.status}`));
      error.status = payload.status;
      throw error;
    }
    return data;
  }
  throw new XueqiuVerificationError('雪球返回 WAF 挑战。请在采集浏览器里打开雪球后再生成，本次已停止。');
}

export function createXueqiuStockDiscussionClient(options = {}) {
  const wait = options.delay || delay;
  const logger = options.logger || console;
  if (typeof options.fetchJson === 'function') {
    return {
      async collectAll(targets, range) {
        return collectDiscussionTargets(targets, { ...range, ...options, fetchJson: options.fetchJson, wait });
      },
    };
  }
  const runtime = options.browserRuntime;
  if (!runtime?.withSession) {
    return {
      async collectAll() {
        throw new Error('雪球采集需要 browserRuntime（BrowserSkill）。');
      },
    };
  }
  return {
    async collectAll(targets, range) {
      const results = [];
      const pace = {
        wait,
        random: options.random,
        intervalMs: options.intervalMs ?? 2500,
        intervalJitterMs: options.intervalJitterMs ?? 500,
      };
      for (const target of targets) {
        const one = await runtime.withSession({ purpose: 'xueqiu-discussion', focused: false }, async (session) => {
          await session.navigate(`${PAGE_ORIGIN}/hq`, { timeoutMs: 90_000 });
          await wait(Math.max(300, Number(pace.intervalMs) || 2500));
          const inspect = await session.evaluate(buildLoginInspectExpression());
          if (!inspect?.logged_in) throw new XueqiuLoginRequiredError();
          const rows = await collectDiscussionTargets([target], {
            ...range,
            fetchJson: (url) => fetchDiscussionJson(session, url, logger, pace),
            wait,
            random: options.random,
            intervalMs: pace.intervalMs,
            intervalJitterMs: pace.intervalJitterMs,
            retries: options.retries ?? 2,
            maxPages: options.maxPages,
            maxCommentPages: options.maxCommentPages,
            commentPosts: options.commentPosts,
          });
          return rows[0];
        });
        results.push(one);
      }
      return results;
    },
  };
}
