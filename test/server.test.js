import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAiCenterServer, createInstanceCookieNames } from '../apps/web/src/server.js';

test('instance cookies remain unique across ids and canonical roots', () => {
  assert.deepEqual(createInstanceCookieNames({
    instanceId: 'local', instanceRoot: 'C:/repo', legacyLayout: true,
  }), {
    cookieName: 'ai_center_device',
    secureCookieName: '__Host-ai_center_device',
  });
  const hyphen = createInstanceCookieNames({
    instanceId: 'foo-bar', instanceRoot: 'C:/instances/shared', legacyLayout: false,
  });
  const dot = createInstanceCookieNames({
    instanceId: 'foo.bar', instanceRoot: 'C:/instances/shared', legacyLayout: false,
  });
  const otherRoot = createInstanceCookieNames({
    instanceId: 'foo-bar', instanceRoot: 'D:/instances/shared', legacyLayout: false,
  });
  assert.notEqual(hyphen.cookieName, dot.cookieName);
  assert.notEqual(hyphen.cookieName, otherRoot.cookieName);
  assert.match(hyphen.cookieName, /^ai_center_device_foo_bar_[0-9a-f]{8}$/);
});

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
    const eventId = Number(eventText.match(/id: (\d+)/)?.[1]);
    assert.ok(eventId > 0);
    await streamReader.cancel();

    const replayResponse = await fetch(`${address.localUrl}/api/v1/events/stream`, {
      headers: { Cookie: cookie, 'Last-Event-ID': String(eventId - 1) },
    });
    const replayReader = replayResponse.body.getReader();
    const replayChunk = await replayReader.read();
    assert.match(decoder.decode(replayChunk.value), /event: post\.created/);
    await replayReader.cancel();

    const posts = await fetch(`${address.localUrl}/api/v1/posts`, { headers: { Cookie: cookie } })
      .then((response) => response.json());
    assert.ok(posts.posts.some((post) => post.id === created.post.id));

    const noteResponse = await fetch(`${address.localUrl}/api/v1/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        body: '从浏览器划词分享到 AI Center',
        sourceType: 'external-share',
        sourceUrl: 'https://example.com/article',
        sourceTitle: '示例文章',
        captureChannel: 'harmony-share',
        sourceApp: 'com.example.browser',
        clientMutationId: 'harmony-http-1',
        capturedAt: 1_700_000_000_000,
      }),
    });
    assert.equal(noteResponse.status, 201);
    const createdNote = await noteResponse.json();
    assert.equal(createdNote.note.captureChannel, 'harmony-share');
    assert.equal(createdNote.note.sourceUrl, 'https://example.com/article');
    const retriedNote = await fetch(`${address.localUrl}/api/v1/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ body: '重试不应重复创建', clientMutationId: 'harmony-http-1' }),
    }).then((response) => response.json());
    assert.equal(retriedNote.note.id, createdNote.note.id);

    const logoutResponse = await fetch(`${address.localUrl}/api/v1/session/logout`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(logoutResponse.status, 200);
    assert.match(logoutResponse.headers.get('set-cookie'), /Max-Age=0/);
  } finally {
    await app.close();
  }

  const reopened = createAiCenterServer({ host: '127.0.0.1', port: 0, dataDirectory: directory });
  const reopenedAddress = await reopened.listen();
  try {
    const posts = await fetch(`${reopenedAddress.localUrl}/api/v1/posts`).then((response) => response.json());
    assert.ok(posts.posts.some((post) => post.title === '连接验证'));
    const notes = await fetch(`${reopenedAddress.localUrl}/api/v1/notes`).then((response) => response.json());
    assert.ok(notes.notes.some((note) => note.captureChannel === 'harmony-share'));
  } finally {
    await reopened.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
