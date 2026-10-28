import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDefaultBskPath } from './browserskill-client.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export const BSK_DAEMON_START_ARGS = Object.freeze([
  'daemon', 'start', '--foreground', '--daemon-idle', '7d', '--session-idle', '30m',
]);

const WATCH_OFF = new Set(['0', 'false', 'off', 'no']);

export function bskDaemonWatchEnabled(env = process.env) {
  const raw = String(env?.AI_CENTER_BSK_DAEMON_WATCH ?? '').trim().toLowerCase();
  if (!raw) return true;
  return !WATCH_OFF.has(raw);
}

export function bskDaemonCheckIntervalMs(env = process.env) {
  const raw = String(env?.AI_CENTER_BSK_DAEMON_CHECK_SECONDS ?? '').trim();
  if (!raw) return 15_000;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 5) return 15_000;
  return parsed * 1000;
}

export function isBskDaemonDownError(error) {
  const code = String(error?.details?.code || error?.code || '').trim().toLowerCase();
  const message = String(error?.message || '');
  if (code === 'no_browser_connected' || /no browser is currently connected|no_browser_connected/i.test(message)) {
    return false;
  }
  if (code === 'daemon_unavailable') return true;
  return /automatic daemon startup is disabled|ensure daemon is running|BSK_AUTO_START=0/i.test(message);
}

export function bskDaemonIsUp(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  if (snapshot.daemonConnected === true) return true;
  const pid = Number(snapshot.pid);
  if (Number.isFinite(pid) && pid > 0) return true;
  if (snapshot.browsers != null || snapshot.sessions != null || snapshot.daemon_version) return true;
  return false;
}

export function bskDaemonBrowserCount(snapshot) {
  if (!snapshot || snapshot.browsers == null) return null;
  return Array.isArray(snapshot.browsers) ? snapshot.browsers.length : Number(snapshot.browsers) || 0;
}

export function defaultBskDaemonLockPath(root = repositoryRoot) {
  return path.join(root, '.ai-data', 'bsk-daemon.lock');
}

export function defaultBskDaemonLogDirectory(root = repositoryRoot) {
  return path.join(root, '.ai-data', 'logs');
}

function tryLock(lockPath) {
  try {
    return openSync(lockPath, 'wx');
  } catch (error) {
    if (error?.code === 'EEXIST') return null;
    throw error;
  }
}

export async function withBskDaemonLock(lockPath, fn, options = {}) {
  if (!lockPath) return fn();
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const staleMs = Number(options.staleMs) > 0 ? Number(options.staleMs) : 60_000;
  let fd = tryLock(lockPath);
  if (fd == null) {
    let stale = false;
    try {
      stale = Date.now() - statSync(lockPath).mtimeMs > staleMs;
    } catch {
      stale = false;
    }
    if (stale) {
      try { unlinkSync(lockPath); } catch { return { action: 'wait', reason: 'starting' }; }
      fd = tryLock(lockPath);
    }
  }
  if (fd == null) return { action: 'wait', reason: 'starting' };
  try {
    return await fn();
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(lockPath); } catch { /* the other side may already have removed it */ }
  }
}

function openDaemonLogs(logDirectory) {
  if (!logDirectory) return 'ignore';
  try {
    mkdirSync(logDirectory, { recursive: true });
    return [
      'ignore',
      openSync(path.join(logDirectory, 'browser.out.log'), 'a'),
      openSync(path.join(logDirectory, 'browser.error.log'), 'a'),
    ];
  } catch {
    return 'ignore';
  }
}

function closeDaemonLogs(stdio) {
  if (!Array.isArray(stdio)) return;
  for (const fd of stdio) {
    if (typeof fd === 'number') {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

export function startBskDaemonProcess(options = {}) {
  const bskPath = options.bskPath || resolveDefaultBskPath(options);
  const spawnImpl = options.spawn || spawn;
  const stdio = options.stdio || openDaemonLogs(options.logDirectory);
  const cwd = options.cwd || options.repositoryRoot || undefined;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(bskPath, [...BSK_DAEMON_START_ARGS], {
        shell: false,
        windowsHide: true,
        detached: true,
        stdio,
        cwd,
        env: {
          ...process.env,
          ...(options.env || {}),
          BSK_AUTO_START: '0',
        },
      });
    } catch (error) {
      closeDaemonLogs(stdio);
      reject(error);
      return;
    }
    const fail = (error) => {
      closeDaemonLogs(stdio);
      reject(error);
    };
    child.once('error', fail);
    child.once('spawn', () => {
      child.unref?.();
      closeDaemonLogs(stdio);
      resolve({ pid: child.pid || 0 });
    });
  });
}

