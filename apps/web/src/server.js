import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { hostname as systemHostname, networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { parseBilibiliFeedQuery, parseXFeedQuery, ValidationError } from '../../../packages/contracts/src/index.js';
import { createConfiguredBrowserRuntime, createDoubaoConnector, createLocalKnowledgeFiles, createPersonalAssetService, createSearxngSearchProvider, createTranslateService } from '../../../packages/connectors/src/index.js';
import { createStore } from '../../../packages/database/src/index.js';
import { createDomainServices } from '../../../packages/domain/src/index.js';
import { resolveInstanceConfig } from '../../../packages/instance/src/index.js';
import { createAgentTraceLog } from '../../../packages/runtime/src/agent-trace-log.js';
import { readTagCatalogFile } from '../../../packages/runtime/src/tagging-module.js';
import { createSourceHub, createSourceModuleRegistry } from '../../../packages/source/src/index.js';
import { createEventStreamHub } from './http/event-stream.js';
import { parseCookies, json } from './http/response.js';
import { createRouter } from './http/router.js';
import { createStaticFileHandler } from './http/static-files.js';
import { createApiRoutes } from './routes/index.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(currentDirectory, '../../..');
const publicDirectory = path.resolve(currentDirectory, '../public');
resolveInstanceConfig({ repositoryRoot });
const version = '0.2.0';

function isLoopback(address = '') {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
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

function parsePublicBaseUrl(value) {
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('AI_CENTER_PUBLIC_URL 必须是没有路径、参数和账号信息的 HTTPS 地址');
  }
  return url.origin;
}

function createCookieAdapter(cookieName, secureCookieName) {
  return Object.freeze({
    authorize(token, secure = false) {
      const name = secure ? secureCookieName : cookieName;
      const secureFlag = secure ? '; Secure' : '';
      return `${name}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=15552000${secureFlag}`;
    },
    clear() {
      const expires = 'HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
      return [
        `${cookieName}=; ${expires}`,
        `${secureCookieName}=; ${expires}; Secure`,
      ];
    },
  });
}

export function createInstanceCookieNames(instance) {
  if (instance.instanceId === 'local' && instance.legacyLayout) {
    return Object.freeze({
      cookieName: 'ai_center_device',
      secureCookieName: '__Host-ai_center_device',
    });
  }
  const readableId = String(instance.instanceId || 'instance')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, 32) || 'instance';
  const normalizedRoot = path.resolve(instance.instanceRoot).replaceAll('\\', '/');
  const canonicalRoot = process.platform === 'win32' ? normalizedRoot.toLowerCase() : normalizedRoot;
  const discriminator = createHash('sha256')
    .update(`${instance.instanceId}\0${canonicalRoot}`)
    .digest('hex')
    .slice(0, 8);
  const suffix = `_${readableId}_${discriminator}`;
  return Object.freeze({
    cookieName: `ai_center_device${suffix}`,
    secureCookieName: `__Host-ai_center_device${suffix}`,
  });
}

function createOptionalSearchPort(explicit) {
  if (explicit !== undefined) return explicit;
  if (String(process.env.AI_CENTER_SEARCH_DISABLED || '').trim() === '1') return null;
  try {
    return createSearxngSearchProvider();
  } catch (error) {
    console.error('[web] search.web 未启用：', error?.message || error);
    return null;
  }
}

