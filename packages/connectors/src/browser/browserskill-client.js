import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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

function commandEnv(options = {}) {
  return {
    ...process.env,
    BSK_AUTO_START: '0',
    ...(options.env || {}),
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
export function runBrowserProcess(file, args, options = {}) {
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || 60_000);
  const maxBuffer = Math.max(1, Number(options.maxBuffer) || 8 * 1024 * 1024);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: commandEnv(options),
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
      if (error) {
        stopChild(child);
        reject(error);
        return;
      }
      resolve(result);
    }

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

  function listedSessions(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.sessions)) return payload.sessions;
    return [];
  }

  function sessionRecordName(record) {
    return String(record?.name || record?.task_name || record?.purpose || '').trim();
  }

  function sessionRecordId(record) {
    return String(record?.session_id || record?.sessionId || record?.id || '').trim();
  }

  // A killed `session start` can leave the Agent Window open without returning
  // a session id. Stop listed sessions with this name, and cancel the tracked
  // request, because `session list` does not always include the task name.
  async function cleanupOrphanSession(purpose, requestId) {
    const deadline = Date.now() + 5_000;
    const left = () => deadline - Date.now();
    const label = String(purpose || '').trim();
    try {
      const listBudget = left();
      if (listBudget >= 200) {
        const payload = await run(['session', 'list'], { timeoutMs: listBudget });
        for (const record of listedSessions(payload)) {
          if (!label || sessionRecordName(record) !== label) continue;
          const id = sessionRecordId(record);
          const stopBudget = left();
          if (!id || stopBudget < 200) break;
          try {
            await run(['session', 'stop', id], { timeoutMs: stopBudget });
          } catch {
            // A later request cancel still covers this start.
          }
        }
      }
    } catch {
      // Listing is best-effort. The request cancel below still runs.
    }
    const cancelBudget = left();
    if (requestId && cancelBudget >= 200) {
      try {
        await run(['session', 'request', String(requestId), '--cancel'], { timeoutMs: cancelBudget });
      } catch {
        // The start error is the one the caller needs.
      }
    }
  }

  return {
    id: 'bsk',

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
      const purpose = String(sessionOptions.purpose || '').trim();
      const requestId = `${Date.now() + 10 * 60 * 1000}:${randomUUID()}`;
      const args = ['session', 'start', '--request-id', requestId];
      if (purpose) args.push('--name', purpose);
      if (sessionOptions.focused === false) args.push('--no-focus');
      if (sessionOptions.browserId) args.push('--browser', String(sessionOptions.browserId));
      const deadlineAt = Number(sessionOptions.deadlineAt);
      const hasDeadline = Number.isFinite(deadlineAt);
      const startTimeout = hasDeadline
        ? Math.min(120_000, deadlineAt - Date.now() - 15_000)
        : Math.max(timeoutMs, 120_000);
      if (hasDeadline && startTimeout < 1_000) {
        const tooLate = new BrowserCommandError('browser_cold_start', { kind: 'browser_cold_start' });
        tooLate.kind = 'browser_cold_start';
        throw tooLate;
      }
      let payload;
      try {
        payload = await run(args, { timeoutMs: Math.max(1_000, startTimeout) });
      } catch (error) {
        const kind = error?.kind || error?.details?.kind;
        const timedOut = kind === 'timeout' || kind === 'browser_cold_start' || error?.killed || /timed out/i.test(String(error?.message || ''));
        if (timedOut) await cleanupOrphanSession(purpose, requestId);
        if (hasDeadline && timedOut) {
          const cold = new BrowserCommandError('browser_cold_start', { kind: 'browser_cold_start' });
          cold.kind = 'browser_cold_start';
          throw cold;
        }
        throw error;
      }
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
      // bsk keeps the IPC open a little past the tool timeout. Five seconds is
      // enough for the timeout result to return before the process is killed.
      return run(args, { timeoutMs: limit + 5_000 });
    },

    async evaluate(sessionId, expression, evaluateOptions = {}) {
      const evaluateTimeoutMs = Math.max(1_000, Number(evaluateOptions.timeoutMs) || timeoutMs);
      const payload = await run(
        ['evaluate', String(expression), '--session', String(sessionId), '--timeout', `${Math.floor(evaluateTimeoutMs)}ms`],
        { timeoutMs: evaluateTimeoutMs },
      );
      if (payload && payload.ok === false) {
        const text = String(payload.error?.text || 'evaluate failed');
        throw new BrowserCommandError(text, { kind: 'evaluate', code: 'evaluate_threw' });
      }
      return payload?.value;
    },

    async click(sessionId, selector, clickOptions = {}) {
      const args = ['click', '--session', String(sessionId), '--selector', String(selector)];
      return run(args, { timeoutMs: clickOptions.timeoutMs || timeoutMs });
    },

    async fill(sessionId, selector, value, fillOptions = {}) {
      const args = [
        'fill',
        '--session', String(sessionId),
        '--selector', String(selector),
        '--value', String(value),
      ];
      return run(args, { timeoutMs: fillOptions.timeoutMs || timeoutMs });
    },

    async stopSession(sessionId) {
      return run(['session', 'stop', String(sessionId)], { timeoutMs: Math.min(timeoutMs, 10_000) });
    },
  };
}
