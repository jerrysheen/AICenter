import { BrowserCommandError } from './errors.js';

function buildFetchExpression(url, options = {}) {
  const request = {
    credentials: 'include',
    method: options.method || 'GET',
  };
  if (options.headers && typeof options.headers === 'object') request.headers = options.headers;
  if (options.body !== undefined) request.body = options.body;
  return `(async () => {
    const response = await fetch(${JSON.stringify(url)}, ${JSON.stringify(request)});
    return {
      status: response.status,
      url: response.url,
      text: await response.text()
    };
  })()`;
}

function normalizeFetchJson(value) {
  if (value && typeof value === 'object' && 'status' in value && 'text' in value) {
    return {
      status: Number(value.status) || 0,
      url: String(value.url || ''),
      text: String(value.text || ''),
    };
  }
  if (typeof value === 'string') {
    return { status: 0, url: '', text: value };
  }
  throw new BrowserCommandError('browser fetchJson 没有返回 status/text', { kind: 'invalid_json' });
}

export function parseBrowserJson(payload) {
  const text = String(payload?.text || '').trim();
  if (!text) throw new BrowserCommandError('采集浏览器返回空响应', { kind: 'empty' });
  try {
    return JSON.parse(text);
  } catch {
    throw new BrowserCommandError('采集浏览器返回的不是 JSON', { kind: 'invalid_json' });
  }
}

function createBrowserSession(provider, started) {
  let closed = false;
  const session = {
    sessionId: started.sessionId,
    browserId: started.browserId || '',
    async navigate(url, options) {
      return provider.navigate(started.sessionId, url, options);
    },
    async evaluate(expression, options) {
      return provider.evaluate(started.sessionId, expression, options);
    },
    async click(selector, options) {
      if (typeof provider.click !== 'function') {
        throw new BrowserCommandError('browser provider 不支持 click', { kind: 'invalid_params' });
      }
      return provider.click(started.sessionId, selector, options);
    },
    async fill(selector, value, options) {
      if (typeof provider.fill !== 'function') {
        throw new BrowserCommandError('browser provider 不支持 fill', { kind: 'invalid_params' });
      }
      return provider.fill(started.sessionId, selector, value, options);
    },
    async fetchJson(url, options) {
      const value = await session.evaluate(buildFetchExpression(url, options), options);
      return normalizeFetchJson(value);
    },
    async close() {
      if (closed) return;
      closed = true;
      await provider.stopSession(started.sessionId);
    },
  };
  return session;
}

export function createBrowserRuntime(options = {}) {
  const provider = options.provider;
  if (!provider) throw new Error('BrowserRuntime 需要 provider');
  const logger = options.logger || console;
  const defaultBrowserId = String(options.defaultBrowserId || '').trim();

  return {
    get providerId() {
      return provider.id || 'unknown';
    },

    health() {
      return provider.health();
    },

    async withSession(sessionOptions, callback) {
      if (typeof callback !== 'function') throw new Error('withSession 需要 callback');
      const resolvedSessionOptions = { ...(sessionOptions || {}) };
      if (!String(resolvedSessionOptions.browserId || '').trim() && defaultBrowserId) {
        resolvedSessionOptions.browserId = defaultBrowserId;
      }
      const started = await provider.startSession(resolvedSessionOptions);
      const session = createBrowserSession(provider, started);
      try {
        return await callback(session);
      } finally {
        try {
          await session.close();
        } catch (stopError) {
          const message = stopError instanceof Error ? stopError.message : String(stopError);
          logger.warn?.(`[browser-runtime] session stop failed: ${message}`);
        }
      }
    },
  };
}
