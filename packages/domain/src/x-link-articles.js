import { formatYmd, zonedParts } from './zoned-time.js';

export const X_LINK_ARTICLE_JOB_TYPE = 'x.links.article';

// t.co 落到 bbc.in，bbc.in 再落到 trib.al，最后才是 www.bbc.com。
// 这三跳都只跟随，不把短链本身当成文章正文。
export const X_LINK_HOP_HOSTS = Object.freeze(['t.co', 'bbc.in', 'trib.al']);
const HOP_HOSTS = new Set(X_LINK_HOP_HOSTS);
const HANDLE_SUFFIXES = new Set([
  'news', 'world', 'business', 'breaking', 'official', 'press', 'media', 'tv', 'radio',
  'wire', 'wires', 'live', 'alerts', 'cn', 'zh', 'uk', 'us', 'asia', 'tech', 'science',
  'sport', 'sports', 'politics', 'video', 'videos', 'intl', 'international', 'chinese',
  'hq', 'desk',
]);

function boundedInt(value, fallback, min, max) {
  if (value == null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

// 默认打开。只处理媒体或官方账号帖子里的外链，并另有每天篇数上限。
// 设为 0 / false / off / no 才关闭。
export function xLinkArticleEnabled(env = process.env) {
  const raw = env.AI_CENTER_X_LINK_ARTICLE;
  if (raw == null || String(raw).trim() === '') return true;
  const value = String(raw).trim().toLowerCase();
  if (value === '0' || value === 'false' || value === 'off' || value === 'no') return false;
  return value === '1' || value === 'true' || value === 'on' || value === 'yes';
}

export function xLinkArticleDailyLimit(env = process.env) {
  return boundedInt(env.AI_CENTER_X_LINK_ARTICLE_DAILY, 8, 0, 48);
}

export function xLinkArticleDay(now = Date.now(), timeZone = 'Asia/Shanghai') {
  return formatYmd(zonedParts(now, timeZone));
}

export function compactOutletToken(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
}

function tokenMatches(value, token) {
  if (!value || !token || token.length < 3) return false;
  if (value === token) return true;
  if (!value.startsWith(token)) return false;
  return HANDLE_SUFFIXES.has(value.slice(token.length));
}

function rememberHost(hosts, host, meta) {
  const name = String(host || '').trim().toLowerCase();
  if (!name || name === 't.co') return;
  if (!hosts.has(name)) hosts.set(name, meta);
  const bare = name.replace(/^www\./, '');
  if (bare !== name && !hosts.has(bare)) hosts.set(bare, meta);
  if (!name.startsWith('www.') && !hosts.has(`www.${name}`)) hosts.set(`www.${name}`, meta);
}

function bareHost(host) {
  return String(host || '').trim().toLowerCase().replace(/^www\./, '');
}

export function buildXLinkPublisherIndex(sources = []) {
  const tokens = [];
  const hosts = new Map();
  const seen = new Set();
  const articleHosts = new Set();
  const redirectHosts = new Set();
  for (const source of sources) {
    const label = String(source?.publisher || source?.channelName || source?.sourceKey || '').trim();
    const sourceKey = String(source?.sourceKey || '').trim().toLowerCase();
    const publisherKey = String(source?.publisherKey || sourceKey).trim().toLowerCase();
    const meta = { label: label || sourceKey, sourceKey, publisherKey };
    for (const name of [source?.publisher, source?.publisherKey, source?.sourceKey, source?.channelName]) {
      const token = compactOutletToken(name);
      if (token.length < 3 || seen.has(token)) continue;
      seen.add(token);
      tokens.push({ token, label: meta.label });
    }
    for (const host of source?.articleHosts || []) {
      rememberHost(hosts, host, meta);
      articleHosts.add(bareHost(host));
    }
    for (const host of source?.redirectHosts || []) {
      rememberHost(hosts, host, meta);
      redirectHosts.add(bareHost(host));
    }
  }
  const hopHosts = new Set(X_LINK_HOP_HOSTS);
  for (const host of redirectHosts) {
    if (host && !articleHosts.has(host)) hopHosts.add(host);
  }
  return { tokens, hosts, hopHosts };
}

export function matchMediaOutlet({ handle = '', name = '' } = {}, index) {
  const values = [compactOutletToken(handle), compactOutletToken(name)].filter((value) => value.length >= 3);
  for (const value of values) {
    for (const entry of index?.tokens || []) {
      if (tokenMatches(value, entry.token)) return { label: entry.label, token: entry.token };
    }
  }
  return null;
}

export function hostArticleMeta(hostname, index) {
  return index?.hosts?.get(String(hostname || '').toLowerCase()) || null;
}

export function readingLinkLabel(publisher) {
  const name = String(publisher || '').trim();
  return name ? `阅读 ${name} 原文` : '阅读原文';
}

const SKIP_HOST = /^(?:www\.)?(?:x|twitter|pic\.x)\.com$/i;

function acceptedUrl(raw) {
  const cleaned = String(raw || '').replace(/[.,;:!?，。！？]+$/g, '');
  const withScheme = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;
  let url;
  try { url = new URL(withScheme); } catch { return ''; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
  if (url.username || url.password) return '';
  if (SKIP_HOST.test(url.hostname)) return '';
  if (!url.pathname || url.pathname === '/') return '';
  return url.toString();
}

export function extractOutboundUrls(text) {
  const found = [];
  const source = String(text || '');
  for (const match of source.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
    const url = acceptedUrl(match[0]);
    if (url) found.push(url);
  }
  for (const match of source.matchAll(/(?:^|[\s([「『])((?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s<>"')\]]+)/gi)) {
    const url = acceptedUrl(match[1]);
    if (url) found.push(url);
  }
  return [...new Set(found)];
}

function hostOf(value) {
  try { return new URL(value).hostname.toLowerCase(); } catch { return ''; }
}

export function chooseOutboundUrl(urls = [], hopHosts = HOP_HOSTS) {
  const hops = hopHosts instanceof Set ? hopHosts : new Set(hopHosts || []);
  const list = [...urls];
  const direct = list.find((item) => {
    const host = hostOf(item);
    return host && !hops.has(host) && !hops.has(host.replace(/^www\./, ''));
  });
  if (direct) return direct;
  const closer = list.find((item) => hostOf(item) && hostOf(item) !== 't.co');
  return closer || list[0] || '';
}

export function canonicalArticleUrl(value) {
  const url = new URL(String(value || ''));
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith('utm_') || key.startsWith('at_') || key === 'fbclid' || key === 'gclid' || key === 'xtor') {
      url.searchParams.delete(key);
    }
  }
  url.hash = '';
  return url.toString();
}

export function tweetOutboundText(capture, item) {
  const meta = capture?.metadata && typeof capture.metadata === 'object' ? capture.metadata : {};
  return [
    item?.body,
    item?.summary,
    item?.title,
    capture?.title,
    meta.text,
    meta.card_url,
    meta.cardUrl,
  ].filter(Boolean).join('\n');
}

export function tweetAuthor(capture, item) {
  const meta = capture?.metadata && typeof capture.metadata === 'object' ? capture.metadata : {};
  const profile = meta.authorProfile && typeof meta.authorProfile === 'object' ? meta.authorProfile : {};
  return {
    handle: String(meta.authorHandle || profile.handle || item?.authorHandle || '').replace(/^@/, ''),
    name: String(meta.authorName || profile.name || item?.authorName || ''),
  };
}
