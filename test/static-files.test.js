import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAiCenterServer } from '../apps/web/src/server.js';
import { createStaticFileHandler } from '../apps/web/src/http/static-files.js';

function getRaw(url, headers = {}) {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      headers,
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

function readStatic(handler, pathname) {
  return new Promise((resolve, reject) => {
    const response = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(body) { resolve({ status: this.status, headers: this.headers, body }); },
    };
    handler(pathname, { headers: { 'accept-encoding': 'identity' } }, response).catch(reject);
  });
}

test('static file memory cache invalidates when a file changes', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-static-reload-'));
  try {
    writeFileSync(path.join(directory, 'index.html'), 'first');
    const handler = createStaticFileHandler(directory);
    const first = await readStatic(handler, '/');
    assert.equal(first.body.toString('utf8'), 'first');

    writeFileSync(path.join(directory, 'index.html'), 'second version');
    const second = await readStatic(handler, '/');
    assert.equal(second.body.toString('utf8'), 'second version');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('static assets are gzipped on request and versioned JS/CSS are cacheable', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-static-'));
  const app = createAiCenterServer({ host: '127.0.0.1', port: 0, dataDirectory: directory });
  const address = await app.listen();
  try {
    const html = await getRaw(`${address.localUrl}/`, { 'Accept-Encoding': 'identity' });
    assert.equal(html.status, 200);
    assert.equal(html.headers['cache-control'], 'no-store');
    assert.equal(html.headers['content-encoding'], undefined);
    const htmlText = html.body.toString('utf8');
    assert.match(htmlText, /app\.js\?v=/);
    assert.match(htmlText, /id="view-sources"/);
    assert.match(htmlText, /id="overview-subnav"/);
    assert.match(htmlText, /id="view-market"/);
    assert.match(htmlText, /id="view-assets"/);

    const gzipped = await getRaw(`${address.localUrl}/app.js`, { 'Accept-Encoding': 'gzip' });
    assert.equal(gzipped.status, 200);
    assert.equal(gzipped.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(gzipped.headers['vary'], 'Accept-Encoding');
    assert.equal(gzipped.headers['content-encoding'], 'gzip');
    const decoded = gunzipSync(gzipped.body).toString('utf8');
    assert.match(decoded, /async function initialize/);
    assert.match(decoded, /Promise\.all\(startupLoads\)/);
    assert.match(decoded, /async function askAgent/);
    assert.match(decoded, /async function loadSourcesPage/);
    assert.match(decoded, /const navItems = \[/);
    assert.match(decoded, /label: '灵感'/);
    assert.match(decoded, /label: '社媒'/);
    assert.match(decoded, /function renderHub\(\)/);
    assert.match(decoded, /futureSourceSlots/);

    const markdown = await getRaw(`${address.localUrl}/markdown.js`, { 'Accept-Encoding': 'identity' });
    assert.equal(markdown.status, 200);
    assert.match(markdown.body.toString('utf8'), /export function markdownToHtml/);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
