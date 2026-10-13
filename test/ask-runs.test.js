import test from 'node:test';
import assert from 'node:assert/strict';
import { ASK_RUNS_MIN_INTERVAL_MS, planAskRunsFetch } from '../apps/web/public/ask-runs.js';

test('agent run list is not polled off the ask page or while hidden', () => {
  assert.deepEqual(planAskRunsFetch({ view: 'sources', visible: true, reason: 'event' }), { fetch: false, reason: 'idle' });
  assert.deepEqual(planAskRunsFetch({ view: 'ask', visible: false, reason: 'event' }), { fetch: false, reason: 'hidden' });
  assert.equal(planAskRunsFetch({ view: 'ask', visible: true, now: 20_000, reason: 'visible' }).fetch, true);
  const again = planAskRunsFetch({
    view: 'ask',
    visible: true,
    lastFetchAt: 20_000,
    now: 20_000 + ASK_RUNS_MIN_INTERVAL_MS - 1,
    reason: 'event',
  });
  assert.equal(again.fetch, false);
  assert.equal(again.reason, 'backoff');
  assert.equal(planAskRunsFetch({
    view: 'feed',
    visible: true,
    liveJobs: 1,
    now: 40_000,
    reason: 'event',
  }).fetch, true);
});
