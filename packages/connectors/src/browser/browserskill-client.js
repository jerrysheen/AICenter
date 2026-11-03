import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserCommandError, BrowserUnavailableError } from './errors.js';
const UNAVAILABLE_CODES = new Set(['no_browser_connected', 'daemon_unavailable']);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export function resolveDefaultBskPath(options = {}) {
  const env = options.env || process.env;
  const configured = String(options.bskPath || env.AI_BSK_PATH || '').trim();
  if (configured) return configured;
  const exists = options.existsSync || existsSync;
  const root = options.repositoryRoot || repositoryRoot;
  const bundled = [
    path.join(root, 'externaltools', 'bsk.exe'),
    path.join(root, 'externaltools', 'bsk'),
  ];
  for (const candidate of bundled) {
    if (exists(candidate)) return candidate;
  }
  return 'bsk';
}

function resolveBskPath(options = {}) {
  const resolved = resolveDefaultBskPath(options);
  if (!resolved) throw new BrowserCommandError('bsk executable path is empty');
  return resolved;
}

// Business CLI calls must not spawn a daemon. Explicit `daemon start` lives in
// bsk-daemon.js. options.env cannot turn this back on.
export function bskCliEnv(options = {}) {
  return {
    ...process.env,
    ...(options.env || {}),
    BSK_AUTO_START: '0',
  };
}

function previewText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function parseJsonOutput(text, fallbackText = '') {
  const candidates = [text, fallbackText]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      const start = candidate.indexOf('{');
      const end = candidate.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(candidate.slice(start, end + 1));
        } catch {
          // Try the next candidate.
        }
      }
      const arrayStart = candidate.indexOf('[');
      const arrayEnd = candidate.lastIndexOf(']');
      if (arrayStart >= 0 && arrayEnd > arrayStart) {
        try {
          return JSON.parse(candidate.slice(arrayStart, arrayEnd + 1));
        } catch {
          // Try the next candidate.
        }
      }
    }
  }
  const preview = previewText(text) || previewText(fallbackText) || '(empty)';
  throw new BrowserCommandError(`bsk 没有返回合法 JSON：${preview}`, { kind: 'invalid_json' });
}

function isArgumentTooLong(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  return code === 'ENAMETOOLONG' || /filename or extension is too long|argument list too long/i.test(message);
}

function normalizeFailure(error, parsed) {
  const code = String(parsed?.code || error?.details?.code || '').trim();
  const message = String(parsed?.message || error?.message || 'bsk command failed').trim();
  const details = {
    kind: parsed ? 'exit' : (error?.details?.kind || 'exit'),
    code: code || undefined,
  };
  if (UNAVAILABLE_CODES.has(code) || /daemon|no browser|not connected/i.test(message)) {
    return new BrowserUnavailableError(message, { ...details, code: code || 'daemon_unavailable' });
  }
  return new BrowserCommandError(message, details);
}

function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.kill();
}

// execFile only settles on the process `close` event. A killed bsk process can
// leave that event pending, which pins the worker on one navigate forever.
function abortError() {
  return Object.assign(new Error('bsk aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
}

export function runBrowserProcess(file, args, options = {}) {
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || 60_000);
  const maxBuffer = Math.max(1, Number(options.maxBuffer) || 8 * 1024 * 1024);
  const signal = options.signal;
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: bskCliEnv(options),
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      finish(Object.assign(new Error(`bsk timed out after ${timeoutMs}ms`), {
        killed: true,
        signal: 'SIGTERM',
        stdout,
        stderr,
      }));
    }, timeoutMs);

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) {
        stopChild(child);
        reject(error);
        return;
      }
      resolve(result);
    }

    function onAbort() {
      finish(abortError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (error) => finish(error));
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > maxBuffer) {
        finish(Object.assign(new Error('bsk stdout exceeded maxBuffer'), { stdout, stderr }));
      }
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > maxBuffer) {
        finish(Object.assign(new Error('bsk stderr exceeded maxBuffer'), { stdout, stderr }));
      }
    });
    child.on('close', (code) => {
      finish(null, { code: code ?? 1, stdout, stderr });
    });
  });
}

async function defaultRunCommand(bskPath, args, options) {
  try {
    const result = await runBrowserProcess(bskPath, args, options);
    return {
      code: result.code,
      stdout: String(result.stdout || ''),
      stderr: String(result.stderr || ''),
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new BrowserUnavailableError('未找到 bsk CLI。请安装 BrowserSkill 并把 bsk 放到 PATH，或设置 AI_BSK_PATH。', {
        kind: 'spawn',
        code: 'daemon_unavailable',
      });
    }
    if (isArgumentTooLong(error)) {
      throw new BrowserCommandError('发给 bsk 的脚本太长，已超过 Windows 命令行限制', { kind: 'argument_too_long' });
    }
    if (error.name === 'AbortError' || error.code === 'ABORT_ERR') throw error;
    if (error.killed || error.signal === 'SIGTERM') {
      throw new BrowserCommandError(`bsk timed out after ${options.timeoutMs}ms`, { kind: 'timeout' });
    }
    return {
      code: Number.isInteger(error.code) ? error.code : 1,
      stdout: String(error.stdout || ''),
      stderr: String(error.stderr || error.message || ''),
    };
  }
}

