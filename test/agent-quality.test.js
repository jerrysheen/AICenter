import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPriorQuestions,
  buildPriorState,
  buildReviewerQuestions,
  buildReviewerState,
  comparePriorQuality,
  computeAgentQualityScore,
  createAgentQualityLayer,
  createAgentQualityLayerFromEnv,
  formatPriorHint,
  isRootTool,
  parseNoulAnswers,
  projectToolAudit,
  resolveAgentQualityConfig,
  settleAgentQualityReview,
} from '../packages/runtime/src/agent-quality.js';
import { createOptionalAgentQuality } from '../apps/worker/src/worker.js';

const tools = [
  { id: 'holdings.get', effect: 'read', description: '读取当前持仓' },
  { id: 'web.search', effect: 'read', description: '搜索公开网页' },
];

test('quality config defaults to shadow prior and can be fully disabled', () => {
  assert.deepEqual(resolveAgentQualityConfig({}), {
    disabled: false,
    priorMode: 'shadow',
    reviewerEnabled: true,
    evidenceGateMode: 'enforce',
    evidenceGateTimeoutMs: 15_000,
  });
  assert.equal(resolveAgentQualityConfig({ AI_CENTER_JEV_DISABLED: '1' }).priorMode, 'off');
  assert.equal(resolveAgentQualityConfig({ AI_CENTER_JEV_DISABLED: '1' }).evidenceGateMode, 'off');
  assert.equal(resolveAgentQualityConfig({ AI_CENTER_JEV_PRIOR: 'advisory' }).priorMode, 'advisory');
  assert.equal(resolveAgentQualityConfig({ AI_CENTER_JEV_REVIEWER: 'off' }).reviewerEnabled, false);
  assert.equal(resolveAgentQualityConfig({ AI_CENTER_JEV_EVIDENCE_GATE: 'shadow' }).evidenceGateMode, 'shadow');
  assert.equal(resolveAgentQualityConfig({ AI_CENTER_JEV_EVIDENCE_TIMEOUT_MS: '4321' }).evidenceGateTimeoutMs, 4321);
  assert.equal(createAgentQualityLayerFromEnv({ env: { AI_CENTER_JEV_DISABLED: '1' }, client: { evaluate: async () => ({}) } }), null);
  assert.equal(createOptionalAgentQuality(undefined, {}), null);
  assert.equal(createOptionalAgentQuality(null, { AI_CENTER_TYPESAFE_API_KEY: 'x' }), null);
});

test('prior questions ask T0 root necessity and skip follow-up tools', () => {
  const mixed = [
    ...tools,
    { id: 'official.source.get', effect: 'read', description: '按 sourceUrl 读官方原文' },
    { id: 'static.signals.list', effect: 'read', description: '官方日程' },
  ];
  const state = buildPriorState({
    message: '接下来一周有哪些官方宏观或央行日程',
    webMode: 'fallback',
    researchMode: 'standard',
    tools: mixed,
  });
  assert.equal(state.prior_scope, 't0-root-required');
  assert.equal(Object.hasOwn(state, 'selectedContext'), false);
  assert.deepEqual(state.root_tools.map((tool) => tool.id).sort(), ['holdings.get', 'static.signals.list', 'web.search']);
  assert.deepEqual(state.follow_up_tools.map((tool) => tool.id), ['official.source.get']);
  assert.equal(isRootTool('official.source.get'), false);
  const questions = buildPriorQuestions(mixed);
  assert.equal(questions.prior__official_source_get, undefined);
  assert.match(questions.prior__static_signals_list.instructions, /required/);
  assert.match(questions.prior__static_signals_list.criteria.false, /merely useful/);
  const scores = parseNoulAnswers({
    prior__holdings_get: { type: 'noul', noul: 0.96 },
    prior__web_search: { type: 'noul', noul: 0.18 },
  }, 'prior', ['holdings.get', 'web.search']);
  assert.match(formatPriorHint(scores), /T0 root-tool necessity hint/);
  assert.match(formatPriorHint(scores), /holdings\.get: high/);
});

