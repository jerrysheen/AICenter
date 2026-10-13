import test from 'node:test';
import assert from 'node:assert/strict';
import {
  API_REQUEST_LIMIT,
  cacheTtlFor,
  createRequestLayer,
  planTranslationPoll,
  requestDedupeKey,
  TRANSLATION_POLL_DEADLINE_MS,
  TRANSLATION_QUEUED_GIVE_UP_MS,
} from '../apps/web/public/client-request.js';

test('reading-hour callers share one cache key per hour window', () => {
  const home = requestDedupeKey('GET', '/api/v1/reports/reading-hour?startAt=100&endAt=200&scope=hour');
  const tree = requestDedupeKey('GET', '/api/v1/reports/reading-hour?scope=hour&endAt=200&startAt=100');
  const other = requestDedupeKey('GET', '/api/v1/reports/reading-hour?startAt=101&endAt=201&scope=hour');
  assert.equal(home, tree);
  assert.notEqual(home, other);
  assert.equal(requestDedupeKey('GET', '/api/v1/reports/reading-hour/snapshot?id=snap-1'), 'GET reading-hour-snapshot:snap-1');
  assert.equal(cacheTtlFor('GET', '/api/v1/reports/reading-hour?startAt=100&endAt=200&scope=hour'), 30_000);
  assert.equal(cacheTtlFor('GET', '/api/v1/reports/daily/latest/brief'), 30_000);
  assert.equal(cacheTtlFor('GET', '/api/v1/static-signals/board?from=1'), 20_000);
  assert.equal(cacheTtlFor('GET', '/api/v1/translate/jobs/abc'), 0);
  assert.equal(cacheTtlFor('POST', '/api/v1/posts'), 0);
  assert.equal(cacheTtlFor('GET', '/api/v1/reports/tree?view=index&refresh=1'), 0);
  assert.equal(API_REQUEST_LIMIT, 6);
});

test('in-flight GETs share one factory call and a short cache', async () => {
  let clock = 1_000;
  let calls = 0;
  const layer = createRequestLayer({ now: () => clock });
  const factory = () => {
    calls += 1;
    return Promise.resolve({ calls });
  };
  const first = layer.run('hour', factory, { share: true, ttl: 30_000, priority: 0 });
  const second = layer.run('hour', factory, { share: true, ttl: 30_000, priority: 0 });
  const [left, right] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(left, right);
  clock += 5_000;
  const cached = await layer.run('hour', factory, { share: true, ttl: 30_000 });
  assert.equal(calls, 1);
  assert.equal(cached.calls, 1);
  clock += 30_000;
  const again = await layer.run('hour', factory, { share: true, ttl: 30_000 });
  assert.equal(calls, 2);
  assert.equal(again.calls, 2);
  const fresh = await layer.run('hour', factory, { share: true, ttl: 30_000, bypass: true });
  assert.equal(calls, 3);
  assert.equal(fresh.calls, 3);
});

test('at most six requests run, and visible work goes ahead of idle work', async () => {
  let active = 0;
  let peak = 0;
  const order = [];
  const layer = createRequestLayer({ maxInflight: API_REQUEST_LIMIT });
  const job = (name, priority) => layer.run(name, () => new Promise((resolve) => {
    active += 1;
    peak = Math.max(peak, active);
    order.push(name);
    setTimeout(() => {
      active -= 1;
      resolve(name);
    }, 30);
  }), { share: false, bypass: true, priority });
  const pending = [];
  for (let index = 0; index < 8; index += 1) pending.push(job(`idle-${index}`, 9));
  pending.push(job('visible', 0));
  await Promise.all(pending);
  assert.ok(peak <= API_REQUEST_LIMIT);
  assert.ok(order.indexOf('visible') < order.indexOf('idle-7'));
});

test('translation polling backs off and stops when the job will not be claimed', () => {
  const startedAt = 10_000;
  const deadline = startedAt + TRANSLATION_POLL_DEADLINE_MS;
  const first = planTranslationPoll({ status: 'queued', now: startedAt, startedAt, deadline, attempt: 0 });
  assert.equal(first.stop, false);
  assert.equal(first.delay, 1_000);
  const waiting = planTranslationPoll({
    status: 'queued', availableAt: startedAt + 4 * 60_000, now: startedAt + 1_000, startedAt, deadline, attempt: 1,
  });
  assert.equal(waiting.stop, true);
  assert.equal(waiting.reason, 'deferred');
  const unclaimed = planTranslationPoll({
    status: 'pending', now: startedAt + TRANSLATION_QUEUED_GIVE_UP_MS, startedAt, deadline, attempt: 4,
  });
  assert.equal(unclaimed.reason, 'unclaimed');
  const running = planTranslationPoll({
    status: 'running', now: startedAt + 30_000, startedAt, deadline, sawRunning: true, attempt: 3,
  });
  assert.equal(running.stop, false);
  assert.ok(running.delay > 1_000 && running.delay <= 8_000);
  const timedOut = planTranslationPoll({
    status: 'running', now: deadline, startedAt, deadline, sawRunning: true, attempt: 6,
  });
  assert.equal(timedOut.reason, 'timeout');
  assert.equal(planTranslationPoll({ missing: true, now: startedAt, startedAt, deadline }).reason, 'missing');
  assert.equal(planTranslationPoll({
    status: 'queued', sawRunning: true, now: startedAt + 2_000, startedAt, deadline,
  }).reason, 'requeued');
});
