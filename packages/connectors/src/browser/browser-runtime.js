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
  const requestedHold = Number(options.maxHoldMs);
  const maxHoldMs = Number.isFinite(requestedHold) && requestedHold >= 1
    ? requestedHold
    : 15 * 60 * 1000;
  // bsk sessions share one browser. A second task can navigate the page out
  // from under an in-flight fetch, so the whole callback stays exclusive.
  // A stuck callback must not pin every later browser task.
  const LOCK_RESERVE_MS = 15_000;
  const MIN_SESSION_MS = 20_000;
  let tail = Promise.resolve();
  function deadlineResult(reason) {
    return {
      source: 'browser_runtime',
      error: reason === 'browser_cold_start' ? 'browser_cold_start' : 'deadline',
      reason,
      deadline: true,
      logged_in: false,
      login_wall: false,
      tweets: [],
      items: [],
      tweet_count: 0,
    };
  }
  function exclusive(task, budget = {}) {
    const previous = tail;
    let releaseTail = () => {};
    const gate = new Promise((resolve) => { releaseTail = resolve; });
    tail = gate;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseTail();
    };
    // A waiter that gives up must not keep the next task behind it, and must
    // not let that task overlap the holder still inside previous.
    const passthrough = () => {
      if (released) return;
      released = true;
      previous.then(() => releaseTail(), () => releaseTail());
    };
    const deadlineAt = Number(budget.deadlineAt);
    const hasDeadline = Number.isFinite(deadlineAt);
    const waitLimit = hasDeadline ? deadlineAt - Date.now() - LOCK_RESERVE_MS : null;
    if (waitLimit != null && waitLimit <= 0) {
      passthrough();
      return Promise.resolve(deadlineResult('lock_wait'));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const onAbort = () => giveUp();
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        budget.signal?.removeEventListener('abort', onAbort);
      };
      const giveUp = () => {
        if (settled) return;
        settled = true;
        cleanup();
        passthrough();
        resolve(deadlineResult('lock_wait'));
      };
      if (budget.signal?.aborted) {
        giveUp();
        return;
      }
      budget.signal?.addEventListener('abort', onAbort, { once: true });
      if (waitLimit != null) timer = setTimeout(giveUp, waitLimit);
      previous.then(() => {
        if (settled) return;
        settled = true;
        cleanup();
        const remain = hasDeadline ? deadlineAt - Date.now() : Infinity;
        if (remain < MIN_SESSION_MS) {
          release();
          resolve(deadlineResult('deadline'));
          return;
        }
        const holdTimer = setTimeout(() => {
          logger.warn?.(`[browser-runtime] 浏览器会话锁超过 ${maxHoldMs}ms，已放行排队任务`);
          release();
        }, maxHoldMs);
        Promise.resolve().then(task).then(resolve, reject).finally(() => {
          clearTimeout(holdTimer);
          release();
        });
      }, (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        passthrough();
        reject(error);
      });
    });
  }

  return {
    get providerId() {
      return provider.id || 'unknown';
    },

    health() {
      return provider.health();
    },

    async withSession(sessionOptions, callback) {
      if (typeof callback !== 'function') throw new Error('withSession 需要 callback');
      const requested = { ...(sessionOptions || {}) };
      return exclusive(async () => {
        const resolvedSessionOptions = { ...requested };
        if (!String(resolvedSessionOptions.browserId || '').trim() && defaultBrowserId) {
          resolvedSessionOptions.browserId = defaultBrowserId;
        }
        let started;
        try {
          started = await provider.startSession(resolvedSessionOptions);
        } catch (error) {
          const kind = error?.kind || error?.details?.kind;
          if (kind === 'browser_cold_start' || error?.message === 'browser_cold_start') {
            return deadlineResult('browser_cold_start');
          }
          throw error;
        }
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
      }, { deadlineAt: requested.deadlineAt, signal: requested.signal });
    },
  };
}
