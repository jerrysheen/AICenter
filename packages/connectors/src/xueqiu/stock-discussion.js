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
  url.searchParams.set('count', String(count));
  url.searchParams.set('comment', '0');
  url.searchParams.set('symbol', String(symbol || '').trim());
  url.searchParams.set('hl', '0');
  url.searchParams.set('source', 'all');
  url.searchParams.set('sort', 'time');
  url.searchParams.set('page', String(page));
  url.searchParams.set('q', '');
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

export function discussionCommentsUrl(statusId, page = 1, count = PAGE_SIZE) {
  const url = new URL('/statuses/comments.json', PAGE_ORIGIN);
  url.searchParams.set('id', String(statusId));
  url.searchParams.set('count', String(count));
  url.searchParams.set('page', String(page));
  url.searchParams.set('asc', 'false');
  return url.toString();
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
    createdAt: Number(item?.created_at) || 0,
    replyCount: Number(item?.reply_count) || 0,
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
    createdAt: Number(row?.created_at) || 0,
    url: post?.url || '',
  };
}

export function assertDiscussionPayload(data) {
  if (data && typeof data === 'object' && isXueqiuLoginError(data)) throw new XueqiuLoginRequiredError();
  if (data?.error_code || data?.error_description || (typeof data?.error === 'string' && data.error)) {
    throw new Error(explainXueqiuApiError(data));
  }
  return data;
}

function retryable(error) {
  if (error?.code === 'login_required') return false;
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
      if (error?.code === 'login_required') throw error;
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

function oldestAt(rows) {
  const stamps = rows.map((row) => Number(row.createdAt) || 0).filter((value) => value > 0);
  return stamps.length ? Math.min(...stamps) : 0;
}

async function pullPages({ request, urlFor, mapRow, rowsOf, since, until, maxPages }) {
  const items = new Map();
  let truncated = false;
  for (let page = 1; page <= maxPages; page += 1) {
    const data = await request(urlFor(page));
    const batch = rowsOf(data).map(mapRow).filter(Boolean);
    if (!batch.length) break;
    for (const row of batch) {
      if (row.createdAt && !inWindow(row.createdAt, since, until)) continue;
      if (!items.has(row.id)) items.set(row.id, row);
    }
    const oldest = oldestAt(batch);
    if (oldest && oldest < since) break;
    if (page === maxPages && (!oldest || oldest >= since)) truncated = true;
  }
  return { items, truncated };
}

export function createRequestPacer({ wait, intervalMs }) {
  let last = 0;
  return async function paced(fn) {
    const gap = last ? intervalMs - (Date.now() - last) : 0;
    if (gap > 0) await wait(gap);
    try {
      return await fn();
    } finally {
      last = Date.now();
    }
  };
}

export async function collectDiscussionTarget(options) {
  const target = options.target;
  const since = Number(options.since);
  const until = Number(options.until);
  const maxPages = Math.max(1, Number(options.maxPages) || 8);
  const maxCommentPages = Math.max(1, Number(options.maxCommentPages) || 5);
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
        if (!posts.has(post.id)) posts.set(post.id, post);
      }
    } catch (error) {
      if (error?.code === 'login_required') throw error;
      failures.push({ label: query.label, reason: String(error?.message || error) });
    }
  }
  const comments = new Map();
  for (const post of posts.values()) {
    if (!post.replyCount) continue;
    try {
      const pulled = await pullPages({
        request,
        since,
        until,
        maxPages: maxCommentPages,
        urlFor: (page) => discussionCommentsUrl(post.id, page),
        mapRow: (row) => mapDiscussionComment(row, post),
        rowsOf: commentRows,
      });
      if (pulled.truncated) truncated = true;
      for (const comment of pulled.items.values()) {
        if (!comments.has(comment.id)) comments.set(comment.id, comment);
      }
    } catch (error) {
      if (error?.code === 'login_required') throw error;
      failures.push({ label: `${post.id} 评论`, reason: String(error?.message || error) });
    }
  }
  const allFailed = queries.length > 0 && failures.length >= queries.length && posts.size === 0;
  return {
    ok: !allFailed && failures.length === 0,
    partial: failures.length > 0 && posts.size > 0,
    failed: allFailed,
    reason: failures.map((item) => `${item.label}: ${item.reason}`).join('；'),
    posts: [...posts.values()],
    comments: [...comments.values()],
    truncated,
    failures,
  };
}

export async function collectDiscussionTargets(targets, options) {
  const wait = options.wait || delay;
  const intervalMs = Math.max(0, Number(options.intervalMs) || 0);
  const retries = Math.max(0, Number(options.retries) || 0);
  const paced = options.request || createRequestPacer({ wait, intervalMs });
  const request = (url) => paced(() => withRetry(() => options.fetchJson(url), { retries, wait, intervalMs }));
  const results = [];
  for (const target of targets) {
    results.push(await collectDiscussionTarget({ ...options, target, request }));
  }
  return results;
}

async function fetchDiscussionJson(session, url) {
  const payload = await session.fetchJson(url, { headers: jsonHeaders(), timeoutMs: 30_000 });
  const data = parseBrowserJson(payload);
  if (payload.status && payload.status >= 400) {
    if (isXueqiuLoginError(data)) throw new XueqiuLoginRequiredError();
    const error = new Error(explainXueqiuApiError(data, `雪球 HTTP ${payload.status}`));
    error.status = payload.status;
    throw error;
  }
  return data;
}

export function createXueqiuStockDiscussionClient(options = {}) {
  const wait = options.delay || delay;
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
      return runtime.withSession({ purpose: 'xueqiu-discussion', focused: false }, async (session) => {
        await session.navigate(`${PAGE_ORIGIN}/hq`, { timeoutMs: 90_000 });
        await wait(Math.max(300, Number(options.intervalMs) || 1200));
        const inspect = await session.evaluate(buildLoginInspectExpression());
        if (!inspect?.logged_in) throw new XueqiuLoginRequiredError();
        return collectDiscussionTargets(targets, {
          ...range,
          fetchJson: (url) => fetchDiscussionJson(session, url),
          wait,
          intervalMs: options.intervalMs ?? 1200,
          retries: options.retries ?? 2,
          maxPages: options.maxPages,
          maxCommentPages: options.maxCommentPages,
        });
      });
    },
  };
}
