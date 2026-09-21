import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import {
  harnessDshEntryPath,
  harnessPatchPath,
  harnessPluginPath,
  materializeHarnessPatch,
} from '../packages/harness/src/launch.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
resolveInstanceConfig({ repositoryRoot });

const vanilla = process.argv.includes('--vanilla');
const debug = process.argv.includes('--debug');
const profileFlag = process.argv.indexOf('--profile');
const profile = profileFlag >= 0 ? process.argv[profileFlag + 1] : 'sdk';
const root = mkdtempSync(path.join(os.tmpdir(), 'aicenter-harness-init-'));
const dshHome = path.join(root, 'home');
const cwd = path.join(root, 'ws');
mkdirSync(dshHome, { recursive: true });
mkdirSync(cwd, { recursive: true });

const overlayPath = path.join(root, 'aicenter.cordis.yml');
const patches = [];
if (!vanilla) {
  writeFileSync(
    overlayPath,
    materializeHarnessPatch(readFileSync(harnessPatchPath(), 'utf8'), harnessPluginPath()),
    'utf8',
  );
  patches.push(overlayPath);
}
if (debug) {
  const debugPath = path.join(root, 'debug.cordis.yml');
  const debugPlugin = pathToFileURL(path.resolve(repositoryRoot, 'packages/harness/plugin/src/debug.js')).href;
  writeFileSync(debugPath, `- insert:\n    - id: aicenter-debug\n      name: ${JSON.stringify(debugPlugin)}\n`, 'utf8');
  patches.push(debugPath);
}

const childEnv = {
  ...process.env,
  DSH_HOME: dshHome,
  DSH_TELEMETRY_DISABLED: '1',
  DSH_TELEMETRY_MODE: 'DISABLED',
  DSH_PERMISSION_MODE: 'read-only',
};

if (debug) {
  const { spawn } = await import('node:child_process');
  const { JsonRpcLineTransport } = await import('@deepseek-ai/dsh-sdk-protocol');
  const args = [
    harnessDshEntryPath(),
    '--profile',
    profile,
    ...patches.flatMap((file) => ['--patch', file]),
  ];
  const child = spawn(process.execPath, args, {
    cwd,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const transport = new JsonRpcLineTransport(child.stdout, child.stdin);
  transport.start();
  try {
    const result = await Promise.race([
      transport.request('initialize', {
        cwd,
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
      }),
      new Promise((_, reject) => {
        child.once('exit', (code) => reject(new Error(`dsh exited ${code}`)));
        setTimeout(() => reject(new Error('initialize timed out')), 120_000);
      }),
    ]);
    console.log(JSON.stringify({ ok: true, vanilla, profile, result }));
  } catch (error) {
    console.log(JSON.stringify({
      ok: false,
      vanilla,
      profile,
      name: error?.name || 'Error',
      message: error?.message || String(error),
      code: error?.code,
      data: error?.data,
    }, null, 2));
    process.exitCode = 1;
  } finally {
    child.kill();
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
} else {
  const harness = new DeepSeekHarness({
    profile,
    dshBin: harnessDshEntryPath(),
    dshHome,
    cwd,
    processCwd: cwd,
    patches,
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    initializeTimeoutMs: 120_000,
    env: childEnv,
  });

  try {
    await harness.start();
    console.log(JSON.stringify({ ok: true, vanilla, profile }));
  } catch (error) {
    console.log(JSON.stringify({
      ok: false,
      vanilla,
      profile,
      name: error?.name || 'Error',
      message: error?.message || String(error),
      code: error?.code,
      data: error?.data,
      cause: error?.cause?.message || undefined,
      errors: Array.isArray(error?.errors) ? error.errors.map((item) => item?.message || String(item)) : undefined,
    }, null, 2));
    process.exitCode = 1;
  } finally {
    try { await harness.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
}
