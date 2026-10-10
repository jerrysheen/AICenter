import test from 'node:test';
import assert from 'node:assert/strict';
import { formatHourGap, hourlyDelayHours, hourStepSense, mergeHourGaps, resolveHourChoice } from '../apps/web/public/information-tree.js';

const HOUR = 3600000;

test('consecutive missing hours collapse into one gap', () => {
  const at11 = Date.parse('2026-10-08T03:00:00Z');
  const at17 = at11 + 6 * HOUR;
  const merged = mergeHourGaps([at17, at11]);
  const gap = merged.find(item => item.kind === 'gap');
  assert.equal(gap.count, 5);
  assert.equal(gap.startAt, at11 + HOUR);
  assert.equal(gap.endAt, at17 - HOUR);
  assert.deepEqual(merged.map(item => item.kind), ['hour', 'gap', 'hour']);
  assert.deepEqual(formatHourGap(12, 16, 5), { label: '12–16点', detail: '12:00–16:00 · 5 期未生成' });
});

test('delay is the whole hours after the latest edition ended, and only once it passes two hours', () => {
  const end = 1_700_000_000_000;
  assert.equal(hourlyDelayHours(end, end + 2 * HOUR), 0);
  assert.equal(hourlyDelayHours(end, end + 2 * HOUR + 1), 2);
  assert.equal(hourlyDelayHours(end, end + 3.5 * HOUR), 3);
  assert.equal(hourlyDelayHours(end, end + HOUR), 0);
});

test('hourly selection defaults to the newest edition', () => {
  const rows = [{ startAt: 300, hour: 16 }, { startAt: 200, hour: 15 }, { startAt: 100, hour: 14 }];
  const choice = resolveHourChoice(rows, null);
  assert.equal(choice.startAt, 300);
  assert.equal(choice.shownHour, 16);
  assert.equal(choice.fallback, false);
});

test('a missing requested hour falls back to the nearest earlier edition', () => {
  const rows = [{ startAt: 300, hour: 16 }, { startAt: 100, hour: 14 }];
  const exact = resolveHourChoice(rows, 16);
  assert.equal(exact.fallback, false);
  assert.equal(exact.startAt, 300);
  const missing = resolveHourChoice(rows, 15);
  assert.equal(missing.fallback, true);
  assert.equal(missing.shownHour, 14);
  assert.equal(missing.startAt, 100);
  assert.equal(missing.requestedHour, 15);
});

test('swipe and keys map to earlier or later by layout', () => {
  assert.equal(hourStepSense('swipe-left', true), 'earlier');
  assert.equal(hourStepSense('swipe-right', true), 'later');
  assert.equal(hourStepSense('ArrowRight', true), 'earlier');
  assert.equal(hourStepSense('ArrowLeft', true), 'later');
  assert.equal(hourStepSense('wheel-right', true), 'earlier');
  assert.equal(hourStepSense('ArrowLeft', false), 'earlier');
  assert.equal(hourStepSense('ArrowRight', false), 'later');
  assert.equal(hourStepSense('wheel-left', false), 'earlier');
  assert.equal(hourStepSense('wheel-right', false), 'later');
  assert.equal(hourStepSense('swipe-left', false), 'earlier');
});
