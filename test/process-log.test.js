import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {attachDailyProcessLog, detachDailyProcessLog} from '../packages/runtime/src/process-log.js';

function fakeStream({tty = false, blockAfter = Infinity} = {}) {
  const writes = [];
  return {
    isTTY: tty,
    writableNeedDrain: false,
    writes,
    write(chunk, encoding, callback) {
      writes.push(String(chunk));
      const done = typeof encoding === 'function' ? encoding : callback;
      if (typeof done === 'function') done();
      if (writes.length >= blockAfter) this.writableNeedDrain = true;
      return !this.writableNeedDrain;
    },
  };
}

test('daily process logs append both streams, rotate, and mirror a non-TTY pipe', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'process-log-'));
  const stdout = fakeStream({tty: false});
  const stderr = fakeStream({tty: true});
  let now = new Date(2026, 9, 12, 23, 50);
  let finished = false;
  const attached = attachDailyProcessLog({directory, name: 'worker', now: () => now, stdout, stderr});
  try {
    assert.equal(attachDailyProcessLog({directory, name: 'web', stdout, stderr}), attached);
    stdout.write('out line\n', () => { finished = true; });
    stderr.write('err line\n');
    assert.equal(finished, true);
    assert.deepEqual(stdout.writes, ['out line\n']);
    assert.deepEqual(stderr.writes, ['err line\n']);
    assert.equal(readFileSync(path.join(directory, 'worker.out.2026-10-12.log'), 'utf8'), 'out line\n');
    assert.equal(readFileSync(path.join(directory, 'worker.error.2026-10-12.log'), 'utf8'), 'err line\n');
    now = new Date(2026, 9, 13, 0, 1);
    stdout.write('next\n');
    assert.equal(readFileSync(path.join(directory, 'worker.out.2026-10-13.log'), 'utf8'), 'next\n');
    assert.equal(attachDailyProcessLog({directory: '', name: ''}), attached);
  } finally {
    detachDailyProcessLog();
  }
  stdout.write('after detach\n');
  assert.deepEqual(stdout.writes, ['out line\n', 'next\n', 'after detach\n']);
  assert.equal(readFileSync(path.join(directory, 'worker.out.2026-10-13.log'), 'utf8'), 'next\n');
  assert.equal(attachDailyProcessLog({directory, name: '../worker'}), null);
});

test('a backed-up pipe keeps the file log and stops mirroring until it drains', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'process-log-drain-'));
  const stdout = fakeStream({tty: false, blockAfter: 1});
  const stderr = fakeStream();
  const attached = attachDailyProcessLog({directory, name: 'worker', stdout, stderr, now: () => new Date(2026, 9, 15, 12)});
  try {
    stdout.write('first\n');
    stdout.write('second\n');
    assert.deepEqual(stdout.writes, ['first\n']);
    assert.equal(readFileSync(path.join(directory, 'worker.out.2026-10-15.log'), 'utf8'), 'first\nsecond\n');
    stdout.writableNeedDrain = false;
    stdout.write('third\n');
    assert.deepEqual(stdout.writes, ['first\n', 'third\n']);
  } finally {
    attached.detach();
  }
});
