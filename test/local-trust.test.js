import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createAiCenterServer } from '../apps/web/src/server.js';
import { isTrustedLocal } from '../apps/web/src/http/local-trust.js';
import { createStore } from '../packages/database/src/index.js';

function temporaryDirectory(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function rawRequest(port, { method = 'GET', path: requestPath = '/api/v1/session', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      method,
      headers,
    }, (response) => {
      response.resume();
      response.on('end', () => resolve({ status: response.statusCode }));
    });
    req.once('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('trusted local requires loopback, local host, no proxy headers and a same-origin write', () => {
  const request = (headers, method = 'GET') => ({
    method,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
  });
  assert.equal(isTrustedLocal(request({ host: '127.0.0.1:8787' }), 8787), true);
  assert.equal(isTrustedLocal(request({ host: '127.0.0.1:8787', 'cf-ray': 'abc' }), 8787), false);
  assert.equal(isTrustedLocal(request({ host: '127.0.0.1:8787', 'x-forwarded-for': '203.0.113.7' }), 8787), false);
  assert.equal(isTrustedLocal(request({ host: 'evil.example:8787' }), 8787), false);
  assert.equal(isTrustedLocal(request({
    host: '127.0.0.1:8787',
    origin: 'https://evil.example',
  }, 'POST'), 8787), false);
  assert.equal(isTrustedLocal(request({
    host: '127.0.0.1:8787',
    origin: 'http://127.0.0.1:8787',
    'sec-fetch-site': 'same-origin',
  }, 'POST'), 8787), true);
  assert.equal(isTrustedLocal({
    method: 'POST',
    headers: { host: '127.0.0.1:8787' },
    socket: { remoteAddress: '192.168.1.20' },
  }, 8787), false);
});