export function createAiCenterServer(options = {}) {
  const instance = options.instanceConfig || resolveInstanceConfig({
    repositoryRoot,
    env: options.env || process.env,
    overrides: {
      instanceRoot: options.instanceRoot,
      instanceId: options.instanceId,
      dataDirectory: options.dataDirectory,
      knowledgeDirectory: options.knowledgeDirectory,
      configDirectory: options.configDirectory,
      importsDirectory: options.importsDirectory,
      runtimeDirectory: options.runtimeDirectory,
      assetWorkbookPath: options.assetWorkbookPath,
      browserId: options.browserId,
    },
  });
  const host = options.host || process.env.AI_CENTER_HOST || '0.0.0.0';
  const configuredPort = Number(options.port ?? instance.port);
  const publicBaseUrl = parsePublicBaseUrl(options.publicUrl ?? process.env.AI_CENTER_PUBLIC_URL ?? '');
  const dataDirectory = instance.dataDirectory;
  const store = options.store || createStore(instance.databasePath);
  const webSearchPort = createOptionalSearchPort(options.webSearchPort);
  const browserRuntime = options.browserRuntime || createConfiguredBrowserRuntime({
    env: options.env || process.env,
    defaultBrowserId: instance.browserId,
  });
  const doubao = options.doubaoConnector || (browserRuntime
    ? createDoubaoConnector({ browserRuntime })
    : null);
  let services;
  const moduleRegistry = options.moduleRegistry || createSourceModuleRegistry({
    twitterService: options.twitterService,
    bilibiliService: options.bilibiliService,
    marketService: options.marketService,
    officialSources: options.officialSources,
    marketNativeSources: options.marketNativeSources,
    webSearchPort,
    browserRuntime,
    marketCatalog: options.marketCatalog,
    marketCatalogPath: instance.marketCatalogPath,
    syncFeed: (...args) => services.feed.getExternalFeed(...args),
  });
  const sourcePort = options.sourcePort || createSourceHub(moduleRegistry);
  const personalAssetPort = options.personalAssetService || createPersonalAssetService({
    dataDirectory,
    workbookPath: instance.assetWorkbookPath,
  });
  services = options.services || createDomainServices({
    store,
    sourcePort,
    personalAssetPort,
    translationPort: options.translateService || createTranslateService({
      browserRuntime,
      doubaoAskQueue: doubao?.queue,
    }),
    agentProgressPort: options.agentProgressPort || createAgentTraceLog({
      dataDirectory,
      logDirectory: instance.legacyLayout ? undefined : path.join(instance.runtimeDirectory, 'logs'),
    }),
    fileKnowledgePort: options.fileKnowledgePort || createLocalKnowledgeFiles({
      rootDirectory: instance.knowledgeDirectory,
    }),
    tagCatalog: options.tagCatalog || readTagCatalogFile(
      existsSync(instance.tagCatalogPath) ? instance.tagCatalogPath : path.join(repositoryRoot, 'config/tags.default.json'),
    ),
  });
  const feedQueryParsers = options.feedQueryParsers || new Map([
    ['x', parseXFeedQuery],
    ['bilibili', parseBilibiliFeedQuery],
  ]);
  const events = createEventStreamHub(services.runtime);
  const router = createRouter(createApiRoutes());
  const serveStatic = createStaticFileHandler(publicDirectory);
  const { cookieName, secureCookieName } = createInstanceCookieNames(instance);
  const cookies = createCookieAdapter(cookieName, secureCookieName);
  const appInfo = Object.freeze({ version, serverName: systemHostname() });
  let actualPort = configuredPort;
  let eventTimer = null;
  const pairingAttempts = new Map();

  function isPublicRequest(request, url) {
    const forwarded = Boolean(request.headers['cf-connecting-ip'] || request.headers['cf-ray']);
    const publicHost = publicBaseUrl && url.host.toLowerCase() === new URL(publicBaseUrl).host.toLowerCase();
    return Boolean(forwarded || publicHost);
  }

  function resolveIdentity(request, publicRequest) {
    if (isLoopback(request.socket.remoteAddress) && !publicRequest) return { kind: 'desktop', device: null };
    const parsed = parseCookies(request.headers.cookie || '');
    const token = parsed[secureCookieName] || parsed[cookieName];
    const device = services.identity.authorizeDevice(token);
    return device ? { kind: 'device', device } : null;
  }

  const pairing = Object.freeze({
    ttlMinutes: Math.max(1, Math.min(Number(
      publicBaseUrl
        ? process.env.AI_CENTER_PUBLIC_PAIRING_TTL_MINUTES || 2
        : process.env.AI_CENTER_PAIRING_TTL_MINUTES || 10,
    ), 60)),
    async candidates(pairingCode) {
      const entries = [];
      if (publicBaseUrl) entries.push({ baseUrl: publicBaseUrl, credential: pairingCode.pairToken, scope: 'public' });
      for (const baseUrl of localNetworkUrls(actualPort)) {
        if (!entries.some((entry) => entry.baseUrl === baseUrl)) {
          entries.push({ baseUrl, credential: pairingCode.code, scope: 'lan' });
        }
      }
      return Promise.all(entries.map(async ({ baseUrl, credential, scope }) => {
        const webPairUrl = `${baseUrl}/?pair=${encodeURIComponent(credential)}`;
        const appPairUrl = `aicenter://pair?server=${encodeURIComponent(baseUrl)}&code=${encodeURIComponent(credential)}`;
        return {
          baseUrl,
          scope,
          pairUrl: webPairUrl,
          webPairUrl,
          appPairUrl,
          qrDataUrl: await QRCode.toDataURL(webPairUrl, { width: 320, margin: 2 }),
          appQrDataUrl: await QRCode.toDataURL(appPairUrl, { width: 320, margin: 2 }),
        };
      }));
    },
    allowAttempt(request, publicRequest) {
      if (!publicRequest && isLoopback(request.socket.remoteAddress)) return { allowed: true, retryAfterSeconds: 0 };
      const now = Date.now();
      const windowMs = 5 * 60_000;
      const key = String(request.headers['cf-connecting-ip'] || request.socket.remoteAddress || 'unknown');
      const current = pairingAttempts.get(key);
      const state = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current;
      state.count += 1;
      pairingAttempts.set(key, state);
      if (pairingAttempts.size > 1_000) {
        for (const [entryKey, entry] of pairingAttempts) {
          if (entry.resetAt <= now) pairingAttempts.delete(entryKey);
        }
      }
      return {
        allowed: state.count <= 10,
        retryAfterSeconds: Math.max(1, Math.ceil((state.resetAt - now) / 1_000)),
      };
    },
  });

  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (await serveStatic(url.pathname, request, response)) return;
        json(response, 404, { ok: false, error: 'Not found' });
        return;
      }

      const publicRequest = isPublicRequest(request, url);
      const handled = await router.dispatch({
        request,
        response,
        url,
        identity: resolveIdentity(request, publicRequest),
        publicRequest,
        services,
        events,
        pairing,
        cookies,
        appInfo,
        feedQueryParsers,
      });
      if (!handled) json(response, 404, { ok: false, error: 'Not found' });
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
    services,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(configuredPort, host, resolve);
      });
      const address = server.address();
      actualPort = typeof address === 'object' && address ? address.port : configuredPort;
      eventTimer = setInterval(events.flush, 250);
      eventTimer.unref?.();
      return {
        host,
        port: actualPort,
        localUrl: `http://127.0.0.1:${actualPort}`,
        networkUrls: localNetworkUrls(actualPort),
        publicUrl: publicBaseUrl,
      };
    },
    async close() {
      if (eventTimer) clearInterval(eventTimer);
      events.closeAll();
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
