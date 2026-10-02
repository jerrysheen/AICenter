const SECRET_QUERY_KEYS = /^(api[-_]?key|access[-_]?token|token|key|apikey)$/i;

export function redactUrl(value) {
  try {
    const url = new URL(String(value || ''));
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_QUERY_KEYS.test(key)) url.searchParams.set(key, 'redacted');
    }
    return url.toString();
  } catch {
    return '';
  }
}

export function isPublicHttpsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && !url.username && !url.password && (url.port === '' || url.port === '443');
  } catch {
    return false;
  }
}

export function hostAllowed(hostname, allowedHosts = []) {
  const host = String(hostname || '').toLowerCase();
  return allowedHosts.some((item) => String(item || '').toLowerCase() === host);
}

export function isPrivateAddress(address) {
  const value = String(address || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!value) return true;
  if (value === '::1' || value === '0.0.0.0' || value.startsWith('fe80:') || value.startsWith('fc') || value.startsWith('fd')) {
    return true;
  }
  const mapped = value.startsWith('::ffff:') ? value.slice(7) : value;
  const parts = mapped.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return value.includes(':') ? false : true;
  }
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export function normalizeArticleUrl(value, { trackingParams = [], identityParams = [] } = {}) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('文章地址必须是 http 或 https');
  }
  const identity = new URLSearchParams();
  for (const key of identityParams) {
    const found = url.searchParams.get(key);
    if (found) identity.set(key, found);
  }
  for (const key of [...url.searchParams.keys()]) {
    if (trackingParams.includes(key) || key.startsWith('utm_')) url.searchParams.delete(key);
  }
  if (identityParams.length) {
    const next = new URLSearchParams();
    for (const key of identityParams) {
      const found = identity.get(key);
      if (found) next.set(key, found);
    }
    for (const [key, item] of url.searchParams.entries()) {
      if (!identityParams.includes(key) && !trackingParams.includes(key) && !key.startsWith('utm_')) next.append(key, item);
    }
    url.search = next.toString() ? `?${next.toString()}` : '';
  }
  url.hash = '';
  return url;
}

export function stableArticleId(publisherKey, { guid = '', link = '', trackingParams = [], identityParams = [] } = {}) {
  const publisher = String(publisherKey || '').trim();
  let normalized = null;
  if (link) {
    try {
      normalized = normalizeArticleUrl(link, { trackingParams, identityParams });
    } catch {
      normalized = null;
    }
  }
  if (normalized) {
    for (const key of identityParams) {
      const found = normalized.searchParams.get(key);
      if (found) return `${publisher}:${key}:${found}`.slice(0, 400);
    }
    const numeric = normalized.pathname.match(/\/(\d{5,})\/?$/);
    if (numeric) return `${publisher}:${numeric[1]}`;
  }
  const rawGuid = String(guid || '').trim();
  if (rawGuid && !/^https?:\/\//i.test(rawGuid)) return `${publisher}:${rawGuid}`.slice(0, 400);
  if (normalized) {
    return `${publisher}:${normalized.hostname}${normalized.pathname}${normalized.search}`.slice(0, 400);
  }
  if (rawGuid) return `${publisher}:${rawGuid}`.slice(0, 400);
  return '';
}

const SKIP_ORIGIN = /(twitter\.com|x\.com|facebook\.com|linkedin\.com|instagram\.com|youtube\.com|youtu\.be)(\/|$)/i;

export function originLinksFromHtml(html, { publisherHosts = [] } = {}) {
  const found = [];
  const pattern = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi;
  for (const match of String(html || '').matchAll(pattern)) {
    const href = match[1];
    if (!/^https?:\/\//i.test(href)) continue;
    if (/\.(png|jpe?g|gif|webp|svg|css|js)(\?|$)/i.test(href)) continue;
    let url;
    try { url = new URL(href); } catch { continue; }
    if (hostAllowed(url.hostname, publisherHosts)) continue;
    if (SKIP_ORIGIN.test(url.hostname)) continue;
    if (/\/author\/|\/authors\/|\/tag\/|\/category\//i.test(url.pathname)) continue;
    found.push(url.toString());
  }
  return [...new Set(found)].slice(0, 8);
}
