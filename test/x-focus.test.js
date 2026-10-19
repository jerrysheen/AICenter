import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { createStore } from '../packages/database/src/index.js';
import { runMigrations } from '../packages/database/src/migrations.js';
import { createReportRepository } from '../packages/database/src/repositories/report-repository.js';
import { loadXFocusConfig, composeFocus, keywordFocus, rankAutoLikeCandidates, buildDrift, buildDriftFromSnapshot, nextAutoLikeSettings, shanghaiDayStart, autoLikeLimits, xFocusInstruction, looksLikeOfficialBrandAccount, storedFocus } from '../packages/domain/src/x-focus.js';
import { looksLikeFeedAd } from '../packages/domain/src/feed-ad.js';
import { createXFocusScorer, X_FOCUS_SCORE_RESERVE_MS } from '../packages/domain/src/x-focus-score.js';
import { createXFocusService, KEYWORD_RESCORE_LIMIT, FOCUS_POINT_LIMIT } from '../packages/domain/src/x-auto-like.js';
import { createFeedInteractionRoutes } from '../apps/web/src/routes/feed-interaction-routes.js';
import { selectFocusExpansions, fallbackFocusExpansions, createXHomeBrowserClient, rankTruncatedExpansions } from '../packages/connectors/src/x/home-browser.js';
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
  assert.equal(config.version, 'x-focus-2');
  assert.deepEqual(config.driftCompatibleVersions, ['x-focus-1']);
  assert.deepEqual(config.directions.map((dir) => dir.id), [
    'us-market', 'semis', 'polymarket', 'oil-geopolitics', 'corporate', 'hardware', 'ai-companies',
  ]);
  assert.equal(config.directions.find((dir) => dir.id === 'oil-geopolitics').weight, 3);
  assert.match(config.directions.find((dir) => dir.id === 'corporate').question, /产品宣传、折扣和官号广告不算/);
  assert.equal(config.autoLike.dailyLimit, 8);
  assert.equal(config.autoLike.hourlyLimit, 2);
  assert.equal(config.autoLike.minIntervalMs, 900_000);
  const overridden = autoLikeLimits(config, {
    AI_CENTER_X_AUTO_LIKE_DAILY: '3',
    AI_CENTER_X_AUTO_LIKE_HOURLY: '1',
    AI_CENTER_X_AUTO_LIKE_INTERVAL_MS: '60000',
  });
  assert.equal(overridden.dailyLimit, 3);
  assert.equal(overridden.hourlyLimit, 1);
  assert.equal(overridden.minIntervalMs, 60_000);
  assert.equal(autoLikeLimits(config, { AI_CENTER_JEV_ENABLED: 'false' }).minScore, 0.9);
  assert.equal(autoLikeLimits(config, {
    AI_CENTER_JEV_ENABLED: 'false',
    AI_CENTER_CLASSIFICATION_PROVIDER: 'bamboo',
  }).minScore, 0.75);
  assert.equal(autoLikeLimits(config, {}).minScore, 0.75);
  assert.match(xFocusInstruction(config), /孙宇晨/);
  assert.match(xFocusInstruction(config), /promotional/);
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
  assert.equal(cache.rows.has('201:x-focus-2'), true);

  mode = 'partial';
  const before = calls.length;
  const partial = await scorer.scoreCards([{ id: '301', text: '甲' }, { id: '302', text: '乙' }]);
  assert.equal(calls.length, before + 2);
  assert.equal(partial.byId['301'].method, 'model');
  assert.equal(partial.byId['302'].method, 'model');
  assert.equal(cache.rows.has('301:x-focus-2'), true);
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
  assert.deepEqual(seen, ['GEMINI_API_KEY']);
  assert.equal(rotated.byId['402'].method, 'keyword');

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
  assert.equal(runs[0].googleKeyEnv, undefined);
  assert.equal(runs[0].googleModel, undefined);
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
  assert.deepEqual(navigated.filter((url) => url.includes('/status/')), ['https://x.com/a/status/22', 'https://x.com/a/status/11']);
  assert.match(selected.tweets.find((tweet) => tweet.tweet_id === '11').text, /全文/);
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
  assert.deepEqual(navigated.filter((url) => url.includes('/status/')), [
    'https://x.com/a/status/11',
    'https://x.com/a/status/22',
  ]);
});

const SUBSTANTIAL = '布伦特原油供应持续趋紧，交易员正在重估油价，以及相关公司未来两个季度的订单和库存情况。';

