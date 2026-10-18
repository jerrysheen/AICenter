import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStore } from '../packages/database/src/index.js';
import { loadXFocusConfig, composeFocus, keywordFocus, rankAutoLikeCandidates, buildDrift, nextAutoLikeSettings } from '../packages/domain/src/x-focus.js';
import { createXFocusScorer } from '../packages/domain/src/x-focus-score.js';
import { createXFocusService } from '../packages/domain/src/x-auto-like.js';
import { selectFocusExpansions, createXHomeBrowserClient } from '../packages/connectors/src/x/home-browser.js';
import { tweetToFeedItem } from '../packages/connectors/src/x/home-timeline.js';
import { createXLikeBrowserPort, buildXLikeExpression, buildXUnlikeExpression } from '../packages/connectors/src/x/like-browser.js';
import { createFeedInteractionService } from '../packages/domain/src/feed-interaction-service.js';
import { createFeedInteractionJobHandlers } from '../packages/runtime/src/feed-interaction-module.js';
import { LikeContentInputSchema, X_LIKE_JOB_TYPE, X_UNLIKE_JOB_TYPE } from '../packages/contracts/src/feed-interaction.js';
import { createAiCenterServer } from '../apps/web/src/server.js';

const config = loadXFocusConfig(path.join(process.cwd(), 'config'));
const NOW = Date.parse('2026-10-18T04:00:00+08:00');

function dirScores(dir, score) {
  return Object.fromEntries(config.directions.map((item) => [item.id, item.id === dir ? score : 0]));
}

function modelBody(dir, score, extra = {}) {
  return JSON.stringify({
    dirScores: dirScores(dir, score),
    sensitive: extra.sensitive === true,
    officialSpeech: extra.officialSpeech === true,
    reason: extra.reason || '油价上涨',
  });
}

function batchBody(count, dir = 'oil-geopolitics', score = 0.9) {
  return JSON.stringify(Array.from({ length: count }, (_, idx) => ({
    idx,
    dirScores: dirScores(dir, score),
    sensitive: false,
    officialSpeech: false,
    reason: '油价',
  })));
}

function modelFocus(dir, score, extra = {}) {
  return {
    ...composeFocus(dirScores(dir, score), config),
    sensitive: false,
    officialSpeech: false,
    reason: '油价上涨',
    method: 'model',
    version: config.version,
    ...extra,
  };
}

function memoryCache() {
  const rows = new Map();
  return {
    rows,
    read(_workspaceId, tweetId, version) {
      return rows.get(`${tweetId}:${version}`) || null;
    },
    write(_workspaceId, tweetId, version, output) {
      rows.set(`${tweetId}:${version}`, output);
    },
  };
}

function scorerEnv(extra = {}) {
  return {
    GEMINI_API_KEY: 'test-key',
    GEMINI_API_KEY2: 'test-key-2',
    AI_CENTER_HARNESS_HOURLY_PROVIDER: '',
    AI_CENTER_HARNESS_HOURLY_MODEL: 'grok-should-not-be-used',
    ...extra,
  };
}

test('x-focus view is served before the generic feed platform route', async () => {
  const store = createStore(':memory:');
  const app = createAiCenterServer({ store, host: '127.0.0.1', port: 0, feedFilter: null });
  const address = await app.listen();
  try {
    const view = await fetch(`${address.localUrl}/api/v1/feed/x-focus`).then((response) => response.json());
    assert.equal(view.ok, true);
    assert.equal(view.autoLike.environmentOn, false);
    assert.equal(view.autoLike.pageOn, false);
    assert.equal(Object.hasOwn(view, 'dirScores'), false);
    const rejected = await fetch(`${address.localUrl}/api/v1/feed/x-focus/auto-like`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"enabled":"yes"}',
    });
    assert.equal(rejected.status, 400);
  } finally {
    await app.close();
    store.close();
  }
});