function clip(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 180);
}

export function createBskDaemonSupervisor(options = {}) {
  const env = options.env || process.env;
  const log = options.log || (() => {});
  const now = options.now || (() => Date.now());
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const readyTimeoutMs = Number(options.readyTimeoutMs) > 0 ? Number(options.readyTimeoutMs) : 20_000;
  const restartGapMs = Number(options.restartGapMs) > 0 ? Number(options.restartGapMs) : 20_000;
  const pollMs = options.pollMs == null ? 400 : Math.max(0, Number(options.pollMs) || 0);
  const lockPath = options.lockPath || '';
  let inflight = null;
  let lastStartAt = 0;

  async function readStatus() {
    try {
      const snapshot = await options.status();
      if (isBskDaemonDownError(snapshot)) return null;
      return snapshot;
    } catch (error) {
      if (isBskDaemonDownError(error)) return null;
      throw error;
    }
  }

  async function startAndWait(reason) {
    lastStartAt = now();
    let startedPid = 0;
    try {
      const started = await options.start();
      startedPid = Number(started?.pid) || 0;
    } catch (error) {
      const detail = clip(error?.message || error);
      log({ action: 'failed', reason: 'start', detail });
      return { action: 'failed', reason: 'start', detail };
    }
    const deadline = now() + readyTimeoutMs;
    for (let attempt = 0; attempt < 50 && now() <= deadline; attempt += 1) {
      let ready = null;
      try {
        ready = await readStatus();
      } catch (error) {
        const detail = clip(error?.message || error);
        log({ action: 'failed', reason: 'status', detail });
        return { action: 'failed', reason: 'status', detail };
      }
      if (bskDaemonIsUp(ready)) {
        const browsers = bskDaemonBrowserCount(ready);
        log({ action: 'started', reason, detail: '', browsers, pid: ready.pid || startedPid || null });
        return {
          action: 'started',
          reason,
          pid: ready.pid || startedPid || null,
          browsers,
        };
      }
      if (pollMs <= 0 || now() >= deadline) break;
      await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
    }
    log({ action: 'failed', reason: 'timeout', detail: '' });
    return { action: 'failed', reason: 'timeout' };
  }

  function ensure(reason = 'down') {
    if (!bskDaemonWatchEnabled(env)) return Promise.resolve({ action: 'none', reason: 'disabled' });
    if (inflight) return inflight;
    inflight = (async () => {
      const snapshot = await readStatus();
      if (bskDaemonIsUp(snapshot)) {
        return { action: 'none', reason: 'up', pid: snapshot.pid || null, browsers: bskDaemonBrowserCount(snapshot) };
      }
      if (lastStartAt && now() - lastStartAt < restartGapMs) {
        return { action: 'wait', reason: 'backoff' };
      }
      if (!lockPath) return startAndWait(reason);
      const locked = await withBskDaemonLock(lockPath, () => startAndWait(reason), options);
      if (locked?.action === 'wait') return locked;
      return locked;
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  function watch(watchOptions = {}) {
    const intervalMs = Number(watchOptions.intervalMs) > 0
      ? Number(watchOptions.intervalMs)
      : bskDaemonCheckIntervalMs(env);
    const seconds = Math.max(1, Math.round(intervalMs / 1000));
    let stopped = false;
    const tick = (tickReason) => {
      if (stopped) return;
      ensure(tickReason).catch((error) => {
        log({ action: 'failed', reason: 'watch', detail: clip(error?.message || error) });
      });
    };
    log({ action: 'watch', reason: 'armed', detail: `intervalSec=${seconds}` });
    const kick = setTimeout(() => tick('watch'), 1000);
    const timer = setInterval(() => tick('watch'), intervalMs);
    kick.unref?.();
    timer.unref?.();
    return () => {
      stopped = true;
      clearTimeout(kick);
      clearInterval(timer);
    };
  }

  return { ensure, watch };
}
