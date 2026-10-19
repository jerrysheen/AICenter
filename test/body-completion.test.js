import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../packages/database/src/index.js';
import { createFeedFilter } from '../packages/domain/src/feed-filter.js';
import { createFeedService } from '../packages/domain/src/feed-service.js';
import {
  BODY_COMPLETION_MAX_AGE_MS,
  BODY_COMPLETION_MAX_ATTEMPTS,
  resolveBodyCompletion,
} from '../packages/domain/src/body-completion.js';

const good = {
  reading_value: 0.9,
  advertising: 0.1,
  specific_content: 0.9,
  sufficient_information: 0.9,
  missing_context: 0.05,
};
const answers = (scores) => Object.fromEntries(Object.entries(scores).map(([key, noul]) => [key, { type: 'noul', noul }]));

test('pending clears on the third truncated observation or after 24 hours and keeps the marker off', () => {
  assert.equal(BODY_COMPLETION_MAX_ATTEMPTS, 3);
  const started = 1_700_000_000_000;
  const first = resolveBodyCompletion({}, { truncated: true, now: started });
  assert.equal(first.bodyCompletion, 'pending');
  assert.equal(first.bodyCompletionAttempts, 1);
  assert.equal(first.exhausted, false);
  const second = resolveBodyCompletion(first, { truncated: true, now: started + 60_000 });
  assert.equal(second.bodyCompletion, 'pending');
  assert.equal(second.bodyCompletionAttempts, 2);
  assert.equal(second.bodyCompletionSince, started);
  const third = resolveBodyCompletion(second, { truncated: true, now: started + 120_000 });
  assert.equal(third.bodyCompletion, '');
  assert.equal(third.bodyCompletionAttempts, 3);
  assert.equal(third.exhausted, true);
  const again = resolveBodyCompletion(third, { truncated: true, now: started + 180_000 });
  assert.equal(again.unchanged, true);
  assert.equal(again.bodyCompletion, '');
  assert.equal(again.bodyCompletionAttempts, 3);
  const legacy = resolveBodyCompletion({
    bodyCompletion: 'pending',
    filterDecision: 'KEEP',
    filterEvaluatedAt: started,
  }, { truncated: true, now: started + BODY_COMPLETION_MAX_AGE_MS });
  assert.equal(legacy.exhausted, true);
  assert.equal(legacy.bodyCompletion, '');
  assert.equal(legacy.bodyCompletionSince, started);
  const fromCapture = resolveBodyCompletion({
    bodyCompletion: 'pending',
    filterDecision: 'KEEP',
    capturedAt: started,
  }, { truncated: true, now: started + BODY_COMPLETION_MAX_AGE_MS });
  assert.equal(fromCapture.exhausted, true);
  assert.equal(fromCapture.bodyCompletionSince, started);
  const filled = resolveBodyCompletion(second, { truncated: false, now: started + 120_000 });
  assert.equal(filled.bodyCompletion, '');
  assert.equal(filled.bodyCompletionAttempts, 0);
  assert.equal(filled.exhausted, false);
});

