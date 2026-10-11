import { createBrowserRuntime } from './browser-runtime.js';
import { createBrowserSkillClient, resolveDefaultBskPath } from './browserskill-client.js';

export { createBrowserRuntime, parseBrowserJson } from './browser-runtime.js';
export { createBrowserSkillClient, resolveDefaultBskPath } from './browserskill-client.js';
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
  return createBrowserRuntime({ provider, logger: options.logger, defaultBrowserId, maxHoldMs });
}