test('x-focus config keeps seven directions and the highest oil weight', () => {
  assert.equal(config.version, 'x-focus-1');
  assert.deepEqual(config.directions.map((dir) => dir.id), [
    'us-market', 'semis', 'polymarket', 'oil-geopolitics', 'corporate', 'hardware', 'ai-companies',
  ]);
  assert.equal(config.directions.find((dir) => dir.id === 'oil-geopolitics').weight, 3);
  assert.equal(config.autoLike.dailyLimit, 20);
  assert.equal(config.autoLike.hourlyLimit, 5);
  assert.equal(config.autoLike.minIntervalMs, 120_000);
  assert.equal(config.batchSize, 20);
  assert.equal(config.maxExpand, 8);
});

test('focus batches parse together, fall back per card, and cache only model scores', async () => {
  const cache = memoryCache();
  const calls = [];
  let mode = 'batch';
  const scorer = createXFocusScorer({
    config,
    env: scorerEnv(),
    cache,
    now: () => NOW,
    complete: async (input) => {
      calls.push(input);
      const payload = JSON.parse(input.message);
      if (!Array.isArray(payload)) return { answer: modelBody('oil-geopolitics', 0.9) };
      if (mode === 'bad-batch') return { answer: 'not json' };
      if (mode === 'partial') {
        const rows = JSON.parse(batchBody(payload.length));
        delete rows[1].sensitive;
        return { answer: JSON.stringify(rows) };
      }
      return { answer: batchBody(payload.length) };
    },
  });
  const cards = [
    { id: '101', text: '原油跳涨' },
    { id: '102', text: '无关内容' },
  ];
  const first = await scorer.scoreCards(cards);
  assert.equal(calls.length, 1);
  assert.match(calls[0].instruction, /JSON 数组/);
  assert.equal(calls[0].model, 'gemini-3.1-flash-lite');
  assert.equal(first.byId['101'].method, 'model');
  assert.equal(first.byId['101'].focusScore, 0.9);
  assert.equal(first.byId['101'].primaryDir, 'oil-geopolitics');
  assert.equal(cache.rows.size, 2);

  const second = await scorer.scoreCards(cards);
  assert.equal(calls.length, 1);
  assert.equal(second.byId['101'].method, 'cache');

  mode = 'bad-batch';
  const fallback = await scorer.scoreCards([{ id: '201', text: '新帖' }, { id: '202', text: '另一帖' }]);
  assert.equal(calls.length, 4);
  assert.doesNotMatch(calls[2].instruction, /JSON 数组/);
  assert.equal(fallback.byId['201'].method, 'model');
  assert.equal(cache.rows.has('201:x-focus-1'), true);

  mode = 'partial';
  const before = calls.length;
  const partial = await scorer.scoreCards([{ id: '301', text: '甲' }, { id: '302', text: '乙' }]);
  assert.equal(calls.length, before + 2);
  assert.equal(partial.byId['301'].method, 'model');
  assert.equal(partial.byId['302'].method, 'model');
  assert.equal(cache.rows.has('301:x-focus-1'), true);
});

