import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, signature);
  let i = start + signature.length;
  let paren = 1;
  for (; i < source.length; i += 1) {
    if (source[i] === '(') paren += 1;
    else if (source[i] === ')') {
      paren -= 1;
      if (paren === 0) { i += 1; break; }
    }
  }
  while (source[i] !== '{') i += 1;
  let depth = 0;
  let quote = '';
  let lineComment = false;
  let blockComment = false;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') { blockComment = false; i += 1; }
      continue;
    }
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i += 1; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i += 1; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed ${signature}`);
}

const source = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');
const apiSource = [
  extractFunction(source, 'function callerGate('),
  extractFunction(source, 'async function performApi('),
  extractFunction(source, 'function api('),
].join('\n');
const context = {
  AbortController,
  Error,
  window: { setTimeout, clearTimeout },
  fetch: async () => { throw new Error('fetch was not stubbed'); },
  requestDedupeKey: (method, path) => `${method} ${path}`,
  cacheTtlFor: () => 0,
  resolvePreparedPending: (load) => load(),
  requestLayer: { run: (_key, task) => task() },
  rememberPageResponse() {},
  linkAbortSignal: () => () => {},
};
vm.createContext(context);
vm.runInContext(`${apiSource}\nthis.api = api;`, context);

function respond(body, status = 200) {
  context.fetch = async () => new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('api() returns JSON from a 200 response', async () => {
  respond(JSON.stringify({ pipeline: 'tree-v3', ok: true }));
  assert.deepEqual(await context.api('/api/v1/reports/tree', { timeoutMs: 0 }), { pipeline: 'tree-v3', ok: true });
});

test('api() throws when a 200 response is not valid JSON', async () => {
  respond('{"pipeline":');
  await assert.rejects(
    () => context.api('/api/v1/reports/tree', { timeoutMs: 0 }),
    (error) => {
      assert.equal(error.message, '响应不完整，请稍后重试');
      assert.equal(error.status, 200);
      return true;
    },
  );
});

test('api() still reports an HTTP error when the error body is not JSON', async () => {
  respond('<html>bad gateway</html>', 502);
  await assert.rejects(
    () => context.api('/api/v1/reports/tree', { timeoutMs: 0 }),
    (error) => {
      assert.equal(error.message, '请求失败 (502)');
      assert.equal(error.status, 502);
      assert.equal(JSON.stringify(error.payload), '{}');
      return true;
    },
  );
});

test('api() keeps a JSON error message from a non-OK response', async () => {
  respond(JSON.stringify({ error: '未登录' }), 401);
  await assert.rejects(
    () => context.api('/api/v1/session', { timeoutMs: 0 }),
    (error) => {
      assert.equal(error.message, '未登录');
      assert.equal(error.status, 401);
      assert.equal(JSON.stringify(error.payload), JSON.stringify({ error: '未登录' }));
      return true;
    },
  );
});
