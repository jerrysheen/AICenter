import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Agent } from 'undici';
import {
  closeGoogleConnectDispatchers,
  googleConnectDispatcher,
  googleConnectTimeoutMs,
  googleFetch,
  isGoogleConnectTimeout,
  withGoogleConnect,
} from '../packages/connectors/src/google-fetch.js';

test('Google connect timeout defaults to 8s and rejects values outside 1–30s', () => {
  assert.equal(googleConnectTimeoutMs({}), 8000);
  assert.equal(googleConnectTimeoutMs({ AI_CENTER_GOOGLE_CONNECT_TIMEOUT_MS: '' }), 8000);
  assert.equal(googleConnectTimeoutMs({ AI_CENTER_GOOGLE_CONNECT_TIMEOUT_MS: '5000' }), 5000);
  assert.throws(() => googleConnectTimeoutMs({ AI_CENTER_GOOGLE_CONNECT_TIMEOUT_MS: '500' }), /1000 to 30000/);
  assert.throws(() => googleConnectTimeoutMs({ AI_CENTER_GOOGLE_CONNECT_TIMEOUT_MS: '40000' }), /1000 to 30000/);
  assert.throws(() => googleConnectTimeoutMs({ AI_CENTER_GOOGLE_CONNECT_TIMEOUT_MS: 'nope' }), /1000 to 30000/);
});

test('withGoogleConnect reuses one agent and keeps the response abort signal', async () => {
  const env = { AI_CENTER_GOOGLE_CONNECT_TIMEOUT_MS: '7000' };
  const signal = new AbortController().signal;
  try {
    const first = withGoogleConnect({ method: 'POST', signal }, env);
    const second = withGoogleConnect({ method: 'POST' }, env);
    assert.ok(first.dispatcher instanceof Agent);
    assert.equal(first.dispatcher, second.dispatcher);
    assert.equal(googleConnectDispatcher(env), first.dispatcher);
    assert.equal(first.signal, signal);
    const custom = { dispatcher: { custom: true }, signal };
    assert.equal(withGoogleConnect(custom, env), custom);
    const injected = async () => {};
    assert.equal(googleFetch(injected, env), injected);
  } finally {
    await closeGoogleConnectDispatchers();
  }
});

test('googleFetch completes a real local request through its own undici fetch', async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    if (request.url === '/slow') {
      setTimeout(() => response.end('slow-body'), 1500);
      return;
    }
    response.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const env = { AI_CENTER_GOOGLE_CONNECT_TIMEOUT_MS: '1000' };
  try {
    const request = googleFetch(fetch, env);
    const quick = await request(`http://127.0.0.1:${port}/`);
    assert.equal(quick.status, 200);
    assert.equal(await quick.text(), 'ok');
    const slow = await request(`http://127.0.0.1:${port}/slow`, { signal: AbortSignal.timeout(10000) });
    assert.equal(slow.status, 200);
    assert.equal(await slow.text(), 'slow-body');
  } finally {
    await closeGoogleConnectDispatchers();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('connect timeout errors are recognized separately from response timeouts', () => {
  assert.equal(isGoogleConnectTimeout({ code: 'UND_ERR_CONNECT_TIMEOUT', name: 'ConnectTimeoutError' }), true);
  assert.equal(isGoogleConnectTimeout(new Error('Connect Timeout Error (UND_ERR_CONNECT_TIMEOUT)')), true);
  assert.equal(isGoogleConnectTimeout(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })), false);
  assert.equal(isGoogleConnectTimeout(Object.assign(new Error('aborted'), { name: 'AbortError' })), false);
});