function capture(tweetId, focus, metadata = {}, extra = {}) {
  return {
    contentItemId: randomUUID(),
    externalId: tweetId,
    title: extra.title || '测试帖',
    text: extra.text === undefined ? SUBSTANTIAL : extra.text,
    authorHandle: extra.authorHandle || '',
    authorName: extra.authorName || '',
    authorVerified: extra.authorVerified || '',
    sourceUrl: extra.sourceUrl || `https://x.com/a/status/${tweetId}`,
    capturedAt: extra.capturedAt || NOW,
    sourceExternalId: extra.sourceExternalId || 'home:for-you',
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

test('auto like skips KEEP produced by the local fallback', async () => {
  const following = capture('3001', modelFocus('oil-geopolitics', 0.99), { filterReason: 'jev-disabled-following' });
  const capped = capture('3002', modelFocus('oil-geopolitics', 0.98), { filterReason: 'fallback-following' });
  const usage = capture('3003', modelFocus('oil-geopolitics', 0.97), { filterReason: 'fallback-xfocus' });
  const real = capture('3004', modelFocus('oil-geopolitics', 0.8), { filterReason: 'all-three' });
  const asCandidate = (row) => ({
    contentItemId: row.contentItemId,
    tweetId: row.externalId,
    text: row.text,
    title: row.title,
    metadata: row.metadata,
    focus: row.metadata.xFocus,
    capturedAt: row.capturedAt,
  });
  const ranked = rankAutoLikeCandidates(
    [following, capped, usage, real].map(asCandidate),
    [],
    { ...config, limits: config.autoLike },
    NOW,
  );
  assert.equal(ranked.eligible, 1);
  assert.equal(ranked.picked.tweetId, real.externalId);
  const state = {
    now: NOW,
    rows: [following, capped, usage, real],
    jobs: [],
    openLike: [],
    openUnlike: [],
    settings: { pageEnabled: true, suspended: false, notice: '', consecutiveUnconfirmed: 0 },
  };
  const calls = [];
  const dispatched = await autoService({ AI_CENTER_X_AUTO_LIKE: '1' }, state, calls).dispatch('local');
  assert.equal(dispatched.tweetId, real.externalId);
  assert.equal(calls.length, 1);
});

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
  state.now = NOW + 15 * 60 * 1000 + 1_000;
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

test('auto like skips ads, official brands, promotions and one-line posts', async () => {
  const long = SUBSTANTIAL;
  const ad = capture('3101', modelFocus('hardware', 0.99), {}, { text: `${long} 扩展坞折扣和优惠码` });
  const recruit = capture('3102', modelFocus('hardware', 0.99), {}, { text: `${long} 承接代投，推广链接返佣` });
  const official = capture('3103', modelFocus('corporate', 0.99), {}, { text: long, authorName: 'XXX Official' });
  const named = capture('3104', modelFocus('corporate', 0.99), {}, { text: long, authorHandle: 'brand', authorName: 'XX官方' });
  const verified = capture('3105', modelFocus('semis', 0.99), {}, { text: long, authorHandle: 'minisforum', authorVerified: 'business' });
  const promo = capture('3106', modelFocus('hardware', 0.99, { promotional: true }), {}, { text: long });
  const short = capture('3107', modelFocus('semis', 0.99), {}, { text: '我空单吃够了' });
  const imageOnly = capture('3108', modelFocus('semis', 0.99), {}, { text: '' });
  const followingAd = capture('3109', modelFocus('oil-geopolitics', 0.99), {}, {
    text: `${long} 模型接口打折接入`,
    sourceExternalId: 'home:following',
  });
  const kept = capture('3110', modelFocus('semis', 0.8), {}, { text: long, sourceExternalId: 'home:following' });
  const state = {
    now: NOW,
    rows: [ad, recruit, official, named, verified, promo, short, imageOnly, followingAd, kept],
    jobs: [],
    openLike: [],
    openUnlike: [],
    settings: { pageEnabled: true, suspended: false, notice: '', consecutiveUnconfirmed: 0, consecutiveUnavailable: 0 },
  };
  const calls = [];
  const service = autoService({ AI_CENTER_X_AUTO_LIKE: '1' }, state, calls);
  const picked = await service.dispatch('local');
  assert.equal(picked.tweetId, kept.externalId);
  assert.equal(calls[0].focusScore, 0.8);
  assert.equal(calls[0].directionLabel, '半导体与科技美股');
  assert.equal(calls[0].reason, '油价上涨');
});

test('personal Global names stay eligible while official wording and business verification do not', async () => {
  assert.equal(looksLikeOfficialBrandAccount({ name: 'Global Macro Guy', handle: 'gmacro' }), false);
  assert.equal(looksLikeOfficialBrandAccount({ name: 'Global Macro Guy' }, { promotional: true }), false);
  assert.equal(looksLikeOfficialBrandAccount({ handle: 'macroglobal', name: 'Macro' }), false);
  assert.equal(looksLikeOfficialBrandAccount({ handle: 'ZeekrGlobal' }), false);
  assert.equal(looksLikeOfficialBrandAccount({ handle: 'brand', name: 'XPENG_Global' }), false);
  assert.equal(looksLikeOfficialBrandAccount({ handle: 'BinanceGlobal' }, { promotional: true }), true);
  assert.equal(looksLikeOfficialBrandAccount({ handle: 'XPENG_Global' }, { promotional: true }), true);
  assert.equal(looksLikeOfficialBrandAccount({ handle: 'brand-Global' }, { promotional: true }), true);
  assert.equal(looksLikeOfficialBrandAccount({ name: 'XXX Official' }), true);
  assert.equal(looksLikeOfficialBrandAccount({ handle: 'Unofficial' }), false);
  assert.equal(looksLikeOfficialBrandAccount({ name: 'Unofficial Macro' }), false);
  assert.equal(looksLikeOfficialBrandAccount({ handle: 'BrandOfficial' }), true);
  assert.equal(looksLikeOfficialBrandAccount({ name: 'XX官方' }), true);
  assert.equal(looksLikeOfficialBrandAccount({ verified: 'business' }), true);
  assert.equal(looksLikeOfficialBrandAccount({ verified: 'government' }), true);
  assert.equal(looksLikeOfficialBrandAccount({ verified: 'true' }), false);
  assert.equal(looksLikeFeedAd('公司发布招募说明书'), false);
  assert.equal(looksLikeFeedAd('公司发布招募说明书', { strict: true }), true);
  assert.equal(looksLikeFeedAd('债券折价发行'), false);
  assert.equal(looksLikeFeedAd('债券折价发行', { strict: true }), false);
  assert.equal(looksLikeFeedAd(`${SUBSTANTIAL} 折扣和优惠码`), false);
  assert.equal(looksLikeFeedAd(`${SUBSTANTIAL} 折扣和优惠码`, { strict: true }), true);

  const long = SUBSTANTIAL;
  const macroGuy = capture('3401', modelFocus('oil-geopolitics', 0.9), {}, { text: long, authorHandle: 'gmacro', authorName: 'Global Macro Guy' });
  const glued = capture('3402', modelFocus('oil-geopolitics', 0.8), {}, { text: long, authorHandle: 'macroglobal' });
  const suffix = capture('3403', modelFocus('corporate', 0.99), {}, { text: long, authorHandle: 'ZeekrGlobal' });
  const displayGlobal = capture('3404', modelFocus('corporate', 0.99), {}, { text: long, authorHandle: 'brand', authorName: 'XPENG_Global' });
  const official = capture('3405', modelFocus('semis', 0.99), {}, { text: long, authorName: 'XXX Official' });
  const cnOfficial = capture('3406', modelFocus('semis', 0.99), {}, { text: long, authorName: 'XX官方' });
  const business = capture('3407', modelFocus('semis', 0.99), {}, { text: long, authorVerified: 'business' });
  const promoGlobal = capture('3408', modelFocus('semis', 0.99, { promotional: true }), {}, { text: long, authorHandle: 'BinanceGlobal' });
  const state = {
    now: NOW,
    rows: [macroGuy, glued, suffix, displayGlobal, official, cnOfficial, business, promoGlobal],
    jobs: [],
    openLike: [],
    openUnlike: [],
    settings: { pageEnabled: true, suspended: false, notice: '', consecutiveUnconfirmed: 0 },
  };
  const calls = [];
  const service = autoService({ AI_CENTER_X_AUTO_LIKE: '1' }, state, calls);
  const picked = await service.dispatch('local');
  assert.equal(picked.tweetId, macroGuy.externalId);
  assert.equal(calls[0].focusScore, 0.9);
  const ranked = rankAutoLikeCandidates(state.rows.map((row) => ({
    ...row,
    tweetId: row.externalId,
    focus: row.metadata.xFocus,
  })), [], { ...config, limits: config.autoLike }, NOW);
  assert.equal(ranked.eligible, 4);
  assert.equal(ranked.picked.externalId, '3401');
});

test('corporate likes need 0.9 while other directions keep the lower floor', async () => {
  const corporate = capture('3201', modelFocus('corporate', 0.85));
  const chip = capture('3202', modelFocus('semis', 0.8));
  const state = {
    now: NOW,
    rows: [corporate, chip],
    jobs: [],
    openLike: [],
    openUnlike: [],
    settings: { pageEnabled: true, suspended: false, notice: '', consecutiveUnconfirmed: 0 },
  };
  const calls = [];
  const service = autoService({ AI_CENTER_X_AUTO_LIKE: '1' }, state, calls);
  assert.equal((await service.dispatch('local')).tweetId, chip.externalId);
  state.jobs = [];
  state.rows = [capture('3203', modelFocus('corporate', 0.9))];
  state.now = NOW + 15 * 60 * 1000 + 1_000;
  assert.equal((await service.dispatch('local')).tweetId, '3203');
});

test('jev off raises the auto like floor to 0.9', async () => {
  const low = capture('3301', modelFocus('semis', 0.85));
  const high = capture('3302', modelFocus('semis', 0.9));
  const state = {
    now: NOW,
    rows: [low, high],
    jobs: [],
    openLike: [],
    openUnlike: [],
    settings: { pageEnabled: true, suspended: false, notice: '', consecutiveUnconfirmed: 0 },
  };
  const service = autoService({ AI_CENTER_X_AUTO_LIKE: '1', AI_CENTER_JEV_ENABLED: 'false' }, state, []);
  assert.equal((await service.dispatch('local')).tweetId, high.externalId);
  state.jobs = [];
  state.rows = [low];
  state.now = NOW + 15 * 60 * 1000 + 1_000;
  assert.equal((await service.dispatch('local')).reason, 'empty');
});

test('two failed auto like jobs stop before another like is sent', async () => {
  const ready = {
    pageEnabled: true,
    suspended: false,
    notice: '',
    consecutiveUnconfirmed: 0,
    consecutiveUnavailable: 0,
    consecutiveTaskErrors: 0,
    failureWatchReady: true,
    notedFailureIds: [],
  };
  const once = {
    ...ready,
    jobs: [{
      id: 'err-1',
      type: X_LIKE_JOB_TYPE,
      status: 'failed',
      createdAt: NOW - 2 * 86_400_000,
      input: { source: 'auto', contentItemId: randomUUID(), tweetId: '4101' },
      error: { name: 'WorkerLeaseExpired', message: '后台进程中断，任务租约已过期' },
    }],
  };
  const state = {
    now: NOW,
    rows: [capture('4102', modelFocus('semis', 0.95))],
    jobs: once.jobs,
    openLike: [],
    openUnlike: [],
    settings: { ...ready },
  };
  const calls = [];
  const service = autoService({ AI_CENTER_X_AUTO_LIKE: '1' }, state, calls);
  const continued = await service.dispatch('local');
  assert.equal(continued.dispatched, true);
  assert.equal(state.settings.suspended, false);
  assert.equal(state.settings.consecutiveTaskErrors, 1);
  assert.equal(calls.length, 1);

  state.jobs = [
    once.jobs[0],
    {
      id: 'err-2',
      type: X_LIKE_JOB_TYPE,
      status: 'failed',
      createdAt: NOW - 2 * 86_400_000 + 1_000,
      input: { source: 'auto', contentItemId: randomUUID(), tweetId: '4103' },
      error: { name: 'WorkerRunTimeout', message: '任务运行超过时限，已释放以便队列继续' },
    },
  ];
  state.now = NOW + 15 * 60 * 1000 + 1_000;
  const stopped = await service.dispatch('local');
  assert.equal(stopped.dispatched, false);
  assert.equal(calls.length, 1);
  assert.equal(state.settings.pageEnabled, false);
  assert.equal(state.settings.suspended, true);
  assert.match(state.settings.notice, /连续两次/);
  assert.match(state.settings.notice, /任务运行超过时限/);
  const stoppedSettings = state.settings;
  service.setPageEnabled('local', true);
  const resumed = await service.dispatch('local');
  assert.equal(resumed.dispatched, true);
  assert.equal(state.settings.suspended, false);

  const cleared = nextAutoLikeSettings(stoppedSettings, 'liked');
  assert.equal(cleared.consecutiveTaskErrors, 0);
  assert.equal(cleared.suspended, true);
});

test('a thrown auto like is reported and two handler failures stop', async () => {
  const notes = [];
  const handlers = createFeedInteractionJobHandlers({
    executeLike: async () => {
      const error = new Error('后台进程中断，任务租约已过期');
      error.name = 'WorkerLeaseExpired';
      throw error;
    },
  }, {
    onAutoLike: (_workspace, output) => { notes.push(output); },
  });
  await assert.rejects(
    () => handlers[X_LIKE_JOB_TYPE]({ source: 'auto', contentItemId: 'item' }, { job: { id: 'job-1', workspaceId: 'local' } }),
    (error) => error.name === 'WorkerLeaseExpired',
  );
  await assert.rejects(
    () => handlers[X_LIKE_JOB_TYPE]({ source: 'manual', contentItemId: 'item' }, { job: { id: 'job-manual', workspaceId: 'local' } }),
  );
  assert.equal(notes.length, 1);
  assert.equal(notes[0].status, 'failed');
  assert.equal(notes[0].jobId, 'job-1');
  assert.match(notes[0].reason, /进程中断/);

  const state = {
    now: NOW,
    rows: [],
    jobs: [],
    openLike: [],
    openUnlike: [],
    settings: { pageEnabled: true, suspended: false, notice: '', consecutiveUnconfirmed: 0, consecutiveUnavailable: 0 },
  };
  const service = autoService({ AI_CENTER_X_AUTO_LIKE: '1' }, state, []);
  service.recordAutoLike('local', notes[0]);
  assert.equal(state.settings.suspended, false);
  service.recordAutoLike('local', { status: 'failed', reason: '任务运行超过时限，已释放以便队列继续', jobId: 'job-2' });
  assert.equal(state.settings.suspended, true);
  assert.match(state.settings.notice, /连续两次/);
  assert.match(state.settings.notice, /任务运行超过时限/);
  service.recordAutoLike('local', notes[0]);
  assert.equal(state.settings.consecutiveTaskErrors, 2);
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

test('scoring shares one deadline, runs three batches, and does not fan out hard errors', async () => {
  const clock = { at: 1_000_000 };
  const seen = [];
  const limited = createXFocusScorer({
    config,
    env: scorerEnv(),
    now: () => clock.at,
    complete: async (input) => {
      seen.push({ timeoutMs: input.timeoutMs, signal: input.signal });
      return { answer: modelBody('oil-geopolitics', 0.9) };
    },
  });
  const controller = new AbortController();
  const scored = await limited.scoreCards([{ id: 'deadline', text: '原油' }], {
    deadlineAt: clock.at + 20_000,
    signal: controller.signal,
  });
  assert.equal(seen[0].timeoutMs, 5_000);
  assert.equal(seen[0].signal, controller.signal);
  assert.equal(X_FOCUS_SCORE_RESERVE_MS, 15_000);
  assert.equal(scored.byId.deadline.method, 'model');

  const skipped = [];
  const short = createXFocusScorer({
    config,
    env: scorerEnv(),
    now: () => clock.at,
    complete: async () => { skipped.push(1); return { answer: modelBody('oil-geopolitics', 0.9) }; },
  });
  const early = await short.scoreCards([{ id: 'early', text: '原油' }], { deadlineAt: clock.at + X_FOCUS_SCORE_RESERVE_MS + 2_000 });
  assert.equal(skipped.length, 0);
  assert.equal(early.byId.early.method, 'keyword');

  const stopped = await short.scoreCards([{ id: 'stop', text: '原油' }], { signal: AbortSignal.abort(), deadlineAt: clock.at + 60_000 });
  assert.equal(skipped.length, 0);
  assert.equal(stopped.byId.stop.method, 'keyword');

  for (const status of [429, 500]) {
    const calls = [];
    const failing = createXFocusScorer({
      config,
      env: scorerEnv({ GEMINI_API_KEY2: 'second', GEMINI_API_KEY3: 'third' }),
      now: () => clock.at,
      complete: async (input) => {
        calls.push(input.keyEnv);
        const error = new Error(status === 429 ? 'quota' : 'upstream');
        error.status = status;
        throw error;
      },
    });
    const result = await failing.scoreCards([{ id: 'a', text: '甲' }, { id: 'b', text: '乙' }]);
    assert.equal(calls.length, 1);
    assert.equal(result.byId.a.method, 'keyword');
    assert.equal(result.byId.b.method, 'keyword');
  }

  const networkCalls = [];
  const network = createXFocusScorer({
    config,
    env: scorerEnv(),
    now: () => clock.at,
    complete: async () => {
      networkCalls.push(1);
      const error = new Error('fetch failed');
      error.code = 'ECONNRESET';
      throw error;
    },
  });
  const networked = await network.scoreCards([{ id: 'net', text: '原油供应' }]);
  assert.equal(networkCalls.length, 1);
  assert.equal(networked.byId.net.method, 'keyword');

  const retries = [];
  const invalid = createXFocusScorer({
    config,
    env: scorerEnv(),
    now: () => clock.at,
    complete: async (input) => {
      retries.push(JSON.parse(input.message));
      if (Array.isArray(retries.at(-1))) return { answer: 'not-json' };
      return { answer: modelBody('oil-geopolitics', 0.88) };
    },
  });
  const many = Array.from({ length: 7 }, (_, index) => ({ id: `bad-${index}`, text: `帖子${index}` }));
  const retried = await invalid.scoreCards(many);
  assert.equal(retries.length, 6);
  assert.equal(retried.byId['bad-0'].method, 'model');
  assert.equal(retried.byId['bad-4'].method, 'model');
  assert.equal(retried.byId['bad-5'].method, 'keyword');
  assert.equal(retried.byId['bad-6'].method, 'keyword');

  let active = 0;
  let peak = 0;
  const parallel = createXFocusScorer({
    config,
    env: scorerEnv(),
    now: () => clock.at,
    complete: async (input) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { answer: batchBody(JSON.parse(input.message).length) };
    },
  });
  const cards = Array.from({ length: 41 }, (_, index) => ({ id: `p-${index}`, text: '原油' }));
  const together = await parallel.scoreCards(cards, { deadlineAt: clock.at + 60_000 });
  assert.equal(peak, 3);
  assert.equal(together.byId['p-40'].method, 'model');
});

function homeRuntime(cards, selectedTab) {
  const navigated = [];
  return {
    navigated,
    browserRuntime: {
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
            if (source.includes('x-status-comments')) return { comments: [] };
            return { url: 'https://x.com/home', title: 'Home', logged_in: true, login_wall: false, selected_tab: selectedTab };
          },
        });
      },
    },
  };
}

