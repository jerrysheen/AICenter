import test from 'node:test';
import assert from 'node:assert/strict';
import { createTypeSafeSystemOneClient, resolveTypeSafeApiKey } from '../packages/connectors/src/typesafe-system-one.js';

test('TypeSafe client is unavailable without a key and does not call fetch', async () => {
  const calls = [];
  const client = createTypeSafeSystemOneClient({
    apiKey: '',
    env: {},
    fetch: async (...args) => {
      calls.push(args);
      return new Response('{}', { status: 200 });
    },
  });
  assert.equal(client.available(), false);
  assert.equal(resolveTypeSafeApiKey({ apiKey: '' }, {}), '');
  await assert.rejects(() => client.evaluate({
    state: 'hello',
    questions: { urgent: { type: 'noul', instructions: 'urgent?' } },
  }), /未配置/);
  assert.equal(calls.length, 0);
});

test('TypeSafe client posts System One questions and returns answers', async () => {
  const calls = [];
  const client = createTypeSafeSystemOneClient({
    apiKey: 'test-key',
    apiRoot: 'https://api.typesafe.ai/v1',
    model: 'jev-latest',
    env: {},
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        model: 'jev-latest',
        answers: { urgent: { type: 'noul', noul: 0.91 } },
        usage: { input_tokens: 12, output_tokens: 3 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  const result = await client.evaluate({
    state: { user_question: '帮我看持仓' },
    questions: { urgent: { type: 'noul', instructions: 'Is this urgent?' } },
  });
  assert.equal(calls[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'jev-latest');
  assert.deepEqual(body.state, { user_question: '帮我看持仓' });
  assert.equal(result.answers.urgent.noul, 0.91);
  assert.equal(result.usage.input_tokens, 12);
});

test('TypeSafe HTTP and timeout errors stay local and do not retry forever', async () => {
  const client = createTypeSafeSystemOneClient({
    apiKey: 'test-key',
    env: {},
    fetch: async () => new Response(JSON.stringify({ message: 'nope' }), { status: 401 }),
  });
  await assert.rejects(() => client.evaluate({
    state: 'x',
    questions: { a: { type: 'noul', instructions: 'yes?' } },
  }), /401/);

  let waited = false;
  const slow = createTypeSafeSystemOneClient({
    apiKey: 'test-key',
    timeoutMs: 20,
    env: {},
    fetch: async (_url, init) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 500);
        init.signal.addEventListener('abort', () => {
          waited = true;
          clearTimeout(timer);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
      return new Response('{}', { status: 200 });
    },
  });
  await assert.rejects(() => slow.evaluate({
    state: 'x',
    questions: { a: { type: 'noul', instructions: 'yes?' } },
  }), /超时/);
  assert.equal(waited, true);
});
