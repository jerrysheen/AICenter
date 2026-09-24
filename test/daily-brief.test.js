import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../packages/database/src/index.js';
import { buildDailyBriefCandidates } from '../packages/domain/src/daily-brief-candidates.js';
import { assembleDailyBrief, createDailyBriefService, parseDailyBriefModelText } from '../packages/domain/src/daily-brief-service.js';
import { createReportJobHandlers } from '../packages/runtime/src/report-module.js';
import { createAgentRuntime } from '../packages/runtime/src/agent-runtime.js';
import { createToolRegistry } from '../packages/runtime/src/tool-registry.js';
import { createRouter } from '../apps/web/src/http/router.js';
import { createReportRoutes } from '../apps/web/src/routes/report-routes.js';

function temporaryDatabase() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-brief-'));
  return {
    path: path.join(directory, 'test.db'),
    remove: () => rmSync(directory, { recursive: true, force: true }),
  };
}

const factors = {
  value: {
    dividendYield: 0.05,
    dividendYieldPercentile5y: 0.92,
    peTtm: 8,
    pePercentile5y: 0.08,
    pb: 0.7,
    pbPercentile5y: 0.12,
  },
  pain: {
    return20d: -0.06,
    return60d: -0.11,
    return120d: -0.15,
    return252d: -0.04,
    drawdown252d: -0.18,
    distanceToMA20: -0.04,
    distanceToMA60: -0.06,
    distanceToMA120: -0.08,
    distanceToMA250: -0.05,
    breadthAboveMA20: 0.31,
    breadthAboveMA60: 0.28,
  },
  dataQuality: {
    constituentCount: 100,
    coverage: 1,
    earningsCoverage: 1,
    negativePeWeight: 0,
    missingWeight: 0,
    adjustedPrice: true,
  },
  regime: 'NORMAL',
};

function strategy(regime, asOf) {
  return {
    strategyKey: 'cn.dividend.value',
    asOf,
    regime,
    factors: { ...factors, regime },
  };
}

function newsItem(id, eventAt, title = `普通消息 ${id}`) {
  return {
    id,
    title,
    summary: '重复的日常评论，没有新增事实。',
    sourceUrl: 'https://example.com/news',
    authorName: 'feed',
    publishedAt: eventAt,
    createdAt: eventAt,
    capturedAt: eventAt,
    eventAt,
  };
}

function release(releaseId = 'pbc-1') {
  return {
    releaseId,
    country: 'CN',
    authority: '中国人民银行',
    documentType: 'announcement',
    title: '公开市场操作公告',
    publishedAt: 1_700_000_000_000,
    timePrecision: 'date',
    effectiveAt: null,
    documentNumber: null,
    sourceUrl: 'https://www.pbc.gov.cn/example',
    observedAt: 1_700_000_000_000,
  };
}

function board(key) {
  return {
    board: key,
    mode: 'live',
    fetchedAt: 1_700_000_000_000,
    asOf: 1_700_000_000_000,
    indices: [{ symbol: key === 'cn' ? '000300.SS' : '^GSPC', name: key, lastPrice: 10, changePct: 0.001, asOf: 1_700_000_000_000 }],
    note: '最新行情',
  };
}

function report({ date = '2026-09-22', regime = 'VALUE_HIGH_PAIN_HIGH', news = [], releases = [], previous = false } = {}) {
  const asOf = 1_700_000_100_000;
  return {
    id: previous ? 'prev-report' : 'current-report',
    workspaceId: 'local',
    reportDate: date,
    status: 'ready',
    updatedAt: asOf,
    createdAt: asOf,
    content: {
      reportDate: date,
      timezone: 'Asia/Shanghai',
      window: { startAt: asOf - 86_400_000, endAt: asOf },
      upcomingWindow: { startAt: asOf, endAt: asOf + 36 * 3_600_000 },
      generatedAt: asOf,
      news,
      officialReleases: releases,
      upcoming: [],
      market: { cn: board('cn'), global: board('global') },
      strategy: strategy(regime, asOf),
      warnings: [],
    },
    sourceRefs: [{ type: 'strategy-snapshot', id: previous ? 'snap-prev' : 'snap-current', at: asOf }],
  };
}

