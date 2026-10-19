import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createBambooStartLuxClient,
  matchedNoulLabels,
  noulWireVariants,
  readChoiceAnswer,
  readScoreAnswer,
  resolveBambooApiKey,
} from '../packages/connectors/src/bamboo-startlux.js';
import { openClassificationClient, resolveClassificationProvider } from '../packages/domain/src/classification-provider.js';
import { hitsAt, labelMetrics, selectComparisonItems } from '../packages/domain/src/bamboo-label-eval.js';
import { createFeedFilterFromEnv } from '../packages/domain/src/feed-filter.js';
import { createFeedValueRefreshService } from '../packages/domain/src/feed-value-refresh-service.js';
import { isJevOutage } from '../packages/domain/src/jev-enabled.js';
import { createReadingHourService } from '../packages/domain/src/reading-hour-service.js';
import { createStore } from '../packages/database/src/index.js';
import { resolveAgentQualityConfig, createAgentQualityLayerFromEnv } from '../packages/runtime/src/agent-quality.js';
import { createOptionalAgentQuality } from '../apps/worker/src/worker.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const labelQuestions = JSON.parse(readFileSync(path.join(root, 'config/bamboo-label-questions.json'), 'utf8'));
const fixtures = JSON.parse(readFileSync(path.join(root, 'config/bamboo-label-fixtures.json'), 'utf8'));
const secret = 'bamboo-test-secret';

function client(fetch, env = {}, extra = {}) {
  return createBambooStartLuxClient({
    env: { BAMBOO_API_KEY: secret, ...env },
    fetch,
    ...extra,
  });
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const sampleQuestions = {
  a_share: { type: 'noul', instructions: labelQuestions.questions[0].instructions, criteria: labelQuestions.questions[0].criteria },
  chinext: { type: 'noul', instructions: labelQuestions.questions[1].instructions, criteria: labelQuestions.questions[1].criteria },
  optical: { type: 'noul', instructions: labelQuestions.questions[2].instructions, criteria: labelQuestions.questions[2].criteria },
};

test('Bamboo stays off unless selected, and the key is only the environment variable', () => {
  assert.equal(resolveClassificationProvider({}), 'typesafe');
  assert.equal(resolveClassificationProvider({ AI_CENTER_CLASSIFICATION_PROVIDER: 'bamboo' }), 'bamboo');
  assert.equal(resolveBambooApiKey({ BAMBOO_API_KEY: 'from-env' }), 'from-env');
  assert.equal(resolveBambooApiKey({}), '');
  const ignored = createBambooStartLuxClient({ apiKey: 'ignored', env: {} });
  assert.equal(ignored.available(), false);
  assert.equal(openClassificationClient({ AI_CENTER_JEV_ENABLED: 'false' }, {
    typesafeClient: { id: 'jev' },
    createBamboo: () => ({ id: 'bamboo' }),
  }).id, 'jev');
  assert.equal(openClassificationClient({ AI_CENTER_CLASSIFICATION_PROVIDER: 'bamboo', AI_CENTER_JEV_ENABLED: 'false' }, {
    typesafeClient: { id: 'jev' },
    createBamboo: () => ({ id: 'bamboo' }),
  }).id, 'bamboo');
});

test('noul criteria stay on the question instead of being folded into instructions', () => {
  const variants = noulWireVariants(sampleQuestions.chinext);
  assert.equal(variants.withCriteria.instructions, variants.instructionsOnly.instructions);
  assert.match(variants.withCriteria.criteria.true, /创业板/);
  assert.match(variants.withCriteria.criteria.false, /初创/);
  assert.equal(variants.instructionsOnly.criteria, undefined);
  assert.match(variants.withCriteria.instructions, /创业公司/);
});

test('one article keeps every noul, including multiple hits and a total miss', async () => {
  const bodies = [];
  const bamboo = client(async (url, init) => {
    bodies.push(JSON.parse(init.body));
    assert.equal(init.redirect, 'manual');
    assert.equal(url, 'https://api.bamboonode.dev/v1/decisions');
    assert.equal(url.includes(secret), false);
    assert.equal(init.headers.Authorization, `Bearer ${secret}`);
    assert.equal(init.body.includes('think_budget'), false);
    return jsonResponse({
      model: 'startlux-decision-27b-autothink',
      answers: {
        a_share: { type: 'noul', noul: 0.91 },
        chinext: { type: 'noul', noul: 0.62 },
        optical: { type: 'noul', noul: 0.88 },
      },
      usage: { input_tokens: 40, output_tokens: 0 },
    });
  });
  const state = { title: '中际旭创光模块', body: '创业板公司出货增加' };
  const result = await bamboo.evaluate({ state, questions: sampleQuestions });
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].think_mode, 'auto');
  assert.deepEqual(bodies[0].state, state);
  assert.equal(bodies[0].questions.a_share.criteria.false.includes('港股'), true);
  assert.deepEqual(matchedNoulLabels(result.answers, 0.5).map((row) => row.id), ['a_share', 'chinext', 'optical']);
  assert.equal(result.answers.chinext.noul, 0.62);
  const miss = await client(async () => jsonResponse({
    model: 'startlux-decision-27b-autothink',
    answers: {
      a_share: { type: 'noul', noul: 0.05 },
      chinext: { type: 'noul', noul: 0.04 },
      optical: { type: 'noul', noul: 0.02 },
    },
  })).evaluate({ state: { title: '创业公司融资' }, questions: sampleQuestions });
  assert.deepEqual(matchedNoulLabels(miss.answers, 0.5), []);
});

