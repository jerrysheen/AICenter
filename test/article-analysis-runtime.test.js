import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../packages/database/src/index.js';
import { createAiCenterWorker } from '../apps/worker/src/worker.js';
import { createRuntimeService } from '../packages/domain/src/runtime-service.js';
import { ARTICLE_ANALYSIS_JOB_TYPE, ARTICLE_ANALYSIS_TASK_TYPE } from '../packages/contracts/src/index.js';
import { createAgentTraceLog } from '../packages/runtime/src/agent-trace-log.js';
import {
  ARTICLE_ANALYSIS_DOMAIN_TOOL_IDS,
  ARTICLE_ANALYSIS_SKILL_INSTRUCTION,
  articleAnalysisAllowedToolIds,
  articleAnalysisSkillInvocation,
} from '../packages/runtime/src/article-analysis/article-analysis-skill.js';

function temporaryDirectory() {
  return mkdtempSync(path.join(os.tmpdir(), 'ai-center-article-'));
}

function scriptedAgent(replies) {
  const queue = [...replies];
  const requests = [];
  return {
    requests,
    async respond(request) {
      requests.push(request);
      const next = queue.shift();
      if (next == null) throw new Error('scripted agent exhausted');
      return { providerId: 'fake', modelId: 'fake-article', ...next };
    },
  };
}

function emptySearchPort(calls = []) {
  return {
    list() {
      return [{ id: 'search.web' }];
    },
    async projectForAI(sourceId, input) {
      calls.push({ sourceId, input });
      if (sourceId === 'search.web') {
        return {
          data: {
            query: input.query,
            available: true,
            results: [{ title: 'Company A released Model X', url: 'https://example.com/x', snippet: 'official release' }],
          },
        };
      }
      return { data: { available: false } };
    },
  };
}

