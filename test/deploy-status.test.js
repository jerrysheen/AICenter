import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAiCenterServer } from '../apps/web/src/server.js';
import { emptyDeployStatus, projectDeployStatus, readDeployStatus } from '../apps/web/src/http/deploy-status.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function cookiePair(response) {
  const lines = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : String(response.headers.get('set-cookie') || '').split(/,(?=\s*(?:__Host-)?[A-Za-z0-9_]+=)/);
  const line = lines.find((item) => item.startsWith('ai_center_device='));
  assert.ok(line, 'missing device cookie');
  return line.split(';')[0];
}

function record(index, extra = {}) {
  const commit = `${index.toString(16).padStart(40, 'a')}`;
  const previous = `${index.toString(16).padStart(40, 'b')}`;
  return {
    commit,
    previousCommit: previous,
    ref: 'origin/deploy',
    startedAt: '2026-10-12T00:00:00.000Z',
    finishedAt: '2026-10-12T00:01:00.000Z',
    ok: index % 2 === 0,
    restarted: true,
    rolledBack: false,
    reason: '健康检查失败，已回滚到上一个提交',
    npmCi: false,
    ...extra,
  };
}

test('deploy status projection drops paths, secrets, and extra history', () => {
  assert.deepEqual(emptyDeployStatus(), { ok: true, current: null, history: [] });
  assert.deepEqual(projectDeployStatus(null), emptyDeployStatus());
  assert.deepEqual(projectDeployStatus({ current: { commit: 'not-a-commit' }, history: 'nope' }), {
    ok: true,
    current: null,
    history: [],
  });

  const projected = projectDeployStatus({
    token: 'secret-token',
    databasePath: 'C:\\secret\\ai-center.db',
    current: {
      ...record(1),
      databasePath: 'C:\\secret\\ai-center.db',
      env: 'GEMINI_API_KEY=secret',
      reason: 'failed at C:\\secret\\.env',
      state: 'error',
      error: 'NativeCommandError at scripts\\deploy-run.ps1:19\npassword=secret-pass Bearer secret-token',
      at: '2026-10-12T00:02:00.000Z',
    },
    history: Array.from({ length: 21 }, (_, index) => ({
      ...record(index + 2),
      password: 'secret-pass',
    })),
  });
  assert.equal(projected.ok, true);
  assert.equal(projected.current.reason, '');
  assert.equal(projected.current.state, 'error');
  assert.match(projected.current.error, /deploy-run\.ps1:19/);
  assert.equal(projected.current.error.includes('secret'), false);
  assert.equal(projected.current.at, '2026-10-12T00:02:00.000Z');
  assert.equal(projected.current.npmCi, false);
  assert.equal(projected.current.ref, 'origin/deploy');
  assert.equal(Object.hasOwn(projected.current, 'databasePath'), false);
  assert.equal(Object.hasOwn(projected.current, 'env'), false);
  assert.equal(projected.history.length, 20);
  assert.equal(JSON.stringify(projected).includes('secret'), false);
  assert.equal(JSON.stringify(projected).includes('.env'), false);
  assert.equal(JSON.stringify(projected).includes('GEMINI'), false);
});