test('illegal noul values are contract errors and are not coerced to zero', async () => {
  const cases = [
    [{ a_share: { type: 'noul', noul: 0.2 } }, '缺少'],
    [{ a_share: { type: 'noul', noul: '0.4' }, chinext: { type: 'noul', noul: 0.2 }, optical: { type: 'noul', noul: 0.2 } }, '不是 0 到 1'],
    [{ a_share: { type: 'noul', noul: true }, chinext: { type: 'noul', noul: 0.2 }, optical: { type: 'noul', noul: 0.2 } }, '不是 0 到 1'],
    [{ a_share: { type: 'noul', noul: 1.4 }, chinext: { type: 'noul', noul: 0.2 }, optical: { type: 'noul', noul: 0.2 } }, '不是 0 到 1'],
    [{ a_share: { type: 'noul', noul: -0.1 }, chinext: { type: 'noul', noul: 0.2 }, optical: { type: 'noul', noul: 0.2 } }, '不是 0 到 1'],
  ];
  for (const [answers, pattern] of cases) {
    await assert.rejects(() => client(async () => jsonResponse({
      model: 'startlux-decision-27b-autothink',
      answers,
    })).evaluate({ state: 'x', questions: sampleQuestions }), (error) => {
      assert.equal(error.code, 'BAMBOO_CONTRACT');
      assert.match(error.message, new RegExp(pattern));
      return true;
    });
  }
});

