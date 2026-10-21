import {attachDailyProcessLog} from '../../../packages/runtime/src/process-log.js';
import { createHardwareArtifactStore } from '../../../packages/connectors/src/hardware-artifacts.js';
import { legacyPriceSnapshot } from '../../../packages/connectors/src/trendforce-prices.js';
import { createHardwarePriceService } from '../../../packages/domain/src/hardware-price-service.js';
import { createContentRoutingService } from '../../../packages/domain/src/content-routing-service.js';
import { loadMediaConfig } from '../../../packages/instance/src/media-config.js';
import { loadResolvedFlashSources } from '../../../packages/domain/src/flash-sources.js';
import { loadFeedValueCalibration } from '../../../packages/instance/src/feed-value-config.js';
import { createMediaConnector } from '../../../packages/connectors/src/media/port.js';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { hostname as systemHostname, networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { parseBilibiliFeedQuery, parseMediaFeedQuery, parseTrendForceFeedQuery, parseXFeedQuery, parseXueqiuFeedQuery, ValidationError } from '../../../packages/contracts/src/index.js';
import { createAnalysisSkillCatalog, createBambooStartLuxClient, createConfiguredBrowserRuntime, createDeepSeekSearchProvider, createLauncherRestartPort, createLocalKnowledgeFiles, createPersonalAssetService, createTranslateService, createTypeSafeSystemOneClient } from '../../../packages/connectors/src/index.js';
import { createAttachmentStore, createStore } from '../../../packages/database/src/index.js';
import { createDomainServices, createFeedFilterFromEnv, createMediaIngestionService, resolveDailyConfig, resolveLoginCredential } from '../../../packages/domain/src/index.js';
import { openJevClient } from '../../../packages/domain/src/jev-enabled.js';
import { openClassificationClient, resolveClassificationProvider } from '../../../packages/domain/src/classification-provider.js';
import { isMain } from '../../../packages/runtime/src/is-main.js';
import { loadXFocusConfig } from '../../../packages/domain/src/x-focus.js';
import { createXFocusService } from '../../../packages/domain/src/x-auto-like.js';
import { createFeedTranslationChunkStore } from '../../../packages/runtime/src/feed-translation-module.js';
import {enqueueTreePreparation} from '../../../packages/runtime/src/information-tree-module.js';
import { resolveInstanceConfig } from '../../../packages/instance/src/index.js';
import { createAgentTraceLog } from '../../../packages/runtime/src/agent-trace-log.js';
import { createWorkPackageTracePort } from '../../../packages/runtime/src/work-package-trace.js';
import { readTagCatalogFile } from '../../../packages/runtime/src/tagging-module.js';
import { loadPolymarketWatchlist, polymarketLegacyEnabled } from '../../../packages/connectors/src/polymarket-watchlist.js';
import { readStoredPolymarketView } from '../../../packages/domain/src/polymarket-series.js';
import { createFailureStreakStore, createMarketBoardReader, createMarketNativeBoardReader, createSourceHub, createSourceModuleRegistry, createStaticSignalBoardReader, installFailureStreakStore } from '../../../packages/source/src/index.js';
import { HOLDINGS_MARKET_SNAPSHOT_KEY, prebuiltSnapshotSlots } from '../../../packages/runtime/src/web-snapshot-jobs.js';
import { createMemorySnapshotCache } from '../../../packages/runtime/src/snapshot-cache.js';
import { createEventLoopMonitor } from './http/event-loop-monitor.js';
import { bindEventLoopProbe, createEventLoopProbe, labelEventLoop } from './http/event-loop-blocks.js';
import { createEventStreamHub } from './http/event-stream.js';
import { isApiTokenAllowlisted, readBearerToken, requestWantsRefresh } from './http/api-token-access.js';
import { redactApiTokenText } from '../../../packages/domain/src/api-token-service.js';
import { publicHttpsLocation } from './http/device-auth.js';
import { parseCookies, json } from './http/response.js';
import { createRouter } from './http/router.js';
import { createAccessLog } from './http/access-log.js';
import { createStaticFileHandler } from './http/static-files.js';
import { createPreparedSlotStore } from './http/prepared-slots.js';
import { startSnapshotBufferLoader } from './http/snapshot-buffer-loader.js';
import { startOffthreadJson } from './http/offthread-json.js';
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
    const pendingPrepared = headerObject?.['X-Prepared-Pending'] === '1';
    const cacheEdition = url.pathname === '/api/v1/reports/tree/edition' && statusCode === 200 && !pendingPrepared;
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
      const safePath = redactApiTokenText(url.pathname);
      console.warn(`[web] ${request.method} ${safePath} total=${Math.round(total)}ms auth=${Math.round(timings.authMs)}ms loop_p99=${Math.round(loopP99)}ms`);
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
      databasePath: options.databasePath,
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
  const typesafeClient = openJevClient(env, options.typesafeClient, createTypeSafeSystemOneClient);
  const classificationClient = openClassificationClient(env, {
    typesafeClient,
    ...(options.classificationClient !== undefined ? { explicit: options.classificationClient } : {}),
    createBamboo: (opts) => createBambooStartLuxClient({ ...opts, log: (message) => console.log(message) }),
  });
  if (resolveClassificationProvider(env) === 'bamboo') {
    console.log(`[web] classification provider=bamboo model=${classificationClient?.modelId || '-'} available=${classificationClient?.available?.() ? 1 : 0}`);
  }
  let xFocusConfig = options.xFocusConfig || null;
  if (!xFocusConfig) {
    try { xFocusConfig = loadXFocusConfig(instance.configDirectory); }
    catch { xFocusConfig = null; }
  }
  const feedFilter=options.feedFilter !== undefined ? options.feedFilter
    : createFeedFilterFromEnv({client:classificationClient,env,calibration:loadFeedValueCalibration(instance),xFocusConfig,log:(message)=>console.log(message),usageDirectory:dataDirectory});
  const mediaConfig = loadMediaConfig(instance.configDirectory);
  const flashSources = options.flashSources || loadResolvedFlashSources({ configDirectory: instance.configDirectory, env, mediaSources: mediaConfig.sources });
  const mediaService = options.mediaService || (store.repositories?.media
    ? createMediaIngestionService({
      mediaRepository: store.repositories.media,
      mediaPort: createMediaConnector({ ...mediaConfig, readSource: (...args) => sourcePort.read(...args) }),
      feedRepository: store.repositories.feed,
      feedFilter,
      taggingRepository: store.repositories.tagging,
      flashSources,
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
  const staticSignalBoard = options.staticSignalBoard || createStaticSignalBoardReader({
    repository: store.repositories.runtimeSnapshots,
  });
  const holdingsQuoteCache = createMemorySnapshotCache({
    read: () => store.repositories.runtimeSnapshots.readSnapshot('local', HOLDINGS_MARKET_SNAPSHOT_KEY),
  });
  const marketBoard = options.marketBoard || createMarketBoardReader({
    repository: store.repositories.runtimeSnapshots,
    marketCatalog: options.marketCatalog,
    quotePort: {
      async fetchQuotes(symbols, { signal } = {}) {
        const snapshot = await sourcePort.read('market.quotes', { symbols }, { signal });
        return Array.isArray(snapshot?.data) ? snapshot.data : [];
      },
    },
  });
  const legacyPolymarket = polymarketLegacyEnabled(env);
  const polymarketWatchlist = options.polymarketWatchlist || loadPolymarketWatchlist(path.join(instance.configDirectory, 'polymarket-watchlist.json'));
  const marketNativeBoard = options.marketNativeBoard || createMarketNativeBoardReader({
    repository: store.repositories.runtimeSnapshots,
    polymarketQuotes: legacyPolymarket || !store.repositories?.polymarket
      ? undefined
      : () => readStoredPolymarketView(store.repositories.polymarket, Date.now(), {
        staleAfterMs: polymarketWatchlist.fetch.staleAfterMinutes * 60_000,
      }),
  });
  services = options.services || createDomainServices({
    modelUsageRates: env.AI_CENTER_MODEL_USAGE_RATES_JSON || [],
    dataDirectory,
    env,
    store,
    sourcePort,
    personalAssetPort,
    translationPort: options.translateService || createTranslateService({
      env,
      quotaRepository: store.repositories.modelQuota,
      chunkStore: createFeedTranslationChunkStore(store.repositories.feed),
      usageObserver: value => store.repositories?.modelUsage?.save({ ...value, stage: 'translation', workspaceId: 'local' }),
    }),
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
    flashSources,
    youtubeConfigPath: path.join(instance.configDirectory, 'youtube-podcasts.json'),
    holdingsQuotePort: {
      read: (readOptions) => holdingsQuoteCache.get(readOptions),
    },
    marketBoardPort: {
      read: (query, readOptions) => marketBoard.read(query, readOptions),
    },
    staticSignalPort: {
      readBoard: (input, readOptions) => staticSignalBoard.read(input, readOptions).then((result) => result.board),
    },
    quantRoot: options.quantRoot || path.join(dataDirectory, 'quant'),
    parityDirectory: options.parityDirectory || path.join(repositoryRoot, '.ai-data', 'etf-whale-parity'),
    analysisSkillCatalog: options.analysisSkillCatalog !== undefined
      ? options.analysisSkillCatalog
      : createAnalysisSkillCatalog({ rootDirectory: path.join(repositoryRoot, 'config/analysis-skills') }),
  });
  if (!options.services) services = Object.freeze({
    ...services,
    staticSignalBoard,
    marketBoard,
    marketNativeBoard,
    runtimeSnapshots: store.repositories.runtimeSnapshots,
    xFocus: (() => {
      try {
        return createXFocusService({
          config: xFocusConfig || loadXFocusConfig(instance.configDirectory),
          env,
          feedRepository: store.repositories.feed,
          runtimeRepository: store,
          snapshots: store.repositories.runtimeSnapshots,
        });
      } catch (error) {
        console.log(`[web] x-focus 配置不可用，推荐记录页暂不启用：${String(error?.message || error).slice(0, 180)}`);
        return null;
      }
    })(),
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
  const preparedSlots = createPreparedSlotStore();
  const offthread = startOffthreadJson({
    databasePath: instance.databasePath,
    pipeline: env.AI_CENTER_INFORMATION_PIPELINE === 'tree-v3' ? 'tree-v3' : 'legacy',
  });
  const router = createRouter(createApiRoutes({ slots: preparedSlots, offthread }));
  const { cookieName, secureCookieName } = createInstanceCookieNames(instance);
  const cookies = createCookieAdapter(cookieName, secureCookieName);
  const appInfo = Object.freeze({ version, serverName: systemHostname() });
  let actualPort = configuredPort;
  let eventTimer = null;
  let snapshotLoader = null;
  const pairingAttempts = new Map();
  const loopLog = { at: 0 };
  const accessLog = options.accessLog || createAccessLog({
    directory: path.join(dataDirectory, 'logs'),
    env,
  });
  const eventLoopProbe = createEventLoopProbe({
    onBlock(block) {
      accessLog.writeEventLoopBlock?.(block);
    },
  });
  bindEventLoopProbe(eventLoopProbe);
  const eventLoopMonitor = createEventLoopMonitor({
    onSample(sample) {
      accessLog.writeEventLoop?.(sample);
      const prepared = preparedSlots.stats();
      console.log(`[web] prepared-slots hit=${prepared.hit} pending=${prepared.pending} size=${prepared.size}`);
    },
  });
  const eventLoopDelay = eventLoopMonitor.histogram;
  accessLog.bindLoopDelay?.(eventLoopDelay);

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
    let requestUrl = new URL('/', 'http://localhost');
    try {
      requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    } catch {
      // 非法 URL 仍记一条访问日志。
    }
    try { accessLog.observe(request, response, requestUrl); } catch { /* 日志不能挡住请求 */ }
    const timings = { started: performance.now(), authMs: 0, handlerStarted: 0 };
    const url = requestUrl;
    let apiTokenId = '';
    let apiTokenLogged = false;
    const logApiToken = (tokenId, status) => {
      if (!tokenId || apiTokenLogged || !services.apiTokens) return;
      apiTokenLogged = true;
      try {
        services.apiTokens.recordAccess({
          tokenId,
          method: request.method,
          path: url.pathname,
          status,
          latencyMs: performance.now() - timings.started,
          touch: status !== 401,
        });
      } catch {
        console.error('[web] api token access log failed');
      }
    };
    const leaveLoop = labelEventLoop(`${request.method || 'GET'} ${url.pathname}`);
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
      let identity = resolveIdentity(request, publicRequest);
      const bearer = readBearerToken(request.headers.authorization);
      if (bearer.present && isApiTokenAllowlisted(request.method, url.pathname) && services.apiTokens) {
        const auth = services.apiTokens.authorize(bearer.token);
        if (!auth.token) {
          timings.authMs = performance.now() - authStarted;
          timings.handlerStarted = performance.now();
          attachApiTiming(response, request, url, timings, eventLoopDelay, loopLog);
          json(response, 401, { ok: false, error: '令牌无效或已撤销' });
          logApiToken(auth.matchedId, 401);
          return;
        }
        const limit = services.apiTokens.consume(auth.token.id);
        if (!limit.allowed) {
          timings.authMs = performance.now() - authStarted;
          timings.handlerStarted = performance.now();
          attachApiTiming(response, request, url, timings, eventLoopDelay, loopLog);
          json(response, 429, { ok: false, error: '请求过于频繁，请稍后重试' }, {
            'Retry-After': String(limit.retryAfterSeconds),
          });
          logApiToken(auth.token.id, 429);
          return;
        }
        if (requestWantsRefresh(url)) {
          timings.authMs = performance.now() - authStarted;
          timings.handlerStarted = performance.now();
          attachApiTiming(response, request, url, timings, eventLoopDelay, loopLog);
          json(response, 403, { ok: false, error: '只读令牌不能触发刷新' });
          logApiToken(auth.token.id, 403);
          return;
        }
        identity = {
          kind: 'api-token',
          token: { id: auth.token.id, name: auth.token.name, prefix: auth.token.prefix },
        };
        apiTokenId = auth.token.id;
      }
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
        deployStatusPath: path.join(dataDirectory, 'deploy-status.json'),
        accessLog,
        accessLogDirectory: accessLog.directory,
        authorizeDeviceCookie(request) {
          const parsed = parseCookies(request.headers?.cookie || '');
          const token = parsed[secureCookieName] || parsed[cookieName] || '';
          return services.identity.authorizeDevice(token);
        },
      });
      if (!handled) json(response, 404, { ok: false, error: 'Not found' });
      logApiToken(apiTokenId, response.statusCode || 500);
    } catch (error) {
      const code = Number(error?.statusCode);
      const status = error instanceof ValidationError ? (code >= 400 && code < 600 ? code : 400) : 500;
      if (status === 500) console.error(error);
      if (!response.headersSent) {
        json(response, status, {
          ok: false,
          error: error instanceof Error ? error.message : 'Internal server error',
          issues: error instanceof ValidationError ? error.issues : undefined,
        });
      }
      logApiToken(apiTokenId, response.statusCode || status);
    } finally {
      leaveLoop();
    }
  });

  return {
    server,
    store,
    services,
    accessLog,
    preparedSlots,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(configuredPort, host, resolve);
      });
      const address = server.address();
      actualPort = typeof address === 'object' && address ? address.port : configuredPort;
      snapshotLoader = startSnapshotBufferLoader({
        databasePath: instance.databasePath,
        slots: preparedSlots,
        keys: prebuiltSnapshotSlots(),
      });
      await Promise.all([snapshotLoader.refresh(), offthread.ready()]);
      eventTimer = setInterval(() => {
        events.flush();
      }, 250);
      eventTimer.unref?.();
      setImmediate(() => {
        try { store.repositories.feed.startFeedSearchIndex?.(); }
        catch (error) {
          console.error('[feed-search] index failed:', error instanceof Error ? error.message : error);
        }
      });
      return {
        host,
        port: actualPort,
        localUrl: `http://127.0.0.1:${actualPort}`,
        networkUrls: localNetworkUrls(actualPort),
        publicUrl: publicBaseUrl,
      };
    },
    refreshPreparedSlots() {
      return snapshotLoader?.refresh() || Promise.resolve(false);
    },
    async close() {
      if (eventTimer) clearInterval(eventTimer);
      await snapshotLoader?.stop();
      await offthread.stop();
      eventLoopMonitor.stop();
      eventLoopProbe.stop();
      events.closeAll();
      await new Promise((resolve) => server.close(resolve));
      await accessLog.close();
      store.close();
    },
  };
}

async function main() {
  attachDailyProcessLog({directory: process.env.AI_CENTER_LOG_DIR, name: process.env.AI_CENTER_LOG_NAME});
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

if (isMain(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