test('loopback trust fails closed for proxy headers, rebinding, cross-site writes and plain text', async () => {
  const directory = temporaryDirectory('ai-center-local-trust-');
  const tunnelPort = await freePort();
  const app = createAiCenterServer({
    host: '127.0.0.1',
    port: 0,
    tunnelPort,
    dataDirectory: directory,
    publicUrl: 'https://center.example.com',
  });
  const address = await app.listen();
  const base = address.localUrl;
  const port = address.port;
  try {
    const desktop = await fetch(`${base}/api/v1/session`).then(async (response) => ({
      status: response.status,
      body: await response.json(),
    }));
    assert.equal(desktop.status, 200);
    assert.equal(desktop.body.role, 'desktop');

    const cfRay = await fetch(`${base}/api/v1/session`, { headers: { 'cf-ray': 'abc' } });
    assert.equal(cfRay.status, 401);
    const forwarded = await fetch(`${base}/api/v1/session`, { headers: { 'x-forwarded-for': '203.0.113.7' } });
    assert.equal(forwarded.status, 401);
    const rebound = await rawRequest(port, { headers: { Host: `evil.example:${port}` } });
    assert.equal(rebound.status, 401);

    const crossSite = await fetch(`${base}/api/v1/runtime/healthcheck`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: '{}',
    });
    assert.equal(crossSite.status, 401);

    const scriptPlain = await fetch(`${base}/api/v1/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{"title":"x","body":"y"}',
    });
    assert.equal(scriptPlain.status, 201);
    for (const headers of [
      { 'Content-Type': 'text/plain', Origin: 'https://evil.example' },
      { 'Content-Type': 'text/plain', 'Sec-Fetch-Site': 'cross-site' },
    ]) {
      const browserPlain = await fetch(`${base}/api/v1/posts`, {
        method: 'POST',
        headers,
        body: '{"title":"x","body":"y"}',
      });
      assert.equal(browserPlain.status, 415);
    }

    const pairing = await fetch(`${base}/api/v1/pairing`).then((response) => response.json());
    const pairToken = new URL(pairing.candidates.find((item) => item.scope === 'public').webPairUrl).searchParams.get('pair');
    const publicHeaders = { Host: 'center.example.com', 'CF-Connecting-IP': '203.0.113.40' };
    const pairResponse = await fetch(`${base}/api/v1/pair`, {
      method: 'POST',
      headers: { ...publicHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: pairToken, deviceName: '安全测试手机' }),
    });
    assert.equal(pairResponse.status, 201);
    const paired = await pairResponse.json();
    const cookie = pairResponse.headers.get('set-cookie').split(';')[0];
    const deviceHeaders = { ...publicHeaders, 'Content-Type': 'application/json', Cookie: cookie };

    const stream = await fetch(`${base}/api/v1/events/stream`, { headers: { ...publicHeaders, Cookie: cookie } });
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    const ready = await reader.read();
    assert.match(decoder.decode(ready.value), /event: ready/);

    for (const [path, init] of [
      ['/api/v1/runtime/restart', { method: 'POST', body: '{}' }],
      ['/api/v1/work-packages/notify', { method: 'POST', body: '{}' }],
    ]) {
      const response = await fetch(`${base}${path}`, { ...init, headers: deviceHeaders });
      assert.equal(response.status, 403, path);
    }

    const created = await fetch(`${base}/api/v1/work-packages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: '本机才能派发' }),
    }).then((response) => response.json());
    const phoneRetry = await fetch(`${base}/api/v1/work-packages/${created.workPackage.id}/retry`, {
      method: 'POST',
      headers: deviceHeaders,
      body: '{}',
    });
    assert.equal(phoneRetry.status, 403);
    const claimed = await fetch(`${base}/api/v1/work-packages/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: created.workPackage.id, claimedBy: 'cursor-local' }),
    });
    assert.equal(claimed.status, 200);
    const completeBody = JSON.stringify({ claimedBy: 'cursor-local', resultSummary: '本机 CLI 回调', changedPaths: [] });
    const completed = await rawRequest(port, {
      method: 'POST',
      path: `/api/v1/work-packages/${created.workPackage.id}/complete`,
      headers: {
        Host: `127.0.0.1:${port}`,
        'Content-Length': Buffer.byteLength(completeBody),
      },
      body: completeBody,
    });
    assert.equal(completed.status, 200);

    const continued = await fetch(`${base}/api/v1/work-packages/${created.workPackage.id}/continue`, {
      method: 'POST',
      headers: deviceHeaders,
      body: JSON.stringify({ body: '只追加，不派发' }),
    }).then((response) => response.json());
    assert.equal(continued.ok, true);
    assert.deepEqual(continued.jobs, []);
    assert.match(continued.dispatchNote, /本机派发/);

    const revoked = await fetch(`${base}/api/v1/devices/${paired.device.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(revoked.status, 200);
    const closed = await Promise.race([
      (async () => {
        let done = false;
        while (!done) {
          const chunk = await reader.read();
          done = chunk.done;
        }
        return true;
      })(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('SSE 未断开')), 2000)),
    ]);
    assert.equal(closed, true);
    const after = await fetch(`${base}/api/v1/posts`, { headers: { ...publicHeaders, Cookie: cookie } });
    assert.equal(after.status, 401);

    const tunnelSession = await fetch(`${address.tunnelUrl}/api/v1/session`);
    assert.equal(tunnelSession.status, 401);
    const tunnelPairing = await fetch(`${address.tunnelUrl}/api/v1/pairing`);
    assert.equal(tunnelPairing.status, 403);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('migration revokes only the perf-audit probe device', () => {
  const directory = temporaryDirectory('ai-center-perf-device-');
  const dbPath = path.join(directory, 'test.db');
  const prepared = createStore(dbPath);
  prepared.close();
  const db = new Database(dbPath);
  const now = Date.now();
  db.prepare(`INSERT INTO devices (id, name, token_hash, paired_at, last_seen_at, revoked_at, workspace_id)
    VALUES (?, ?, ?, ?, ?, NULL, 'local')`).run('perf-device', 'perf-audit (box curl)', 'hash-perf', now, now);
  db.prepare(`INSERT INTO devices (id, name, token_hash, paired_at, last_seen_at, revoked_at, workspace_id)
    VALUES (?, ?, ?, ?, ?, NULL, 'local')`).run('keep-device', '主人的手机', 'hash-keep', now, now);
  db.prepare('DELETE FROM schema_migrations WHERE version = 50').run();
  db.pragma('user_version = 49');
  db.close();

  const upgraded = createStore(dbPath);
  upgraded.close();
  const check = new Database(dbPath, { readonly: true });
  const probe = check.prepare('SELECT revoked_at FROM devices WHERE id = ?').get('perf-device');
  const kept = check.prepare('SELECT revoked_at FROM devices WHERE id = ?').get('keep-device');
  const event = check.prepare(`SELECT event_name FROM outbox_events WHERE aggregate_id = ? AND event_name = 'device.revoked'`).get('perf-device');
  check.close();
  rmSync(directory, { recursive: true, force: true });
  assert.ok(probe.revoked_at);
  assert.equal(kept.revoked_at, null);
  assert.equal(event.event_name, 'device.revoked');
});