test('HTML, missing answers, redirect, size, timeout and HTTP statuses stay distinct and do not retry', async () => {
  const html = client(async () => new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
  await assert.rejects(() => html.evaluate({ state: 'x', questions: { a: { type: 'noul', instructions: 'yes?' } } }), (error) => error.code === 'BAMBOO_BAD_RESPONSE');

  let redirects = 0;
  const redirecting = client(async () => {
    redirects += 1;
    return new Response('', { status: 302, headers: { location: 'https://evil.example/collect' } });
  });
  await assert.rejects(() => redirecting.evaluate({ state: 'x', questions: { a: { type: 'noul', instructions: 'yes?' } } }), (error) => error.code === 'BAMBOO_REDIRECT');
  assert.equal(redirects, 1);

  const huge = client(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json', 'content-length': '2000000' } }), {}, { maxBytes: 1000 });
  await assert.rejects(() => huge.evaluate({ state: 'x', questions: { a: { type: 'noul', instructions: 'yes?' } } }), (error) => error.code === 'BAMBOO_BAD_RESPONSE');

  let timed = 0;
  const slow = client(async (_url, init) => {
    timed += 1;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 400);
      init.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });
    return jsonResponse({});
  }, {}, { timeoutMs: 20 });
  await assert.rejects(() => slow.evaluate({ state: 'x', questions: { a: { type: 'noul', instructions: 'yes?' } } }), (error) => error.code === 'BAMBOO_TIMEOUT');
  assert.equal(timed, 1);

  const statuses = [[401, 'BAMBOO_UNAUTHORIZED'], [403, 'BAMBOO_FORBIDDEN'], [422, 'BAMBOO_UNPROCESSABLE'], [429, 'BAMBOO_RATE_LIMIT'], [502, 'BAMBOO_UPSTREAM']];
  for (const [status, code] of statuses) {
    let calls = 0;
    const bamboo = client(async () => {
      calls += 1;
      return jsonResponse({ error: 'no' }, status);
    });
    await assert.rejects(() => bamboo.evaluate({ state: 'x', questions: { a: { type: 'noul', instructions: 'yes?' } } }), (error) => error.code === code && error.status === status);
    assert.equal(calls, 1);
  }
});