test('candidate pool keeps strategy transition and official release ahead of repeated news', () => {
  const news = Array.from({ length: 80 }, (_, index) => newsItem(
    `n${index}`,
    1_700_000_000_000 - index,
    '市场震荡整理',
  ));
  const current = report({ news, releases: [release()], regime: 'VALUE_HIGH_PAIN_HIGH' });
  const previous = report({ date: '2026-09-21', regime: 'NORMAL', previous: true });
  const pool = buildDailyBriefCandidates(current, previous);
  const ids = pool.candidates.map((item) => item.id);
  assert.equal(ids.includes('strategy-transition:cn.dividend.value'), true);
  assert.equal(ids.includes('official-release:pbc-1'), true);
  assert.equal(ids.includes('strategy:cn.dividend.value'), true);
  assert.ok(pool.includedCount <= 120);
  assert.equal(pool.candidates.filter((item) => item.type === 'news').length < 80 || pool.truncated === false, true);
  assert.equal(JSON.stringify(pool.modelInput).includes('sourceUrl'), false);
  assert.equal(pool.modelInput.candidates.some((item) => item.sourceRefs), false);
});

test('missing or unknown previous regime does not invent a transition', () => {
  const current = report({ regime: 'VALUE_HIGH' });
  assert.equal(buildDailyBriefCandidates(current, null).candidates.some((item) => item.type === 'strategy-transition'), false);
  const unknown = report({ date: '2026-09-21', regime: 'UNKNOWN', previous: true });
  assert.equal(buildDailyBriefCandidates(current, unknown).candidates.some((item) => item.type === 'strategy-transition'), false);
});

test('strategy transition is a fact when both regimes are known and differ', () => {
  const pool = buildDailyBriefCandidates(
    report({ regime: 'VALUE_HIGH_PAIN_HIGH' }),
    report({ date: '2026-09-21', regime: 'NORMAL', previous: true }),
  );
  const transition = pool.candidates.find((item) => item.type === 'strategy-transition');
  assert.equal(transition.id, 'strategy-transition:cn.dividend.value');
  assert.deepEqual(transition.data, {
    strategyKey: 'cn.dividend.value',
    from: 'NORMAL',
    to: 'VALUE_HIGH_PAIN_HIGH',
  });
  assert.deepEqual(transition.sourceRefs.map((item) => item.id), ['snap-prev', 'snap-current']);
});

test('same-event news stays separate candidates so the model can pick one', () => {
  const news = Array.from({ length: 5 }, (_, index) => newsItem(`same-${index}`, 1_700_000_000_000, '同一事件'));
  const pool = buildDailyBriefCandidates(report({ news, regime: 'NORMAL' }), null);
  const same = pool.candidates.filter((item) => item.title === '同一事件');
  assert.equal(same.length, 5);
  assert.equal(new Set(same.map((item) => item.id)).size, 5);
});

test('unknown candidate id rejects the whole model output', () => {
  const pool = buildDailyBriefCandidates(report(), null);
  const output = parseDailyBriefModelText(`\`\`\`json
{"overview":"今天看策略。","items":[{"candidateId":"abc-does-not-exist","headline":"不存在","whyItMatters":"没有这条候选。","watchNext":"不要保存。"}]}
\`\`\``);
  assert.throws(() => assembleDailyBrief({
    id: 'brief-1',
    report: report(),
    candidates: pool.candidates,
    modelOutput: output,
    generatedAt: 1,
  }), /候选不存在/);
});

test('quiet and duplicate selections keep only the returned candidate ids', () => {
  const news = Array.from({ length: 5 }, (_, index) => newsItem(`same-${index}`, 1_700_000_000_000, '同一事件'));
  const current = report({ news, regime: 'NORMAL' });
  const pool = buildDailyBriefCandidates(current, null);
  const one = parseDailyBriefModelText(JSON.stringify({
    overview: '今天没有明显新增信号。',
    items: [{
      candidateId: 'news:same-0',
      headline: '同一事件只保留一条',
      whyItMatters: '其余四条没有新增事实。',
      watchNext: '不需要重复阅读。',
    }, {
      candidateId: 'news:same-0',
      headline: '重复项',
      whyItMatters: '应被去掉。',
      watchNext: '只留第一条。',
    }],
  }));
  const brief = assembleDailyBrief({
    id: 'brief-quiet',
    report: current,
    candidates: pool.candidates,
    modelOutput: one,
    generatedAt: 2,
  });
  assert.deepEqual(brief.items.map((item) => item.candidateId), ['news:same-0']);
  assert.deepEqual(brief.items[0].sourceRefs, pool.candidates.find((item) => item.id === 'news:same-0').sourceRefs);
  assert.equal(brief.items[0].type, 'news');
});