test('following still expands truncated posts and a scoring failure keeps a fallback', async () => {
  const tweets = Array.from({ length: 9 }, (_, index) => ({
    tweet_id: String(300 + index),
    tweet_url: `https://x.com/a/status/${300 + index}`,
    text: `关注帖 ${index}`,
    truncated: true,
    author_handle: 'alice',
  }));
  const low = Object.fromEntries(tweets.map((tweet) => [tweet.tweet_id, {
    focusScore: 0.1, rank: 0.1, reason: '低', method: 'model',
  }]));
  const followed = homeRuntime(tweets, 'Following');
  const client = createXHomeBrowserClient({
    browserRuntime: followed.browserRuntime,
    delay: async () => {},
    scoreHomeCards: async () => ({ minScore: 0.75, maxExpand: 8, byId: low }),
  });
  const following = await client.fetchHomeTimeline({ feed: 'following', limit: 9 });
  assert.equal(followed.navigated.filter((url) => url.includes('/status/')).length, 9);
  assert.equal(following.tweets[0].x_focus.focusScore, 0.1);

  const recommendedRuntime = homeRuntime(tweets, 'For you');
  const recommendedClient = createXHomeBrowserClient({
    browserRuntime: recommendedRuntime.browserRuntime,
    delay: async () => {},
    scoreHomeCards: async () => ({ minScore: 0.75, maxExpand: 8, byId: low }),
  });
  const recommended = await recommendedClient.fetchHomeTimeline({ feed: 'for-you', limit: 9 });
  assert.equal(recommendedRuntime.navigated.filter((url) => url.includes('/status/')).length, 8);
  assert.equal(recommended.tweets.length, 9);

  const fallbackCards = [
    { tweet_id: '1', tweet_url: 'https://x.com/a/status/1', text: '短', truncated: true, author_handle: 'a' },
    { tweet_id: '2', tweet_url: 'https://x.com/a/status/2', text: '油'.repeat(30), truncated: true, author_handle: 'a' },
    { tweet_id: '3', tweet_url: 'https://x.com/a/status/3', text: '中'.repeat(20), truncated: true, author_handle: 'a' },
    { tweet_id: '4', tweet_url: 'https://x.com/a/status/4', text: `${'长'.repeat(40)} 原油跳涨`, truncated: true, author_handle: 'a' },
  ];
  const brokenRuntime = homeRuntime(fallbackCards, 'For you');
  const broken = createXHomeBrowserClient({
    browserRuntime: brokenRuntime.browserRuntime,
    delay: async () => {},
    focusKeywords: ['原油'],
    scoreHomeCards: async () => { throw new Error('score down'); },
  });
  await broken.fetchHomeTimeline({ feed: 'for-you', limit: 4 });
  assert.deepEqual(brokenRuntime.navigated.filter((url) => url.includes('/status/')), [
    'https://x.com/a/status/4',
    'https://x.com/a/status/2',
    'https://x.com/a/status/3',
    'https://x.com/a/status/1',
  ]);
  const plain = fallbackFocusExpansions([
    { tweet_id: 'a', text: '一' },
    { tweet_id: 'b', text: '二二' },
    { tweet_id: 'c', text: '三三三' },
    { tweet_id: 'd', text: '四四四四' },
  ], []);
  assert.deepEqual([...plain.expandIds], ['d', 'c', 'b']);
  assert.deepEqual(rankTruncatedExpansions([
    { tweet_id: 'short', text: '短', x_focus: { focusScore: 0.2 } },
    { tweet_id: 'long-low', text: '很长的低分帖', x_focus: { focusScore: 0.1 } },
    { tweet_id: 'valued', text: '短但更值得展开', x_focus: { focusScore: 0.95 } },
  ]).map((item) => item.tweet_id), ['valued', 'short', 'long-low']);
});