test('tool audit keeps counts and never copies holdings fields', () => {
  const audit = projectToolAudit('holdings.get', {
    data: {
      positions: [
        { symbol: 'NVDA', name: '英伟达', quantity: 12, costCny: '100000' },
        { symbol: 'AAPL', quantity: 3 },
      ],
    },
    warnings: ['quote stale'],
  }, { durationMs: 350 });
  const serialized = JSON.stringify(audit);
  assert.equal(audit.tool, 'holdings.get');
  assert.equal(audit.success, true);
  assert.equal(audit.role, 'root');
  assert.equal(audit.resultKind, 'positions');
  assert.equal(audit.resultCount, 2);
  assert.equal(audit.outcome, 'found');
  assert.equal(audit.resultUtility, 'strong');
  assert.equal(audit.warningCount, 1);
  assert.equal(audit.durationMs, 350);
  assert.equal(serialized.includes('NVDA'), false);
  assert.equal(serialized.includes('100000'), false);
  assert.equal(serialized.includes('英伟达'), false);
});

test('reviewer state only projects audit rows and code computes the overall score', () => {
  const state = buildReviewerState({
    message: '我现在持仓亏多少',
    tools,
    answer: '你的持仓亏损主要来自 NVDA 成本 100000',
    toolAudits: [projectToolAudit('holdings.get', { data: { positions: [{ symbol: 'NVDA', costCny: '100000' }] } })],
  });
  assert.equal(state.called_tools[0].resultKind, 'positions');
  assert.equal(state.called_tools[0].outcome, 'found');
  assert.equal(state.called_tools[0].resultUtility, 'strong');
  assert.equal(JSON.stringify(state).includes('100000'), false);
  assert.equal(JSON.stringify(state).includes('NVDA'), false);
  assert.equal(state.evidence_gate, null);
  assert.equal(state.answer_present, true);
  assert.equal(computeAgentQualityScore({
    coverage: 0.92,
    relevance: 0.86,
    evidence: 0.91,
    sequence: 0.74,
    efficiency: 0.62,
    completion: 0.88,
  }), 85);
});

test('prior quality distinguishes miss and false positive using reviewer necessity', () => {
  const compared = comparePriorQuality(
    { 'web.search': 0.15, 'holdings.get': 0.95 },
    ['web.search'],
    { 'web.search': 0.9, 'holdings.get': 0.1 },
  );
  const byTool = Object.fromEntries(compared.items.map((item) => [item.tool, item.verdict]));
  assert.equal(compared.scope, 't0-root');
  assert.equal(byTool['web.search'], 'prior-miss');
  assert.equal(byTool['holdings.get'], 'prior-false-positive');
  assert.equal(compared.counts.miss, 1);
  assert.equal(compared.counts.falsePositive, 1);
});

test('empty-valid method lookup is not a failure and follow-up tools stay out of T0 prior quality', () => {
  const method = projectToolAudit('user.method.get', {
    data: null,
    warnings: ['尚未创建 metadata.kind 为 investment-method 的知识文档'],
  });
  assert.equal(method.success, true);
  assert.equal(method.outcome, 'empty-valid');
  assert.equal(method.resultUtility, 'empty');
  assert.equal(JSON.stringify(method).includes('investment-method'), false);

  const web = projectToolAudit('web.search', {
    data: { available: true, results: [{ title: 'Fed', url: 'https://example.com' }] },
  });
  assert.equal(web.outcome, 'found');
  assert.equal(web.resultUtility, 'weak');

  const official = projectToolAudit('official.source.get', {
    data: { title: 'FOMC statement', body: 'held' },
  });
  assert.equal(official.role, 'follow-up');
  assert.equal(official.resultUtility, 'strong');

  const compared = comparePriorQuality(
    { 'static.signals.list': 0.97, 'official.source.get': 0.3 },
    ['static.signals.list', 'official.source.get'],
    { 'static.signals.list': 0.54, 'official.source.get': 0.61 },
  );
  const byTool = Object.fromEntries(compared.items.map((item) => [item.tool, item.verdict]));
  assert.equal(byTool['static.signals.list'], 'prior-hit');
  assert.equal(byTool['official.source.get'], 'excluded-follow-up');
  assert.equal(compared.counts.hit, 1);
  assert.equal(compared.counts.miss, 0);
  assert.equal(compared.counts.excludedFollowUp, 1);
});

