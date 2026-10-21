import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

test('an unhandled rejection is logged and the process stays up', async () => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { installWorkerRejectionGuard } from './packages/runtime/src/worker-rejection-guard.js';
    installWorkerRejectionGuard();
    Promise.reject(new Error('database is locked'));
    setTimeout(() => console.log('still-alive'), 80);
  `], { cwd: process.cwd() });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0, err);
  assert.match(out, /still-alive/);
  assert.match(err, /\[worker\] unhandledRejection/);
  assert.match(err, /database is locked/);
});
