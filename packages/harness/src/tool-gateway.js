import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fromHarnessToolName } from './tool-id.js';

function randomToken() {
  return randomBytes(32).toString('hex');
}

function equalToken(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 256 * 1024) {
        reject(new Error('工具请求过大'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('工具请求不是 JSON'));
      }
    });
    request.on('error', reject);
  });
}

function send(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function bearer(request) {
  const header = String(request.headers.authorization || '');
  const match = header.match(/^Bearer\s+(\S+)/i);
  return match ? match[1] : '';
}

/**
 * Loopback-only HTTP adapter so a Harness subprocess can execute AI Center
 * Domain tools without opening SQLite in the child process.
 */
export async function createToolGateway({
  tools,
  allowedToolIds = [],
  context = {},
  token = randomToken(),
  onExecuted,
} = {}) {
  if (!tools || typeof tools.execute !== 'function') {
    throw new Error('tool gateway 需要现有 ToolRegistry');
  }
  const allow = new Set(allowedToolIds.map((item) => String(item || '').trim()).filter(Boolean));
  const contextRef = { current: context };

  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/tools/execute') {
        send(response, 404, { ok: false, error: 'not found' });
        return;
      }
      if (!equalToken(token, bearer(request))) {
        send(response, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      const payload = await readJson(request);
      const id = fromHarnessToolName(payload.id || payload.name);
      if (!allow.has(id)) {
        send(response, 403, { ok: false, error: `工具 ${id || '(empty)'} 未对 Harness 开放` });
        return;
      }
      const startedAt = Date.now();
      const runContext = contextRef.current || {};
      let result = await tools.execute(id, payload.input || {}, {
        ...runContext,
        signal: runContext.signal,
      });
      const durationMs = Date.now() - startedAt;
      const next = await onExecuted?.({
        id,
        input: payload.input || {},
        result,
        durationMs,
      });
      if (next && Object.prototype.hasOwnProperty.call(next, 'result')) result = next.result;
      send(response, 200, { ok: true, result });
    } catch (error) {
      send(response, 400, { ok: false, error: String(error?.message || error) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;

  return Object.freeze({
    url,
    token,
    setContext(next) {
      contextRef.current = next || {};
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  });
}
