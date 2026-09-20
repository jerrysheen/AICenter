import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import { resolveBilibiliSpaceTarget } from './lib/bilibili-space-target.mjs';

const { hostMid } = resolveBilibiliSpaceTarget();
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const instance = resolveInstanceConfig({ repositoryRoot });
const outputDir = path.join(instance.runtimeDirectory, 'bilibili-up', hostMid);

function readJson(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function run(script, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, '--mid', hostMid, ...extraArgs], {
      cwd: repositoryRoot,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code || 0));
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let rounds = 0;
while (rounds < 12) {
  const checkpoint = readJson(path.join(outputDir, 'checkpoint.json'), {});
  if (checkpoint.complete && checkpoint.hasMore === false) break;
  rounds += 1;
  console.log(`[pipeline] dynamics round ${rounds} mid=${hostMid} existing=${checkpoint.itemCount || 0}`);
  const code = await run('scripts/collect-bilibili-space-dynamics.mjs', ['--max-pages', '400']);
  const next = readJson(path.join(outputDir, 'checkpoint.json'), {});
  if (next.complete && next.hasMore === false) break;
  const waitMs = next.error === '-352' ? 60_000 : 15_000;
  console.log(`[pipeline] dynamics incomplete code=${code} error=${next.error || ''} wait=${waitMs}`);
  await delay(waitMs);
}

const checkpoint = readJson(path.join(outputDir, 'checkpoint.json'), {});
if (!checkpoint.complete) {
  console.error('[pipeline] dynamics did not finish');
  process.exit(2);
}

console.log(`[pipeline] subtitles mid=${hostMid}`);
const subCode = await run('scripts/collect-bilibili-space-subtitles.mjs');
if (subCode !== 0) process.exit(subCode);

console.log(`[pipeline] audit mid=${hostMid}`);
const auditCode = await run('scripts/audit-bilibili-space-collection.mjs');
process.exit(auditCode);