test('drift snapshot ignores keyword rows, page data is cached, and jobs stay in one workspace', async () => {
  const store = createStore(':memory:');
  try {
    const feed = store.repositories.feed;
    const account = feed.upsertSourceAccount({
      workspaceId: 'local', provider: 'x', externalId: 'x:home:for-you', displayName: '推荐',
    });
    const focus = modelFocus('oil-geopolitics', 0.9);
    const captured = feed.saveCapture({
      workspaceId: 'local',
      provider: 'x',
      externalId: '9001',
      sourceAccountId: account.id,
      sourceUrl: 'https://x.com/alice/status/9001',
      title: '原油',
      contentHash: 'hash-9001',
      capturedAt: NOW,
      metadata: { xFocus: focus, filterDecision: 'KEEP' },
    });
    feed.saveCapture({
      workspaceId: 'local',
      provider: 'x',
      externalId: '9002',
      sourceAccountId: account.id,
      sourceUrl: 'https://x.com/alice/status/9002',
      title: '关键词',
      contentHash: 'hash-9002',
      capturedAt: NOW,
      metadata: { xFocus: { ...focus, method: 'keyword', focusScore: 0.2 } },
    });
    const item = feed.saveContentItem({
      workspaceId: 'local',
      captureId: captured.id,
      originType: 'subscription',
      contentType: 'post',
      title: '原油跳涨',
      body: '原油供应收紧',
      sourceUrl: 'https://x.com/alice/status/9001',
    });
    const service = createXFocusService({
      config,
      env: { AI_CENTER_X_AUTO_LIKE: '1' },
      feedRepository: feed,
      runtimeRepository: store,
      snapshots: store.repositories.runtimeSnapshots,
      now: () => NOW,
    });
    const payload = service.refreshDrift('local');
    assert.equal(payload.feeds['for-you']['2026-10-18'].total, 1);
    const page = service.view('local');
    const oil = page.drift.series.find((entry) => entry.name === '油价大宗与地缘');
    assert.equal(oil.recommended.at(-1), 1);
    let reads = 0;
    const original = store.repositories.runtimeSnapshots.readSnapshot.bind(store.repositories.runtimeSnapshots);
    store.repositories.runtimeSnapshots.readSnapshot = (...args) => { reads += 1; return original(...args); };
    service.view('local');
    assert.equal(reads, 0);
    store.createJob({
      workspaceId: 'local',
      type: 'feed.x.like',
      input: { contentItemId: item.id, source: 'manual', focusScore: 0.9, directionLabel: '油价大宗与地缘' },
    });
    assert.equal(store.listJobsByType('feed.x.like', { workspaceId: 'local', since: 0 }).length, 1);
    assert.equal(store.listJobsByType('feed.x.like', { workspaceId: 'other', since: 0 }).length, 0);
    const clock = { at: NOW + 61_000 };
    const cached = createXFocusService({
      config,
      feedRepository: { listXCapturesByContentIds: () => { reads += 1; return []; } },
      runtimeRepository: { listJobsByType: () => [] },
      snapshots: { readSnapshot: () => ({ payload }) },
      now: () => clock.at,
    });
    cached.view('local');
    const before = reads;
    cached.view('local');
    assert.equal(reads, before);
    clock.at += 61_000;
    cached.view('local');
    assert.equal(reads, before + 1);

    const drift = buildDrift([
      { capturedAt: NOW, feed: 'for-you', focus },
      { capturedAt: NOW, feed: 'for-you', focus: { ...focus, method: 'keyword' } },
    ], [], config, NOW);
    assert.equal(drift.series.find((entry) => entry.name === '油价大宗与地缘').recommended.at(-1), 1);

    const repair = createXFocusService({
      config,
      feedRepository: feed,
      scorer: {
        scoreCards: async (cards) => ({
          byId: Object.fromEntries(cards.map((card) => [card.id, { ...modelFocus('semis', 0.8), method: 'model' }])),
        }),
      },
      now: () => NOW,
    });
    const result = await repair.rescoreKeywords('local');
    assert.equal(result.rescored, 1);
    assert.equal(KEYWORD_RESCORE_LIMIT, 40);
    const patched = feed.getCapture('local', 'x', '9002');
    assert.equal(patched.metadata.xFocus.method, 'model');
    assert.equal(patched.metadata.xFocus.primaryDir, 'semis');
  } finally {
    store.close();
  }
});

