import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../packages/database/src/index.js';
import { createGeminiArticleAdmission } from '../packages/runtime/src/gemini-article-admission.js';
import { GEMMA_26B, resolveGemmaTranslationSlots } from '../packages/connectors/src/translate/gemma.js';
import { resolveGoogleHourlyAdmissionModels } from '../packages/harness/src/llm-route.js';
import { investorSummaryModelList } from '../packages/connectors/src/investor-discussion-model.js';
import { formatGeminiQuotaClock, geminiQuotaDay, nextGeminiDailyReset } from '../packages/connectors/src/gemini-grok-task.js';

const env = {
  GEMINI_API_KEY: 'one',
  AI_CENTER_GEMINI_KEY_ENVS: 'GEMINI_API_KEY',
  AI_CENTER_GEMINI_ARTICLE_MIN_INTERVAL_MS: '1',
  AI_CENTER_GEMINI_ARTICLE_REQUESTS_PER_MINUTE: '100',
  AI_CENTER_GEMINI_ARTICLE_REQUESTS_PER_HOUR: '5000',
  AI_CENTER_GEMINI_ARTICLE_REQUESTS_PER_DAY: '5000',
  AI_CENTER_GEMINI_ARTICLE_KEY_REQUESTS_PER_DAY: '5000',
  AI_CENTER_GEMINI_ARTICLE_ESTIMATED_TOKENS_PER_MINUTE: '100000000',
};

function open(atRef) {
  const store = createStore(':memory:');
  const admission = createGeminiArticleAdmission({
    repository: store.repositories.modelQuota,
    usage: store.repositories.modelUsage,
    env,
    now: () => atRef.at,
    allowFallback: false,
  });
  return { store, admission };
}

