import { lookup as defaultLookup } from 'node:dns/promises';
import { isPrivateAddress, isPublicHttpsUrl, hostAllowed, redactUrl } from './article-url.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

async function assertPublicHost(hostname, lookupImpl) {
  const records = await lookupImpl(hostname, { all: true, verbatim: true });
  const list = Array.isArray(records) ? records : [records];
  if (!list.length) throw new Error(`无法解析 ${hostname}`);
  for (const record of list) {
    if (isPrivateAddress(record.address)) {
      throw new Error(`拒绝私有地址 ${hostname}`);
    }
  }
}

function header(response, name) {
  return response.headers?.get?.(name) || response.headers?.[name] || '';
}

function retryAfterDelayMs(value, now = Date.now()) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? Math.max(0, parsed - now) : null;
}

export async function fetchAllowlisted(input, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const lookupImpl = options.lookupImpl || defaultLookup;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes || 2_097_152;
  const maxAttempts = options.maxAttempts || (input.kind === 'article' ? 1 : 2);
  const allowed = [...(input.allowedHosts || []), ...(input.redirectHosts || [])];
  let current = String(input.url || '');
  const redirectChain = [];
  if (!isPublicHttpsUrl(current) || !hostAllowed(new URL(current).hostname, input.allowedHosts || [])) {
    return { ok: false, health: 'blocked_url', status: null, bytes: 0, redirectChain, note: '地址不在来源白名单' };
  }
  let attempt = 0;
  let rateRetry = false;
  while (attempt < maxAttempts) {
    attempt += 1;
    let hostname;
    try {
      hostname = new URL(current).hostname;
      if (!hostAllowed(hostname, allowed)) {
        return { ok: false, health: 'blocked_redirect', status: null, bytes: 0, redirectChain, finalUrl: redactUrl(current), note: '重定向离开白名单' };
      }
      await assertPublicHost(hostname, lookupImpl);
      if (options.onRequest && !options.onRequest()) return { ok: false, health: 'budget_deferred', status: null, bytes: 0, redirectChain, finalUrl: redactUrl(current), note: '请求预算耗尽' };
    } catch (error) {
      if (attempt < maxAttempts) continue;
      return {
        ok: false,
        health: 'network',
        status: null,
        bytes: 0,
        redirectChain,
        finalUrl: redactUrl(current),
        note: error instanceof Error ? error.message : '网络失败',
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { Accept: input.kind === 'article' ? 'text/html, application/xhtml+xml;q=0.9' : 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1', 'User-Agent': 'AICenterMedia/0.2 (+local)' };
      if (input.etag) headers['If-None-Match'] = input.etag;
      if (input.lastModified) headers['If-Modified-Since'] = input.lastModified;
      const response = await fetchImpl(current, { method: 'GET', redirect: 'manual', headers, signal: controller.signal });
      const status = Number(response.status) || 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = header(response, 'location');
        if (!location || redirectChain.length >= MAX_REDIRECTS) {
          return { ok: false, health: 'blocked_redirect', status, bytes: 0, redirectChain, finalUrl: redactUrl(current), note: '重定向无效或过多' };
        }
        const next = new URL(location, current).toString();
        redirectChain.push(redactUrl(next));
        current = next;
        attempt -= 1;
        continue;
      }
      if (status === 304) {
        return {
          ok: true,
          notModified: true,
          health: 'not_modified',
          status,
          bytes: 0,
          body: '',
          contentType: header(response, 'content-type'),
          date: header(response, 'date'),
          etag: header(response, 'etag') || input.etag || '',
          lastModified: header(response, 'last-modified') || input.lastModified || '',
          redirectChain,
          finalUrl: redactUrl(current),
          note: '条件请求未修改',
        };
      }
      if (status === 429) {
        const waitMs = retryAfterDelayMs(header(response, 'retry-after'));
        const honorMs = Number.isFinite(options.maxRetryAfterMs) ? options.maxRetryAfterMs : 60_000;
        const mayHonor = options.honorRetryAfter === true || input.kind !== 'article';
        if (mayHonor && !rateRetry && waitMs != null && waitMs <= honorMs) {
          rateRetry = true;
          if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
          attempt -= 1;
          continue;
        }
        return {
          ok: false, health: 'rate_limited', status, bytes: 0, redirectChain, finalUrl: redactUrl(current),
          contentType: header(response, 'content-type'), date: header(response, 'date'),
          retryAfterMs: Number.isFinite(waitMs) ? waitMs : null, note: '来源要求稍后重试',
        };
      }
      if (status === 401 || status === 402 || status === 403) {
        return { ok: false, health: 'blocked', status, bytes: 0, redirectChain, finalUrl: redactUrl(current), contentType: header(response, 'content-type'), date: header(response, 'date'), note: '来源拒绝或需要授权，不改走浏览器' };
      }
      if (status < 200 || status >= 300) {
        return { ok: false, health: 'http_error', status, bytes: 0, redirectChain, finalUrl: redactUrl(current), contentType: header(response, 'content-type'), date: header(response, 'date'), note: `HTTP ${status}` };
      }
      let buffer;
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > maxBytes) {
              await reader.cancel();
              return { ok: false, health: 'oversized', status, bytes: size, redirectChain, finalUrl: redactUrl(current), note: '响应超过字节上限' };
            }
            chunks.push(Buffer.from(part.value));
          }
          buffer = Buffer.concat(chunks, size);
        } finally { reader.releaseLock(); }
      } else buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > maxBytes) {
        return { ok: false, health: 'oversized', status, bytes: buffer.length, redirectChain, finalUrl: redactUrl(current), contentType: header(response, 'content-type'), date: header(response, 'date'), note: '响应超过字节上限' };
      }
      return {
        ok: true,
        notModified: false,
        health: 'ready',
        status,
        bytes: buffer.length,
        body: buffer.toString('utf8'),
        contentType: header(response, 'content-type'),
        date: header(response, 'date'),
        etag: header(response, 'etag'),
        lastModified: header(response, 'last-modified'),
        redirectChain,
        finalUrl: redactUrl(current),
        note: '',
      };
    } catch (error) {
      if (attempt < maxAttempts) continue;
      return {
        ok: false,
        health: 'network',
        status: null,
        bytes: 0,
        redirectChain,
        finalUrl: redactUrl(current),
        note: error instanceof Error ? error.message : '网络失败',
      };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, health: 'network', status: null, bytes: 0, redirectChain, note: '请求失败' };
}