test('x-focus stage rows older than 14 days are removed', () => {
  const database = new Database(':memory:');
  runMigrations(database);
  const reports = createReportRepository(database, () => {});
  reports.saveAnalysisStage('local', 'x-focus', 'tweet:old', 'x-focus-1', { tweetId: 'old' }, { method: 'model' }, 'completed');
  reports.saveAnalysisStage('local', 'x-focus', 'tweet:new', 'x-focus-1', { tweetId: 'new' }, { method: 'model' }, 'completed');
  reports.saveAnalysisStage('local', '2026-10-01', 'editorial', 'hash', {}, { ok: true }, 'completed');
  database.prepare(`UPDATE daily_analysis_stages SET updated_at = ? WHERE stage_key = 'tweet:old'`).run(NOW - 15 * 86_400_000);
  database.prepare(`UPDATE daily_analysis_stages SET updated_at = ? WHERE report_date = '2026-10-01'`).run(NOW - 15 * 86_400_000);
  assert.equal(reports.deleteAnalysisStagesBefore('local', 'x-focus', NOW - 14 * 86_400_000, '2026-10-18'), 1);
  assert.equal(reports.getAnalysisStage('local', 'x-focus', 'tweet:old', 'x-focus-1'), null);
  assert.equal(reports.getAnalysisStage('local', 'x-focus', 'tweet:new', 'x-focus-1').status, 'completed');
  assert.ok(reports.getAnalysisStage('local', '2026-10-01', 'editorial', 'hash'));
  reports.saveAnalysisStage('local', 'x-focus', 'tweet:later', 'x-focus-1', { tweetId: 'later' }, { method: 'model' }, 'completed');
  database.prepare(`UPDATE daily_analysis_stages SET updated_at = ? WHERE stage_key = 'tweet:later'`).run(NOW - 15 * 86_400_000);
  assert.equal(reports.deleteAnalysisStagesBefore('local', 'x-focus', NOW - 14 * 86_400_000, '2026-10-18'), 0);
  assert.equal(reports.getAnalysisStage('local', 'x-focus', 'tweet:later', 'x-focus-1').status, 'completed');
  const insert = database.prepare(`INSERT INTO daily_analysis_stages VALUES (?,?,?,?,?,?,?,?,?)`);
  for (let index = 0; index < 501; index += 1) {
    insert.run('local', 'x-focus', `tweet:batch-${index}`, 'x-focus-1', '{}', null, 'completed', '', NOW - 15 * 86_400_000);
  }
  assert.equal(reports.deleteAnalysisStagesBefore('local', 'x-focus', NOW - 14 * 86_400_000, '2026-10-19'), 502);
  database.close();
});