test('daily brief job stores one row and refreshes it when the report changes', async () => {
  const temporary = temporaryDatabase();
  const store = createStore(temporary.path);
  const current = report({
    news: [newsItem('only-news', 1_700_000_000_000, '普通波动')],
    releases: [release()],
    regime: 'VALUE_HIGH_PAIN_HIGH',
  });
  const previous = report({ date: '2026-09-21', regime: 'NORMAL', previous: true });
  store.repositories.report.upsertDailyReport({
    workspaceId: 'local',
    reportDate: previous.reportDate,
    status: 'ready',
    content: previous.content,
    sourceRefs: previous.sourceRefs,
  });
  const saved = store.repositories.report.upsertDailyReport({
    workspaceId: 'local',
    reportDate: current.reportDate,
    status: 'ready',
    content: current.content,
    sourceRefs: current.sourceRefs,
  });
  const answers = [JSON.stringify({
    overview: '今天主要看策略状态变化和央行公告。',
    items: [
      {
        candidateId: 'strategy-transition:cn.dividend.value',
        headline: '红利状态发生变化',
        whyItMatters: '昨日 NORMAL，今日 VALUE_HIGH_PAIN_HIGH。',
        watchNext: '看下一次快照是否仍是这个状态。',
      },
      {
        candidateId: 'official-release:pbc-1',
        headline: '央行发布公告',
        whyItMatters: '这是窗口内的官方发布。',
        watchNext: '看原文是否还有后续。',
      },
    ],
  })];
  const runtime = {
    async run(input) {
      assert.equal(input.closedContext, true);
      assert.equal(input.webMode, 'off');
      assert.equal(input.enableAuxiliarySearch, false);
      assert.doesNotMatch(input.taskInstruction, /web_search/);
      return { answer: answers[0], providerId: 'fake', modelId: 'brief-test' };
    },
  };
  const briefService = createDailyBriefService({
    reportRepository: store.repositories.report,
    agentRuntime: runtime,
    now: () => 1_700_000_200_000,
  });
  try {
    const first = await briefService.generateDailyBrief({ workspaceId: 'local', reportId: saved.id });
    assert.deepEqual(first.items.map((item) => item.candidateId), [
      'strategy-transition:cn.dividend.value',
      'official-release:pbc-1',
    ]);
    assert.equal(first.items[0].type, 'strategy-transition');
    assert.deepEqual(first.items[0].sourceRefs.map((item) => item.id).sort(), ['snap-current', 'snap-prev']);
    assert.equal(first.sourceReportUpdatedAt, saved.updatedAt);
    const again = await briefService.generateDailyBrief({ workspaceId: 'local', reportId: saved.id });
    assert.equal(again.id, first.id);
    const row = store.repositories.report.getDailyBriefByReportId('local', saved.id);
    assert.equal(row.id, first.id);
    assert.equal(store.listEvents(0, 20).some((event) => event.name === 'report.daily.brief.generated.v1'), true);
  } finally {
    store.close();
    temporary.remove();
  }
});

test('hallucinated brief is not stored', async () => {
  const temporary = temporaryDatabase();
  const store = createStore(temporary.path);
  const saved = store.repositories.report.upsertDailyReport({
    workspaceId: 'local',
    reportDate: '2026-09-22',
    status: 'ready',
    content: report().content,
    sourceRefs: report().sourceRefs,
  });
  const briefService = createDailyBriefService({
    reportRepository: store.repositories.report,
    agentRuntime: {
      async run() {
        return { answer: '{"overview":"编造","items":[{"candidateId":"abc-does-not-exist","headline":"假","whyItMatters":"不存在的候选。","watchNext":"拒绝。"}]}' };
      },
    },
  });
  try {
    await assert.rejects(() => briefService.generateDailyBrief({ reportId: saved.id }), /候选不存在/);
    assert.equal(store.repositories.report.getLatestDailyBrief('local'), null);
  } finally {
    store.close();
    temporary.remove();
  }
});