export function createBrowserSkillClient(options = {}) {
  const bskPath = resolveBskPath(options);
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs) || 60_000);
  const maxBuffer = Math.max(1_024, Number(options.maxOutputBytes) || 8 * 1024 * 1024);
  const runCommand = options.runCommand || ((args, commandOptions) => defaultRunCommand(bskPath, args, commandOptions));

  async function run(args, commandOptions = {}) {
    const result = await runCommand(['--json', ...args], {
      timeoutMs: commandOptions.timeoutMs || timeoutMs,
      maxBuffer,
      env: options.env,
      signal: commandOptions.signal,
    });
    const parsed = (() => {
      try {
        return parseJsonOutput(result.stdout, result.stderr);
      } catch (error) {
        if (result.code !== 0) {
          throw normalizeFailure(error, null);
        }
        throw error;
      }
    })();
    if (result.code !== 0) {
      throw normalizeFailure(null, parsed);
    }
    return parsed;
  }

  async function status() {
    return run(['status'], { timeoutMs: Math.min(timeoutMs, 15_000) });
  }

  function refusalKind(error) {
    const message = String(error?.message || '');
    if (/observed content changed|observed page or control state changed|media source changed/i.test(message)) return 'moving';
    if (/context returned by the latest cooperate sync|cooperation_sync_required|synchronize and replan/i.test(message)) return 'context';
    return '';
  }

  function selectorMissing(error) {
    const message = String(error?.message || '');
    const code = String(error?.details?.code || '');
    return code === 'selector_not_found'
      || code === 'selector_missing'
      || /selector did not match|selector_not_found|selector_missing/i.test(message);
  }

  function listedDepends(dependsOn) {
    const values = Array.isArray(dependsOn) ? dependsOn : dependsOn ? [dependsOn] : [];
    return [...new Set(values.map((item) => String(item || '').trim()).filter(Boolean))];
  }

  function commandArgs(args, context, dependsOn) {
    const next = [...args];
    if (context) next.push('--context', context);
    for (const selector of dependsOn) next.push('--depends-on', selector);
    return next;
  }

  async function readContext(sessionId, commandOptions, wait) {
    if (wait) {
      try {
        await run(
          ['cooperate', 'wait', '--session', String(sessionId), '--timeout-ms', '8000'],
          { timeoutMs: 20_000, signal: commandOptions.signal },
        );
      } catch (error) {
        if (commandOptions.signal?.aborted) throw error;
        // A missed wait still leaves the following sync able to refresh the page.
      }
    }
    const synced = await run(
      ['cooperate', 'sync', '--session', String(sessionId), '--settle'],
      {
        timeoutMs: Math.max(5_000, Math.min(30_000, Number(commandOptions.timeoutMs) || 30_000)),
        signal: commandOptions.signal,
      },
    );
    return String(synced?.context_id || synced?.context || '').trim();
  }

  // bsk 0.4 shared-tab actions need the context_id from the latest cooperate
  // sync, and each context authorizes one action. A quiet page still succeeds
  // without it. A missing context syncs and retries. A page that moved waits
  // before every resync, and keeps going while the command budget remains,
  // because a live timeline can stay stale for more than two tries.
  // `--depends-on` narrows that guard to the named regions. A missing selector
  // drops the narrowing once and retries against the whole page.
  // moving:'once' is for a page that will not sit still: sync once, do not add
  // the 8s wait, and stop after the retry so the caller can keep what it read.
  async function runShared(sessionId, args, commandOptions = {}) {
    const budget = Math.max(1_000, Number(commandOptions.timeoutMs) || timeoutMs);
    const controller = new AbortController();
    const signal = commandOptions.signal
      ? AbortSignal.any([commandOptions.signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), budget);
    try {
      return await runSharedAttempts(sessionId, args, { ...commandOptions, signal }, Date.now() + budget);
    } catch (error) {
      if (commandOptions.signal?.aborted) throw abortError();
      if (controller.signal.aborted) {
        throw new BrowserCommandError(`bsk timed out after ${budget}ms`, { kind: 'timeout' });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function runSharedAttempts(sessionId, args, commandOptions, deadlineAt) {
    let context = '';
    let dependsOn = listedDepends(commandOptions.dependsOn);
    let droppedDepends = false;
    let lastError = null;
    const fastMove = commandOptions.moving === 'once';
    const maxAttempts = 6;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (commandOptions.signal.aborted) throw abortError();
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) throw new BrowserCommandError('bsk timed out', { kind: 'timeout' });
      try {
        const boundedArgs = commandArgs(args, context, dependsOn);
        const timeoutIndex = boundedArgs.indexOf('--timeout');
        if (timeoutIndex >= 0 && Number.parseInt(boundedArgs[timeoutIndex + 1], 10) > remaining) {
          boundedArgs[timeoutIndex + 1] = `${remaining}ms`;
        }
        return await run(boundedArgs, { ...commandOptions, timeoutMs: remaining });
      } catch (error) {
        lastError = error;
        if (dependsOn.length && !droppedDepends && selectorMissing(error)) {
          droppedDepends = true;
          dependsOn = [];
          attempt -= 1;
          continue;
        }
        const kind = refusalKind(error);
        const moveBudgetSpent = fastMove && kind && attempt >= 1;
        if (!kind || moveBudgetSpent || attempt === maxAttempts - 1 || Date.now() >= deadlineAt || commandOptions.signal.aborted) throw error;
        try {
          context = await readContext(sessionId, commandOptions, fastMove ? false : (kind === 'moving' || attempt > 0));
        } catch (syncError) {
          if (commandOptions.signal.aborted) throw syncError;
          throw error;
        }
        if (!context) throw error;
      }
    }
    throw lastError;
  }

  return {
    id: 'bsk',
    status,

    async health() {
      try {
        const snapshot = await status();
        const browsers = Array.isArray(snapshot.browsers) ? snapshot.browsers.length : 0;
        return {
          available: browsers > 0,
          daemonConnected: true,
          browserConnected: browsers > 0,
          browsers,
        };
      } catch (error) {
        if (error instanceof BrowserUnavailableError || error instanceof BrowserCommandError) {
          return {
            available: false,
            daemonConnected: false,
            browserConnected: false,
            browsers: 0,
          };
        }
        throw error;
      }
    },

    async startSession(sessionOptions = {}) {
      const args = ['session', 'start'];
      if (sessionOptions.purpose) args.push('--name', String(sessionOptions.purpose));
      if (sessionOptions.focused === false) args.push('--no-focus');
      if (sessionOptions.browserId) args.push('--browser', String(sessionOptions.browserId));
      const payload = await run(args, { timeoutMs: Math.max(timeoutMs, 120_000) });
      const sessionId = String(payload.session_id || payload.sessionId || '').trim();
      if (!sessionId) {
        throw new BrowserCommandError('bsk session start 没有返回 sessionId', { kind: 'invalid_json' });
      }
      return {
        sessionId,
        browserId: String(payload.browser_instance_id || payload.browserId || ''),
      };
    },

    async navigate(sessionId, url, navigateOptions = {}) {
      if (!/^https?:\/\//i.test(String(url || ''))) {
        throw new BrowserCommandError('navigate url must be http(s)', { kind: 'invalid_params' });
      }
      const limit = Math.max(1_000, Number(navigateOptions.timeoutMs) || timeoutMs);
      const args = ['navigate', String(url), '--session', String(sessionId), '--timeout', `${Math.floor(limit)}ms`];
      if (navigateOptions.waitUntil) args.push('--wait-until', String(navigateOptions.waitUntil));
      // bsk keeps the IPC open for the tool timeout plus 15s. Leave room so a
      // timeout result can return before the process is killed.
      return runShared(sessionId, args, {
        timeoutMs: limit + 20_000,
        signal: navigateOptions.signal,
        dependsOn: navigateOptions.dependsOn,
        moving: navigateOptions.moving,
      });
    },

    async evaluate(sessionId, expression, evaluateOptions = {}) {
      const evaluateTimeoutMs = Math.max(1_000, Number(evaluateOptions.timeoutMs) || timeoutMs);
      const payload = await runShared(
        sessionId,
        ['evaluate', String(expression), '--session', String(sessionId), '--timeout', `${Math.floor(evaluateTimeoutMs)}ms`],
        {
          timeoutMs: evaluateTimeoutMs,
          signal: evaluateOptions.signal,
          dependsOn: evaluateOptions.dependsOn,
          moving: evaluateOptions.moving,
        },
      );
      if (payload && payload.ok === false) {
        const text = String(payload.error?.text || 'evaluate failed');
        throw new BrowserCommandError(text, { kind: 'evaluate', code: 'evaluate_threw' });
      }
      return payload?.value;
    },

    async click(sessionId, selector, clickOptions = {}) {
      const args = ['click', '--session', String(sessionId), '--selector', String(selector)];
      return runShared(sessionId, args, {
        timeoutMs: clickOptions.timeoutMs || timeoutMs,
        signal: clickOptions.signal,
        dependsOn: clickOptions.dependsOn,
        moving: clickOptions.moving,
      });
    },

    async fill(sessionId, selector, value, fillOptions = {}) {
      const args = [
        'fill',
        '--session', String(sessionId),
        '--selector', String(selector),
        '--value', String(value),
      ];
      return runShared(sessionId, args, {
        timeoutMs: fillOptions.timeoutMs || timeoutMs,
        signal: fillOptions.signal,
        dependsOn: fillOptions.dependsOn,
        moving: fillOptions.moving,
      });
    },

    async stopSession(sessionId) {
      return run(['session', 'stop', String(sessionId)], { timeoutMs: Math.min(timeoutMs, 30_000) });
    },
  };
}