test('scoring times out to keywords, rotates quota, and never calls Grok', async () => {
  const cache = memoryCache();
  const timeoutScorer = createXFocusScorer({
    config,
    env: scorerEnv(),
    cache,
    now: () => NOW,
    complete: async () => {
      const error = new Error('timed out');
      error.code = 'timeout';
      throw error;
    },
  });
  const timed = await timeoutScorer.scoreCards([{ id: '401', text: 'WTI 原油跳涨' }]);
  assert.equal(timed.byId['401'].method, 'keyword');
  assert.ok(timed.byId['401'].focusScore >= 0.75);
  assert.equal(timed.byId['401'].primaryDir, 'oil-geopolitics');
  assert.equal(cache.rows.size, 0);
  assert.equal(keywordFocus('随便聊聊', config).focusScore, 0);

  const seen = [];
  const quotaScorer = createXFocusScorer({
    config,
    env: scorerEnv(),
    now: () => NOW,
    complete: async (input) => {
      seen.push(input.keyEnv);
      if (seen.length === 1) {
        const error = new Error('quota');
        error.status = 429;
        throw error;
      }
      return { answer: modelBody('semis', 0.8) };
    },
  });
  const rotated = await quotaScorer.scoreCards([{ id: '402', text: '英伟达' }]);
  assert.deepEqual(seen, ['GEMINI_API_KEY', 'GEMINI_API_KEY2']);
  assert.equal(rotated.byId['402'].primaryDir, 'semis');

  const fetches = [];
  const direct = createXFocusScorer({
    config,
    env: scorerEnv({ AI_CENTER_HARNESS_HOURLY_PROVIDER: 'elucid-grok' }),
    now: () => NOW,
    agentRuntime: { run: async () => { throw new Error('grok must not score'); } },
    fetchImpl: async (url, init) => {
      fetches.push({ url, init });
      return {
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: modelBody('hardware', 0.9) }] } }] }),
      };
    },
  });
  const hardware = await direct.scoreCards([{ id: '403', text: 'H100 租金' }]);
  assert.equal(hardware.byId['403'].primaryDir, 'hardware');
  assert.equal(fetches.length, 1);
  assert.match(fetches[0].url, /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3\.1-flash-lite:generateContent/);
  assert.equal(fetches[0].init.headers['x-goog-api-key'], 'test-key');
  assert.doesNotMatch(fetches[0].url, /grok|key=/i);

  const runs = [];
  const google = createXFocusScorer({
    config,
    env: scorerEnv({
      AI_CENTER_HARNESS_HOURLY_PROVIDER: 'google',
      AI_CENTER_HARNESS_HOURLY_MODEL: 'gemini-3.1-flash-lite',
    }),
    now: () => NOW,
    fetchImpl: async () => { throw new Error('direct gemini must not run'); },
    agentRuntime: {
      run: async (input) => {
        runs.push(input);
        return { answer: modelBody('ai-companies', 0.9) };
      },
    },
  });
  const companies = await google.scoreCards([{ id: '404', text: 'OpenAI' }]);
  assert.equal(companies.byId['404'].primaryDir, 'ai-companies');
  assert.equal(runs[0].closedTask, 'hourly-brief');
  assert.equal(runs[0].usageStage, 'x-focus');
  assert.equal(runs[0].googleKeyEnv, 'GEMINI_API_KEY');
  assert.match(runs[0].googleModel, /flash-lite/);
});

test('a batch larger than 20 is split and a short deadline stays on keywords', async () => {
  const calls = [];
  const scorer = createXFocusScorer({
    config,
    env: scorerEnv(),
    now: () => 1_000,
    complete: async (input) => {
      calls.push(JSON.parse(input.message).length);
      return { answer: batchBody(JSON.parse(input.message).length) };
    },
  });
  const cards = Array.from({ length: 21 }, (_, index) => ({ id: String(500 + index), text: '原油' }));
  await scorer.scoreCards(cards, { deadlineAt: 20_000 });
  assert.deepEqual(calls, [20, 1]);
  const rushed = await scorer.scoreCards([{ id: '600', text: '原油' }], { deadlineAt: 2_000 });
  assert.equal(calls.length, 2);
  assert.equal(rushed.byId['600'].method, 'keyword');
});

