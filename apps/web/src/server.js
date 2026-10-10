import { createHardwareArtifactStore } from '../../../packages/connectors/src/hardware-artifacts.js';
import { legacyPriceSnapshot } from '../../../packages/connectors/src/trendforce-prices.js';
import { createHardwarePriceService } from '../../../packages/domain/src/hardware-price-service.js';
import { createContentRoutingService } from '../../../packages/domain/src/content-routing-service.js';
import { loadMediaConfig } from '../../../packages/instance/src/media-config.js';
import { loadFeedValueCalibration } from '../../../packages/instance/src/feed-value-config.js';
import { createMediaConnector } from '../../../packages/connectors/src/media/port.js';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { hostname as systemHostname, networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { parseBilibiliFeedQuery, parseMediaFeedQuery, parseTrendForceFeedQuery, parseXFeedQuery, parseXueqiuFeedQuery, ValidationError } from '../../../packages/contracts/src/index.js';
import { createAnalysisSkillCatalog, createConfiguredBrowserRuntime, createDeepSeekSearchProvider, createLauncherRestartPort, createLocalKnowledgeFiles, createPersonalAssetService, createTranslateService, createTypeSafeSystemOneClient } from '../../../packages/connectors/src/index.js';
import { createAttachmentStore, createStore } from '../../../packages/database/src/index.js';
import { createDomainServices, createFeedFilterFromEnv, createMediaIngestionService, resolveDailyConfig, resolveLoginCredential } from '../../../packages/domain/src/index.js';
import {enqueueTreePreparation} from '../../../packages/runtime/src/information-tree-module.js';
import { resolveInstanceConfig } from '../../../packages/instance/src/index.js';
import { createAgentTraceLog } from '../../../packages/runtime/src/agent-trace-log.js';
import { createWorkPackageTracePort } from '../../../packages/runtime/src/work-package-trace.js';
import { readTagCatalogFile } from '../../../packages/runtime/src/tagging-module.js';
import { createFailureStreakStore, createSourceHub, createSourceModuleRegistry, installFailureStreakStore, readStaticSignalBoard } from '../../../packages/source/src/index.js';
import { createEventStreamHub } from './http/event-stream.js';
import { publicHttpsLocation } from './http/device-auth.js';
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
      const encoded = encodeURIComponent(token);
      const base = 'HttpOnly; Path=/; Max-Age=15552000';
      const regular = `${cookieName}=${encoded}; ${base}; SameSite=${secure ? 'Lax' : 'Strict'}${secure ? '; Secure' : ''}`;
      if (!secure) return regular;
      return [
        `${secureCookieName}=${encoded}; ${base}; SameSite=Strict; Secure`,
        regular,
      ];
    },
    clear() {
      const expires = 'HttpOnly; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
      return [
        `${cookieName}=; ${expires}; SameSite=Lax`,
        `${secureCookieName}=; ${expires}; SameSite=Strict; Secure`,
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

function attachApiTiming(response, request, url, timings, eventLoopDelay, loopLog) {
  const originalWriteHead = response.writeHead;
  response.writeHead = function writeHead(statusCode, statusMessage, headers) {
    let phrase = statusMessage;
    let headerObject = headers;
    if (typeof statusMessage === 'object' && statusMessage !== null) {
      headerObject = statusMessage;
      phrase = undefined;
    }
    const now = performance.now();
    const total = now - timings.started;
    const handler = Math.max(0, now - timings.handlerStarted);
    const timing = `auth;dur=${timings.authMs.toFixed(1)}, handler;dur=${handler.toFixed(1)}, total;dur=${total.toFixed(1)}`;
    const cacheEdition = url.pathname === '/api/v1/reports/tree/edition' && statusCode === 200;
    if (headerObject && typeof headerObject === 'object' && !Array.isArray(headerObject)) {
      headerObject['Server-Timing'] = timing;
      if (cacheEdition) headerObject['Cache-Control'] = 'private, max-age=86400, immutable';
    } else {
      response.setHeader('Server-Timing', timing);
      if (cacheEdition) response.setHeader('Cache-Control', 'private, max-age=86400, immutable');
    }
    const loopP99 = eventLoopDelay.percentile(99) / 1e6;
    const stalled = loopP99 >= 200;
    if (total >= 500 || (stalled && Date.now() - loopLog.at >= 10_000)) {
      if (stalled) loopLog.at = Date.now();
      console.warn(`[web] ${request.method} ${url.pathname} total=${Math.round(total)}ms auth=${Math.round(timings.authMs)}ms loop_p99=${Math.round(loopP99)}ms`);
    }
    return phrase === undefined
      ? originalWriteHead.call(response, statusCode, headerObject)
      : originalWriteHead.call(response, statusCode, phrase, headerObject);
  };
}

function createOptionalSearchPort(explicit, env = process.env) {
  if (explicit !== undefined) return explicit;
  if (String(env.AI_CENTER_AGENT_RUNTIME || '').trim().toLowerCase() !== 'local') return null;
  if (String(env.AI_CENTER_SEARCH_DISABLED || '').trim() === '1') return null;
  try {
    return createDeepSeekSearchProvider();
  } catch (error) {
    console.error('[web] legacy search.web 未启用：', error?.message || error);
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
  installFailureStreakStore(createFailureStreakStore({
    filePath: path.join(dataDirectory, 'static-source-failure-streaks.json'),
  }));
  const store = options.store || createStore(instance.databasePath);
  const webSearchPort = createOptionalSearchPort(options.webSearchPort, options.env || process.env);
  const browserRuntime = options.browserRuntime || createConfiguredBrowserRuntime({
    env: options.env || process.env,
    defaultBrowserId: instance.browserId,
  });
  let services;
  const env = options.env || process.env;
  const typesafeClient = options.typesafeClient || createTypeSafeSystemOneClient({ env });
  const feedFilter=options.feedFilter !== undefined ? options.feedFilter
    : createFeedFilterFromEnv({client:typesafeClient,env,calibration:loadFeedValueCalibration(instance)});
  const mediaService = options.mediaService || (store.repositories?.media
    ? createMediaIngestionService({
      mediaRepository: store.repositories.media,
      mediaPort: createMediaConnector({ ...loadMediaConfig(instance.configDirectory), readSource: (...args) => sourcePort.read(...args) }),
      feedRepository: store.repositories.feed,
      feedFilter,
      taggingRepository: store.repositories.tagging,
    })
    : null);
  const hardwarePriceService = options.hardwarePriceService || createHardwarePriceService({repository:store.repositories.hardwarePrices,artifactStore:createHardwareArtifactStore({dataDirectory})});
  const contentRoutingPort = options.contentRoutingPort || createContentRoutingService({mediaService,hardwarePrices:hardwarePriceService,feedRepository:store.repositories.feed,legacyPricePort:legacyPriceSnapshot});
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
    mediaService,
    readTrendforceStored: workspaceId => mediaService.readFeed({channel:'tech',sourceKey:'trendforce',view:'all'},{workspaceId}),
    migrateTrendforce: workspaceId=>contentRoutingPort.migrate(workspaceId),
    hardwarePriceService,
  });
  const sourcePort = options.sourcePort || createSourceHub(moduleRegistry);
  const personalAssetPort = options.personalAssetService || createPersonalAssetService({
    dataDirectory,
    workbookPath: instance.assetWorkbookPath,
  });
  services = options.services || createDomainServices({
    modelUsageRates: env.AI_CENTER_MODEL_USAGE_RATES_JSON || [],
    dataDirectory,
    env,
    store,
    sourcePort,
    personalAssetPort,
    translationPort: options.translateService || createTranslateService({ env, quotaRepository: store.repositories.modelQuota, usageObserver: value => store.repositories?.modelUsage?.save({ ...value, stage: 'translation', workspaceId: 'local' }) }),
    feedFilter,
    mediaService,
    hardwarePriceService,
    contentRoutingPort,
    agentProgressPort: options.agentProgressPort || createAgentTraceLog({
      dataDirectory,
      logDirectory: instance.legacyLayout ? undefined : path.join(instance.runtimeDirectory, 'logs'),
      eventStore: store,
    }),
    fileKnowledgePort: options.fileKnowledgePort || createLocalKnowledgeFiles({
      rootDirectory: instance.knowledgeDirectory,
    }),
    tagCatalog: options.tagCatalog || readTagCatalogFile(
      existsSync(instance.tagCatalogPath) ? instance.tagCatalogPath : path.join(repositoryRoot, 'config/tags.default.json'),
    ),
    restartPort: options.restartPort || createLauncherRestartPort({
      runtimeDirectory: instance.runtimeDirectory,
    }),
    workPackageTracePort: options.workPackageTracePort || createWorkPackageTracePort({
      logDirectory: path.join(instance.runtimeDirectory, 'logs'),
      repositoryRoot,
    }),
    attachmentStore: options.attachmentStore || createAttachmentStore({
      dataDirectory,
    }),
    loginCredential: options.loginCredential !== undefined
      ? options.loginCredential
      : resolveLoginCredential(options.env || process.env),
    dailyConfig: resolveDailyConfig(env),
    informationPipeline: env.AI_CENTER_INFORMATION_PIPELINE === 'tree-v3' ? 'tree-v3' : 'legacy',
    onContentReady:env.AI_CENTER_INFORMATION_PIPELINE==='tree-v3' ? ({workspaceId,sourceIds})=>enqueueTreePreparation(store,workspaceId,sourceIds) : null,
    staticSignalPort: {
      readBoard: (input, readOptions) => readStaticSignalBoard(sourcePort, input, readOptions),
    },
    quantRoot: options.quantRoot || path.join(dataDirectory, 'quant'),
    parityDirectory: options.parityDirectory || path.join(repositoryRoot, '.ai-data', 'etf-whale-parity'),
    analysisSkillCatalog: options.analysisSkillCatalog !== undefined
      ? options.analysisSkillCatalog
      : createAnalysisSkillCatalog({ rootDirectory: path.join(repositoryRoot, 'config/analysis-skills') }),
  });
  const feedQueryParsers = options.feedQueryParsers || new Map([
    ['x', parseXFeedQuery],
    ['xueqiu', parseXueqiuFeedQuery],
    ['bilibili', parseBilibiliFeedQuery],
    ['trendforce', parseTrendForceFeedQuery],
    ['media', parseMediaFeedQuery],
  ]);
  const serveStatic = createStaticFileHandler(publicDirectory);
  const uiAssets = Object.freeze({
    getRevision: () => serveStatic.getUiRevision(),
  });
  const events = createEventStreamHub(services.runtime, {
    getUiRevision: () => serveStatic.getUiRevision(),
  });
  const router = createRouter(createApiRoutes());
  const { cookieName, secureCookieName } = createInstanceCookieNames(instance);
  const cookies = createCookieAdapter(cookieName, secureCookieName);
  const appInfo = Object.freeze({ version, serverName: systemHostname() });
  let actualPort = configuredPort;
  let eventTimer = null;
  const pairingAttempts = new Map();
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  eventLoopDelay.enable();
  const eventLoopTimer = setInterval(() => eventLoopDelay.reset(), 10_000);
  eventLoopTimer.unref?.();
  const loopLog = { at: 0 };

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
    const timings = { started: performance.now(), authMs: 0, handlerStarted: 0 };
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    try {
      const httpsLocation = publicHttpsLocation(request, url, publicBaseUrl);
      if (httpsLocation) {
        response.writeHead(308, { Location: httpsLocation, 'Cache-Control': 'no-store' });
        response.end();
        return;
      }
      if (!url.pathname.startsWith('/api/')) {
        if (await serveStatic(url.pathname, request, response)) return;
        json(response, 404, { ok: false, error: 'Not found' });
        return;
      }

      const publicRequest = isPublicRequest(request, url);
      const authStarted = performance.now();
      const identity = resolveIdentity(request, publicRequest);
      timings.authMs = performance.now() - authStarted;
      timings.handlerStarted = performance.now();
      attachApiTiming(response, request, url, timings, eventLoopDelay, loopLog);
      const handled = await router.dispatch({
        request,
        response,
        url,
        identity,
        publicRequest,
        services,
        events,
        pairing,
        cookies,
        appInfo,
        uiAssets,
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
      clearInterval(eventLoopTimer);
      eventLoopDelay.disable();
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
