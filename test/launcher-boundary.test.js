import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launcher = readFileSync(path.join(root, 'scripts/start-ai-center.ps1'), 'utf8');
const searchLauncher = readFileSync(path.join(root, 'scripts/start-searxng.ps1'), 'utf8');
const searchProcesses = readFileSync(path.join(root, 'scripts/searxng-process.ps1'), 'utf8');

test('launcher state and logs belong to the selected instance runtime', () => {
  assert.match(launcher, /print-instance-config\.mjs/);
  assert.match(launcher, /\$RuntimeDirectory = \[IO\.Path\]::GetFullPath\(\[string\]\$InstanceConfig\.runtimeDirectory\)/);
  assert.match(launcher, /\$StateFile = Join-Path \$RuntimeDirectory 'processes\.json'/);
  assert.match(launcher, /\$WebOutLog = Join-Path \$LogDirectory/);
  assert.match(launcher, /\$WorkerOutLog = Join-Path \$LogDirectory/);
  assert.match(launcher, /\$SearchOutLog = Join-Path \$HostLogDirectory/);
  assert.match(launcher, /\$BrowserOutLog = Join-Path \$HostLogDirectory/);
});

test('launcher only stops recorded web and worker processes', () => {
  assert.doesNotMatch(launcher, /Get-ExistingAiCenterInstances|Stop-LateAiCenterDuplicates/);
  assert.doesNotMatch(launcher, /Get-CimInstance Win32_Process -Filter "Name = 'node\.exe'/);
  assert.match(launcher, /Test-RecordedInstanceProcess/);
  assert.match(launcher, /startTime = \$Process\.StartTime/);
  const stopBlock = launcher.match(/function Stop-StartedAiCenterProcesses \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(stopBlock, /\$workerProcess/);
  assert.match(stopBlock, /\$webProcess/);
  assert.doesNotMatch(stopBlock, /\$searchProcess|\$browserProcess/);
});

test('standalone Search launcher reuses or refuses and never scans or kills Python', () => {
  const combined = `${searchLauncher}\n${searchProcesses}`;
  assert.match(searchLauncher, /Wait-SearxngHealth/);
  assert.doesNotMatch(combined, /Get-CimInstance Win32_Process|Stop-Process/);
});

test('launcher config respects instance env port unless an explicit port wins', () => {
  const instanceRoot = mkdtempSync(path.join(os.tmpdir(), 'ai-center-launcher-port-'));
  writeFileSync(path.join(instanceRoot, '.env'), 'AI_CENTER_PORT=8788\n');
  try {
    const baseArgs = [path.join(root, 'scripts', 'print-instance-config.mjs'), '--instance-root', instanceRoot];
    const fromInstance = JSON.parse(execFileSync(process.execPath, baseArgs, {
      cwd: root, encoding: 'utf8', env: { ...process.env, AI_CENTER_PORT: '' },
    }));
    assert.equal(fromInstance.port, 8788);
    const explicit = JSON.parse(execFileSync(process.execPath, [...baseArgs, '--port', '8790'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, AI_CENTER_PORT: '' },
    }));
    assert.equal(explicit.port, 8790);
  } finally {
    rmSync(instanceRoot, { recursive: true, force: true });
  }
});