test('home capture expands only the highest focus cards and at most eight', async () => {
  const items = Array.from({ length: 10 }, (_, index) => ({
    tweet_id: String(index + 1),
    text: `card ${index}`,
  }));
  const byId = Object.fromEntries(items.map((item, index) => [item.tweet_id, {
    focusScore: index === 0 ? 0.2 : 0.9,
    rank: index,
  }]));
  const plan = selectFocusExpansions(items, { minScore: 0.75, maxExpand: 8, byId });
  assert.equal(plan.mode, 'selected');
  assert.equal(plan.expandIds.size, 8);
  assert.equal(plan.expandIds.has('1'), false);
  assert.equal(plan.items[0].x_focus.focusScore, 0.2);
  assert.equal(selectFocusExpansions(items, null).mode, 'all');

  const cards = [
    { tweet_id: '11', tweet_url: 'https://x.com/a/status/11', text: '低分卡片', truncated: true, reply_count: 4, author_handle: 'a' },
    { tweet_id: '22', tweet_url: 'https://x.com/a/status/22', text: '原油', truncated: true, reply_count: 2, author_handle: 'a' },
  ];
  const navigated = [];
  const runtime = {
    async withSession(_options, callback) {
      return callback({
        async navigate(url) { navigated.push(url); },
        async evaluate(expression) {
          const source = String(expression);
          if (source.includes('tweetText')) {
            const opened = [...navigated].reverse().find((url) => url.includes('/status/'));
            if (opened) {
              const id = opened.match(/status\/(\d+)/)[1];
              const card = cards.find((item) => item.tweet_id === id);
              return { items: [{ ...card, text: `${card.text} 全文`, truncated: false }] };
            }
            return { items: cards };
          }
          if (source.includes('x-status-comments')) return { comments: [{ text: '评论' }] };
          return { url: 'https://x.com/home', title: 'Home', logged_in: true, login_wall: false, selected_tab: 'For you' };
        },
      });
    },
  };
  const client = createXHomeBrowserClient({
    browserRuntime: runtime,
    delay: async () => {},
    scoreHomeCards: async () => ({
      minScore: 0.75,
      maxExpand: 8,
      byId: {
        11: { focusScore: 0.2, rank: 0.2, reason: '无关' },
        22: { focusScore: 0.9, rank: 2.7, reason: '油价' },
      },
    }),
  });
  const selected = await client.fetchHomeTimeline({ feed: 'for-you', limit: 5 });
  assert.deepEqual(navigated.filter((url) => url.includes('/status/')), ['https://x.com/a/status/22']);
  assert.equal(selected.tweets.find((tweet) => tweet.tweet_id === '11').text, '低分卡片');
  assert.match(selected.tweets.find((tweet) => tweet.tweet_id === '22').text, /全文/);
  assert.equal(selected.tweets.find((tweet) => tweet.tweet_id === '11').x_focus.focusScore, 0.2);
  const mapped = tweetToFeedItem(selected.tweets.find((tweet) => tweet.tweet_id === '22'));
  assert.equal(mapped.xFocus.focusScore, 0.9);
  assert.equal('x_focus' in mapped, false);

  navigated.length = 0;
  const closed = createXHomeBrowserClient({
    browserRuntime: runtime,
    delay: async () => {},
    scoreHomeCards: async () => { throw new Error('score failed'); },
  });
  await closed.fetchHomeTimeline({ feed: 'for-you', limit: 5 });
  assert.equal(navigated.some((url) => url.includes('/status/')), false);
});

function capture(tweetId, focus, metadata = {}) {
  return {
    contentItemId: randomUUID(),
    externalId: tweetId,
    title: '测试帖',
    sourceUrl: `https://x.com/a/status/${tweetId}`,
    capturedAt: NOW,
    sourceExternalId: 'home:for-you',
    metadata: { filterDecision: 'KEEP', xFocus: focus, ...metadata },
  };
}

function autoService(env, state, calls) {
  return createXFocusService({
    config,
    env,
    now: () => state.now,
    feedRepository: { listRecentXCaptures: () => state.rows },
    runtimeRepository: {
      listJobsByType: (type) => state.jobs.filter((job) => job.type === type),
      listOpenJobs: (type) => (type === X_UNLIKE_JOB_TYPE ? state.openUnlike : state.openLike),
    },
    snapshots: {
      readSnapshot: () => ({ payload: state.settings }),
      saveSnapshot: (_workspace, _key, payload) => { state.settings = payload; },
    },
    requestLike: (_workspace, input) => {
      calls.push(input);
      state.jobs.push({ type: X_LIKE_JOB_TYPE, createdAt: state.now, input, status: 'queued' });
      return { id: 'like-job' };
    },
  });
}