test('knowledge.search taxonomy.list and holdings.rank are root-capable; memory.save follows taxonomy', () => {
  assert.equal(isRootTool('knowledge.search'), true);
  assert.equal(isRootTool('taxonomy.list'), true);
  assert.equal(isRootTool('holdings.rank'), true);
  assert.equal(isRootTool('knowledge.get'), false);
  assert.equal(isRootTool('memory.save'), false);
  const state = buildPriorState({
    message: '查一下我的知识库里有没有 AVT 的内容',
    tools: [
      { id: 'knowledge.search', effect: 'read', description: '检索知识' },
      { id: 'knowledge.get', effect: 'read', description: '按 id 读取知识' },
      { id: 'taxonomy.list', effect: 'read', description: '分类目录' },
      { id: 'memory.save', effect: 'write', description: '写入灵感或知识' },
    ],
  });
  assert.deepEqual(state.root_tools.map((tool) => tool.id).sort(), ['knowledge.search', 'taxonomy.list']);
  assert.deepEqual(state.follow_up_tools.map((tool) => ({ id: tool.id, dependsOn: tool.dependsOn })), [
    { id: 'knowledge.get', dependsOn: 'knowledge.search' },
    { id: 'memory.save', dependsOn: 'taxonomy.list' },
  ]);
  const questions = buildPriorQuestions(state.root_tools.concat(state.follow_up_tools));
  assert.ok(questions.prior__knowledge_search);
  assert.equal(questions.prior__knowledge_get, undefined);
  assert.equal(questions.prior__memory_save, undefined);
});

test('partial official listing is usable, not strong, and reviewer stays process-only', () => {
  const partial = projectToolAudit('static.signals.list', {
    data: {
      upcoming: [{ eventId: 'fed-1', title: 'FOMC' }],
      releases: [],
      sourceHealth: [
        { title: 'Fed', status: 'ready' },
        { title: 'SCIO', status: 'failed' },
      ],
    },
  });
  assert.equal(partial.outcome, 'partial');
  assert.equal(partial.resultUtility, 'usable');
  assert.equal(JSON.stringify(partial).includes('FOMC'), false);

  const questions = buildReviewerQuestions({
    tools: [{ id: 'user.method.get', effect: 'read', description: '投资方法' }],
    toolAudits: [{ tool: 'user.method.get', outcome: 'empty-valid', resultUtility: 'empty' }],
  });
  assert.match(questions.completion.instructions, /cannot see the final answer/);
  assert.equal(questions.completion.instructions.includes('said so'), false);
  assert.match(questions.evidence.instructions, /resource does not exist/);
  assert.match(questions.evidence.criteria.false, /proof that content exists/);
});

test('quality layer failures stay local and do not throw into the agent', async () => {
  const layer = createAgentQualityLayer({
    client: {
      async evaluate() {
        throw Object.assign(new Error('TypeSafe down'), { code: 'TYPESAFE_HTTP_ERROR' });
      },
    },
    config: { priorMode: 'shadow', reviewerEnabled: true, disabled: false },
  });
  const prior = await layer.advisePrior({ message: '持仓呢', tools });
  assert.equal(prior.status, 'failed');
  assert.equal(prior.kind, 'prior');
  const review = await layer.reviewRun({
    message: '持仓呢',
    tools,
    toolAudits: [],
    answer: '好',
  });
  assert.equal(review.status, 'failed');
  const events = [];
  await settleAgentQualityReview({
    quality: layer,
    input: { message: '持仓呢' },
    result: { answer: '好', toolAudits: [], qualityPrior: { scores: {} } },
    record: async (event, detail) => { events.push({ event, detail }); },
  });
  assert.equal(events.at(-1).event, 'reviewer.failed');
});