test('hourly admission includes both Flash Lite models', () => {
  assert.deepEqual(resolveGoogleHourlyAdmissionModels({
    GEMINI_API_KEY: 'one',
    AI_CENTER_HARNESS_HOURLY_MODEL: 'gemini-3.1-flash-lite',
  }), ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite']);
});

test('a Flash Lite call switches before 15 RPM instead of waiting for 429', () => {
  const atRef = { at: Date.parse('2026-10-20T13:00:00Z') };
  const { store, admission } = open(atRef);
  try {
    for (let index = 0; index < 14; index += 1) {
      const ticket = admission.reserve({ model: 'gemini-3.1-flash-lite', inputBytes: 1, maxTokens: 1 });
      assert.equal(ticket.model, 'gemini-3.1-flash-lite');
      atRef.at += 20;
    }
    const switched = admission.reserve({ model: 'gemini-3.1-flash-lite', inputBytes: 1, maxTokens: 1 });
    assert.equal(switched.model, 'gemini-3.5-flash-lite');
  } finally {
    store.close();
  }
});

test('a Flash Lite call switches before 500 RPD', () => {
  const atRef = { at: Date.parse('2026-10-20T13:00:00Z') };
  const { store, admission } = open(atRef);
  try {
    for (let index = 0; index < 480; index += 1) {
      const ticket = admission.reserve({ model: 'gemini-3.5-flash-lite', inputBytes: 1, maxTokens: 1 });
      assert.equal(ticket.model, 'gemini-3.5-flash-lite');
      if ((index + 1) % 13 === 0) atRef.at += 61_000;
      else atRef.at += 20;
    }
    const switched = admission.reserve({ model: 'gemini-3.5-flash-lite', inputBytes: 1, maxTokens: 1 });
    assert.equal(switched.model, 'gemini-3.1-flash-lite');
    assert.ok(switched.retryAt === undefined || switched.retryAt <= nextGeminiDailyReset(atRef.at));
  } finally {
    store.close();
  }
});

test('investor summaries use the other Flash Lite when no extra model list is configured', () => {
  assert.deepEqual(investorSummaryModelList({
    AI_CENTER_INVESTOR_DIGEST_MODEL: 'gemini-3.1-flash-lite',
  }), ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite']);
});

test('Flash Lite RPM and RPD headroom stay on the key that still has room', () => {
  const atRef = { at: Date.parse('2026-10-21T04:30:00Z') };
  const store = createStore(':memory:');
  const admission = createGeminiArticleAdmission({
    repository: store.repositories.modelQuota,
    env: {
      ...env,
      GEMINI_API_KEY2: 'two',
      AI_CENTER_GEMINI_KEY_ENVS: 'GEMINI_API_KEY,GEMINI_API_KEY2',
    },
    now: () => atRef.at,
    allowFallback: false,
  });
  try {
    for (let index = 0; index < 15; index += 1) {
      const ticket = admission.reserve({ model: 'gemini-3.1-flash-lite', inputBytes: 1, maxTokens: 1 });
      assert.equal(ticket.model, 'gemini-3.1-flash-lite');
      atRef.at += 20;
    }
    const earlier = atRef.at - 5 * 60_000;
    for (const model of ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite']) {
      for (let index = 0; index < 480; index += 1) {
        store.repositories.modelQuota.recordProbeUse({ project: 'other-project', keyEnv: 'GEMINI_API_KEY', model, at: earlier });
      }
    }
    const open = admission.reserve({ model: 'gemini-3.1-flash-lite', inputBytes: 1, maxTokens: 1 });
    assert.equal(open.model, 'gemini-3.1-flash-lite');
    assert.equal(open.keyEnv, 'GEMINI_API_KEY2');
  } finally {
    store.close();
  }
});

test('keys that name the same project still share the Flash Lite cap', () => {
  const atRef = { at: Date.parse('2026-10-21T04:30:00Z') };
  const store = createStore(':memory:');
  const admission = createGeminiArticleAdmission({
    repository: store.repositories.modelQuota,
    env: {
      ...env,
      GEMINI_API_KEY2: 'two',
      AI_CENTER_GEMINI_KEY_ENVS: 'GEMINI_API_KEY,GEMINI_API_KEY2',
      GEMINI_API_KEY_PROJECT: 'shared-flash',
      GEMINI_API_KEY2_PROJECT: 'shared-flash',
    },
    now: () => atRef.at,
    allowFallback: false,
  });
  try {
    for (let index = 0; index < 14; index += 1) {
      assert.equal(admission.reserve({ model: 'gemini-3.1-flash-lite', inputBytes: 1, maxTokens: 1 }).model, 'gemini-3.1-flash-lite');
      atRef.at += 20;
    }
    assert.equal(admission.reserve({ model: 'gemini-3.1-flash-lite', inputBytes: 1, maxTokens: 1 }).model, 'gemini-3.5-flash-lite');
  } finally {
    store.close();
  }
});

test('both keys at 480 RPD wait until the Pacific day instead of merging early', () => {
  const at = Date.parse('2026-10-21T04:30:00Z');
  const store = createStore(':memory:');
  const admission = createGeminiArticleAdmission({
    repository: store.repositories.modelQuota,
    env: {
      ...env,
      GEMINI_API_KEY2: 'two',
      AI_CENTER_GEMINI_KEY_ENVS: 'GEMINI_API_KEY,GEMINI_API_KEY2',
    },
    now: () => at,
    allowFallback: false,
  });
  try {
    const earlier = at - 5 * 60_000;
    for (const keyEnv of ['GEMINI_API_KEY', 'GEMINI_API_KEY2']) {
      for (const model of ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite']) {
        for (let index = 0; index < 480; index += 1) {
          store.repositories.modelQuota.recordProbeUse({ project: 'other-project', keyEnv, model, at: earlier });
        }
      }
    }
    assert.throws(
      () => admission.reserve({ model: 'gemini-3.1-flash-lite', inputBytes: 1, maxTokens: 1 }),
      (error) => error?.code === 'budget-deferred' && error.quotaExhausted === true && error.flashHeadroom === 'rpd' && error.retryAt === nextGeminiDailyReset(at),
    );
    const counts = store.repositories.modelQuota.reservationDayCounts({
      models: ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'],
      dayStart: at - 24 * 3600000,
      dayEnd: at + 3600000,
    });
    assert.equal(counts.filter((row) => row.model === 'gemini-3.1-flash-lite').reduce((sum, row) => sum + row.calls, 0), 960);
    assert.equal(counts.filter((row) => row.model === 'gemini-3.5-flash-lite').reduce((sum, row) => sum + row.calls, 0), 960);
  } finally {
    store.close();
  }
});

test('the Pacific quota day is labeled in both Pacific and Beijing clocks', () => {
  const at = Date.parse('2026-10-21T06:11:00Z');
  const { dayStart, dayEnd } = geminiQuotaDay(at);
  assert.equal(dayEnd, nextGeminiDailyReset(at));
  assert.equal(formatGeminiQuotaClock(dayEnd), 'pacific=2026-10-21 00:00 beijing=2026-10-21 15:00');
  assert.equal(formatGeminiQuotaClock(dayStart), 'pacific=2026-10-20 00:00 beijing=2026-10-20 15:00');
});

test('a merged 2500 Flash Lite day is daily exhaustion even when the other model is only per-key full', () => {
  const at = Date.parse('2026-10-21T06:11:00Z');
  const store = createStore(':memory:');
  const admission = createGeminiArticleAdmission({
    repository: store.repositories.modelQuota,
    env: {
      ...env,
      GEMINI_API_KEY2: 'two',
      AI_CENTER_GEMINI_KEY_ENVS: 'GEMINI_API_KEY,GEMINI_API_KEY2',
      AI_CENTER_GEMINI_ARTICLE_POOL_CONCURRENCY: '2',
      AI_CENTER_GEMINI_ARTICLE_REQUESTS_PER_DAY: '2500',
      AI_CENTER_GEMINI_ARTICLE_KEY_REQUESTS_PER_DAY: '5000',
      AI_CENTER_GEMINI_ARTICLE_REQUESTS_PER_HOUR: '20000',
      AI_CENTER_HARNESS_ARTICLE_FALLBACK: 'elucid-grok',
    },
    now: () => at,
    models: ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'],
    allowFallback: false,
    modelOrder: 'least-used',
  });
  try {
    const earlier = at - 5 * 60_000;
    for (const keyEnv of ['GEMINI_API_KEY', 'GEMINI_API_KEY2']) {
      for (let index = 0; index < 480; index += 1) {
        store.repositories.modelQuota.recordProbeUse({ project: 'other', keyEnv, model: 'gemini-3.1-flash-lite', at: earlier });
      }
    }
    for (let index = 0; index < 2500; index += 1) {
      store.repositories.modelQuota.recordProbeUse({
        project: 'other', keyEnv: index % 2 ? 'GEMINI_API_KEY2' : 'GEMINI_API_KEY', model: 'gemini-3.5-flash-lite', at: earlier,
      });
    }
    assert.throws(
      () => admission.reserve({ model: 'gemini-3.1-flash-lite', inputBytes: 1, maxTokens: 1 }),
      (error) => error?.code === 'budget-deferred' && error.quotaExhausted === true && error.flashHeadroom === 'rpd' && error.retryAt === nextGeminiDailyReset(at),
    );
    assert.equal(admission.nextReadyAt('gemini-3.1-flash-lite'), at);
    const gemmaEnv = {
      ...env,
      AI_CENTER_GEMINI_KEY_ENVS: 'GEMINI_API_KEY',
      AI_CENTER_GEMINI_ARTICLE_POOL_CONCURRENCY: '2',
      AI_CENTER_GEMINI_ARTICLE_REQUESTS_PER_DAY: '2500',
      AI_CENTER_GEMINI_ARTICLE_KEY_REQUESTS_PER_DAY: '5000',
      AI_CENTER_GEMINI_ARTICLE_REQUESTS_PER_HOUR: '20000',
      AI_CENTER_GEMMA_TRANSLATION_INTERVAL_MIN_MS: '60000',
      AI_CENTER_GEMMA_TRANSLATION_INTERVAL_MAX_MS: '60000',
      AI_CENTER_GEMMA_TRANSLATION_REQUESTS_PER_MINUTE: '100',
    };
    const waiting = createGeminiArticleAdmission({
      repository: store.repositories.modelQuota,
      env: gemmaEnv,
      now: () => at,
      models: ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'],
      allowFallback: false,
      modelOrder: 'least-used',
    });
    const slot = resolveGemmaTranslationSlots(gemmaEnv)[0];
    store.repositories.modelQuota.recordProbeUse({ project: slot.project, keyEnv: slot.keyEnv, model: GEMMA_26B, at: at - 1000 });
    assert.equal(waiting.nextReadyAt('gemini-3.1-flash-lite'), at - 1000 + 60000);
  } finally {
    store.close();
  }
});

test('per-key Flash daily cap still marks exhaustion when the 480 counter did not see those rows', () => {
  const at = Date.parse('2026-10-21T06:11:00Z');
  const store = createStore(':memory:');
  const admission = createGeminiArticleAdmission({
    repository: store.repositories.modelQuota,
    env: {
      ...env,
      AI_CENTER_GEMINI_ARTICLE_POOL_CONCURRENCY: '2',
      AI_CENTER_GEMINI_ARTICLE_REQUESTS_PER_DAY: '5000',
      AI_CENTER_GEMINI_ARTICLE_KEY_REQUESTS_PER_DAY: '500',
      AI_CENTER_GEMINI_ARTICLE_REQUESTS_PER_HOUR: '20000',
    },
    now: () => at,
    models: ['gemini-3.1-flash-lite'],
    allowFallback: false,
  });
  try {
    const ticket = admission.reserve({ model: 'gemini-3.1-flash-lite', inputBytes: 1, maxTokens: 1 });
    store.repositories.modelQuota.discard(ticket);
    const earlier = at - 5 * 60_000;
    for (const model of ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite']) {
      for (let index = 0; index < 500; index += 1) {
        store.repositories.modelQuota.recordProbeUse({ project: ticket.project, keyEnv: 'OTHER', model, at: earlier });
      }
    }
    assert.throws(
      () => admission.reserve({ model: 'gemini-3.1-flash-lite', inputBytes: 1, maxTokens: 1 }),
      (error) => error?.code === 'budget-deferred' && error.quotaExhausted === true && error.flashHeadroom === 'rpd',
    );
  } finally {
    store.close();
  }
});

test('daily model counts group request rows and omit turns', () => {
  const store = createStore(':memory:');
  const at = Date.parse('2026-10-20T13:00:00Z');
  const usage = {
    inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheWriteTokens: null,
    reasoningTokens: null, totalTokens: 2,
  };
  const row = (id, model, kind) => ({
    id, workspaceId: 'local', kind, jobId: '', jobAttempt: null,
    stage: 'hourly', applicationSessionId: '', harnessSessionId: '',
    turn: null, step: null, attempt: null, provider: 'gemini', model,
    status: 'succeeded', httpStatus: 200, itemId: '', keySuffix: '',
    completeness: 'complete', usage, occurredAt: at, supplierAmount: null, supplierCurrency: null,
  });
  try {
    store.repositories.modelUsage.save(row('a', 'gemini-3.1-flash-lite', 'request'));
    store.repositories.modelUsage.save(row('b', 'gemini-3.1-flash-lite', 'request'));
    store.repositories.modelUsage.save(row('c', 'gemini-3.5-flash-lite', 'request'));
    store.repositories.modelUsage.save(row('d', 'gemini-3.1-flash-lite', 'turn'));
    assert.deepEqual(store.repositories.modelUsage.dailyCounts('local', { startAt: at, endAt: at + 1 }), [
      { model: 'gemini-3.1-flash-lite', calls: 2 },
      { model: 'gemini-3.5-flash-lite', calls: 1 },
    ]);
  } finally {
    store.close();
  }
});