test('auto like keeps the highest kept card and respects switches, limits and duplicates', async () => {
  const oil = capture('1001', modelFocus('oil-geopolitics', 0.8));
  const chip = capture('1002', modelFocus('semis', 0.95));
  const low = capture('1003', modelFocus('oil-geopolitics', 0.74));
  const sensitive = capture('1004', modelFocus('oil-geopolitics', 0.99, { sensitive: true }));
  const speech = capture('1005', modelFocus('polymarket', 0.99, { officialSpeech: true }));
  const keyword = capture('1006', { ...modelFocus('oil-geopolitics', 0.9), method: 'keyword' });
  const dropped = capture('1007', modelFocus('oil-geopolitics', 0.99), { filterDecision: 'DROP' });
  const state = {
    now: NOW,
    rows: [oil, chip, low, sensitive, speech, keyword, dropped],
    jobs: [],
    openLike: [],
    openUnlike: [],
    settings: { pageEnabled: false, suspended: false, notice: '', consecutiveUnconfirmed: 0 },
  };
  const calls = [];
  const env = { AI_CENTER_X_AUTO_LIKE: '' };
  const service = autoService(env, state, calls);

  assert.equal((await service.dispatch('local')).dispatched, false);
  env.AI_CENTER_X_AUTO_LIKE = '1';
  assert.equal((await service.dispatch('local')).dispatched, false);
  assert.equal(calls.length, 0);
  service.setPageEnabled('local', true);
  const first = await service.dispatch('local');
  assert.equal(first.dispatched, true);
  assert.equal(first.tweetId, oil.externalId);
  assert.equal(calls[0].source, 'auto');
  assert.equal(calls[0].contentItemId, oil.contentItemId);
  assert.equal(calls[0].directionLabel, '油价大宗与地缘');

  assert.equal((await service.dispatch('local')).reason, 'limit');
  state.now = NOW + 121_000;
  const next = await service.dispatch('local');
  assert.equal(next.tweetId, chip.externalId);

  state.jobs = [];
  state.rows = [oil];
  state.jobs.push({
    type: X_LIKE_JOB_TYPE,
    createdAt: NOW - 20 * 60 * 60 * 1000,
    input: { source: 'manual', contentItemId: oil.contentItemId, tweetId: oil.externalId },
    status: 'completed',
    output: { status: 'liked' },
  });
  assert.equal((await service.dispatch('local')).reason, 'empty');

  state.jobs = Array.from({ length: 5 }, () => ({
    type: X_LIKE_JOB_TYPE,
    createdAt: state.now - 1_000,
    input: { source: 'auto', contentItemId: randomUUID(), tweetId: String(8000 + Math.random()) },
    status: 'completed',
  }));
  state.rows = [chip];
  assert.equal((await service.dispatch('local')).reason, 'limit');

  state.jobs = Array.from({ length: 20 }, (_, index) => ({
    type: X_LIKE_JOB_TYPE,
    createdAt: state.now - 2 * 60 * 60 * 1000 - index * 1000,
    input: { source: 'auto', contentItemId: randomUUID(), tweetId: String(7000 + index) },
    status: 'completed',
  }));
  assert.equal((await service.dispatch('local')).reason, 'limit');

  state.jobs = [];
  state.openLike = [{ id: 'open' }];
  assert.equal((await service.dispatch('local')).reason, 'busy');
  state.openLike = [];
  state.settings = { pageEnabled: true, suspended: true, notice: '已停止', consecutiveUnconfirmed: 0 };
  assert.equal((await service.dispatch('local')).dispatched, false);
});

