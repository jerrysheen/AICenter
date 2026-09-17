import { gzipSync } from 'node:zlib';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const HTML_CACHE_CONTROL = 'no-store';

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

export function createStaticFileHandler(publicDirectory) {
  const files = {
    '/': ['index.html', 'text/html; charset=utf-8', HTML_CACHE_CONTROL],
    '/index.html': ['index.html', 'text/html; charset=utf-8', HTML_CACHE_CONTROL],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8', ASSET_CACHE_CONTROL],
    '/markdown.js': ['markdown.js', 'text/javascript; charset=utf-8', ASSET_CACHE_CONTROL],
    '/icons.js': ['icons.js', 'text/javascript; charset=utf-8', ASSET_CACHE_CONTROL],
    '/mock.js': ['mock.js', 'text/javascript; charset=utf-8', ASSET_CACHE_CONTROL],
    '/styles.css': ['styles.css', 'text/css; charset=utf-8', ASSET_CACHE_CONTROL],
  };
  const cache = new Map();

  async function load(pathname) {
    const target = files[pathname];
    if (!target) return null;
    const filePath = path.join(publicDirectory, target[0]);
    const file = await stat(filePath);
    const fingerprint = `${file.mtimeMs}:${file.size}`;
    const hit = cache.get(pathname);
    if (hit?.fingerprint === fingerprint) return hit;
    const raw = await readFile(filePath);
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

  return async function serveStatic(pathname, request, response) {
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
  };
}
