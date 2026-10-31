import { fetchAllowlisted } from './media/http.js';

export const SEMI_MIN_INTERVAL_MS = 3000;
const HOSTS = new Set(['semianalysis.com', 'www.semianalysis.com']);
const PAYWALL = /subscribe to (?:read|continue)|members?[-\s]?only|paywall|sign in to read|log in to continue|paid subscribers/i;
const FEED_BODY = /<rss[\s>]|<feed[\s>]|content:encoded/i;

export function semianalysisResearchStatus() {
  return Object.freeze({
    available: false,
    connected: false,
    reason: 'not_connected',
    note: 'Research API 仅预留，未接入。请人读公开页，或在媒体页粘贴公开 URL。',
  });
}

export function createSemiRequestGate({
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let last = null;
  return async function wait(requested = SEMI_MIN_INTERVAL_MS) {
    const interval = Math.max(SEMI_MIN_INTERVAL_MS, Math.trunc(Number(requested) || SEMI_MIN_INTERVAL_MS));
    const current = now();
    if (last != null && current - last < interval) await sleep(interval - (current - last));
    last = now();
  };
}

function decode(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseSemiPublicUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    return { ok: false, health: 'blocked_url', note: '地址无效' };
  }
  if (url.protocol !== 'https:' || url.username || url.password || !HOSTS.has(url.hostname.toLowerCase())) {
    return { ok: false, health: 'blocked_url', note: '只接受 semianalysis.com 的公开 https 地址' };
  }
  if (/\/(?:feed|rss)(?:\/|$)/i.test(url.pathname) || /\.(?:xml|atom)$/i.test(url.pathname) || /^(rss|atom)$/i.test(url.searchParams.get('format') || '')) {
    return { ok: false, health: 'feed_refused', note: '不抓 Newsletter RSS 或 Atom' };
  }
  url.hash = '';
  return { ok: true, url: url.toString(), externalId: `semianalysis:${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '') || '/'}`.slice(0, 400) };
}

function metaContent(html, key) {
  const attrs = String(html || '').match(/<meta\b[^>]*>/gi) || [];
  for (const tag of attrs) {
    const name = tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1] || '';
    if (name.toLowerCase() !== key) continue;
    return decode(tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1] || '');
  }
  return '';
}

function visibleParagraph(html) {
  const match = String(html || '').match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
  return decode(String(match?.[1] || '').replace(/<[^>]+>/g, ' '));
}

export function extractSemiPublicExcerpt(html) {
  const raw = String(html || '');
  if (FEED_BODY.test(raw)) {
    return { ok: false, health: 'feed_refused', contentLevel: 'partial', title: '', excerpt: '', reason: 'feed_refused', note: '不把 Newsletter feed 或 content:encoded 当正文' };
  }
  const title = metaContent(raw, 'og:title') || decode((raw.match(/<title>([^<]+)<\/title>/i) || [])[1] || '');
  const description = metaContent(raw, 'og:description') || metaContent(raw, 'description');
  const paragraph = visibleParagraph(raw);
  const paywall = PAYWALL.test(raw);
  const lead = [description, paragraph].find((text) => text && !PAYWALL.test(text) && text.length >= 40) || '';
  if (!title || !lead) {
    return { ok: false, health: 'policy_skipped', contentLevel: 'partial', title, excerpt: '', reason: paywall ? 'paywall' : 'missing_public_lead', note: paywall ? '付费墙已跳过' : '公开页没有可保存的导语' };
  }
  return {
    ok: true,
    health: 'partial',
    contentLevel: 'partial',
    title: title.slice(0, 500),
    excerpt: lead.slice(0, 1200),
    reason: paywall ? 'paywall_public_lead' : 'manual_public_excerpt',
    note: '',
  };
}

export async function readSemiPublicPage(entry, pageUrl, { fetchImpl, lookupImpl, gate } = {}) {
  const parsed = parseSemiPublicUrl(pageUrl);
  if (!parsed.ok) return { ...parsed, status: null, title: '', excerpt: '', contentLevel: 'partial' };
  if (gate) await gate(Math.max(SEMI_MIN_INTERVAL_MS, Number(entry?.minRequestIntervalMs) || SEMI_MIN_INTERVAL_MS));
  const fetched = await fetchAllowlisted({
    url: parsed.url,
    allowedHosts: entry?.allowedHosts?.length ? entry.allowedHosts : [...HOSTS],
    redirectHosts: entry?.redirectHosts || [],
    kind: 'article',
  }, { fetchImpl, lookupImpl, maxBytes: 1_500_000, maxAttempts: 1 });
  if (fetched.status === 401 || fetched.status === 403 || fetched.health === 'blocked') {
    return { ok: false, health: 'policy_skipped', status: fetched.status || 403, externalId: parsed.externalId, title: '', excerpt: '', contentLevel: 'partial', reason: 'paywall', note: '付费墙或无权页面已跳过' };
  }
  if (!fetched.ok) {
    return { ok: false, health: fetched.health, status: fetched.status ?? null, externalId: parsed.externalId, title: '', excerpt: '', contentLevel: 'partial', reason: fetched.health, note: fetched.note || '' };
  }
  const article = extractSemiPublicExcerpt(fetched.body);
  return { ...article, status: fetched.status ?? 200, externalId: parsed.externalId, finalUrl: fetched.finalUrl || parsed.url };
}
