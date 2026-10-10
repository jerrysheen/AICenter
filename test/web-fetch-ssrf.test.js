import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { HttpFetchProvider } from '@deepseek-ai/dsh-web-fetch-http';

const limits = {
  maxResponseBytes: 1024,
  maxBodyChars: 1024,
  timeoutMs: 2000,
  maxRedirects: 2,
  userAgent: 'ai-center-ssrf-test',
};

function blocked(error) {
  return error?.code === 'WEB_BLOCKED_URL'
    || /non-public|WEB_BLOCKED_URL/i.test(`${error?.message || ''} ${error?.code || ''}`);
}

async function assertBlocked(url) {
  const provider = new HttpFetchProvider(limits);
  await assert.rejects(
    () => provider.fetch({ url }, AbortSignal.timeout(2000)),
    (error) => blocked(error),
    url,
  );
}

test('harness web_fetch rejects loopback, private and link-local destinations', async () => {
  for (const url of [
    'http://127.0.0.1/',
    'http://127.0.0.2/',
    'http://10.1.2.3/',
    'http://192.168.1.1/',
    'http://172.16.0.1/',
    'http://169.254.169.254/',
    'http://0.0.0.0/',
    'http://100.64.0.1/',
    'http://[::1]/',
    'http://[fc00::1]/',
    'http://[fe80::1]/',
    'http://localhost/',
  ]) {
    await assertBlocked(url);
  }
});

test('harness web_fetch does not connect to a loopback redirector', async () => {
  let hits = 0;
  const server = createServer((request, response) => {
    hits += 1;
    response.writeHead(302, { Location: `http://127.0.0.1${request.url}` });
    response.end('secret');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await assertBlocked(`http://127.0.0.1:${port}/pairing`);
    assert.equal(hits, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