test('logs and errors do not keep the key', async () => {
  const lines = [];
  const bamboo = client(async () => {
    throw new Error(`network failed Authorization: Bearer ${secret} url?key=${secret}`);
  }, {}, { log: (line) => lines.push(line) });
  await assert.rejects(() => bamboo.evaluate({ state: 'x', questions: { a: { type: 'noul', instructions: 'yes?' } } }), (error) => {
    assert.equal(error.code, 'BAMBOO_NETWORK_ERROR');
    assert.equal(error.message.includes(secret), false);
    assert.match(error.message, /Bearer \[redacted\]/);
    return true;
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /provider=bamboo/);
  assert.match(lines[0], /category=network/);
  assert.equal(lines[0].includes(secret), false);
  let fetched = 0;
  const leaked = createBambooStartLuxClient({
    env: { BAMBOO_API_KEY: secret, AI_CENTER_BAMBOO_ENDPOINT: `https://api.bamboonode.dev/v1/decisions?key=${secret}` },
    fetch: async () => { fetched += 1; return jsonResponse({}); },
  });
  await assert.rejects(() => leaked.evaluate({ state: 'x', questions: { a: { type: 'noul', instructions: 'yes?' } } }), (error) => {
    assert.equal(error.code, 'BAMBOO_UNAVAILABLE');
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.equal(fetched, 0);
});

test('choice null and score bounds are preserved without forcing a winner', () => {
  const choice = readChoiceAnswer({
    type: 'choice', choice: null, none_probability: 0.7, probabilities: { billing: 0.8, tech: 0.2 },
  });
  assert.equal(choice.choice, null);
  assert.equal(choice.noneProbability, 0.7);
  assert.equal(choice.probabilities.billing, 0.8);
  assert.equal(readScoreAnswer({ type: 'score', score: 1.3, probabilities: { 0: 0.1, 1: 0.5, 2: 0.4 } }, 3).score, 1.3);
  assert.throws(() => readScoreAnswer({ type: 'score', score: 3 }, 3), (error) => error.code === 'BAMBOO_CONTRACT');
});

test('disabled JEV keeps the fallback, and Bamboo replaces it only when selected', async () => {
  let calls = 0;
  const refusing = {
    available: () => true,
    async evaluate() { calls += 1; throw new Error('should not run'); },
  };
  const closed = createFeedFilterFromEnv({
    env: { AI_CENTER_JEV_ENABLED: 'false', AI_CENTER_FEED_FILTER: 'enforce' },
    client: refusing,
  });
  const fallback = await closed.evaluate({
    provider: 'x',
    originalText: '关注流里的一条完整更新。',
    item: { provider: 'x', title: '关注', body: '关注流里的一条完整更新。', sourceExternalId: 'x:home:following' },
  });
  assert.equal(calls, 0);
  assert.equal(fallback.metadata.filterReason, 'jev-disabled-following');

  const opened = createFeedFilterFromEnv({
    env: {
      AI_CENTER_JEV_ENABLED: 'false',
      AI_CENTER_CLASSIFICATION_PROVIDER: 'bamboo',
      AI_CENTER_FEED_FILTER: 'enforce',
    },
    client: {
      modelId: 'startlux-decision-27b-autothink',
      available: () => true,
      async evaluate() {
        calls += 1;
        return {
          model: 'startlux-decision-27b-autothink',
          answers: {
            reading_value: { type: 'noul', noul: 0.91 },
            advertising: { type: 'noul', noul: 0.05 },
            specific_content: { type: 'noul', noul: 0.9 },
            sufficient_information: { type: 'noul', noul: 0.88 },
            missing_context: { type: 'noul', noul: 0.04 },
          },
        };
      },
    },
  });
  const kept = await opened.evaluate({
    provider: 'x',
    originalText: '关注流里的一条完整更新，写了订单和金额。',
    item: { provider: 'x', title: '订单', body: '关注流里的一条完整更新，写了订单和金额。', sourceExternalId: 'x:home:following' },
  });
  assert.equal(calls, 1);
  assert.equal(kept.metadata.filterReason, 'all-three');
  assert.equal(kept.metadata.filterScores.reading_value, 0.91);
});

test('reading hour asks Bamboo when JEV is off and the provider is bamboo', async () => {
  const node = {
    id: 'n1', sourceId: 's1', version: '1', title: '公司拿到新订单', text: '订单金额已经公布。', publisher: '来源',
  };
  const calls = [];
  const reading = createReadingHourService({
    enabled: true,
    env: { AI_CENTER_JEV_ENABLED: 'false', AI_CENTER_CLASSIFICATION_PROVIDER: 'bamboo' },
    client: {
      available: () => true,
      async evaluate() {
        calls.push('evaluate');
        return { model: 'startlux-decision-27b-autothink', answers: { CO_EVENT: { type: 'noul', noul: 0.22 } } };
      },
    },
    repository: {
      listInformationInWindow: () => [node],
      publishReadingHour: (_workspace, snapshot) => ({ published: true, snapshot }),
    },
    agentRuntime: {
      async run() {
        return { answer: '{"primaryDirection":"industry","subjectKind":"company_event","domainTagIds":[],"classificationStatus":"classified","evidenceQuote":"订单"}' };
      },
    },
    log: () => {},
  });
  const result = await reading.scoreWindow({ window: { startAt: 10, endAt: 20 } });
  assert.equal(calls.length, 1);
  assert.equal(result.snapshot.items[0].questions.CO_EVENT.score, 0.22);
  assert.equal(result.snapshot.items[0].questions.CO_EVENT.reason, undefined);
  assert.equal(result.snapshot.items[0].disposition, 'miss');
});

test('quality checks turn back on for Bamboo and stay off when the provider is unchanged', () => {
  const off = { AI_CENTER_JEV_ENABLED: 'false' };
  assert.equal(resolveAgentQualityConfig(off).disabled, true);
  assert.equal(createOptionalAgentQuality(undefined, off), null);
  const bamboo = { ...off, AI_CENTER_CLASSIFICATION_PROVIDER: 'bamboo', BAMBOO_API_KEY: secret };
  assert.equal(resolveAgentQualityConfig(bamboo).disabled, false);
  assert.equal(resolveAgentQualityConfig(bamboo).evidenceGateMode, 'enforce');
  assert.equal(resolveAgentQualityConfig({ ...bamboo, AI_CENTER_JEV_DISABLED: '1' }).disabled, true);
  assert.ok(createAgentQualityLayerFromEnv({
    env: bamboo,
    client: { available: () => true, evaluate: async () => ({ answers: {} }) },
  }));
  assert.ok(createOptionalAgentQuality(undefined, bamboo));
  assert.equal(isJevOutage({ code: 'BAMBOO_TIMEOUT' }), true);
  assert.equal(isJevOutage({ code: 'BAMBOO_CONTRACT', status: 200 }), false);
  assert.equal(isJevOutage({ code: 'BAMBOO_UNPROCESSABLE', status: 422 }), false);
});

test('quality refresh calls Bamboo only after the provider is selected', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-bamboo-refresh-'));
  const store = createStore(path.join(directory, 'test.db'));
  try {
    const feed = store.repositories.feed;
    const source = feed.upsertSourceAccount({
      workspaceId: 'local', provider: 'x', externalId: 'x:home:following', displayName: '关注',
    });
    const capture = feed.saveCapture({
      workspaceId: 'local', provider: 'x', externalId: 'follow', sourceAccountId: source.id,
      contentHash: 'follow', metadata: { originalText: '关注流里的一条完整更新，包含订单金额。' },
    });
    feed.saveContentItem({
      workspaceId: 'local', captureId: capture.id, originType: 'subscription', contentType: 'post',
      title: '关注', body: '关注流里的一条完整更新，包含订单金额。',
    });
    let calls = 0;
    const service = createFeedValueRefreshService({
      feedRepository: feed,
      model: 'startlux-decision-27b-autothink',
      jevEnabled: false,
      classificationProvider: 'bamboo',
      client: {
        async evaluate() {
          calls += 1;
          return {
            model: 'startlux-decision-27b-autothink',
            answers: {
              reading_value: { type: 'noul', noul: 0.9 },
              advertising: { type: 'noul', noul: 0.1 },
              specific_content: { type: 'noul', noul: 0.9 },
              sufficient_information: { type: 'noul', noul: 0.9 },
              missing_context: { type: 'noul', noul: 0.05 },
            },
          };
        },
      },
    });
    const result = await service.refresh({ concurrency: 1 }, { runId: 'bamboo' });
    assert.equal(calls, 1);
    assert.equal(result.KEEP, 1);
    assert.equal(feed.getCapture('local', 'x', 'follow').metadata.filterReason, 'all-three');
    assert.equal(feed.getCapture('local', 'x', 'follow').metadata.filterScores.reading_value, 0.9);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('label metrics skip unlabeled rows and tags that have no positive example', () => {
  const picked = selectComparisonItems([
    { id: '1', provider: 'x', title: '光伏电站并网', body: '' },
    { id: '2', provider: 'x', title: '普通帖子', body: '' },
    { id: '3', provider: 'media', title: '创业板光模块', body: '' },
    { id: '4', provider: 'media', title: '另一条', body: '' },
  ], { limit: 3 });
  assert.equal(picked.some((item) => item.title.includes('光伏')), true);
  assert.equal(picked.some((item) => item.title.includes('创业板')), true);
  assert.equal(picked.length, 3);
  const metrics = labelMetrics([
    { id: 'a', title: '未标', human: null, scores: { optical: 0.9 } },
    { id: 'b', title: '港股光缆', human: ['optical'], scores: { optical: 0.2, a_share: 0.1, chinext: 0.1 } },
  ], ['a_share', 'chinext', 'optical'], 0.5);
  assert.equal(metrics.a_share.reason, '无正例，不算分');
  assert.equal(metrics.optical.recall, 0);
  assert.equal(metrics.optical.misses[0].kind, 'fn');
  assert.equal(fixtures.items.find((item) => item.id === 'fx-startup').human.length, 0);
  assert.deepEqual(hitsAt({ a_share: 0.9, chinext: 0.2, optical: 0.8 }, 0.5), ['a_share', 'optical']);
});
