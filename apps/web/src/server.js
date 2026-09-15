import { createServer } from 'node:http';
import { networkInterfaces, hostname as systemHostname } from 'node:os';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { parseBehaviorEvent, parseMarketQuery, parseMarketSearchQuery, parseNoteInput, parsePairInput, parsePostInput, ValidationError } from '../../../packages/contracts/src/index.js';
import { createMarketService } from '../../../packages/connectors/src/index.js';
import { createStore } from '../../../packages/database/src/index.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(currentDirectory, '../../..');
const publicDirectory = path.resolve(currentDirectory, '../public');
const cookieName = 'ai_center_device';
const version = '0.2.0';

function isLoopback(address = '') {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => {
    const separator = part.indexOf('=');
    if (separator < 0) return ['', ''];
    return [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())];
  }).filter(([key]) => key));
}

function json(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 128 * 1024) throw new ValidationError('请求内容过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ValidationError('请求不是有效 JSON');
  }
}

function localNetworkUrls(port) {
  const urls = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal || entry.address.startsWith('169.254.')) continue;
      urls.push(`http://${entry.address}:${port}`);
    }
  }
  return [...new Set(urls)];
}

function securityHeaders(contentType) {
  const isDocument = contentType.startsWith('text/html') || contentType.includes('javascript');
  return {
    'Content-Type': contentType,
    'Cache-Control': isDocument ? 'no-store' : 'public, max-age=300',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

async function serveStatic(pathname, response) {
  const files = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/mock.js': ['mock.js', 'text/javascript; charset=utf-8'],
    '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  };
  const target = files[pathname];
  if (!target) return false;
  const body = await readFile(path.join(publicDirectory, target[0]));
  response.writeHead(200, { ...securityHeaders(target[1]), 'Content-Length': body.length });
  response.end(body);
  return true;
}

export function createAiCenterServer(options = {}) {
  const host = options.host || process.env.AI_CENTER_HOST || '0.0.0.0';
  const configuredPort = Number(options.port ?? process.env.AI_CENTER_PORT ?? 8787);
  const dataDirectory = path.resolve(options.dataDirectory || process.env.AI_CENTER_DATA_DIR || path.join(repositoryRoot, 'data'));
  const store = options.store || createStore(path.join(dataDirectory, 'ai-center.db'));
  const marketService = options.marketService || createMarketService();
  const clients = new Set();
  let actualPort = configuredPort;
  let eventCursor = store.latestEventId();
  let eventTimer = null;
  let flushingEvents = false;

  function identity(request) {
    if (isLoopback(request.socket.remoteAddress)) return { kind: 'desktop', device: null };
    const token = parseCookies(request.headers.cookie || '')[cookieName];
    const device = store.authorizeToken(token);
    return device ? { kind: 'device', device } : null;
  }

  function eventFrame(event) {
    return `id: ${event.id}\nevent: ${event.name}\ndata: ${JSON.stringify(event.payload)}\n\n`;
  }

  function broadcast(event) {
    const frame = eventFrame(event);
    for (const client of clients) {
      if (client.workspaceId === event.workspaceId) client.response.write(frame);
    }
  }

  function flushEvents() {
    if (flushingEvents) return;
    flushingEvents = true;
    try {
      while (true) {
        const events = store.listEvents(eventCursor, 200);
        if (!events.length) break;
        for (const event of events) {
          eventCursor = event.id;
          broadcast(event);
        }
        if (events.length < 200) break;
      }
    } finally {
      flushingEvents = false;
    }
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (await serveStatic(url.pathname, response)) return;
        json(response, 404, { ok: false, error: 'Not found' });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/v1/health') {
        json(response, 200, { ok: true, service: 'ai-center', version, serverName: systemHostname(), now: Date.now() });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/pair') {
        const input = parsePairInput(await readJson(request));
        const result = store.redeemPairingCode(input.code, input.deviceName);
        if (!result) {
          json(response, 400, { ok: false, error: '配对码无效、已使用或已过期' });
          return;
        }
        store.recordBehavior('device.paired', result.device.id, { source: 'pairing' });
        flushEvents();
        json(response, 201, { ok: true, device: result.device }, {
          'Set-Cookie': `${cookieName}=${encodeURIComponent(result.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=315360000`,
        });
        return;
      }

      const currentIdentity = identity(request);

      if (request.method === 'GET' && url.pathname === '/api/v1/session') {
        if (!currentIdentity) {
          json(response, 401, { ok: false, paired: false, error: '此设备尚未配对' });
          return;
        }
        json(response, 200, {
          ok: true,
          paired: true,
          role: currentIdentity.kind,
          device: currentIdentity.device,
          serverName: systemHostname(),
          version,
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/v1/pairing') {
        if (currentIdentity?.kind !== 'desktop') {
          json(response, 403, { ok: false, error: '只能在本机生成配对二维码' });
          return;
        }
        const ttlMinutes = Math.max(1, Math.min(Number(process.env.AI_CENTER_PAIRING_TTL_MINUTES || 10), 60));
        const pairing = store.createPairingCode(ttlMinutes);
        const candidates = await Promise.all(localNetworkUrls(actualPort).map(async (baseUrl) => {
          const webPairUrl = `${baseUrl}/?pair=${encodeURIComponent(pairing.code)}`;
          const appPairUrl = `aicenter://pair?server=${encodeURIComponent(baseUrl)}&code=${encodeURIComponent(pairing.code)}`;
          return {
            baseUrl,
            pairUrl: webPairUrl,
            webPairUrl,
            appPairUrl,
            qrDataUrl: await QRCode.toDataURL(webPairUrl, { width: 320, margin: 2 }),
            appQrDataUrl: await QRCode.toDataURL(appPairUrl, { width: 320, margin: 2 }),
          };
        }));
        json(response, 200, { ok: true, ...pairing, candidates });
        return;
      }

      if (!currentIdentity) {
        json(response, 401, { ok: false, error: '此设备尚未配对' });
        return;
      }

      const deviceId = currentIdentity.device?.id || null;

      if (request.method === 'GET' && url.pathname === '/api/v1/runtime') {
        if (currentIdentity.kind !== 'desktop') {
          json(response, 403, { ok: false, error: '运行状态仅在本机显示' });
          return;
        }
        json(response, 200, { ok: true, runtime: store.getRuntimeStatus() });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/runtime/healthcheck') {
        if (currentIdentity.kind !== 'desktop') {
          json(response, 403, { ok: false, error: '运行检查仅允许在本机发起' });
          return;
        }
        const job = store.createJob({ type: 'system.healthcheck', input: { requestedAt: Date.now() }, maxAttempts: 1 });
        flushEvents();
        json(response, 202, { ok: true, job });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/v1/runtime/jobs') {
        if (currentIdentity.kind !== 'desktop') {
          json(response, 403, { ok: false, error: '任务状态仅在本机显示' });
          return;
        }
        json(response, 200, { ok: true, jobs: store.listJobs(Number(url.searchParams.get('limit') || 50)) });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/v1/posts') {
        const posts = store.listPosts(Number(url.searchParams.get('limit') || 100));
        json(response, 200, { ok: true, posts });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/posts') {
        const post = store.createPost(parsePostInput(await readJson(request)), deviceId);
        store.recordBehavior('post.created', deviceId, { postId: post.id });
        flushEvents();
        json(response, 201, { ok: true, post });
        return;
      }

      const postMatch = url.pathname.match(/^\/api\/v1\/posts\/([0-9a-f-]+)$/i);
      if (request.method === 'GET' && postMatch) {
        const post = store.getPost(postMatch[1]);
        if (!post) json(response, 404, { ok: false, error: '信息不存在' });
        else json(response, 200, { ok: true, post });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/v1/notes') {
        json(response, 200, { ok: true, notes: store.listNotes(url.searchParams.get('status') || 'inbox') });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/notes') {
        const note = store.createNote(parseNoteInput(await readJson(request)));
        flushEvents();
        json(response, 201, { ok: true, note });
        return;
      }

      const archiveMatch = url.pathname.match(/^\/api\/v1\/notes\/([0-9a-f-]+)\/archive$/i);
      if (request.method === 'POST' && archiveMatch) {
        const note = store.archiveNote(archiveMatch[1]);
        flushEvents();
        if (!note) json(response, 404, { ok: false, error: '灵感不存在' });
        else json(response, 200, { ok: true, note });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/v1/knowledge') {
        json(response, 200, { ok: true, items: store.listKnowledge() });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/v1/markets') {
        const query = parseMarketQuery(Object.fromEntries(url.searchParams.entries()));
        try {
          const market = await marketService.getBoard(query);
          json(response, 200, { ok: true, market });
        } catch (error) {
          json(response, 502, { ok: false, error: error instanceof Error ? error.message : '行情加载失败' });
        }
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/v1/markets/search') {
        const q = parseMarketSearchQuery(url.searchParams.get('q') || '');
        try {
          json(response, 200, { ok: true, items: q ? await marketService.search(q) : [] });
        } catch (error) {
          json(response, 502, { ok: false, error: error instanceof Error ? error.message : '标的搜索失败' });
        }
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/behavior') {
        const event = parseBehaviorEvent(await readJson(request));
        store.recordBehavior(event.name, deviceId, event.metadata);
        json(response, 202, { ok: true });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/v1/events/stream') {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        const requestedLastId = Number(request.headers['last-event-id'] || url.searchParams.get('lastEventId') || 0);
        if (Number.isSafeInteger(requestedLastId) && requestedLastId > 0) {
          const workspaceId = currentIdentity.device?.workspaceId || 'local';
          for (const event of store.listEvents(requestedLastId, 1_000, workspaceId)) response.write(eventFrame(event));
        }
        response.write(`event: ready\ndata: ${JSON.stringify({ now: Date.now(), latestEventId: store.latestEventId() })}\n\n`);
        const client = {
          response,
          workspaceId: currentIdentity.device?.workspaceId || 'local',
          deviceId: currentIdentity.device?.id || null,
        };
        clients.add(client);
        const heartbeat = setInterval(() => response.write(`: heartbeat ${Date.now()}\n\n`), 20_000);
        request.on('close', () => {
          clearInterval(heartbeat);
          clients.delete(client);
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/v1/metrics') {
        if (currentIdentity.kind !== 'desktop') {
          json(response, 403, { ok: false, error: '验证指标仅在本机显示' });
          return;
        }
        json(response, 200, { ok: true, metrics: store.getMetrics() });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/v1/devices') {
        if (currentIdentity.kind !== 'desktop') {
          json(response, 403, { ok: false, error: '设备管理仅在本机开放' });
          return;
        }
        json(response, 200, { ok: true, devices: store.listDevices() });
        return;
      }

      const deviceMatch = url.pathname.match(/^\/api\/v1\/devices\/([0-9a-f-]+)$/i);
      if (request.method === 'DELETE' && deviceMatch) {
        if (currentIdentity.kind !== 'desktop') {
          json(response, 403, { ok: false, error: '设备管理仅在本机开放' });
          return;
        }
        const revoked = store.revokeDevice(deviceMatch[1]);
        flushEvents();
        if (revoked) {
          for (const client of clients) {
            if (client.deviceId === deviceMatch[1]) {
              client.response.end();
              clients.delete(client);
            }
          }
        }
        json(response, revoked ? 200 : 404, { ok: revoked });
        return;
      }

      json(response, 404, { ok: false, error: 'Not found' });
    } catch (error) {
      const status = error instanceof ValidationError ? 400 : 500;
      if (status === 500) console.error(error);
      json(response, status, {
        ok: false,
        error: error instanceof Error ? error.message : 'Internal server error',
        issues: error instanceof ValidationError ? error.issues : undefined,
      });
    }
  });

  return {
    server,
    store,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(configuredPort, host, resolve);
      });
      const address = server.address();
      actualPort = typeof address === 'object' && address ? address.port : configuredPort;
      eventTimer = setInterval(flushEvents, 250);
      eventTimer.unref?.();
      return { host, port: actualPort, localUrl: `http://127.0.0.1:${actualPort}`, networkUrls: localNetworkUrls(actualPort) };
    },
    async close() {
      if (eventTimer) clearInterval(eventTimer);
      for (const client of clients) client.response.end();
      await new Promise((resolve) => server.close(resolve));
      store.close();
    },
  };
}

async function main() {
  const app = createAiCenterServer();
  const address = await app.listen();
  console.log(`AI Center ${version}`);
  console.log(`Desktop: ${address.localUrl}`);
  for (const url of address.networkUrls) console.log(`Phone:   ${url}`);
  if (!address.networkUrls.length) console.log('Phone:   未发现局域网 IPv4 地址，请检查网络连接。');

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
