import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FEED_TRANSLATION_TEXT_MAX } from '../packages/contracts/src/index.js';
import { jsonBodyLimit, readJson } from '../apps/web/src/http/response.js';
import { TRANSLATE_REQUEST_MAX_BYTES } from '../apps/web/src/routes/feed-routes.js';
import { createAiCenterServer } from '../apps/web/src/server.js';

function iterableRequest(chunks, headers = {}) {
  return {
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function post(url, body, { agent, headers = {} } = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      method: 'POST',
      agent,
      headers: {
        'content-type': 'application/json',
        'content-length': String(payload.length),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
        reused: Boolean(req.reusedSocket),
      }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('readJson checks Content-Length, drains the body, then rejects with 413', async () => {
  const chunks = [Buffer.alloc(400, 0x61), Buffer.alloc(400, 0x62), Buffer.alloc(400, 0x63)];
  let pulled = 0;
  const request = {
    headers: { 'content-length': String(chunks.reduce((sum, chunk) => sum + chunk.length, 0)) },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        pulled += 1;
        yield chunk;
      }
    },
  };
  await assert.rejects(readJson(request, { maxBytes: 1024 }), (error) => {
    assert.equal(error.statusCode, 413);
    assert.equal(error.message, '请求内容过大');
    return true;
  });
  assert.equal(pulled, chunks.length);
  const streamed = iterableRequest([Buffer.alloc(700), Buffer.alloc(700)]);
  await assert.rejects(readJson(streamed, { maxBytes: 1024 }), (error) => error.statusCode === 413);
  const parsed = await readJson(iterableRequest([Buffer.from('{"ok":true}')]), { maxBytes: 1024 });
  assert.equal(parsed.ok, true);
});

test('translate accepts a body over the old 128KB cap and still drains a larger one', async () => {
  assert.equal(TRANSLATE_REQUEST_MAX_BYTES, jsonBodyLimit(FEED_TRANSLATION_TEXT_MAX));
  assert.ok(TRANSLATE_REQUEST_MAX_BYTES > 128 * 1024);
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-body-limit-'));
  const app = createAiCenterServer({
    host: '127.0.0.1',
    port: 0,
    dataDirectory: directory,
    translateService: {
      async translate(input) {
        return { sourceText: input.text, translatedText: '你好', targetLang: 'zh', engine: 'test' };
      },
    },
  });
  const address = await app.listen();
  const agent = new http.Agent({ keepAlive: true });
  try {
    const accepted = await post(`${address.localUrl}/api/v1/translate`, JSON.stringify({
      text: 'a'.repeat(150_000),
      targetLang: 'zh',
    }), { agent });
    assert.equal(accepted.status, 202, accepted.body);
    const tooLong = await post(`${address.localUrl}/api/v1/translate`, JSON.stringify({
      text: 'b'.repeat(FEED_TRANSLATION_TEXT_MAX + 1),
      targetLang: 'zh',
    }), { agent });
    assert.equal(tooLong.status, 400, tooLong.body);
    assert.match(tooLong.body, /200000/);
    const oversized = await post(`${address.localUrl}/api/v1/translate`, Buffer.alloc(TRANSLATE_REQUEST_MAX_BYTES + 64, 0x61), { agent });
    assert.equal(oversized.status, 413, oversized.body);
    assert.match(oversized.body, /请求内容过大/);
    const behavior = await post(`${address.localUrl}/api/v1/behavior`, Buffer.alloc(9000, 0x7b), { agent });
    assert.equal(behavior.status, 413, behavior.body);
    assert.equal(behavior.reused, true);
    const follow = await post(`${address.localUrl}/api/v1/behavior`, JSON.stringify({ name: 'app.open' }), { agent });
    assert.equal(follow.status, 202, follow.body);
    assert.equal(follow.reused, true);
  } finally {
    agent.destroy();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