test('successful prior and review write comparable scores', async () => {
  const layer = createAgentQualityLayer({
    client: {
      async evaluate({ questions }) {
        const answers = {};
        for (const key of Object.keys(questions)) {
          answers[key] = { type: 'noul', noul: key.includes('web') ? 0.2 : 0.9 };
        }
        return { model: 'jev-latest', answers, usage: {} };
      },
    },
    config: { priorMode: 'shadow', reviewerEnabled: true, disabled: false },
  });
  const prior = await layer.advisePrior({ message: '持仓亏多少', webMode: 'off', tools });
  assert.equal(prior.status, 'ok');
  assert.equal(prior.scores['holdings.get'] > 0.8, true);
  const review = await layer.reviewRun({
    message: '持仓亏多少',
    tools,
    toolAudits: [{ tool: 'holdings.get', success: true, resultKind: 'positions', resultCount: 2 }],
    priorScores: prior.scores,
    answer: '已读取持仓',
  });
  assert.equal(review.status, 'ok');
  assert.equal(Number.isInteger(review.score), true);
  assert.equal(review.priorQuality.items.some((item) => item.tool === 'holdings.get'), true);
});

test('evidence gate scores a search batch and fail-opens when Jev errors', async () => {
  const layer = createAgentQualityLayer({
    client: {
      async evaluate({ questions }) {
        const answers = {};
        for (const key of Object.keys(questions)) {
          if (key === 'sufficiency') answers[key] = { type: 'noul', noul: 0.91 };
          else if (key.includes('1_')) answers[key] = { type: 'noul', noul: 0.96 };
          else answers[key] = { type: 'noul', noul: 0.02 };
        }
        return { model: 'jev-latest', answers, usage: {} };
      },
    },
    config: { priorMode: 'off', reviewerEnabled: false, evidenceGateMode: 'enforce', disabled: false },
  });
  const gated = await layer.gateEvidence({
    message: '光迅 3.2T NPO 是否已经发布',
    query: 'Accelink 3.2T NPO CIOE',
    toolId: 'web.search',
    toolResult: {
      data: {
        results: [
          { title: 'Accelink Launches 3.2T NPO', url: 'https://accelink.com/npo', snippet: 'World’s first 3.2T SiPh NPO' },
          { title: 'Monkeytype', url: 'https://monkeytype.com', snippet: 'A minimalistic typing test' },
        ],
      },
    },
  });
  assert.equal(gated.status, 'ok');
  assert.equal(gated.accepted.length, 1);
  assert.equal(gated.rejected[0].host, 'monkeytype.com');
  assert.equal(gated.sufficiency, 0.91);
  assert.match(gated.hint, /sufficient/i);

  const broken = createAgentQualityLayer({
    client: {
      async evaluate() {
        throw Object.assign(new Error('TypeSafe down'), { code: 'TYPESAFE_HTTP_ERROR' });
      },
    },
    config: { priorMode: 'off', reviewerEnabled: false, evidenceGateMode: 'enforce', disabled: false },
  });
  const failed = await broken.gateEvidence({
    message: 'NPO',
    query: 'NPO',
    toolId: 'web.search',
    toolResult: { data: { results: [{ title: 'x', url: 'https://example.com' }] } },
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.kind, 'evidence-gate');

  const timed = createAgentQualityLayer({
    client: {
      async evaluate({ signal }) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    },
    config: {
      priorMode: 'off',
      reviewerEnabled: false,
      evidenceGateMode: 'enforce',
      evidenceGateTimeoutMs: 20,
      disabled: false,
    },
  });
  const timeout = await timed.gateEvidence({
    message: 'NPO',
    query: 'NPO',
    toolId: 'web.search',
    toolResult: { data: { results: [{ title: 'x', url: 'https://example.com' }] } },
  });
  assert.equal(timeout.status, 'failed');
  assert.equal(timeout.code, 'EVIDENCE_GATE_TIMEOUT');
});
