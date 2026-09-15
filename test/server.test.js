import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAiCenterServer } from '../apps/web/src/server.js';

test('HTTP flow supports health, pairing, publishing, and persistence', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-server-'));
  const app = createAiCenterServer({ host: '127.0.0.1', port: 0, dataDirectory: directory });
  const address = await app.listen();
  try {
    const health = await fetch(`${address.localUrl}/api/v1/health`).then((response) => response.json());
    assert.equal(health.ok, true);

    const pairing = await fetch(`${address.localUrl}/api/v1/pairing`).then((response) => response.json());
    assert.equal(pairing.code.length, 6);

    const pairResponse = await fetch(`${address.localUrl}/api/v1/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: pairing.code, deviceName: '自动化测试手机' }),
    });
    assert.equal(pairResponse.status, 201);
    const cookie = pairResponse.headers.get('set-cookie').split(';')[0];

    const streamResponse = await fetch(`${address.localUrl}/api/v1/events/stream`, { headers: { Cookie: cookie } });
    assert.equal(streamResponse.status, 200);
    const streamReader = streamResponse.body.getReader();
    const decoder = new TextDecoder();
    const readyChunk = await streamReader.read();
    assert.match(decoder.decode(readyChunk.value), /event: ready/);

    const createResponse = await fetch(`${address.localUrl}/api/v1/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ title: '连接验证', body: '信息已经写入', tags: ['测试'] }),
    });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();
    assert.equal(created.post.title, '连接验证');

    const eventChunk = await streamReader.read();
    const eventText = decoder.decode(eventChunk.value);
    assert.match(eventText, /event: post\.created/);
    assert.match(eventText, new RegExp(created.post.id));
    await streamReader.cancel();

    const posts = await fetch(`${address.localUrl}/api/v1/posts`, { headers: { Cookie: cookie } })
      .then((response) => response.json());
    assert.ok(posts.posts.some((post) => post.id === created.post.id));
  } finally {
    await app.close();
  }

  const reopened = createAiCenterServer({ host: '127.0.0.1', port: 0, dataDirectory: directory });
  const reopenedAddress = await reopened.listen();
  try {
    const posts = await fetch(`${reopenedAddress.localUrl}/api/v1/posts`).then((response) => response.json());
    assert.ok(posts.posts.some((post) => post.title === '连接验证'));
  } finally {
    await reopened.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
