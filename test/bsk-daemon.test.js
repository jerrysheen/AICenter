import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BrowserUnavailableError, bskCliEnv, createBrowserRuntime, createConfiguredBrowserRuntime } from '../packages/connectors/src/browser/index.js';
import {
  BSK_DAEMON_START_ARGS,
  bskDaemonBrowserCount,
  bskDaemonCheckIntervalMs,
  bskDaemonIsUp,
  bskDaemonWatchEnabled,
  createBskDaemonSupervisor,
  isBskDaemonDownError,
  startBskDaemonProcess,
  withBskDaemonLock,
} from '../packages/connectors/src/browser/bsk-daemon.js';
import { bskCliEnv as bskCliEnvFromClient } from '../packages/connectors/src/browser/browserskill-client.js';

const daemonDown = () => new BrowserUnavailableError(
  'ensure daemon is running: automatic daemon startup is disabled (BSK_AUTO_START=0)',
  { kind: 'exit', code: 'daemon_unavailable' },
);

test('BSK_AUTO_START stays off for CLI calls', () => {
  const previous = process.env.BSK_AUTO_START;
  process.env.BSK_AUTO_START = '1';
  try {
    assert.equal(bskCliEnv().BSK_AUTO_START, '0');
    assert.equal(bskCliEnvFromClient({ env: { BSK_AUTO_START: '1' } }).BSK_AUTO_START, '0');
    assert.equal(bskCliEnv({ env: { AI_BSK_PATH: 'C:\\bsk.exe' } }).AI_BSK_PATH, 'C:\\bsk.exe');
  } finally {
    if (previous == null) delete process.env.BSK_AUTO_START;
    else process.env.BSK_AUTO_START = previous;
  }
});

test('daemon watch defaults on and can be switched off', () => {
  assert.equal(bskDaemonWatchEnabled({}), true);
  assert.equal(bskDaemonWatchEnabled({ AI_CENTER_BSK_DAEMON_WATCH: '0' }), false);
  assert.equal(bskDaemonWatchEnabled({ AI_CENTER_BSK_DAEMON_WATCH: 'off' }), false);
  assert.equal(bskDaemonWatchEnabled({ AI_CENTER_BSK_DAEMON_WATCH: '1' }), true);
  assert.equal(bskDaemonCheckIntervalMs({}), 15_000);
  assert.equal(bskDaemonCheckIntervalMs({ AI_CENTER_BSK_DAEMON_CHECK_SECONDS: '30' }), 30_000);
  assert.equal(bskDaemonCheckIntervalMs({ AI_CENTER_BSK_DAEMON_CHECK_SECONDS: '1' }), 15_000);
});

test('daemon-down is not the same as a missing Chrome extension', () => {
  assert.equal(isBskDaemonDownError(daemonDown()), true);
  assert.equal(isBskDaemonDownError(new Error('ensure daemon is running: automatic daemon startup is disabled (BSK_AUTO_START=0)')), true);
  assert.equal(isBskDaemonDownError(new BrowserUnavailableError('no browser is currently connected', { code: 'no_browser_connected' })), false);
  assert.equal(bskDaemonIsUp(null), false);
  assert.equal(bskDaemonIsUp({ pid: 4, browsers: [] }), true);
  assert.equal(bskDaemonBrowserCount({ pid: 4, browsers: [] }), 0);
  assert.equal(bskDaemonIsUp({ daemon_version: '0.3.2', browsers: [{ instance_id: 'c' }] }), true);
});

test('explicit daemon start keeps the canonical args and does not enable auto-start', async () => {
  const previous = process.env.BSK_AUTO_START;
  process.env.BSK_AUTO_START = '1';
  const calls = [];
  try {
    const started = await startBskDaemonProcess({
      bskPath: 'C:\\tools\\bsk.exe',
      env: { BSK_AUTO_START: '1', AI_CENTER_PORT: '8787' },
      spawn(file, args, options) {
        calls.push({ file, args, options });
        return {
          pid: 42,
          unref() {},
          once(event, fn) {
            if (event === 'spawn') queueMicrotask(fn);
            return this;
          },
        };
      },
    });
    assert.equal(started.pid, 42);
    assert.equal(calls[0].file, 'C:\\tools\\bsk.exe');
    assert.deepEqual(calls[0].args, [...BSK_DAEMON_START_ARGS]);
    assert.equal(calls[0].options.shell, false);
    assert.equal(calls[0].options.detached, true);
    assert.equal(calls[0].options.env.BSK_AUTO_START, '0');
    assert.equal(calls[0].options.env.AI_CENTER_PORT, '8787');
  } finally {
    if (previous == null) delete process.env.BSK_AUTO_START;
    else process.env.BSK_AUTO_START = previous;
  }
});

test('a dead daemon is started once and a second caller waits on the same attempt', async () => {
  let up = false;
  let starts = 0;
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const logs = [];
  const supervisor = createBskDaemonSupervisor({
    env: {},
    lockPath: '',
    pollMs: 0,
    readyTimeoutMs: 5_000,
    log: (entry) => logs.push(entry),
    async status() {
      if (!up) throw daemonDown();
      return { pid: 9, browsers: [{ instance_id: 'chrome' }] };
    },
    async start() {
      starts += 1;
      await gate;
      up = true;
      return { pid: 9 };
    },
  });
  const first = supervisor.ensure('watch');
  const second = supervisor.ensure('session');
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(starts, 1);
  assert.equal(a.action, 'started');
  assert.equal(b.action, 'started');
  assert.equal(a.browsers, 1);
  assert.equal(logs.at(-1).action, 'started');
  const steady = await supervisor.ensure('watch');
  assert.equal(steady.action, 'none');
  assert.equal(steady.reason, 'up');
  assert.equal(starts, 1);
});