test('login wall, block and two unconfirmed likes stop auto like', () => {
  const current = { pageEnabled: true, suspended: false, notice: '', consecutiveUnconfirmed: 0 };
  const once = nextAutoLikeSettings(current, 'unconfirmed');
  assert.equal(once.suspended, false);
  assert.equal(once.consecutiveUnconfirmed, 1);
  const stopped = nextAutoLikeSettings(once, 'unconfirmed');
  assert.equal(stopped.suspended, true);
  assert.match(stopped.notice, /连续两次/);
  assert.equal(nextAutoLikeSettings(stopped, 'liked').pageEnabled, false);
  const cleared = nextAutoLikeSettings(once, 'liked');
  assert.equal(cleared.consecutiveUnconfirmed, 0);
  assert.match(nextAutoLikeSettings(current, 'login-required').notice, /重新登录/);
  assert.match(nextAutoLikeSettings(current, 'blocked').notice, /被拦截/);

  const state = {
    now: NOW,
    rows: [capture('2001', modelFocus('oil-geopolitics', 0.9))],
    jobs: [],
    openLike: [],
    openUnlike: [],
    settings: { pageEnabled: true, suspended: false, notice: '', consecutiveUnconfirmed: 0 },
  };
  const service = autoService({ AI_CENTER_X_AUTO_LIKE: 'on' }, state, []);
  service.recordAutoLike('local', { status: 'unconfirmed' });
  service.recordAutoLike('local', { status: 'unconfirmed' });
  assert.equal(state.settings.suspended, true);
  assert.equal(service.view('local').autoLike.pageOn, false);
  assert.match(service.view('local').autoLike.notice, /连续两次/);
  assert.equal(JSON.stringify(service.view('local')).includes('dirScores'), false);
  assert.equal(JSON.stringify(service.view('local')).includes('focusScore'), false);
  assert.equal(JSON.stringify(service.view('local')).includes('primaryDir'), false);
});

test('drift alerts when today is more than 30 percent under the recent average', () => {
  const rows = [];
  for (let day = 1; day <= 4; day += 1) {
    const at = NOW - day * 86_400_000;
    rows.push({ capturedAt: at, feed: 'for-you', focus: modelFocus('oil-geopolitics', 0.9) });
    rows.push({ capturedAt: at, feed: 'for-you', focus: modelFocus('oil-geopolitics', 0.9) });
  }
  rows.push({ capturedAt: NOW, feed: 'for-you', focus: modelFocus('oil-geopolitics', 0.9) });
  rows.push({ capturedAt: NOW, feed: 'for-you', focus: modelFocus('us-market', 0.1) });
  const drift = buildDrift(rows, [{ createdAt: NOW, output: { status: 'liked' } }], config, NOW);
  assert.equal(drift.likes.at(-1), 1);
  assert.ok(drift.alerts.some((message) => message.includes('油价大宗与地缘') && message.includes('推荐')));
});

