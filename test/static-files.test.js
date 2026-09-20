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
    assert.match(htmlText, /src="\/ui-boot\.js"/);
    assert.match(htmlText, /name="ai-center-ui-revision"/);
    const boot = await getRaw(`${address.localUrl}/ui-boot.js`, { 'Accept-Encoding': 'identity' });
    assert.equal(boot.status, 200);
    assert.equal(boot.headers['cache-control'], 'no-store');
    assert.match(boot.body.toString('utf8'), /\/api\/v1\/ui\/revision/);
    assert.match(boot.body.toString('utf8'), /aiCenterUiBoot/);
    assert.match(boot.body.toString('utf8'), /settleRevision/);
    const health = await getRaw(`${address.localUrl}/api/v1/health`);
    const healthBody = JSON.parse(health.body.toString('utf8'));
    assert.match(healthBody.uiRevision, /^[0-9a-f]{12}$/);
    assert.match(htmlText, new RegExp(`app\\.js\\?v=${healthBody.uiRevision}`));
    const revision = await getRaw(`${address.localUrl}/api/v1/ui/revision`);
    assert.equal(JSON.parse(revision.body.toString('utf8')).revision, healthBody.uiRevision);
    assert.match(htmlText, /class="is-unpaired"/);
    assert.match(htmlText, /id="unpaired-panel"/);
    assert.match(htmlText, /正在连接/);
    assert.doesNotMatch(htmlText, /id="unpaired-panel"[^>]*\bhidden\b/);
    const css = await getRaw(`${address.localUrl}/styles.css`, { 'Accept-Encoding': 'identity' });
    assert.match(css.body.toString('utf8'), /body:not\(\.is-ready\) \.app-shell/);
    assert.match(htmlText, /id="view-sources"/);
    assert.match(htmlText, /id="overview-subnav"/);
    assert.match(htmlText, /id="view-market"/);
    assert.match(htmlText, /id="ask-live-chip"/);

    const gzipped = await getRaw(`${address.localUrl}/app.js`, { 'Accept-Encoding': 'gzip' });
    assert.equal(gzipped.status, 200);
    assert.equal(gzipped.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(gzipped.headers['vary'], 'Accept-Encoding');
    assert.equal(gzipped.headers['content-encoding'], 'gzip');
    const decoded = gunzipSync(gzipped.body).toString('utf8');
    assert.match(decoded, /function paintAuthorizedChrome/);
    assert.match(decoded, /async function completeAuthorizedStart/);
    assert.match(decoded, /async function waitForAuthorizedSession/);
    assert.match(decoded, /async function initialize/);
    assert.match(decoded, /async function settleUiRevision/);
    assert.match(decoded, /async function reloadShellWhenStable/);
    assert.match(decoded, /Promise\.all\(startupLoads\)/);
    assert.match(decoded, /async function askAgent/);
    assert.match(decoded, /async function pollAskJobs/);
    assert.match(decoded, /async function loadSourcesPage/);
    assert.match(decoded, /const navItems = \[/);
    assert.match(decoded, /label: '灵感'/);
    assert.match(decoded, /label: '信息流'/);
    assert.match(decoded, /function renderHub\(\)/);
    assert.match(decoded, /function renderStaticSignalBoard/);
    assert.match(decoded, /async function loadStaticSignalBoard/);

    const markdown = await getRaw(`${address.localUrl}/markdown.js`, { 'Accept-Encoding': 'identity' });
    assert.equal(markdown.status, 200);
    assert.match(markdown.body.toString('utf8'), /export function markdownToHtml/);
    const appJs = await getRaw(`${address.localUrl}/app.js`, { 'Accept-Encoding': 'identity' });
    assert.match(appJs.body.toString('utf8'), new RegExp(`icons\\.js\\?v=${healthBody.uiRevision}`));
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('ui revision changes after a public file is edited', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-ui-revision-'));
  try {
    writeFileSync(path.join(directory, 'index.html'), '<meta name="ai-center-ui-revision" content="dev"><link href="/styles.css?v=old">');
    writeFileSync(path.join(directory, 'app.js'), 'import "./icons.js?v=old"');
    writeFileSync(path.join(directory, 'styles.css'), 'body{}');
    writeFileSync(path.join(directory, 'icons.js'), '');
    writeFileSync(path.join(directory, 'markdown.js'), '');
    writeFileSync(path.join(directory, 'mock.js'), '');
    const handler = createStaticFileHandler(directory);
    const firstRevision = await handler.getUiRevision();
    const firstHtml = await readStatic(handler, '/');
    assert.match(firstHtml.body.toString('utf8'), new RegExp(`styles\\.css\\?v=${firstRevision}`));

    writeFileSync(path.join(directory, 'styles.css'), 'body{color:red}');
    const secondRevision = await handler.getUiRevision();
    assert.notEqual(secondRevision, firstRevision);
    const secondHtml = await readStatic(handler, '/');
    assert.match(secondHtml.body.toString('utf8'), new RegExp(`styles\\.css\\?v=${secondRevision}`));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
