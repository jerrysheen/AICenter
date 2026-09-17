import { execFile as execFileCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { BrowserCommandError, BrowserUnavailableError } from './errors.js';

const execFile = promisify(execFileCallback);
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

async function defaultRunCommand(bskPath, args, options) {
  try {
    const result = await execFile(bskPath, args, {
      shell: false,
      windowsHide: true,
      timeout: options.timeoutMs,
      maxBuffer: options.maxBuffer,
      env: commandEnv(options),
    });
    return {
      code: 0,
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
      const args = ['navigate', String(url), '--session', String(sessionId)];
      if (navigateOptions.timeoutMs) args.push('--timeout', `${Math.floor(navigateOptions.timeoutMs)}ms`);
      return run(args, { timeoutMs: navigateOptions.timeoutMs || timeoutMs });
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
      return run(['session', 'stop', String(sessionId)], { timeoutMs: Math.min(timeoutMs, 30_000) });
    },
  };
}