test('daily report success enqueues a brief job with only workspace and report id', async () => {
  const temporary = temporaryDatabase();
  const store = createStore(temporary.path);
  const handlers = createReportJobHandlers({
    reportService: {
      async generateDailyReport() {
        return { id: 'report-1', workspaceId: 'local', reportDate: '2026-09-22', status: 'ready' };
      },
    },
    briefService: { async generateDailyBrief() { return { id: 'brief-1', reportId: 'report-1', reportDate: '2026-09-22' }; } },
  });
  try {
    await handlers['report.daily.generate']({ reportDate: '2026-09-22' }, { store });
    const queued = store.claimNextJob('worker', ['report.daily.brief.generate']);
    assert.equal(queued.type, 'report.daily.brief.generate');
    assert.deepEqual(queued.input, { workspaceId: 'local', reportId: 'report-1' });
  } finally {
    store.close();
    temporary.remove();
  }
});

test('brief routes are read-only except desktop generate', async () => {
  const jobs = [];
  const services = {
    report: {
      getLatestDailyReport: () => ({ id: 'report-1', reportDate: '2026-09-22' }),
      getDailyReport: () => ({ id: 'report-1', reportDate: '2026-09-22' }),
      getLatestDailyBrief: () => ({ id: 'brief-1', overview: '概览' }),
      getDailyBrief: () => ({ id: 'brief-1', reportDate: '2026-09-22' }),
    },
    runtime: {
      requestDailyBrief(input) {
        const job = { id: 'job-brief', type: 'report.daily.brief.generate', input };
        jobs.push(job);
        return job;
      },
    },
  };
  const router = createRouter(createReportRoutes());
  const latest = { status: 0, body: '', writeHead(status) { this.status = status; }, end(body = '') { this.body = body; } };
  await router.dispatch({
    request: { method: 'GET' },
    response: latest,
    url: new URL('http://127.0.0.1/api/v1/reports/daily/latest/brief'),
    identity: { kind: 'device' },
    services,
  });
  assert.equal(latest.status, 200);
  assert.match(latest.body, /概览/);

  const denied = { status: 0, body: '', writeHead(status) { this.status = status; }, end(body = '') { this.body = body; } };
  await router.dispatch({
    request: { method: 'POST', async *[Symbol.asyncIterator]() { yield Buffer.from('{}'); } },
    response: denied,
    url: new URL('http://127.0.0.1/api/v1/reports/daily/brief/generate'),
    identity: { kind: 'device' },
    services,
  });
  assert.equal(denied.status, 403);

  const accepted = { status: 0, body: '', writeHead(status) { this.status = status; }, end(body = '') { this.body = body; } };
  await router.dispatch({
    request: { method: 'POST', async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ date: '2026-09-22' })); } },
    response: accepted,
    url: new URL('http://127.0.0.1/api/v1/reports/daily/brief/generate'),
    identity: { kind: 'desktop' },
    services,
  });
  assert.equal(accepted.status, 202);
  assert.deepEqual(jobs[0].input, { reportId: 'report-1' });
  assert.equal(jobs[0].type, 'report.daily.brief.generate');
});

test('local runtime closed context exposes no tools', async () => {
  const tools = createToolRegistry();
  tools.register({
    id: 'market.stock.stats',
    effect: 'read',
    description: '股票统计',
    async execute() { return { data: {}, refs: [], observedAt: 1, warnings: [] }; },
  });
  let seen = null;
  let calls = 0;
  const runtime = createAgentRuntime({
    tools,
    llm: {
      async respond(request) {
        calls += 1;
        if (calls === 1) {
          seen = request;
          return { text: '只能依据材料。', toolCalls: [], providerId: 'fake', modelId: 'local' };
        }
        return {
          text: '',
          toolCalls: [{ id: 'market.stock.stats', name: 'market.stock.stats', args: {} }],
          providerId: 'fake',
          modelId: 'local',
        };
      },
    },
  });
  const result = await runtime.run({ message: '封闭', closedContext: true, webMode: 'always', enableAuxiliarySearch: true });
  assert.equal(seen.tools.length, 0);
  assert.doesNotMatch(seen.systemInstruction, /web_search/);
  assert.doesNotMatch(seen.systemInstruction, /web_fetch/);
  assert.equal(result.visibleTools.length, 0);
  await assert.rejects(
    () => runtime.run({ message: '试工具', closedContext: true }),
    /未注册工具/,
  );
});
