import test from 'node:test';
import assert from 'node:assert/strict';
import { settleUntilStable } from '../apps/web/src/http/ui-revision-settle.js';

test('settleUntilStable waits until a burst of revisions stops changing', async () => {
  const values = ['a', 'b', 'c', 'c', 'c', 'd'];
  let index = 0;
  const waits = [];
  const stable = await settleUntilStable(() => values[Math.min(index++, values.length - 1)], {
    intervalMs: 10,
    stableReads: 3,
    maxReads: 8,
    delay: async (ms) => { waits.push(ms); },
  });
  assert.equal(stable, 'c');
  assert.equal(index, 5);
  assert.deepEqual(waits, [10, 10, 10, 10]);
});

test('settleUntilStable returns the last value when the burst never settles', async () => {
  const values = ['a', 'b', 'c', 'd'];
  let index = 0;
  const stable = await settleUntilStable(() => values[Math.min(index++, values.length - 1)], {
    intervalMs: 1,
    stableReads: 3,
    maxReads: 4,
    delay: async () => {},
  });
  assert.equal(stable, 'd');
  assert.equal(index, 4);
});
