import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const HTML_CACHE_CONTROL = 'no-store';
const VERSION_QUERY = /\?v=[A-Za-z0-9._-]+/g;

function normalizeNewlines(value) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
  return text.replace(/\r\n?/g, '\n');
}

function inlineScriptHashes(html) {
  const hashes = [];
  const text = normalizeNewlines(html);
  for (const match of text.matchAll(/<script\b(?![^>]*\bsrc\b)[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (!match[1].trim()) continue;
    hashes.push(`'sha256-${createHash('sha256').update(normalizeNewlines(match[1])).digest('base64')}'`);
  }
  return hashes;
}

function scriptSrcFor(contentType, html) {
  if (!String(contentType).includes('html') || !html) return "'self'";
  const hashes = inlineScriptHashes(html);
  return hashes.length ? `'self' ${hashes.join(' ')}` : "'self'";
}

function securityHeaders(contentType, cacheControl, scriptSrc = "'self'") {
  return {
    'Content-Type': contentType,
    'Cache-Control': cacheControl,
    'Vary': 'Accept-Encoding',
    'Content-Security-Policy': `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src ${scriptSrc || "'self'"}; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
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
    '/media-feed.js': ['media-feed.js', 'text/javascript; charset=utf-8', ASSET_CACHE_CONTROL],
    '/brief-page.js': ['brief-page.js', 'text/javascript; charset=utf-8', ASSET_CACHE_CONTROL],
    '/information-tree.js': ['information-tree.js', 'text/javascript; charset=utf-8', ASSET_CACHE_CONTROL],
    '/investor-digest.js': ['investor-digest.js', 'text/javascript; charset=utf-8', ASSET_CACHE_CONTROL],
    '/home-timeline.js': ['home-timeline.js', 'text/javascript; charset=utf-8', ASSET_CACHE_CONTROL],
    '/html-text.js': ['html-text.js', 'text/javascript; charset=utf-8', ASSET_CACHE_CONTROL],
    '/news-list.js': ['news-list.js', 'text/javascript; charset=utf-8', ASSET_CACHE_CONTROL],
    '/model-usage.js': ['model-usage.js', 'text/javascript; charset=utf-8', ASSET_CACHE_CONTROL],
    '/feed-interaction.js': ['feed-interaction.js', 'text/javascript; charset=utf-8', ASSET_CACHE_CONTROL],
    '/hardware-prices.js': ['hardware-prices.js', 'text/javascript; charset=utf-8', ASSET_CACHE_CONTROL],
    '/compute-prices.js': ['compute-prices.js', 'text/javascript; charset=utf-8', ASSET_CACHE_CONTROL],
    '/markdown.js': ['markdown.js', 'text/javascript; charset=utf-8', ASSET_CACHE_CONTROL],
    '/share-card.js': ['share-card.js', 'text/javascript; charset=utf-8', ASSET_CACHE_CONTROL],
    '/qr-code.js': ['qr-code.js', 'text/javascript; charset=utf-8', ASSET_CACHE_CONTROL],
    '/quote-chart.js': ['quote-chart.js', 'text/javascript; charset=utf-8', ASSET_CACHE_CONTROL],
    '/klinecharts.js': ['klinecharts.js', 'text/javascript; charset=utf-8', ASSET_CACHE_CONTROL],
    '/icons.js': ['icons.js', 'text/javascript; charset=utf-8', ASSET_CACHE_CONTROL],
    '/mock.js': ['mock.js', 'text/javascript; charset=utf-8', ASSET_CACHE_CONTROL],
    '/quant-lab.js': ['quant-lab.js', 'text/javascript; charset=utf-8', ASSET_CACHE_CONTROL],
    '/etf-whale': ['etf-whale.html', 'text/html; charset=utf-8', HTML_CACHE_CONTROL],
    '/etf-whale.html': ['etf-whale.html', 'text/html; charset=utf-8', HTML_CACHE_CONTROL],
    '/etf-whale.js': ['etf-whale.js', 'text/javascript; charset=utf-8', HTML_CACHE_CONTROL],
    '/etf-whale.css': ['etf-whale.css', 'text/css; charset=utf-8', HTML_CACHE_CONTROL],
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
    let raw = await readFile(filePath);
    if (target[1].includes('html')) {
      let text = normalizeNewlines(raw);
      if (text.includes('<script src="/ui-boot.js"></script>')) {
        const boot = normalizeNewlines(await readFile(path.join(publicDirectory, 'ui-boot.js')));
        text = text.replace(
          '<script src="/ui-boot.js"></script>',
          `<script>${boot}</script>`,
        );
      }
      raw = Buffer.from(text);
    }
    raw = applyUiRevision(raw, target[1], revision);
    const gzipped = gzipSync(raw);
    const entry = {
      fingerprint,
      contentType: target[1],
      cacheControl: target[2],
      raw,
      gzipped: gzipped.length < raw.length ? gzipped : null,
      scriptSrc: scriptSrcFor(target[1], raw.toString('utf8')),
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
      ...securityHeaders(entry.contentType, entry.cacheControl, entry.scriptSrc),
      'Content-Length': body.length,
      ...(useGzip ? { 'Content-Encoding': 'gzip' } : {}),
    });
    response.end(body);
    return true;
  }

  serveStatic.getUiRevision = getUiRevision;
  return serveStatic;
}
