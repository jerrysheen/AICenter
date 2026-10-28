import { createBrowserRuntime } from './browser-runtime.js';
import {
  bskDaemonWatchEnabled,
  createBskDaemonSupervisor,
  defaultBskDaemonLockPath,
  defaultBskDaemonLogDirectory,
  startBskDaemonProcess,
} from './bsk-daemon.js';
import { createBrowserSkillClient, resolveDefaultBskPath } from './browserskill-client.js';

export { createBrowserRuntime, parseBrowserJson } from './browser-runtime.js';
export { bskCliEnv, createBrowserSkillClient, resolveDefaultBskPath } from './browserskill-client.js';
export {
  BSK_DAEMON_START_ARGS,
  bskDaemonCheckIntervalMs,
  bskDaemonWatchEnabled,
  createBskDaemonSupervisor,
  isBskDaemonDownError,
  startBskDaemonProcess,
} from './bsk-daemon.js';
export {
  BrowserCommandError,
  BrowserError,
  BrowserUnavailableError,
  isBrowserUnavailable,
} from './errors.js';

export function resolveBrowserProviderName(env = process.env) {
  const value = String(env.AI_BROWSER_PROVIDER || 'bsk').trim().toLowerCase();
  if (value === 'bsk') return value;
  throw new Error(`未知 AI_BROWSER_PROVIDER: ${value}。当前只支持 bsk`);
}

function browserLockMs(env = process.env) {
  const raw = Number(env.AI_CENTER_BROWSER_LOCK_MS);
  if (Number.isFinite(raw) && raw >= 1000) return Math.trunc(raw);
  return 15 * 60 * 1000;
}

export function createConfiguredBrowserRuntime(options = {}) {
  const env = options.env || process.env;
  const defaultBrowserId = options.defaultBrowserId ?? env.AI_CENTER_BROWSER_ID;
  const maxHoldMs = options.maxHoldMs ?? browserLockMs(env);
  if (options.runtime) return options.runtime;
  if (options.provider) return createBrowserRuntime({
    provider: options.provider,
    logger: options.logger,
    defaultBrowserId,
    maxHoldMs,
    ensureDaemon: options.ensureDaemon,
    sleep: options.sleep,
    extensionWaitMs: options.extensionWaitMs,
  });
  const providerName = options.providerName || resolveBrowserProviderName(env);
  const providers = options.providers || {
    bsk: options.bskProvider || createBrowserSkillClient({
      bskPath: options.bskPath || resolveDefaultBskPath({ env, bskPath: env.AI_BSK_PATH }),
      env: options.bskEnv,
    }),
  };
  const provider = providers[providerName];
  if (!provider) throw new Error(`BrowserRuntime 没有 ${providerName} provider`);
  const root = options.repositoryRoot;
  const supervise = options.superviseDaemon === true && bskDaemonWatchEnabled(env);
  let supervisor = null;
  const runtime = createBrowserRuntime({
    provider,
    logger: options.logger,
    defaultBrowserId,
    maxHoldMs,
    sleep: options.sleep,
    extensionWaitMs: options.extensionWaitMs,
    ensureDaemon: supervise ? ((reason) => supervisor.ensure(reason)) : options.ensureDaemon,
    daemonWatch: supervise ? ((watchOptions) => supervisor.watch(watchOptions)) : null,
  });
  if (supervise) {
    const log = options.daemonLog || ((entry) => {
      const browsers = entry.browsers == null ? '' : ` browsers=${entry.browsers}`;
      const detail = entry.detail ? ` detail=${entry.detail}` : '';
      console.log(`[worker] bsk-daemon action=${entry.action} reason=${entry.reason || '-'}${browsers}${detail}`);
    });
    supervisor = createBskDaemonSupervisor({
      env,
      log,
      lockPath: options.daemonLockPath === undefined ? defaultBskDaemonLockPath(root) : options.daemonLockPath,
      sleep: options.sleep,
      now: options.now,
      readyTimeoutMs: options.daemonReadyTimeoutMs,
      restartGapMs: options.daemonRestartGapMs,
      pollMs: options.daemonPollMs,
      async status() {
        if (typeof provider.status !== 'function') {
          const health = await provider.health?.();
          if (health?.daemonConnected) return { daemonConnected: true, browsers: health.browsers };
          return null;
        }
        return provider.status();
      },
      start: options.startDaemon || (() => startBskDaemonProcess({
        env,
        bskPath: options.bskPath || resolveDefaultBskPath({ env, bskPath: env.AI_BSK_PATH, repositoryRoot: root }),
        cwd: root,
        logDirectory: options.daemonLogDirectory || defaultBskDaemonLogDirectory(root),
        repositoryRoot: root,
      })),
    });
  }
  return runtime;
}
