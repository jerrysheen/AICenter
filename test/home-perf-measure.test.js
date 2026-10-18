import assert from 'node:assert/strict';
import test from 'node:test';
import { runHomeFirstScreenBench } from '../scripts/bench-home-first-screen.mjs';
import {
  bootstrapSegments,
  parseBoardLog,
  parseHomeLog,
  summarizeBoardJobs,
} from '../scripts/measure-home-perf.mjs';

test('board job summary counts duration and failure rate', () => {
  const summary = summarizeBoardJobs([
    { status: 'completed', started_at: 0, completed_at: 100, output_json: JSON.stringify({ timings: { us: 40, cn: 10 } }) },
    { status: 'completed', started_at: 0, completed_at: 300, output_json: '{"timings":{"us":80}}' },
    { status: 'failed', started_at: 0, completed_at: 50 },
    { status: 'running', started_at: 1, completed_at: null },
  ]);
  assert.equal(summary.completed, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.running, 1);
  assert.equal(summary.failureRate, 1 / 3);
  assert.equal(summary.durationMs.p50, 100);
  assert.equal(summary.boards.us.n, 2);
  assert.equal(summary.boards.us.p50, 40);
  assert.equal(summary.boards.cn.max, 10);
});

test('bootstrap timings and worker log lines parse', () => {
  assert.deepEqual(bootstrapSegments({ timings: { tree: 3, total: 9 } }), { tree: 3, total: 9 });
  assert.equal(bootstrapSegments({ ok: true }), null);
  assert.deepEqual(parseHomeLog('[worker] home-bootstrap tree=4ms readings=12ms total=20ms'), {
    tree: 4, readings: 12, total: 20,
  });
  assert.equal(parseHomeLog('other'), null);
  assert.deepEqual(parseBoardLog('[market] boards us=30ms asia=2ms cn=3ms global=1ms failed=us'), {
    segments: { us: 30, asia: 2, cn: 3, global: 1 },
    failed: ['us'],
  });
  assert.deepEqual(parseBoardLog('[market] boards us=1ms asia=1ms cn=1ms global=1ms failed=0').failed, []);
});

test('local first-screen bench spends less time after batching and pending quotes', () => {
  const result = runHomeFirstScreenBench({ hours: 48, perHour: 12, quoteWaitMs: 200, runs: 1 });
  assert.ok(result.before.queries > result.after.queries);
  assert.ok(result.before.firstScreenMs > result.after.firstScreenMs);
  assert.ok(result.week.before.queries > result.week.after.queries);
  assert.equal(result.after.quoteWaitMs, 0);
  assert.equal(result.fixture.note.includes('不是线上 14.5 秒的回放'), true);
});