test('missing or unreadable deploy status file is an empty state', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-deploy-file-'));
  const file = path.join(directory, 'deploy-status.json');
  try {
    assert.deepEqual(readDeployStatus(file), emptyDeployStatus());
    assert.deepEqual(readDeployStatus(''), emptyDeployStatus());
    writeFileSync(file, '{');
    assert.deepEqual(readDeployStatus(file), emptyDeployStatus());
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('deploy status requires a device login and ignores loopback headers', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-deploy-auth-'));
  const app = createAiCenterServer({
    host: '127.0.0.1',
    port: 0,
    dataDirectory: directory,
    loginCredential: { username: 'owner', password: 'secret-pass' },
  });
  const address = await app.listen();
  try {
    const localHeaders = { 'X-Forwarded-For': '127.0.0.1', 'X-Real-IP': '127.0.0.1' };
    const anonymous = await fetch(`${address.localUrl}/api/v1/runtime/deploy-status`, { headers: localHeaders });
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).error, '此设备尚未配对');

    const session = await fetch(`${address.localUrl}/api/v1/session`);
    assert.equal(session.status, 200);
    assert.equal((await session.json()).role, 'desktop');

    const publicAnonymous = await fetch(`${address.localUrl}/api/v1/runtime/deploy-status`, {
      headers: { Host: 'center.example.com', 'CF-Connecting-IP': '203.0.113.40' },
    });
    assert.equal(publicAnonymous.status, 401);

    const login = await fetch(`${address.localUrl}/api/v1/session/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'secret-pass', deviceName: '部署状态' }),
    });
    assert.equal(login.status, 201);
    const cookie = cookiePair(login);

    const empty = await fetch(`${address.localUrl}/api/v1/runtime/deploy-status`, {
      headers: { ...localHeaders, Cookie: cookie },
    });
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { ok: true, current: null, history: [] });

    writeFileSync(path.join(directory, 'deploy-status.json'), JSON.stringify({
      current: {
        ...record(3),
        npmCi: true,
        restarted: false,
        ok: true,
        reason: '',
        workspacePath: directory,
      },
      history: [record(3, { npmCi: true, restarted: false, ok: true, reason: '' })],
    }));
    const filled = await fetch(`${address.localUrl}/api/v1/runtime/deploy-status`, {
      headers: { Cookie: cookie, 'CF-Connecting-IP': '203.0.113.41' },
    }).then((response) => response.json());
    assert.equal(filled.ok, true);
    assert.equal(filled.current.ok, true);
    assert.equal(filled.current.npmCi, true);
    assert.equal(filled.current.restarted, false);
    assert.equal(filled.history.length, 1);
    assert.equal(JSON.stringify(filled).includes(directory), false);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function powershellBinary() {
  for (const command of ['pwsh', 'powershell', 'powershell.exe']) {
    try {
      execFileSync(command, ['-NoProfile', '-Command', 'Write-Output ok'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return command;
    } catch {
      // try the next host
    }
  }
  return '';
}

const powershell = powershellBinary();

test('powershell deploy decisions', { skip: powershell ? false : 'PowerShell is not installed' }, () => {
  const output = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'scripts/test-deploy-logic.ps1')], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.match(output, /deploy-logic-ok/);
});

test('launcher keeps daily logs, worker-only restart, and deploy guards', () => {
  const launcher = readFileSync(path.join(root, 'scripts/start-ai-center.ps1'), 'utf8');
  const deploy = readFileSync(path.join(root, 'scripts/deploy-run.ps1'), 'utf8');
  assert.match(launcher, /web\.out\.\$day\.log/);
  assert.match(launcher, /Restart-AiCenterWorkerOnly/);
  assert.match(launcher, /restart\.worker\.request/);
  assert.match(launcher, /deploy-logic\.ps1/);
  assert.match(launcher, /Invoke-AiCenterAutoDeploy/);
  const waitStart = launcher.indexOf('function Wait-ForCtrlCOrCrash');
  const guard = launcher.indexOf('$script:deployInProgress', waitStart);
  const exited = launcher.indexOf('$webProcess.HasExited', waitStart);
  assert.ok(guard > waitStart && guard < exited);
  assert.match(deploy, /merge --ff-only/);
  assert.match(deploy, /Enter-AiCenterDeployLock/);
  assert.match(deploy, /deployLockDepth/);
  assert.match(deploy, /stale-missing|Get-AiCenterDeployLockDecision/);
  assert.doesNotMatch(deploy, /2>&1/);
  assert.match(launcher, /InvocationInfo\.PositionMessage/);
  assert.match(launcher, /ScriptStackTrace/);
  assert.match(launcher, /Write-AiCenterDeployErrorStatus/);
  assert.match(deploy, /Wait-AiCenterWebHealth/);
  assert.match(deploy, /Test-AiCenterRestartRequired/);
  assert.match(deploy, /Test-AiCenterEnvChange/);
  assert.doesNotMatch(deploy, /git\s+checkout\s+--/);
  assert.doesNotMatch(deploy, /git\s+clean/);
  assert.doesNotMatch(deploy, /git\s+stash/);
  assert.doesNotMatch(deploy, /Get-Content[^\n]*\.env/);
  assert.match(launcher, /Web exited\. Restarting Web and Worker; tunnel stays up\./);
  assert.match(launcher, /Queue<LogLine>/);
  assert.match(launcher, /Monitor\.Pulse/);
  assert.match(launcher, /queue\.Count >= Capacity/);
  assert.match(launcher, /FileShare\.ReadWrite \| FileShare\.Delete/);
  assert.match(launcher, /DatedPath/);
  const received = launcher.indexOf('process.OutputDataReceived');
  const writeLine = launcher.indexOf('writer.WriteLine', received);
  assert.ok(received > 0 && writeLine > received);
  assert.equal(launcher.slice(received, received + 220).includes('WriteLine'), false);
  assert.match(launcher, /AI_CENTER_LOG_DIR/);
  assert.match(launcher, /AI_CENTER_LOG_NAME/);
  assert.match(launcher, /static string LogName/);
  const worker = readFileSync(path.join(root, 'apps/worker/src/worker.js'), 'utf8');
  const server = readFileSync(path.join(root, 'apps/web/src/server.js'), 'utf8');
  assert.match(worker, /attachDailyProcessLog\(\{directory: process\.env\.AI_CENTER_LOG_DIR/);
  assert.match(server, /attachDailyProcessLog\(\{directory: process\.env\.AI_CENTER_LOG_DIR/);
  assert.equal(worker.startsWith("import {attachDailyProcessLog}"), true);
  assert.equal(server.startsWith("import {attachDailyProcessLog}"), true);
});

test('instance config exposes deploy backup paths and not dotenv values', () => {
  const instanceRoot = mkdtempSync(path.join(os.tmpdir(), 'ai-center-deploy-config-'));
  writeFileSync(path.join(instanceRoot, '.env'), 'AI_CENTER_PORT=8788\nAI_CENTER_LOGIN_PASSWORD=super-secret-value\n');
  try {
    const config = JSON.parse(execFileSync(process.execPath, [
      path.join(root, 'scripts/print-instance-config.mjs'),
      '--instance-root',
      instanceRoot,
    ], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, AI_CENTER_PORT: '' },
    }));
    assert.equal(config.port, 8788);
    assert.equal(config.databasePath.endsWith(`${path.sep}ai-center.db`), true);
    assert.equal(path.basename(config.dataDirectory), 'data');
    assert.equal(JSON.stringify(config).includes('super-secret-value'), false);
  } finally {
    rmSync(instanceRoot, { recursive: true, force: true });
  }
});
