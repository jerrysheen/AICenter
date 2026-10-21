import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { installWorkerRejectionGuard } from '../packages/runtime/src/worker-rejection-guard.js';

function guard(options = {}) {
  const target = new EventEmitter();
  const lines = [];
  const exits = [];
  const stop = installWorkerRejectionGuard(target, (line) => lines.push(line), {
    windowMs: 10 * 60 * 1000,
    now: () => options.at ?? 0,
    exit(code) { exits.push(code); },
    ...options,
  });
  return {
    target,
    lines,
    exits,
    stop,
    emit(error) { target.emit('unhandledRejection', error); },
  };
}

function busy(message = 'database is locked') {
  return Object.assign(new Error(message), { code: 'SQLITE_BUSY' });
}

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

test('one database rejection stays up and the third of the same kind exits', () => {
  const seen = guard();
  seen.emit(busy());
  seen.emit(Object.assign(new Error('database is locked'), {}));
  assert.deepEqual(seen.exits, []);
  seen.emit(busy());
  assert.deepEqual(seen.exits, [1]);
  assert.match(seen.lines.at(-1), /database SQLITE_BUSY repeated 3 times, exiting/);
  seen.emit(busy());
  assert.deepEqual(seen.exits, [1]);
});

test('different database errors do not share a repeat count', () => {
  const seen = guard();
  const constraint = Object.assign(new Error('UNIQUE constraint failed'), { code: 'SQLITE_CONSTRAINT' });
  seen.emit(busy());
  seen.emit(busy());
  seen.emit(constraint);
  seen.emit(constraint);
  assert.deepEqual(seen.exits, []);
});

test('database repeats older than 10 minutes no longer count', () => {
  let at = 0;
  const seen = guard({ now: () => at });
  seen.emit(busy());
  seen.emit(busy());
  at = 10 * 60 * 1000 + 1;
  seen.emit(busy());
  seen.emit(busy());
  assert.deepEqual(seen.exits, []);
  seen.emit(busy());
  assert.deepEqual(seen.exits, [1]);
});

test('the twenty-first unhandled rejection inside 10 minutes exits', () => {
  const seen = guard();
  for (let i = 0; i < 20; i += 1) seen.emit(new Error(`other ${i}`));
  assert.deepEqual(seen.exits, []);
  seen.emit(new Error('other 21'));
  assert.deepEqual(seen.exits, [1]);
  assert.match(seen.lines.at(-1), /21 times in 600000ms, exiting/);
});

test('rejections outside the 10 minute window do not add up to the limit', () => {
  let at = 0;
  const seen = guard({ now: () => at });
  for (let i = 0; i < 20; i += 1) seen.emit(new Error(`old ${i}`));
  at = 10 * 60 * 1000 + 1;
  for (let i = 0; i < 20; i += 1) seen.emit(new Error(`new ${i}`));
  assert.deepEqual(seen.exits, []);
});

test('three SQLITE_BUSY rejections exit the process', async () => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { installWorkerRejectionGuard } from './packages/runtime/src/worker-rejection-guard.js';
    installWorkerRejectionGuard();
    const error = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    process.emit('unhandledRejection', error);
    process.emit('unhandledRejection', error);
    process.emit('unhandledRejection', error);
    setTimeout(() => console.log('still-alive'), 80);
  `], { cwd: process.cwd() });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 1, err);
  assert.equal(out.includes('still-alive'), false);
  assert.match(err, /database SQLITE_BUSY repeated 3 times, exiting/);
});
