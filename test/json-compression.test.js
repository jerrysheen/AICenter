import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { json } from '../apps/web/src/http/response.js';

function respond(payload, encoding, compress = true, headers = {}) {
  const response = { req: { headers: { 'accept-encoding': encoding } },
    writeHead(status, values) { this.status = status; this.headers = values; }, end(body) { this.body = body; } };
  json(response, 200, payload, headers, { compress });
  return response;
}
test('large media JSON negotiates gzip, preserves content and stays private', () => {
  const payload = { feed: { items: [{ body: '已保存的完整文章。'.repeat(3000) }] } };
  const raw = respond(payload, 'identity'); const compressed = respond(payload, 'br, gzip');
  assert.equal(raw.headers['Content-Encoding'], undefined);
  assert.equal(compressed.headers['Content-Encoding'], 'gzip');
  assert.equal(compressed.headers['Cache-Control'], 'no-store');
  assert.equal(compressed.headers.Vary, 'Accept-Encoding');
  assert.equal(compressed.headers['Content-Length'], compressed.body.length);
  assert.ok(compressed.body.length < raw.body.length / 5);
  assert.deepEqual(JSON.parse(gunzipSync(compressed.body)), payload);
  assert.equal(respond(payload, 'gzip;q=0, br').headers['Content-Encoding'], undefined);
  assert.equal(respond(payload, 'gzip; q=0.5').headers['Content-Encoding'], 'gzip');
  assert.equal(respond(payload, 'gzip', false).headers['Content-Encoding'], undefined);
});
test('small responses remain uncompressed and preserve cookie headers', () => {
  const response = respond({ ok: true }, 'gzip', true, { 'Set-Cookie': 'device=value' });
  assert.equal(response.headers['Content-Encoding'], undefined);
  assert.deepEqual(response.headers['Set-Cookie'], ['device=value']);
  assert.deepEqual(JSON.parse(response.body), { ok: true });
});
