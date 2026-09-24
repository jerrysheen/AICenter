import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const HTML_CACHE_CONTROL = 'no-store';
const VERSION_QUERY = /\?v=[A-Za-z0-9._-]+/g;

function securityHeaders(contentType, cacheControl) {
  return {
    'Content-Type': contentType,
    'Cache-Control': cacheControl,
    'Vary': 'Accept-Encoding',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

function wantsGzip(request) {
  return /\bgzip\b/i.test(String(request?.headers?.['accept-encoding'] || ''));
}

function applyUiRevision(raw, contentType, revision) {
  if (!contentType.includes('html') && !contentType.includes('javascript')) return raw;
  let text = raw.toString('utf8').replace(VERSION_QUERY, `?v=${revision}`);
  if (contentType.includes('html')) {
    if (/name="ai-center-ui-revision"/.test(text)) {
      text = text.replace(
        /(<meta\s+name="ai-center-ui-revision"\s+content=")[^"]*(")/,
        `$1${revision}$2`,
      );
    } else {
      text = text.replace('<head>', `<head>\n  <meta name="ai-center-ui-revision" content="${revision}">`);
    }
  }
  return Buffer.from(text);
}

export function createStaticFileHandler(publicDirectory) {
  const files = {
    '/': ['index.html', 'text/html; charset=utf-8', HTML_CACHE_CONTROL],
    '/index.html': ['index.html', 'text/html; charset=utf-8', HTML_CACHE_CONTROL],
    '/ui-boot.js': ['ui-boot.js', 'text/javascript; charset=utf-8', HTML_CACHE_CONTROL],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8', ASSET_CACHE_CONTROL],
    '/markdown.js': ['markdown.js', 'text/javascript; charset=utf-8', ASSET_CACHE_CONTROL],
    '/share-card.js': ['share-card.js', 'text/javascript; charset=utf-8', ASSET_CACHE_CONTROL],
    '/quote-chart.js': ['quote-chart.js', 'text/javascript; charset=utf-8', ASSET_CACHE_CONTROL],
    '/klinecharts.js': ['klinecharts.js', 'text/javascript; charset=utf-8', ASSET_CACHE_CONTROL],
    '/icons.js': ['icons.js', 'text/javascript; charset=utf-8', ASSET_CACHE_CONTROL],
    '/mock.js': ['mock.js', 'text/javascript; charset=utf-8', ASSET_CACHE_CONTROL],
    '/styles.css': ['styles.css', 'text/css; charset=utf-8', ASSET_CACHE_CONTROL],
  };
  const uniqueNames = [...new Set(Object.values(files).map(([name]) => name))].sort();
  const cache = new Map();

  async function getUiRevision() {
    const parts = [];
    for (const name of uniqueNames) {
      try {
        const file = await stat(path.join(publicDirectory, name));
        parts.push(`${name}:${file.mtimeMs}:${file.size}`);
      } catch {
        parts.push(`${name}:missing`);
      }
    }
    return createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);
  }

  async function load(pathname) {
    const target = files[pathname];
    if (!target) return null;
    const revision = await getUiRevision();
    const filePath = path.join(publicDirectory, target[0]);
    const file = await stat(filePath);
    const fingerprint = `${file.mtimeMs}:${file.size}:${revision}`;
    const hit = cache.get(pathname);
    if (hit?.fingerprint === fingerprint) return hit;
    const raw = applyUiRevision(await readFile(filePath), target[1], revision);
    const gzipped = gzipSync(raw);
    const entry = {
      fingerprint,
      contentType: target[1],
      cacheControl: target[2],
      raw,
      gzipped: gzipped.length < raw.length ? gzipped : null,
    };
    cache.set(pathname, entry);
    return entry;
  }

  async function serveStatic(pathname, request, response) {
    const entry = await load(pathname);
    if (!entry) return false;
    const useGzip = Boolean(entry.gzipped && wantsGzip(request));
    const body = useGzip ? entry.gzipped : entry.raw;
    response.writeHead(200, {
      ...securityHeaders(entry.contentType, entry.cacheControl),
      'Content-Length': body.length,
      ...(useGzip ? { 'Content-Encoding': 'gzip' } : {}),
    });
    response.end(body);
    return true;
  }

  serveStatic.getUiRevision = getUiRevision;
  return serveStatic;
}
