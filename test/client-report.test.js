import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAiCenterServer } from '../apps/web/src/server.js';
import { createClientErrorGate, formatClientErrorLine, projectClientError } from '../apps/web/src/http/access-log.js';
import { clientErrorPayload, postClientError, shouldSendClientError } from '../apps/web/public/client-report.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function cookiePair(response) {
  const lines = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : String(response.headers.get('set-cookie') || '').split(/,(?=\s*(?:__Host-)?[A-Za-z0-9_]+=)/);
  const line = lines.find((item) => item.startsWith('ai_center_device='));
  assert.ok(line, 'missing device cookie');
  return line.split(';')[0];
}

test('client error payload keeps a short path and drops a bad kind', () => {
  assert.equal(clientErrorPayload({ kind: 'home request', path: '/api/v1/home/bootstrap' }), null);
  const payload = clientErrorPayload({
    kind: 'home-request',
    path: '/api/v1/reports/reading-hour?startAt=1&endAt=2#x',
    status: 404,
    detail: '缺少这一小时\n下一行',
  });
  assert.equal(payload.path, '/api/v1/reports/reading-hour?startAt=1&endAt=2');
  assert.equal(payload.status, 404);
  assert.equal(payload.detail.includes('\n'), false);
  assert.equal(shouldSendClientError(payload, 1_000), true);
  assert.equal(shouldSendClientError(payload, 1_000 + 10_000), false);
  assert.equal(shouldSendClientError(payload, 1_000 + 60_000), true);
  const calls = [];
  assert.equal(postClientError(payload, {
    fetch(url, options) { calls.push({ url, options }); return Promise.resolve(); },
  }, 5_000_000), true);
  assert.equal(calls[0].url, '/api/v1/runtime/client-error');
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(projectClientError({ kind: 'home-fallback', path: '/api/v1/home/bootstrap', status: 0 }).kind, 'home-fallback');
  assert.equal(projectClientError({ kind: 'home-request', path: 'https://evil.example' }), null);
  assert.match(formatClientErrorLine({ kind: 'home-request', status: 404, path: '/api/v1/reports/reading-hour', detail: '缺少' }), /^\[web\] client-error kind=home-request status=404 path=\/api\/v1\/reports\/reading-hour detail=/);
  const allow = createClientErrorGate({ limit: 2, now: () => 10_000 });
  assert.equal(allow('phone'), true);
  assert.equal(allow('phone'), true);
  assert.equal(allow('phone'), false);
  assert.equal(allow('desktop'), true);
  const whitelist = readFileSync(path.join(root, 'apps/web/src/http/static-files.js'), 'utf8');
  assert.match(whitelist, /\/client-report\.js/);
});

test('paired device can post a client error and extra posts are limited', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-client-error-'));
  const lines = [];
  const original = console.log;
  console.log = (...args) => {
    lines.push(args.map(String).join(' '));
    original(...args);
  };
  const app = createAiCenterServer({
    host: '127.0.0.1',
    port: 0,
    dataDirectory: directory,
    loginCredential: { username: 'owner', password: 'secret-pass' },
  });
  const address = await app.listen();
  try {
    const remote = { 'CF-Connecting-IP': '203.0.113.77' };
    const anonymous = await fetch(`${address.localUrl}/api/v1/runtime/client-error`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...remote },
      body: JSON.stringify({ kind: 'home-request', path: '/api/v1/home/bootstrap', status: 500, detail: '失败' }),
    });
    assert.equal(anonymous.status, 401);
    const script = await fetch(`${address.localUrl}/client-report.js?v=dev`);
    assert.equal(script.status, 200);
    assert.match(await script.text(), /\/api\/v1\/runtime\/client-error/);
    const login = await fetch(`${address.localUrl}/api/v1/session/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'secret-pass', deviceName: '手机' }),
    });
    assert.equal(login.status, 201);
    const cookie = cookiePair(login);
    const posted = await fetch(`${address.localUrl}/api/v1/runtime/client-error`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, ...remote },
      body: JSON.stringify({ kind: 'home-fallback', path: '/api/v1/home/bootstrap', status: 0, detail: '改走旧路径' }),
    });
    assert.equal(posted.status, 204);
    assert.ok(lines.some((line) => line.startsWith('[web] client-error kind=home-fallback status=0 path=/api/v1/home/bootstrap')));
    const invalid = await fetch(`${address.localUrl}/api/v1/runtime/client-error`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, ...remote },
      body: JSON.stringify({ kind: 'nope space', path: '/api/v1/home/bootstrap' }),
    });
    assert.equal(invalid.status, 400);
    let limited = 0;
    for (let index = 0; index < 40; index += 1) {
      const response = await fetch(`${address.localUrl}/api/v1/runtime/client-error`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, ...remote },
        body: JSON.stringify({ kind: 'home-request', path: `/api/v1/reports/reading-hour?startAt=${index}`, status: 404, detail: '没有快照' }),
      });
      if (response.status === 429) limited += 1;
      else assert.equal(response.status, 204);
    }
    assert.ok(limited > 0);
  } finally {
    console.log = original;
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