test('drift recounts only today and yesterday, and a rescored post is counted once', async () => {
  const store = createStore(':memory:');
  try {
    const feed = store.repositories.feed;
    const account = feed.upsertSourceAccount({
      workspaceId: 'local', provider: 'x', externalId: 'x:home:for-you', displayName: '推荐',
    });
    const focus = modelFocus('oil-geopolitics', 0.9);
    const olderAt = NOW - 3 * 86_400_000;
    feed.saveCapture({
      workspaceId: 'local', provider: 'x', externalId: 'older', sourceAccountId: account.id,
      sourceUrl: 'https://x.com/alice/status/older', title: '较早', contentHash: 'hash-older',
      capturedAt: olderAt, metadata: { xFocus: focus, originalText: 'older crude' },
    });
    feed.saveCapture({
      workspaceId: 'local', provider: 'x', externalId: 'kw', sourceAccountId: account.id,
      sourceUrl: 'https://x.com/alice/status/kw', title: '关键词', contentHash: 'hash-kw',
      capturedAt: NOW,
      metadata: {
        xFocus: { ...focus, method: 'keyword' },
        originalText: 'WTI crude jumped',
      },
    });
    const keywordItem = feed.getCapture('local', 'x', 'kw');
    feed.saveContentItem({
      workspaceId: 'local', captureId: keywordItem.id, originType: 'subscription', contentType: 'post',
      title: '译文标题', body: '原油跳涨的中文译文', sourceUrl: 'https://x.com/alice/status/kw',
    });
    const queries = [];
    const feedPort = {
      ...feed,
      listXFocusPoints: (workspaceId, options) => {
        queries.push(options);
        return feed.listXFocusPoints(workspaceId, options);
      },
    };
    let seenText = '';
    const service = createXFocusService({
      config,
      feedRepository: feedPort,
      snapshots: store.repositories.runtimeSnapshots,
      scorer: {
        scoreCards: async (cards) => {
          seenText = cards[0]?.text || '';
          return { byId: { kw: { ...focus, method: 'model' } } };
        },
      },
      now: () => NOW,
    });
    const first = service.refreshDrift('local');
    assert.equal(first.feeds['for-you']['2026-10-18']?.total || 0, 0);
    assert.equal(first.feeds['for-you']['2026-10-15'].total, 1);
    assert.equal(queries[0].limit, FOCUS_POINT_LIMIT);
    assert.equal(queries[0].since, NOW - 14 * 86_400_000);
    const rescored = await service.rescoreKeywords('local');
    assert.equal(rescored.rescored, 1);
    assert.equal(seenText, 'WTI crude jumped');
    const second = service.refreshDrift('local');
    assert.equal(queries[1].since, shanghaiDayStart(NOW) - 86_400_000);
    assert.equal(queries[1].limit, FOCUS_POINT_LIMIT);
    assert.equal(second.feeds['for-you']['2026-10-18'].total, 1);
    assert.equal(second.feeds['for-you']['2026-10-18'].hits['oil-geopolitics'], 1);
    assert.equal(second.feeds['for-you']['2026-10-15'].total, 1);
    const third = service.refreshDrift('local');
    assert.equal(third.feeds['for-you']['2026-10-18'].total, 1);
    assert.equal(third.feeds['for-you']['2026-10-18'].hits['oil-geopolitics'], 1);
    assert.equal(third.feeds['for-you']['2026-10-15'].total, 1);
    store.repositories.runtimeSnapshots.saveSnapshot('local', 'x-focus-drift', {
      version: 'stale',
      feeds: { 'for-you': { '2020-01-01': { total: 9, hits: {} } }, following: {} },
    }, NOW);
    const rebuilt = service.refreshDrift('local');
    assert.equal(queries.at(-1).since, NOW - 14 * 86_400_000);
    assert.equal(rebuilt.feeds['for-you']['2020-01-01'], undefined);
    assert.equal(rebuilt.feeds['for-you']['2026-10-18'].total, 1);
    assert.equal(rebuilt.version, config.version);
  } finally {
    store.close();
  }
});

