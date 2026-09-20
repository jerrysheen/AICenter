import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publicHttpsLocation } from '../apps/web/src/http/device-auth.js';
import { createAiCenterServer } from '../apps/web/src/server.js';

test('publicHttpsLocation only upgrades forwarded HTTP on the public host', () => {
  const url = new URL('http://center.example.com/login?next=1');
  assert.equal(publicHttpsLocation({ headers: {} }, url, 'https://center.example.com'), '');
  assert.equal(publicHttpsLocation({
    headers: { 'x-forwarded-proto': 'https' },
  }, url, 'https://center.example.com'), '');
  assert.equal(publicHttpsLocation({
    headers: { 'x-forwarded-proto': 'http' },
  }, url, 'https://center.example.com'), 'https://center.example.com/login?next=1');
  assert.equal(publicHttpsLocation({
    headers: { 'x-forwarded-proto': 'http', 'x-forwarded-host': 'center.example.com' },
  }, new URL('http://127.0.0.1:8787/login?next=1'), 'https://center.example.com'), 'https://center.example.com/login?next=1');
  assert.equal(publicHttpsLocation({
    headers: { 'x-forwarded-proto': 'http' },
  }, new URL('http://127.0.0.1:8787/'), 'https://center.example.com'), '');
});

test('public HTTP page is redirected to the configured HTTPS origin', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-https-'));
  const app = createAiCenterServer({
    host: '127.0.0.1',
    port: 0,
    dataDirectory: directory,
    publicUrl: 'https://center.example.com',
  });
  const address = await app.listen();
  try {
    const response = await fetch(`${address.localUrl}/`, {
      redirect: 'manual',
      headers: {
        Host: 'center.example.com',
        'CF-Connecting-IP': '203.0.113.30',
        'X-Forwarded-Host': 'center.example.com',
        'X-Forwarded-Proto': 'http',
      },
    });
    assert.equal(response.status, 308);
    assert.equal(response.headers.get('location'), 'https://center.example.com/');
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