test('knowledge article returns markdown, writes AiRun, and does not create knowledge documents', async () => {
  const directory = temporaryDirectory();
  const store = createStore(path.join(directory, 'ai-center.db'));
  const llm = scriptedAgent([
    { text: '## Knowledge\nAttention 用来按相关性聚合上下文，而不是机械摘要。' },
  ]);
  const worker = createAiCenterWorker({
    store,
    workerId: 'article-reader-knowledge',
    agentClient: llm,
    sourcePort: emptySearchPort(),
    auxiliarySearch: null,
    agentQuality: null,
  });
  try {
    const before = store.repositories.knowledge.listRecent('local', 50);
    const job = store.createJob({
      type: ARTICLE_ANALYSIS_JOB_TYPE,
      input: {
        workspaceId: 'local',
        source: { type: 'inline', title: 'Attention', body: 'Transformer 为什么需要 Attention。' },
      },
      maxAttempts: 1,
    });
    const completed = await worker.runner.runOnce();
    assert.equal(completed.id, job.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.output.artifact, undefined);
    assert.match(completed.output.outputText, /Attention/);
    assert.doesNotMatch(completed.output.outputText, /^\s*\{/);
    assert.ok(completed.output.aiRunId);
    const run = store.repositories.knowledge.getAiRun('local', completed.output.aiRunId);
    assert.equal(run.taskType, ARTICLE_ANALYSIS_TASK_TYPE);
    assert.equal(store.repositories.knowledge.listRecent('local', 50).length, before.length);
    const session = store.repositories.knowledge.getSession('local', run.sessionId);
    assert.equal(session.kind, 'article-analysis');
  } finally {
    await worker.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('news article can reuse AgentRuntime web.search and return markdown', async () => {
  const directory = temporaryDirectory();
  const store = createStore(path.join(directory, 'ai-center.db'));
  const searchCalls = [];
  const llm = scriptedAgent([
    {
      toolCalls: [{ name: 'web_search', args: { query: 'Company A Model X' }, callId: 'call-1' }],
      modelContent: { role: 'model', parts: [] },
    },
    { text: '## 发生了什么\nA 公司发布了 Model X。检索结果支持这一发布。' },
  ]);
  const worker = createAiCenterWorker({
    store,
    workerId: 'article-reader-news',
    agentClient: llm,
    sourcePort: emptySearchPort(searchCalls),
    auxiliarySearch: null,
    agentQuality: null,
  });
  try {
    store.createJob({
      type: ARTICLE_ANALYSIS_JOB_TYPE,
      input: {
        workspaceId: 'local',
        source: { type: 'inline', title: '发布', body: 'A 公司今天发布 Model X。' },
      },
      maxAttempts: 1,
    });
    const completed = await worker.runner.runOnce();
    assert.equal(completed.status, 'completed');
    assert.match(completed.output.outputText, /Model X/);
    assert.equal(searchCalls.some((item) => item.sourceId === 'search.web'), true);
  } finally {
    await worker.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('article analysis skill is instruction plus domain tool scope, not a classifier or workflow', () => {
  assert.deepEqual([...ARTICLE_ANALYSIS_DOMAIN_TOOL_IDS].sort(), ['knowledge.get', 'knowledge.search']);
  assert.equal(ARTICLE_ANALYSIS_DOMAIN_TOOL_IDS.includes('web.search'), false);
  assert.equal(ARTICLE_ANALYSIS_DOMAIN_TOOL_IDS.includes('memory.save'), false);
  assert.equal(ARTICLE_ANALYSIS_DOMAIN_TOOL_IDS.includes('taxonomy.list'), false);
  assert.deepEqual(articleAnalysisAllowedToolIds({ kind: 'harness' }), ARTICLE_ANALYSIS_DOMAIN_TOOL_IDS);
  assert.deepEqual(
    articleAnalysisAllowedToolIds({ kind: 'local' }).sort(),
    ['knowledge.get', 'knowledge.search', 'web.search'],
  );
  const invocation = articleAnalysisSkillInvocation({ kind: 'harness' });
  assert.equal(invocation.taskInstruction, ARTICLE_ANALYSIS_SKILL_INSTRUCTION);
  assert.deepEqual(invocation.allowedToolIds, ARTICLE_ANALYSIS_DOMAIN_TOOL_IDS);
  assert.equal(invocation.webMode, 'always');
  assert.equal(invocation.enableAuxiliarySearch, false);
  assert.match(ARTICLE_ANALYSIS_SKILL_INSTRUCTION, /不要先单独做分类请求/);
  assert.match(ARTICLE_ANALYSIS_SKILL_INSTRUCTION, /不要启动固定 Workflow/);
  assert.match(ARTICLE_ANALYSIS_SKILL_INSTRUCTION, /What changed/);
  assert.match(ARTICLE_ANALYSIS_SKILL_INSTRUCTION, /今天发布了新架构/);
  assert.match(ARTICLE_ANALYSIS_SKILL_INSTRUCTION, /knowledge\.search/);
  assert.match(ARTICLE_ANALYSIS_SKILL_INSTRUCTION, /web_search/);
  assert.match(ARTICLE_ANALYSIS_SKILL_INSTRUCTION, /不要自动写入 Knowledge/);
  assert.doesNotMatch(ARTICLE_ANALYSIS_SKILL_INSTRUCTION, /Intent Router|固定 JSON Schema/);
});

test('article analysis skill only exposes knowledge domain tools plus local web.search fallback', async () => {
  const directory = temporaryDirectory();
  const store = createStore(path.join(directory, 'ai-center.db'));
  const llm = scriptedAgent([
    { text: '这是一篇 Knowledge 材料，核心是 Attention。' },
  ]);
  const worker = createAiCenterWorker({
    store,
    workerId: 'article-skill-tools',
    agentClient: llm,
    sourcePort: emptySearchPort(),
    auxiliarySearch: null,
    agentQuality: null,
  });
  try {
    store.createJob({
      type: ARTICLE_ANALYSIS_JOB_TYPE,
      input: {
        workspaceId: 'local',
        source: { type: 'inline', body: 'Transformer 为什么需要 Attention。' },
      },
      maxAttempts: 1,
    });
    await worker.runner.runOnce();
    const ids = (llm.requests[0]?.tools || []).map((tool) => tool.id).sort();
    assert.deepEqual(ids, ['knowledge.get', 'knowledge.search', 'web.search']);
    assert.match(llm.requests[0].systemInstruction, /Article Analysis Skill/);
    assert.match(llm.requests[0].systemInstruction, /不要先单独做分类请求/);
    assert.match(llm.requests[0].systemInstruction, /不要返回 JSON/);
    assert.equal(ids.includes('holdings.get'), false);
    assert.equal(ids.includes('memory.save'), false);
    assert.equal(ids.includes('taxonomy.list'), false);
    assert.equal(ids.includes('market.overview.get'), false);
  } finally {
    await worker.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('runtime service exposes article analysis stage without mixing ask jobs', async () => {
  const directory = temporaryDirectory();
  const store = createStore(path.join(directory, 'ai-center.db'));
  const runtime = createRuntimeService({ runtimeRepository: store });
  const job = runtime.requestArticleAnalysis({
    workspaceId: 'local',
    source: { type: 'inline', body: 'OpenAI 今天发布 GPT-X' },
  });
  assert.equal(job.type, ARTICLE_ANALYSIS_JOB_TYPE);
  const view = await runtime.getArticleAnalysisRun(job.id);
  assert.equal(view.status, 'queued');
  assert.equal(view.stage, 'queued');
  const active = runtime.listActiveAgentRuns('local');
  assert.equal(active.length, 1);
  assert.equal(active[0].runId, job.id);
  assert.equal(active[0].agentMode, 'article-analysis');
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test('article analysis run returns AgentRuntime progress and a readable result', async () => {
  const directory = temporaryDirectory();
  const store = createStore(path.join(directory, 'ai-center.db'));
  const trace = createAgentTraceLog({ dataDirectory: directory });
  const runtime = createRuntimeService({ runtimeRepository: store, agentProgressPort: trace });
  const llm = scriptedAgent([
    { text: '## Knowledge\n这是可读的 Markdown 分析。' },
  ]);
  const worker = createAiCenterWorker({
    store,
    workerId: 'article-reader-progress',
    agentClient: llm,
    sourcePort: emptySearchPort(),
    auxiliarySearch: null,
    agentQuality: null,
    agentTraceLog: trace,
  });
  try {
    const job = store.createJob({
      type: ARTICLE_ANALYSIS_JOB_TYPE,
      input: {
        workspaceId: 'local',
        source: { type: 'inline', title: 'Attention', body: 'Transformer 为什么需要 Attention。' },
      },
      maxAttempts: 1,
    });
    await worker.runner.runOnce();
    const view = await runtime.getArticleAnalysisRun(job.id);
    assert.equal(view.status, 'completed');
    assert.equal(view.stage, 'completed');
    assert.equal(view.artifact, undefined);
    assert.match(view.outputText, /Markdown/);
    const events = view.progress.map((step) => step.event);
    assert.equal(events.filter((event) => event === 'article.started').length, 1);
    assert.equal(events.includes('model.requested'), true);
    assert.equal(events.includes('model.responded') || events.includes('run.completed') || events.includes('article.completed'), true);
    const run = store.repositories.knowledge.getAiRun('local', view.aiRunId);
    assert.equal(store.repositories.knowledge.getSession('local', run.sessionId).kind, 'article-analysis');
    const session = store.repositories.knowledge.getSessionDetail('local', run.sessionId);
    assert.equal(session.exchanges[0].jobId, job.id);
  } finally {
    await worker.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('article reader does not start auxiliary search or silently clip long markdown', async () => {
  const directory = temporaryDirectory();
  const store = createStore(path.join(directory, 'ai-center.db'));
  const begins = [];
  const longAnswer = `## Knowledge\n${'结构化决策不应塞进自回归模型。'.repeat(600)}`;
  assert.ok(longAnswer.length > 8_000);
  const llm = scriptedAgent([
    {
      toolCalls: [{ name: 'web_search', args: { query: 'Jev System One' }, callId: 'call-1' }],
      modelContent: { role: 'model', parts: [] },
    },
    { text: longAnswer },
  ]);
  const worker = createAiCenterWorker({
    store,
    workerId: 'article-reader-aux',
    agentClient: llm,
    sourcePort: emptySearchPort(),
    auxiliarySearch: {
      begin(input) {
        begins.push(input);
        return { startedAt: Date.now(), promise: Promise.resolve({ text: '这段不该出现。', status: 'ok' }) };
      },
    },
    agentQuality: null,
  });
  try {
    store.createJob({
      type: ARTICLE_ANALYSIS_JOB_TYPE,
      input: {
        workspaceId: 'local',
        source: { type: 'inline', title: 'Jev', body: '大家都在讨论 Jev。' },
      },
      maxAttempts: 1,
    });
    const completed = await worker.runner.runOnce();
    assert.equal(completed.status, 'completed');
    assert.equal(begins.length, 0);
    assert.doesNotMatch(completed.output.outputText, /补充资讯/);
    assert.equal(completed.output.outputText.length, longAnswer.length);
    assert.match(completed.output.outputText, /结构化决策/);
  } finally {
    await worker.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