test('switching focus version keeps old points on the drift chart and ignores them for likes', async () => {
  const oldFocus = { ...modelFocus('oil-geopolitics', 0.95), version: 'x-focus-1' };
  assert.equal(storedFocus({ xFocus: oldFocus }, config), null);
  assert.equal(storedFocus({ xFocus: modelFocus('oil-geopolitics', 0.95) }, config).version, config.version);
  const legacySnapshot = {
    version: 'x-focus-1',
    feeds: {
      'for-you': { '2026-10-18': { total: 4, hits: { 'oil-geopolitics': 2 } } },
      following: {},
    },
  };
  const shown = buildDriftFromSnapshot(legacySnapshot, [], config, NOW);
  const oil = shown.series.find((entry) => entry.name === '油价大宗与地缘');
  assert.equal(oil.recommended.at(-1), 0.5);
  const unknown = buildDriftFromSnapshot({ ...legacySnapshot, version: 'x-focus-0' }, [], config, NOW);
  assert.equal(unknown.series.find((entry) => entry.name === '油价大宗与地缘').recommended.at(-1), null);

  const store = createStore(':memory:');
  try {
    const feed = store.repositories.feed;
    const account = feed.upsertSourceAccount({
      workspaceId: 'local', provider: 'x', externalId: 'x:home:for-you', displayName: '推荐',
    });
    feed.saveCapture({
      workspaceId: 'local', provider: 'x', externalId: 'legacy', sourceAccountId: account.id,
      sourceUrl: 'https://x.com/alice/status/legacy', title: '旧版本', contentHash: 'hash-legacy',
      capturedAt: NOW,
      metadata: { xFocus: oldFocus, originalText: SUBSTANTIAL, filterDecision: 'KEEP' },
    });
    const captured = feed.getCapture('local', 'x', 'legacy');
    feed.saveContentItem({
      workspaceId: 'local', captureId: captured.id, originType: 'subscription', contentType: 'post',
      title: '旧版本', body: SUBSTANTIAL, sourceUrl: 'https://x.com/alice/status/legacy',
    });
    const calls = [];
    const service = createXFocusService({
      config,
      env: { AI_CENTER_X_AUTO_LIKE: '1' },
      feedRepository: feed,
      runtimeRepository: {
        listJobsByType: () => [],
        listOpenJobs: () => [],
      },
      snapshots: store.repositories.runtimeSnapshots,
      requestLike: () => {
        calls.push('like');
        return { id: 'should-not-like' };
      },
      now: () => NOW,
    });
    service.setPageEnabled('local', true);
    const rebuilt = service.refreshDrift('local');
    assert.equal(rebuilt.version, 'x-focus-2');
    assert.equal(rebuilt.feeds['for-you']['2026-10-18'].total, 1);
    assert.equal(rebuilt.feeds['for-you']['2026-10-18'].hits['oil-geopolitics'], 1);
    const series = service.view('local').drift.series.find((entry) => entry.name === '油价大宗与地缘');
    assert.equal(series.recommended.at(-1), 1);
    const dispatched = await service.dispatch('local');
    assert.equal(dispatched.reason, 'empty');
    assert.equal(dispatched.dispatched, false);
    assert.equal(calls.length, 0);
  } finally {
    store.close();
  }
});