test('a truncated keep is fetched again only twice, then pending clears without another score', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-body-cap-'));
  const store = createStore(path.join(directory, 'test.db'));
  const repo = store.repositories.feed;
  let calls = 0;
  let reading = 0.61;
  const filter = createFeedFilter({
    config: { mode: 'enforce', version: 'feed-value-v3.0', rule: 'all-three-0.60', now: () => Date.now() },
    client: {
      modelId: 'fixed',
      async evaluate() {
        calls += 1;
        return { model: 'fixed', answers: answers({ ...good, reading_value: reading }) };
      },
    },
  });
  const bodies = [
    '第一条截断预览，正文还没展开。',
    '第二条截断预览，正文还没展开。',
  ];
  let body = bodies[0];
  const service = createFeedService({
    legacyRepository: store,
    feedRepository: repo,
    feedFilter: filter,
    sourcePort: {
      findByProvider: () => ({ id: 'x' }),
      persistence: () => ({
        providerId: 'x',
        sourceAccount: {
          externalId: 'x:body-cap',
          displayName: 'X',
          profileUrl: 'https://x.com/home',
          authMode: 'browser-session',
        },
      }),
      read: async () => ({
        data: {
          feed: 'for-you',
          fetchedAt: 1_700_000_000_000,
          mode: 'live',
          items: [{
            externalId: 'cap',
            body,
            captureContext: { truncated: true },
            sourceUrl: 'https://x.com/u/status/cap',
          }],
        },
      }),
    },
  });
  try {
    await service.getExternalFeed('x', { feed: 'for-you', refresh: true });
    const first = repo.getCapture('local', 'x', 'cap');
    assert.equal(calls, 1);
    assert.equal(first.metadata.filterDecision, 'KEEP');
    assert.equal(first.metadata.bodyCompletion, 'pending');
    assert.equal(first.metadata.bodyCompletionAttempts, 1);
    assert.equal(first.metadata.filterScores.reading_value, 0.61);
    assert.deepEqual(repo.listPendingBodyExternalIds('local', 'x'), ['cap']);

    body = bodies[0];
    await service.getExternalFeed('x', { feed: 'for-you', refresh: true });
    const second = repo.getCapture('local', 'x', 'cap');
    assert.equal(calls, 1);
    assert.equal(second.metadata.bodyCompletion, 'pending');
    assert.equal(second.metadata.bodyCompletionAttempts, 2);
    assert.equal(second.metadata.filterDecision, 'KEEP');
    assert.equal(second.metadata.filterScores.reading_value, 0.61);

    await service.getExternalFeed('x', { feed: 'for-you', refresh: true });
    const third = repo.getCapture('local', 'x', 'cap');
    assert.equal(calls, 1);
    assert.equal(third.metadata.bodyCompletion, '');
    assert.equal(third.metadata.bodyCompletionAttempts, 3);
    assert.equal(third.metadata.filterDecision, 'KEEP');
    assert.equal(third.metadata.filterScores.reading_value, 0.61);
    assert.equal(third.metadata.originalText, bodies[0]);
    assert.deepEqual(repo.listPendingBodyExternalIds('local', 'x'), []);

    reading = 0.95;
    body = bodies[1];
    await service.getExternalFeed('x', { feed: 'for-you', refresh: true });
    const kept = repo.getCapture('local', 'x', 'cap');
    assert.equal(calls, 1);
    assert.equal(kept.metadata.bodyCompletion, '');
    assert.equal(kept.metadata.bodyCompletionAttempts, 3);
    assert.equal(kept.metadata.filterScores.reading_value, 0.61);
    assert.equal(kept.metadata.originalText, bodies[1]);
    assert.equal(repo.getContentItemByCapture('local', first.id).body, bodies[1]);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a completed body clears pending and can be scored again', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-body-filled-'));
  const store = createStore(path.join(directory, 'test.db'));
  const repo = store.repositories.feed;
  let calls = 0;
  const filter = createFeedFilter({
    config: { mode: 'enforce', version: 'feed-value-v3.0', rule: 'all-three-0.60', now: () => Date.now() },
    client: {
      modelId: 'fixed',
      async evaluate() {
        calls += 1;
        return { model: 'fixed', answers: answers({ ...good, reading_value: calls === 1 ? 0.61 : 0.8 }) };
      },
    },
  });
  let truncated = true;
  let body = '还是截断预览。';
  const service = createFeedService({
    legacyRepository: store,
    feedRepository: repo,
    feedFilter: filter,
    sourcePort: {
      findByProvider: () => ({ id: 'x' }),
      persistence: () => ({
        providerId: 'x',
        sourceAccount: {
          externalId: 'x:body-filled',
          displayName: 'X',
          profileUrl: 'https://x.com/home',
          authMode: 'browser-session',
        },
      }),
      read: async () => ({
        data: {
          feed: 'for-you',
          fetchedAt: 1_700_000_000_000,
          mode: 'live',
          items: [{
            externalId: 'filled',
            body,
            captureContext: { truncated },
            sourceUrl: 'https://x.com/u/status/filled',
          }],
        },
      }),
    },
  });
  try {
    await service.getExternalFeed('x', { feed: 'for-you', refresh: true });
    assert.equal(repo.getCapture('local', 'x', 'filled').metadata.bodyCompletion, 'pending');
    truncated = false;
    body = '展开后的完整正文，包含原来预览里没有的事实。';
    await service.getExternalFeed('x', { feed: 'for-you', refresh: true });
    const saved = repo.getCapture('local', 'x', 'filled');
    assert.equal(calls, 2);
    assert.equal(saved.metadata.bodyCompletion, '');
    assert.equal(saved.metadata.bodyCompletionAttempts, 0);
    assert.equal(saved.metadata.filterDecision, 'KEEP');
    assert.equal(saved.metadata.filterScores.reading_value, 0.8);
    assert.equal(saved.metadata.originalText, body);
    assert.deepEqual(repo.listPendingBodyExternalIds('local', 'x'), []);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
