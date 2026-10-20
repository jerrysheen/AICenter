import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticFileHandler } from '../apps/web/src/http/static-files.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDirectory = path.join(root, 'apps/web/public');
const staticFilesSource = path.join(root, 'apps/web/src/http/static-files.js');
const LOCAL_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.[^'"]+)['"]/g;

function whitelistScriptNames(source) {
  const block = source.match(/const files = \{([\s\S]*?)\n  \};/);
  assert.ok(block, 'static file whitelist is present');
  const names = new Set();
  for (const match of block[1].matchAll(/['"]\/?([^'"]+\.js)['"]/g)) {
    names.add(path.posix.basename(match[1]));
  }
  return names;
}

function importedLocalScripts(source) {
  const names = new Set();
  for (const match of source.matchAll(LOCAL_IMPORT)) {
    const specifier = match[1].split(/[?#]/)[0];
    if (!specifier.endsWith('.js')) continue;
    names.add(path.posix.basename(specifier));
  }
  return names;
}

function publicScripts() {
  return readdirSync(publicDirectory, { recursive: true })
    .map(name => name.split(path.sep).join('/'))
    .filter(name => name.endsWith('.js'));
}

function getRaw(url) {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

const JS_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

function publicFiles(extension) {
  return readdirSync(publicDirectory, { recursive: true })
    .map(name => name.split(path.sep).join('/'))
    .filter(name => name.endsWith(extension));
}

function attribute(attrs, name) {
  const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(['"])(.*?)\\1`, 'i'));
  return match ? match[2] : '';
}

function isLocalJsReference(specifier) {
  const value = String(specifier || '').trim();
  if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) return false;
  const filePath = value.split(/[?#]/)[0];
  return filePath.endsWith('.js') && (filePath.startsWith('.') || filePath.startsWith('/') || !filePath.includes('/'));
}

function versionQuery(specifier) {
  const query = String(specifier).split('#')[0].split('?')[1] || '';
  return new URLSearchParams(query).get('v') || '';
}

function htmlScriptRefs(source) {
  const refs = [];
  for (const match of source.matchAll(/<(script|link)\b([^>]*)>/gi)) {
    const tag = match[1].toLowerCase();
    const attrs = match[2];
    if (tag === 'script') {
      const src = attribute(attrs, 'src');
      if (src) refs.push(src);
    } else if (/\b(?:modulepreload|module)\b/i.test(attribute(attrs, 'rel'))) {
      const href = attribute(attrs, 'href');
      if (href) refs.push(href);
    }
  }
  return refs;
}

test('public local JS references carry a version query', () => {
  const missing = [];
  for (const file of publicFiles('.js')) {
    const source = readFileSync(path.join(publicDirectory, file), 'utf8');
    for (const match of source.matchAll(JS_SPECIFIER)) {
      if (!isLocalJsReference(match[1]) || versionQuery(match[1])) continue;
      missing.push(`${file} ${match[1]}`);
    }
  }
  for (const file of publicFiles('.html')) {
    const source = readFileSync(path.join(publicDirectory, file), 'utf8');
    for (const specifier of htmlScriptRefs(source)) {
      if (!isLocalJsReference(specifier) || versionQuery(specifier)) continue;
      missing.push(`${file} ${specifier}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('public JS imports are listed in the static file whitelist', () => {
  const whitelist = whitelistScriptNames(readFileSync(staticFilesSource, 'utf8'));
  const imported = new Map();
  for (const file of publicScripts()) {
    const source = readFileSync(path.join(publicDirectory, file), 'utf8');
    for (const name of importedLocalScripts(source)) {
      const users = imported.get(name) || [];
      users.push(file);
      imported.set(name, users);
    }
  }

  assert.ok(imported.has('news-list.js'), 'scanner sees ./news-list.js?v=dev');
  assert.ok(imported.has('html-text.js'), 'scanner sees ./html-text.js?v=dev');
  const missing = [...imported.entries()]
    .filter(([name]) => !whitelist.has(name))
    .map(([name, users]) => `${users.join(', ')} imports ${name}`);
  assert.deepEqual(missing, []);
});

function resolvePublicPath(fromPath, specifier) {
  const bare = String(specifier || '').split(/[?#]/)[0];
  if (!bare) return '';
  if (bare.startsWith('/')) return path.posix.normalize(bare);
  const dir = path.posix.dirname(fromPath.startsWith('/') ? fromPath : `/${fromPath}`);
  return path.posix.normalize(path.posix.join(dir, bare));
}

function htmlModuleEntries(source) {
  const entries = [];
  for (const match of source.matchAll(/<(script|link)\b([^>]*)>/gi)) {
    const tag = match[1].toLowerCase();
    const attrs = match[2];
    if (tag === 'script') {
      if (!/\bmodule\b/i.test(attribute(attrs, 'type'))) continue;
      const src = attribute(attrs, 'src');
      if (isLocalJsReference(src)) entries.push(resolvePublicPath('/index.html', src));
    } else if (/\b(?:modulepreload|module)\b/i.test(attribute(attrs, 'rel'))) {
      const href = attribute(attrs, 'href');
      if (isLocalJsReference(href)) entries.push(resolvePublicPath('/index.html', href));
    }
  }
  return entries;
}

function reachableModules(startPaths) {
  const seen = [];
  const queued = new Set();
  const missing = [];
  const queue = [...startPaths];
  while (queue.length) {
    const urlPath = queue.shift();
    if (!urlPath || queued.has(urlPath)) continue;
    queued.add(urlPath);
    seen.push(urlPath);
    let source = '';
    try {
      source = readFileSync(path.join(publicDirectory, urlPath.replace(/^\//, '')), 'utf8');
    } catch {
      missing.push(urlPath);
      continue;
    }
    for (const match of source.matchAll(JS_SPECIFIER)) {
      if (!isLocalJsReference(match[1])) continue;
      queue.push(resolvePublicPath(urlPath, match[1]));
    }
  }
  return { seen, missing };
}

function listen(handler) {
  const server = createServer(async (req, response) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (await handler(url.pathname, req, response)) return;
    response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end('{"ok":false}');
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

// 源码文件名集合能发现完全没写进白名单的 import，但只比文件名时，数组里的磁盘文件名也会被当成已登记路由。
// 这次漏登记没有先跑到上面的核对。从 index.html 的 app.js 顺着 import / import() 走完，再向静态服务要文件；没登记就是 404，线上就是白屏。
test('app.js and its transitive imports are served as javascript', async () => {
  const indexHtml = readFileSync(path.join(publicDirectory, 'index.html'), 'utf8');
  const entries = htmlModuleEntries(indexHtml);
  assert.ok(entries.includes('/app.js'), 'index.html loads app.js as a module');
  const { seen, missing } = reachableModules(entries);
  assert.deepEqual(missing, []);
  assert.ok(seen.includes('/youtube-article-links.js'), 'app.js import graph reaches youtube-article-links.js');
  assert.ok(seen.includes('/article-read-position.js'), 'app.js import graph reaches article-read-position.js');
  assert.ok(seen.includes('/news-list.js'));
  assert.ok(seen.includes('/klinecharts.js'), 'dynamic import() is followed transitively');
  const server = await listen(createStaticFileHandler(publicDirectory));
  const { port } = server.address();
  try {
    for (const pathname of seen) {
      const response = await getRaw(`http://127.0.0.1:${port}${pathname}?v=dev`);
      assert.equal(response.status, 200, pathname);
      assert.equal(response.headers['content-type'], 'text/javascript; charset=utf-8', pathname);
      assert.equal(response.headers['cache-control'], 'public, max-age=31536000, immutable', pathname);
    }
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