test('a failed start backs off and a disabled watch does not spawn', async () => {
  let starts = 0;
  const supervisor = createBskDaemonSupervisor({
    env: { AI_CENTER_BSK_DAEMON_WATCH: '1' },
    lockPath: '',
    pollMs: 0,
    restartGapMs: 60_000,
    async status() { return null; },
    async start() {
      starts += 1;
      throw new Error('bsk missing');
    },
  });
  const failed = await supervisor.ensure('watch');
  assert.equal(failed.action, 'failed');
  assert.equal(failed.reason, 'start');
  const waiting = await supervisor.ensure('watch');
  assert.deepEqual(waiting, { action: 'wait', reason: 'backoff' });
  assert.equal(starts, 1);

  const disabled = createBskDaemonSupervisor({
    env: { AI_CENTER_BSK_DAEMON_WATCH: '0' },
    async status() { throw new Error('should not status'); },
    async start() { throw new Error('should not start'); },
  });
  assert.deepEqual(await disabled.ensure('session'), { action: 'none', reason: 'disabled' });
});

test('an up daemon with no extension is left alone', async () => {
  let starts = 0;
  const supervisor = createBskDaemonSupervisor({
    env: {},
    lockPath: '',
    async status() { return { pid: 3, browsers: [] }; },
    async start() { starts += 1; },
  });
  const result = await supervisor.ensure('watch');
  assert.equal(result.action, 'none');
  assert.equal(result.reason, 'up');
  assert.equal(result.browsers, 0);
  assert.equal(starts, 0);
});

test('daemon start lock is exclusive until released and a stale lock can be taken', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bsk-lock-'));
  const lockPath = path.join(dir, 'bsk-daemon.lock');
  try {
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    const first = withBskDaemonLock(lockPath, async () => {
      const second = await withBskDaemonLock(lockPath, async () => 'inner');
      assert.deepEqual(second, { action: 'wait', reason: 'starting' });
      await gate;
      return 'outer';
    });
    release();
    assert.equal(await first, 'outer');
    assert.equal(await withBskDaemonLock(lockPath, async () => 'again'), 'again');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withSession starts a dead daemon once and then opens the session', async () => {
  let sessions = 0;
  let ensured = 0;
  const runtime = createBrowserRuntime({
    extensionWaitMs: 0,
    async ensureDaemon(reason) {
      ensured += 1;
      assert.equal(reason, 'session');
      return { action: 'started', reason };
    },
    provider: {
      id: 'bsk',
      async health() {
        return { daemonConnected: true, browserConnected: true, browsers: 1 };
      },
      async startSession() {
        sessions += 1;
        if (sessions === 1) throw daemonDown();
        return { sessionId: 'S', browserId: 'c' };
      },
      async stopSession() {},
    },
  });
  const value = await runtime.withSession({ purpose: 'x.home' }, async () => 'scraped');
  assert.equal(value, 'scraped');
  assert.equal(sessions, 2);
  assert.equal(ensured, 1);
});

test('a missing extension does not restart the daemon', async () => {
  let ensured = 0;
  const runtime = createBrowserRuntime({
    async ensureDaemon() {
      ensured += 1;
      return { action: 'started', reason: 'session' };
    },
    provider: {
      id: 'bsk',
      async startSession() {
        throw new BrowserUnavailableError('no browser is currently connected', { code: 'no_browser_connected' });
      },
      async stopSession() {},
    },
  });
  await assert.rejects(
    () => runtime.withSession({}, async () => 'nope'),
    /no browser is currently connected/,
  );
  assert.equal(ensured, 0);
});

test('configured runtime recovers a daemon-down session without CLI auto-start', async () => {
  let up = false;
  let starts = 0;
  const logs = [];
  const provider = {
    id: 'bsk',
    async status() {
      if (!up) throw daemonDown();
      return { pid: 11, browsers: [{ instance_id: 'chrome' }] };
    },
    async health() {
      if (!up) return { available: false, daemonConnected: false, browserConnected: false, browsers: 0 };
      return { available: true, daemonConnected: true, browserConnected: true, browsers: 1 };
    },
    async startSession() {
      if (!up) throw daemonDown();
      return { sessionId: 'S', browserId: 'chrome' };
    },
    async stopSession() {},
  };
  const runtime = createConfiguredBrowserRuntime({
    superviseDaemon: true,
    env: { BSK_AUTO_START: '0' },
    providers: { bsk: provider },
    daemonLockPath: '',
    daemonPollMs: 0,
    daemonReadyTimeoutMs: 1_000,
    extensionWaitMs: 0,
    daemonLog: (entry) => logs.push(entry),
    startDaemon: async () => {
      starts += 1;
      up = true;
      return { pid: 11 };
    },
  });
  const value = await runtime.withSession({ purpose: 'xueqiu.home' }, async () => 'rows');
  assert.equal(value, 'rows');
  assert.equal(starts, 1);
  assert.equal(logs.some((entry) => entry.action === 'started'), true);
  const stop = runtime.startDaemonWatch();
  stop();
});
