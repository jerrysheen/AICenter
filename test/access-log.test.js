import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAiCenterServer } from '../apps/web/src/server.js';
import {
  clientTimingAllowed,
  createAccessLog,
  createDailyLogWriter,
  formatSummaryText,
  hashClientAddress,
  projectClientTiming,
  readAccessSummary,
  safeRequestPath,
  userAgentClass,
} from '../apps/web/src/http/access-log.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function cookiePair(response) {
  const lines = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : String(response.headers.get('set-cookie') || '').split(/,(?=\s*(?:__Host-)?[A-Za-z0-9_]+=)/);
  const line = lines.find((item) => item.startsWith('ai_center_device='));
  assert.ok(line, 'missing device cookie');
  return line.split(';')[0];
}

function readJsonLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('request path keeps the query string, drops token parameters, and classifies the user agent', () => {
  assert.equal(safeRequestPath('/api/v1/feed?limit=12&token=secret&v=abc'), '/api/v1/feed?limit=12&v=abc');
  assert.equal(safeRequestPath('/app.js?v=dev'), '/app.js?v=dev');
  assert.equal(safeRequestPath('/api/v1/reports/reading-hour?startAt=1&endAt=2&scope=hour'), '/api/v1/reports/reading-hour?startAt=1&endAt=2&scope=hour');
  assert.equal(safeRequestPath('/api/v1/session?q=secret'), '/api/v1/session?q=secret');
  assert.equal(safeRequestPath('/api/v1/session?v=bad value'), '/api/v1/session');
  assert.equal(safeRequestPath('/api/v1/home/bootstrap?refresh=1&token=abc'), '/api/v1/home/bootstrap?refresh=1');
  assert.equal(userAgentClass('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), 'mobile');
  assert.equal(userAgentClass('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'desktop');
  assert.equal(userAgentClass('curl/8.0'), 'bot');
  assert.equal(userAgentClass(''), 'other');
  const hashed = hashClientAddress('203.0.113.10', 'salt');
  assert.match(hashed, /^[0-9a-f]{16}$/);
  assert.equal(hashed.includes('203.0.113.10'), false);
  assert.equal(hashClientAddress('203.0.113.10', 'salt'), hashed);
  assert.notEqual(hashClientAddress('203.0.113.11', 'salt'), hashed);
  assert.equal(hashClientAddress('', 'salt'), '');
});

test('daily writer rotates in Shanghai and drops files older than the retention window', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-access-retain-'));
  const clock = Date.parse('2026-10-13T04:00:00.000Z');
  try {
    writeFileSync(path.join(directory, 'access.2026-09-28.log'), 'old\n');
    writeFileSync(path.join(directory, 'access.2026-09-29.log'), 'edge\n');
    writeFileSync(path.join(directory, 'access.2026-09-30.log'), 'keep\n');
    writeFileSync(path.join(directory, 'web.out.2020-01-01.log'), 'other\n');
    const writer = createDailyLogWriter({
      directory,
      prefix: 'access',
      retentionDays: 14,
      now: () => clock,
    });
    writer.enqueue(`${JSON.stringify({ receivedAt: '2026-10-13T12:00:00.000+08:00' })}\n`);
    await writer.close();
    assert.equal(existsSync(path.join(directory, 'access.2026-09-28.log')), false);
    assert.equal(existsSync(path.join(directory, 'access.2026-09-29.log')), false);
    assert.equal(existsSync(path.join(directory, 'access.2026-09-30.log')), true);
    assert.equal(existsSync(path.join(directory, 'web.out.2020-01-01.log')), true);
    assert.equal(existsSync(path.join(directory, 'access.2026-10-13.log')), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('access lines record timing, cache, and a hashed client without blocking a bad directory', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-access-http-'));
  const logDirectory = path.join(directory, 'logs');
  const accessLog = createAccessLog({ directory: logDirectory, salt: 'test-salt', env: {} });
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    accessLog.observe(req, res, url);
    if (url.pathname === '/hang') return;
    if (url.pathname === '/not-modified') {
      res.writeHead(304, { 'Cache-Control': 'public, max-age=31536000, immutable' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end('hi');
  });
  const address = await listen(server);
  const blocked = mkdtempSync(path.join(os.tmpdir(), 'ai-center-access-block-'));
  const blockedFile = path.join(blocked, 'not-dir');
  writeFileSync(blockedFile, 'x');
  const blockedLog = createAccessLog({ directory: blockedFile, salt: 'test-salt', env: {} });
  const blockedServer = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    blockedLog.observe(req, res, url);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  const blockedAddress = await listen(blockedServer);
  try {
    const ok = await fetch(`http://127.0.0.1:${address.port}/api/v1/health?token=secret-value&v=abc`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'CF-Connecting-IP': '203.0.113.10',
        'CF-Ray': 'abcd1234-SJC',
      },
    });
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), 'hi');
    const notModified = await fetch(`http://127.0.0.1:${address.port}/not-modified`);
    assert.equal(notModified.status, 304);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('aborted request did not close')), 2000);
      const req = httpRequest(`http://127.0.0.1:${address.port}/hang`);
      req.on('error', () => {});
      server.once('request', (_incoming, response) => {
        response.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
        req.destroy();
      });
      req.end();
    });
    await accessLog.flush();

    const day = readFileSync(path.join(logDirectory, `access.${new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)}.log`), 'utf8');
    assert.equal(day.includes('secret-value'), false);
    assert.equal(day.includes('203.0.113.10'), false);
    const lines = day.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const health = lines.find((line) => line.path === '/api/v1/health?v=abc');
    assert.ok(health);
    assert.equal(health.method, 'GET');
    assert.equal(health.status, 200);
    assert.equal(health.bytesSent, 2);
    assert.equal(health.aborted, false);
    assert.equal(health.ua, 'desktop');
    assert.equal(health.cache.control, 'no-store');
    assert.equal(health.cache.notModified, false);
    assert.equal(Object.hasOwn(health.cache, 'hit'), false);
    assert.equal(health.cfRay, 'abcd1234-SJC');
    assert.equal(health.client, hashClientAddress('203.0.113.10', 'test-salt'));
    assert.equal(typeof health.serverMs, 'number');
    assert.equal(typeof health.transferMs, 'number');
    assert.equal(health.totalMs, health.serverMs + health.transferMs);
    assert.ok(health.receivedAt.endsWith('+08:00'));
    assert.ok(health.firstByteAt);
    assert.ok(health.finishedAt);

    const cached = lines.find((line) => line.path === '/not-modified');
    assert.equal(cached.status, 304);
    assert.equal(cached.cache.notModified, true);
    assert.equal(cached.cache.control, 'public, max-age=31536000, immutable');
    assert.equal(cached.bytesSent, 0);

    const aborted = lines.find((line) => line.path === '/hang');
    assert.ok(aborted);
    assert.equal(aborted.aborted, true);
    assert.equal(aborted.serverMs, null);
    assert.equal(aborted.transferMs, null);
    assert.equal(typeof aborted.totalMs, 'number');

    const stillOk = await fetch(`http://127.0.0.1:${blockedAddress.port}/plain`);
    assert.equal(stillOk.status, 200);
    assert.equal(await stillOk.text(), 'ok');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => blockedServer.close(resolve));
    await accessLog.close();
    await blockedLog.close();
    rmSync(directory, { recursive: true, force: true });
    rmSync(blocked, { recursive: true, force: true });
  }
});