test('unlike is a separate manual command and a repeated like does not undo', async () => {
  const id = randomUUID();
  const item = { id, provider: 'x', externalId: '123456789', sourceUrl: 'https://x.com/author/status/123456789' };
  const store = createStore(':memory:');
  const unlikeCalls = [];
  const autoNotes = [];
  const interaction = createFeedInteractionService({
    runtimeRepository: store,
    feedRepository: { getContentItem: (workspace, target) => (workspace === 'local' && target === id ? item : null) },
    likePort: {
      like: async () => ({ status: 'liked', accountHandle: 'fixture', checkedAt: 1 }),
      unlike: async (postId) => {
        unlikeCalls.push(postId);
        return { status: 'unliked', accountHandle: 'fixture', checkedAt: 1 };
      },
    },
  });
  try {
    assert.deepEqual(LikeContentInputSchema.parse({ contentItemId: id }), { contentItemId: id });
    const like = interaction.requestLike('local', {
      contentItemId: id,
      source: 'auto',
      tweetId: '123456789',
      focusScore: 0.91,
      primaryDir: 'oil-geopolitics',
      directionLabel: '油价大宗与地缘',
      reason: '油价',
    });
    assert.equal(like.type, X_LIKE_JOB_TYPE);
    assert.equal(like.input.source, 'auto');
    assert.throws(() => interaction.requestUnlike('local', { contentItemId: id }));
    const handlers = createFeedInteractionJobHandlers(interaction, {
      onAutoLike: (_workspace, output) => { autoNotes.push(output.status); },
    });
    const claimed = store.claimNextJob('fixture', [X_LIKE_JOB_TYPE]);
    const output = await handlers[X_LIKE_JOB_TYPE](claimed.input, { job: claimed });
    store.completeJob(like.id, output, { workerId: 'fixture', attemptCount: claimed.attemptCount });
    assert.deepEqual(autoNotes, ['liked']);
    assert.deepEqual(unlikeCalls, []);

    const manual = interaction.requestLike('local', { contentItemId: id });
    const manualClaim = store.claimNextJob('fixture', [X_LIKE_JOB_TYPE]);
    await handlers[X_LIKE_JOB_TYPE](manualClaim.input, { job: manualClaim });
    store.completeJob(manual.id, { status: 'already-liked', accountHandle: 'fixture', checkedAt: 1 }, { workerId: 'fixture', attemptCount: manualClaim.attemptCount });
    assert.deepEqual(autoNotes, ['liked']);

    const unlike = interaction.requestUnlike('local', { contentItemId: id });
    assert.equal(unlike.type, X_UNLIKE_JOB_TYPE);
    assert.deepEqual(unlike.input, { contentItemId: id });
    const unlikeClaim = store.claimNextJob('fixture', [X_UNLIKE_JOB_TYPE]);
    const unlikeOutput = await handlers[X_UNLIKE_JOB_TYPE](unlikeClaim.input, { job: unlikeClaim });
    assert.equal(unlikeOutput.status, 'unliked');
    assert.deepEqual(unlikeCalls, ['123456789']);

    const reads = [];
    const session = {
      navigate: async () => {},
      evaluate: async (expression) => {
        reads.push(expression.includes(', true,'));
        if (expression.includes(', true,')) return { status: 'unconfirmed', accountHandle: 'fixture', checkedAt: 1 };
        return { status: 'already-liked', accountHandle: 'fixture', checkedAt: 1 };
      },
    };
    const likePort = createXLikeBrowserPort({ browserRuntime: { withSession: async (_options, call) => call(session) }, delay: async () => {} });
    assert.equal((await likePort.like('123456789')).status, 'already-liked');
    assert.equal(reads.includes(true), false);
    assert.match(buildXLikeExpression('123456789'), /already-liked/);
    assert.match(buildXUnlikeExpression('123456789'), /not-liked/);

    let clicks = 0;
    let index = 0;
    const states = ['not-liked'];
    const idle = createXLikeBrowserPort({
      browserRuntime: {
        withSession: async (_options, call) => call({
          navigate: async () => {},
          evaluate: async (expression) => {
            if (expression.includes(', true,')) clicks += 1;
            return { status: states[Math.min(index++, states.length - 1)], accountHandle: 'fixture', checkedAt: 1 };
          },
        }),
      },
      delay: async () => {},
    });
    assert.equal((await idle.unlike('123456789')).status, 'not-liked');
    assert.equal(clicks, 0);

    clicks = 0;
    index = 0;
    const likedStates = ['liked', 'not-liked', 'not-liked'];
    const active = createXLikeBrowserPort({
      browserRuntime: {
        withSession: async (_options, call) => call({
          navigate: async () => {},
          evaluate: async (expression) => {
            if (expression.includes(', true,')) {
              clicks += 1;
              return { status: 'unconfirmed', accountHandle: 'fixture', checkedAt: 1 };
            }
            return { status: likedStates[Math.min(index++, likedStates.length - 1)], accountHandle: 'fixture', checkedAt: 1 };
          },
        }),
      },
      delay: async () => {},
    });
    assert.equal((await active.unlike('123456789')).status, 'unliked');
    assert.equal(clicks, 1);
  } finally {
    store.close();
  }
});
