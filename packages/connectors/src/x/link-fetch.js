import { lookup as defaultLookup } from 'node:dns/promises';
import { X_LINK_HOP_HOSTS } from '../../../domain/src/x-link-articles.js';
import { hostAllowed, isPrivateAddress, isPublicHttpsUrl, redactUrl } from '../media/article-url.js';
import { fetchAllowlisted } from '../media/http.js';
import { extractArticleText } from '../media/article-html.js';

const HOP_HOSTS = [...X_LINK_HOP_HOSTS];
const MAX_REDIRECTS = 5;
const ARTICLE_MAX_BYTES = 1_500_000;
const TEXT_MAX_BYTES = 100_000;

function hostnameOf(value) {
  return new URL(value).hostname.toLowerCase();
}

function header(response, name) {
  return response.headers?.get?.(name) || response.headers?.[name] || '';
}

async function assertPublicHost(hostname, lookupImpl) {
  const records = await lookupImpl(hostname, { all: true, verbatim: true });
  const list = Array.isArray(records) ? records : [records];
  if (!list.length) throw new Error(`无法解析 ${hostname}`);
  for (const record of list) {
    if (isPrivateAddress(record.address)) throw new Error(`拒绝私有地址 ${hostname}`);
  }
}

function fail(reason, finalUrl = '') {
  return { ok: false, reason, finalUrl: finalUrl ? redactUrl(finalUrl) : '', host: '' };
}

// t.co、bbc.in、trib.al 只作跳转。不带 Cookie，落地必须在媒体域名白名单里。
export async function expandPublicUrl(url, {
  allowedHosts = [],
  hopHosts = HOP_HOSTS,
  lookupImpl = defaultLookup,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
} = {}) {
  let current = String(url || '');
  const hops = Array.isArray(hopHosts) ? hopHosts : [...(hopHosts || [])];
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!isPublicHttpsUrl(current)) return fail('blocked_url', current);
    const host = hostnameOf(current);
    const short = hostAllowed(host, hops) || hostAllowed(host.replace(/^www\./, ''), hops);
    const allowed = hostAllowed(host, allowedHosts);
    if (short) {
      // 短链继续跳，即使它也被写进了域名表。
    } else if (!allowed) return fail('blocked_host', current);
    else return { ok: true, reason: '', finalUrl: current, host };
    try {
      await assertPublicHost(host, lookupImpl);
    } catch {
      return fail('blocked_host', current);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          Accept: 'text/html',
          'User-Agent': 'AICenterMedia/0.2 (+local)',
        },
        signal: controller.signal,
      });
      response.body?.cancel?.().catch?.(() => {});
      const status = Number(response.status) || 0;
      if (![301, 302, 303, 307, 308].includes(status)) return fail('blocked_host', current);
      const location = header(response, 'location');
      if (!location) return fail('blocked_redirect', current);
      current = new URL(location, current).toString();
    } catch (error) {
      return fail('network', current);
    } finally {
      clearTimeout(timer);
    }
  }
  return fail('blocked_redirect', current);
}

function fetchReason(result) {
  if (result.status === 402) return 'paywall';
  if (result.status === 401 || result.status === 403 || result.health === 'blocked') return 'blocked';
  if (result.health === 'oversized') return 'oversized';
  return result.health || 'failed';
}

export async function fetchLinkedArticle({
  url,
  allowedHosts = [],
  hopHosts = HOP_HOSTS,
  sourceKey = '',
  publisherKey = '',
  publisherForHost,
  fetchImpl,
  lookupImpl,
  maxBytes = ARTICLE_MAX_BYTES,
} = {}) {
  const expanded = await expandPublicUrl(url, { allowedHosts, hopHosts, fetchImpl, lookupImpl });
  if (!expanded.ok) {
    return { ok: false, reason: expanded.reason, finalUrl: expanded.finalUrl || '', title: '', text: '', contentLevel: '' };
  }
  const site = publisherForHost?.(expanded.host) || {};
  const result = await fetchAllowlisted({
    url: expanded.finalUrl,
    kind: 'article',
    allowedHosts: [expanded.host],
  }, { fetchImpl, lookupImpl, maxBytes, maxAttempts: 1 });
  const finalUrl = result.finalUrl || expanded.finalUrl;
  if (!result.ok) {
    return { ok: false, reason: fetchReason(result), finalUrl, title: '', text: '', contentLevel: '' };
  }
  const article = extractArticleText(result.body, {
    status: result.status,
    sourceKey: site.sourceKey || sourceKey,
    publisherKey: site.publisherKey || publisherKey,
    maxBytes: TEXT_MAX_BYTES,
  });
  if (article.reason === 'paywall' || article.reason === 'blocked') {
    return { ok: false, reason: article.reason, finalUrl, title: '', text: '', contentLevel: article.contentLevel || '' };
  }
  if (!article.ok || article.contentLevel !== 'full') {
    return {
      ok: false,
      reason: article.reason || 'incomplete',
      finalUrl,
      title: '',
      text: '',
      contentLevel: article.contentLevel || '',
    };
  }
  return {
    ok: true,
    reason: '',
    finalUrl,
    title: String(article.title || '').trim(),
    text: String(article.text || '').trim(),
    contentLevel: article.contentLevel,
  };
}
