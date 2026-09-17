import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAiCenterServer } from '../apps/web/src/server.js';

test('public hostname never inherits loopback desktop privileges', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-public-'));
  const app = createAiCenterServer({
    host: '127.0.0.1',
    port: 0,
    dataDirectory: directory,
    publicUrl: 'https://center.example.com',
  });
  const address = await app.listen();
  const publicHeaders = { Host: 'center.example.com', 'CF-Connecting-IP': '203.0.113.7' };
  try {
    const pairing = await fetch(`${address.localUrl}/api/v1/pairing`).then((response) => response.json());
    const publicCandidate = pairing.candidates.find((candidate) => candidate.scope === 'public');
    assert.equal(publicCandidate.baseUrl, 'https://center.example.com');
    const pairToken = new URL(publicCandidate.webPairUrl).searchParams.get('pair');
    assert.ok(pairToken.length >= 40);

    const shortCodeResponse = await fetch(`${address.localUrl}/api/v1/pair`, {
      method: 'POST',
      headers: { ...publicHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: pairing.code, deviceName: '公网测试手机' }),
    });
    assert.equal(shortCodeResponse.status, 400);

    const pairResponse = await fetch(`${address.localUrl}/api/v1/pair`, {
      method: 'POST',
      headers: { ...publicHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: pairToken, deviceName: '公网测试手机' }),
    });
    assert.equal(pairResponse.status, 201);
    const cookie = pairResponse.headers.get('set-cookie').split(';')[0];
    assert.match(pairResponse.headers.get('set-cookie'), /__Host-ai_center_device=/);
    assert.match(pairResponse.headers.get('set-cookie'), /; Secure/);

    const unauthenticatedRuntime = await fetch(`${address.localUrl}/api/v1/runtime`, {
      headers: publicHeaders,
    });
    assert.equal(unauthenticatedRuntime.status, 401);

    const deviceRuntime = await fetch(`${address.localUrl}/api/v1/runtime`, {
      headers: { ...publicHeaders, Cookie: cookie },
    });
    assert.equal(deviceRuntime.status, 403);

    const posts = await fetch(`${address.localUrl}/api/v1/posts`, {
      headers: { ...publicHeaders, Cookie: cookie },
    });
    assert.equal(posts.status, 200);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('public pairing endpoint is rate limited', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-public-rate-'));
  const app = createAiCenterServer({
    host: '127.0.0.1', port: 0, dataDirectory: directory, publicUrl: 'https://center.example.com',
  });
  const address = await app.listen();
  try {
    let response;
    for (let attempt = 0; attempt < 11; attempt += 1) {
      response = await fetch(`${address.localUrl}/api/v1/pair`, {
        method: 'POST',
        headers: {
          Host: 'center.example.com',
          'CF-Connecting-IP': '203.0.113.8',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ code: 'invalid-public-secret', deviceName: '测试手机' }),
      });
    }
    assert.equal(response.status, 429);
    assert.ok(Number(response.headers.get('retry-after')) > 0);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