test('summary reports percentiles and the script prints the same view', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-access-summary-'));
  const stamp = '2026-10-13T10:00:00.000+08:00';
  const rows = [10, 20, 30, 40, 100].map((total) => ({
    receivedAt: stamp,
    path: '/app.js?v=abc',
    bytesSent: 100,
    serverMs: total - 4,
    transferMs: 4,
    totalMs: total,
  }));
  rows.push({
    receivedAt: '2026-10-13T08:00:00.000+08:00',
    path: '/old',
    bytesSent: 1,
    serverMs: 1,
    transferMs: 1,
    totalMs: 9_000,
  });
  rows.push({
    receivedAt: stamp,
    path: '/api/v1/health',
    bytesSent: 20,
    serverMs: 5,
    transferMs: 1,
    totalMs: 6,
  });
  writeFileSync(path.join(directory, 'access.2026-10-13.log'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\nnot-json\n`);
  try {
    const summary = await readAccessSummary(directory, {
      date: '2026-10-13',
      since: '2026-10-13T09:00:00.000+08:00',
      top: '1',
    });
    assert.equal(summary.ok, true);
    assert.equal(summary.count, 6);
    assert.equal(summary.paths.length, 1);
    assert.equal(summary.paths[0].path, '/app.js?v=abc');
    assert.equal(summary.paths[0].count, 5);
    assert.equal(summary.paths[0].bytes, 500);
    assert.deepEqual(summary.paths[0].total, { p50: 30, p95: 100, max: 100 });
    assert.deepEqual(summary.paths[0].serverMs, { p50: 26, p95: 96, max: 96 });
    assert.equal((await readAccessSummary(directory, { date: '2026-99-99' })).error, '日期无效');

    const printed = spawnSync(process.execPath, [
      path.join(root, 'scripts/access-log-summary.mjs'),
      '--dir', directory,
      '--date', '2026-10-13',
      '--since', '2026-10-13T09:00:00.000+08:00',
      '--top', '5',
    ], { encoding: 'utf8' });
    assert.equal(printed.status, 0, printed.stderr);
    assert.equal(printed.stdout.trim(), formatSummaryText(await readAccessSummary(directory, {
      date: '2026-10-13',
      since: '2026-10-13T09:00:00.000+08:00',
      top: '5',
    })));
    assert.match(printed.stdout, /serverMs=26\/96\/96/);
    assert.match(printed.stdout, /transferMs=/);
    assert.match(printed.stdout, /count=5/);
    const bad = spawnSync(process.execPath, [
      path.join(root, 'scripts/access-log-summary.mjs'),
      '--date', 'nope',
    ], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('client timing payload drops secrets and other hosts', async () => {
  const record = projectClientTiming({
    path: '/?token=secret-value&v=dev',
    nav: { dns: 1, connect: 2, tls: 3, ttfb: 4, download: 5, domContentLoaded: 6, load: 7 },
    resources: [
      { name: '/app.js?v=abc&token=secret-value', type: 'script', dur: 40, ttfb: 5, size: 100 },
      { name: 'https://evil.example/tracker.js', type: 'script', dur: 80, ttfb: 1, size: 1 },
    ],
  }, {
    headers: { host: '127.0.0.1', 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 'cf-ray': 'ray-1' },
  }, { salt: 'test-salt', now: Date.parse('2026-10-13T02:00:00.000Z') });
  assert.equal(record.path, '/?v=dev');
  assert.equal(record.ua, 'mobile');
  assert.equal(record.resources.length, 1);
  assert.equal(record.resources[0].name, '/app.js?v=abc');
  assert.equal(JSON.stringify(record).includes('secret-value'), false);
  assert.equal(JSON.stringify(record).includes('evil.example'), false);
  assert.equal(projectClientTiming({ nav: { dns: 1 } }, { headers: {} }), null);
  assert.equal(clientTimingAllowed({ headers: { origin: 'https://evil.example', host: 'tradingplus.cn' } }), false);
  assert.equal(clientTimingAllowed({ headers: { 'sec-fetch-site': 'cross-site', host: 'tradingplus.cn' } }), false);
  assert.equal(clientTimingAllowed({ headers: { 'sec-fetch-site': 'same-site', origin: 'https://tradingplus.cn', host: 'tradingplus.cn' } }), false);
  assert.equal(clientTimingAllowed({ headers: { origin: 'https://tradingplus.cn', host: 'tradingplus.cn' } }), true);
  assert.equal(clientTimingAllowed({
    headers: { 'sec-fetch-site': 'same-origin', origin: 'https://tradingplus.cn', host: '127.0.0.1:8787' },
  }), true);
  assert.equal(clientTimingAllowed({
    headers: { origin: 'https://tradingplus.cn', host: '127.0.0.1:8787', 'x-forwarded-host': 'tradingplus.cn' },
  }), true);
  assert.equal(clientTimingAllowed({
    headers: { origin: 'https://tradingplus.cn', host: '127.0.0.1:8787', 'cf-ray': 'abc123-SJC', 'cf-connecting-ip': '203.0.113.8' },
  }), true);
  assert.equal(clientTimingAllowed({
    headers: { origin: 'https://evil.example', host: '127.0.0.1:8787', 'cf-ray': 'abc123-SJC', 'sec-fetch-site': 'cross-site' },
  }), false);
  const limitDirectory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-client-limit-'));
  try {
    const limited = createAccessLog({ directory: limitDirectory, salt: 's', env: {} });
    for (let index = 0; index < 300; index += 1) assert.equal(limited.acceptClientSample(0, 1_000), true);
    assert.equal(limited.acceptClientSample(0, 1_000), false);
    assert.equal(limited.acceptClientSample(0, 61_000), true);
    await limited.close();
  } finally {
    rmSync(limitDirectory, { recursive: true, force: true });
  }

  const html = readFileSync(path.join(root, 'apps/web/public/index.html'), 'utf8');
  const whale = readFileSync(path.join(root, 'apps/web/public/etf-whale.html'), 'utf8');
  const source = readFileSync(path.join(root, 'apps/web/public/client-timing.js'), 'utf8');
  const whitelist = readFileSync(path.join(root, 'apps/web/src/http/static-files.js'), 'utf8');
  assert.match(html, /src="\/client-timing\.js\?v=dev"/);
  assert.match(whale, /src="\/client-timing\.js\?v=dev"/);
  assert.match(source, /\/api\/v1\/runtime\/client-timing/);
  assert.match(source, /CLIENT_TIMING_SAMPLE = 1/);
  assert.match(source, /'Content-Type': 'text\/plain'/);
  assert.match(source, /type: 'text\/plain'/);
  assert.match(source, /readyState === 'complete'/);
  assert.match(source, /event\.persisted/);
  assert.match(html, /type="module" src="\/client-timing\.js\?v=dev"/);
  assert.doesNotMatch(source, /application\/json/);
  assert.equal(/https?:\/\//.test(source), false);
  assert.match(whitelist, /\/client-timing\.js/);
  assert.doesNotMatch(html, /cloudflareinsights|data-cf-beacon/);
  assert.doesNotMatch(whale, /cloudflareinsights|data-cf-beacon/);
});

test('summary endpoint follows device login and the page can post timings', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-access-server-'));
  const app = createAiCenterServer({
    host: '127.0.0.1',
    port: 0,
    dataDirectory: directory,
    loginCredential: { username: 'owner', password: 'secret-pass' },
  });
  const address = await app.listen();
  try {
    const anonymous = await fetch(`${address.localUrl}/api/v1/runtime/access-summary`, {
      headers: { 'X-Forwarded-For': '127.0.0.1', 'CF-Connecting-IP': '203.0.113.40' },
    });
    assert.equal(anonymous.status, 401);

    const beacon = await fetch(`${address.localUrl}/client-timing.js?v=dev`);
    assert.equal(beacon.status, 200);
    assert.match(beacon.headers.get('content-type') || '', /javascript/);
    assert.match(beacon.headers.get('cache-control') || '', /immutable/);
    assert.match(await beacon.text(), /\/api\/v1\/runtime\/client-timing/);

    const css = await fetch(`${address.localUrl}/styles.css?v=dev`);
    assert.equal(css.status, 200);
    await css.arrayBuffer();
    const cssAgain = await fetch(`${address.localUrl}/styles.css?v=dev`);
    assert.equal(cssAgain.status, 200);
    await cssAgain.arrayBuffer();

    const timing = await fetch(`${address.localUrl}/api/v1/runtime/client-timing`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      },
      body: JSON.stringify({
        path: `/?token=secret-value&v=dev`,
        nav: { dns: 1, connect: 2, tls: 3, ttfb: 40, download: 5, domContentLoaded: 80, load: 90 },
        resources: [
          { name: '/app.js?v=abc&token=secret-value', type: 'script', dur: 40, ttfb: 5, size: 100 },
          { name: 'https://evil.example/tracker.js', type: 'script', dur: 80, ttfb: 1, size: 1 },
        ],
      }),
    });
    assert.equal(timing.status, 204);
    const rewritten = await fetch(`${address.localUrl}/api/v1/runtime/client-timing`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=UTF-8',
        'Sec-Fetch-Site': 'same-origin',
        Origin: 'https://tradingplus.cn',
        'CF-Connecting-IP': '203.0.113.50',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      },
      body: JSON.stringify({
        path: '/',
        nav: { dns: 2, connect: 2, tls: 2, ttfb: 55, download: 2, domContentLoaded: 70, load: 80 },
        resources: [{ name: '/app.js?v=dev', type: 'script', dur: 12, ttfb: 3, size: 20 }],
      }),
    });
    assert.equal(rewritten.status, 204);
    const foreign = await fetch(`${address.localUrl}/api/v1/runtime/client-timing`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
      },
      body: JSON.stringify({
        path: '/',
        nav: { dns: 1, connect: 1, tls: 1, ttfb: 1, download: 1, domContentLoaded: 1, load: 1 },
        resources: [],
      }),
    });
    assert.equal(foreign.status, 204);
    const invalid = await fetch(`${address.localUrl}/api/v1/runtime/client-timing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"nav":{}}',
    });
    assert.equal(invalid.status, 400);

    await app.accessLog.flush();
    const logDirectory = path.join(directory, 'logs');
    const accessFiles = readFileSync(path.join(logDirectory, `access.${new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)}.log`), 'utf8');
    assert.equal(accessFiles.includes('secret-value'), false);
    const accessLines = accessFiles.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const hits = accessLines.filter((line) => line.path === '/styles.css?v=dev');
    assert.equal(hits.length, 2);
    assert.equal(hits[0].cache.hit, false);
    assert.equal(hits[1].cache.hit, true);
    assert.match(hits[1].cache.control, /immutable/);
    const clientLines = readJsonLines(path.join(logDirectory, `client-timing.${new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)}.log`));
    assert.equal(clientLines.length, 2);
    assert.equal(clientLines[0].path, '/?v=dev');
    assert.equal(clientLines[1].nav.ttfb, 55);
    assert.equal(clientLines[1].resources[0].name, '/app.js?v=dev');
    assert.equal(clientLines[0].nav.ttfb, 40);
    assert.equal(clientLines[0].resources.length, 1);
    assert.equal(clientLines[0].resources[0].name, '/app.js?v=abc');
    assert.equal(JSON.stringify(clientLines).includes('evil.example'), false);

    const login = await fetch(`${address.localUrl}/api/v1/session/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'secret-pass', deviceName: '访问日志' }),
    });
    assert.equal(login.status, 201);
    const cookie = cookiePair(login);
    const summary = await fetch(`${address.localUrl}/api/v1/runtime/access-summary?top=5`, {
      headers: { Cookie: cookie, 'CF-Connecting-IP': '203.0.113.41' },
    });
    assert.equal(summary.status, 200);
    const payload = await summary.json();
    assert.equal(payload.ok, true);
    assert.ok(payload.paths.some((row) => row.path === '/styles.css?v=dev'));
    assert.equal(JSON.stringify(payload).includes(directory), false);
    const badDate = await fetch(`${address.localUrl}/api/v1/runtime/access-summary?date=nope`, {
      headers: { Cookie: cookie },
    });
    assert.equal(badDate.status, 400);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('access log can be switched off', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-access-off-'));
  const app = createAiCenterServer({
    host: '127.0.0.1',
    port: 0,
    dataDirectory: directory,
    env: { ...process.env, AI_CENTER_ACCESS_LOG: '0' },
  });
  const address = await app.listen();
  try {
    const health = await fetch(`${address.localUrl}/api/v1/health`);
    assert.equal(health.status, 200);
    await health.json();
    await app.accessLog.flush();
    assert.equal(app.accessLog.enabled, false);
    const names = existsSync(path.join(directory, 'logs'))
      ? readdirSync(path.join(directory, 'logs')).filter((name) => /^(access|client-timing)\./.test(name))
      : [];
    assert.deepEqual(names, []);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