test('unlike clears the recommendation page cache', async () => {
  const routes = createFeedInteractionRoutes();
  const unlike = routes.find((route) => route.method === 'POST' && String(route.path).includes('x-unlike'));
  let invalidated = '';
  const response = { writeHead() {}, end() {} };
  await unlike.handler({
    request: (async function* () { yield Buffer.from('{"confirmed":true}'); })(),
    response,
    services: {
      feedInteraction: { requestUnlike: () => ({ id: randomUUID() }) },
      xFocus: { invalidateView: (workspaceId) => { invalidated = workspaceId; } },
    },
    identity: { device: { workspaceId: 'local' } },
    params: { values: [randomUUID()] },
    events: { flush() {} },
  });
  assert.equal(invalidated, 'local');
});

test('three unavailable likes stop auto-like', () => {
  const current = { pageEnabled: true, suspended: false, notice: '', consecutiveUnconfirmed: 0, consecutiveUnavailable: 0 };
  const once = nextAutoLikeSettings(current, 'unavailable');
  assert.equal(once.pageEnabled, true);
  const twice = nextAutoLikeSettings(once, 'unavailable');
  assert.equal(twice.consecutiveUnavailable, 2);
  const stopped = nextAutoLikeSettings(twice, 'unavailable');
  assert.equal(stopped.pageEnabled, false);
  assert.match(stopped.notice, /连续三次/);
  assert.equal(nextAutoLikeSettings(once, 'liked').consecutiveUnavailable, 0);
});

test('a broken x-focus config does not stop the web server', async () => {
  const store = createStore(':memory:');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'x-focus-bad-'));
  fs.writeFileSync(path.join(directory, 'x-focus.json'), '{');
  const watchlist = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config/polymarket-watchlist.json'), 'utf8'));
  const app = createAiCenterServer({
    store,
    host: '127.0.0.1',
    port: 0,
    feedFilter: null,
    configDirectory: directory,
    runtimeDirectory: directory,
    dataDirectory: directory,
    polymarketWatchlist: watchlist,
  });
  const address = await app.listen();
  try {
    const page = await fetch(`${address.localUrl}/api/v1/feed/x-focus`);
    assert.equal(page.status, 404);
    const denied = await fetch(`${address.localUrl}/api/v1/feed/x-focus/auto-like`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.8' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(denied.status, 401);
  } finally {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
