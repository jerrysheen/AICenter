import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { createStore } from '../packages/database/src/index.js';
import { createAiCenterWorker } from '../apps/worker/src/worker.js';
import { createAiCenterServer } from '../apps/web/src/server.js';
import { createAgentRuntime } from '../packages/runtime/src/agent-runtime.js';
import { createToolRegistry } from '../packages/runtime/src/tool-registry.js';
import { createRuntimeService } from '../packages/domain/src/runtime-service.js';
import { createAgentTraceLog } from '../packages/runtime/src/agent-trace-log.js';

function temporaryDirectory() {
  return mkdtempSync(path.join(os.tmpdir(), 'ai-center-agent-'));
}

test('agent worker completes a registered question-answer job and persists an AiRun', async () => {
  const directory = temporaryDirectory();
  const store = createStore(path.join(directory, 'ai-center.db'));
  const worker = createAiCenterWorker({
    store,
    workerId: 'agent-test-worker',
    agentClient: { ask: async ({ message }) => ({ text: `回答：${message}`, providerId: 'fake-gemini', modelId: 'fake-model', warnings: [] }) },
  });
  try {
    const job = store.createJob({ type: 'ai.agent.run', input: { message: '测试问题', webMode: 'off' }, maxAttempts: 1 });
    const completed = await worker.runner.runOnce();
    assert.equal(completed.id, job.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.output.answer, '回答：测试问题');
    assert.ok(completed.output.aiRunId);
    assert.ok(completed.output.sessionId);
    assert.ok(store.listEvents(0).some((event) => event.name === 'knowledge.ai-run.completed.v1'));
    assert.ok(store.listEvents(0).some((event) => event.name === 'knowledge.ai-session.created.v1'));
    assert.equal(store.repositories.knowledge.listSessions(job.workspaceId || 'local').sessions.length, 1);
  } finally {
    await worker.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('agent job writes selected refs without calling tools', async () => {
  const directory = temporaryDirectory();
  const store = createStore(path.join(directory, 'ai-center.db'));
  const source = store.repositories.feed.upsertSourceAccount({
    workspaceId: 'local', provider: 'x', externalId: 'x:home:for-you', displayName: 'X',
  });
  const capture = store.repositories.feed.saveCapture({
    workspaceId: 'local', provider: 'x', externalId: 'tweet-1', sourceAccountId: source.id,
    sourceUrl: 'https://x.com/user/status/tweet-1', contentHash: 'hash-1',
  });
  const item = store.repositories.feed.saveContentItem({
    workspaceId: 'local', captureId: capture.id, originType: 'subscription', contentType: 'post',
    title: 'SK海力士', body: 'HBM4 进度', sourceUrl: capture.sourceUrl,
  });
  let seen = '';
  const worker = createAiCenterWorker({
    store,
    workerId: 'agent-ref-worker',
    agentClient: {
      respond: async ({ contents }) => {
        seen = contents.at(-1).parts[0].text;
        return { text: '供给偏紧', providerId: 'fake-gemini', modelId: 'fake-model', warnings: [] };
      },
    },
  });
  try {
    const job = store.createJob({
      type: 'ai.agent.run',
      input: {
        message: '怎么看',
        webMode: 'off',
        references: [{ resourceType: 'content-item', resourceId: item.id }],
      },
      maxAttempts: 1,
    });
    const completed = await worker.runner.runOnce();
    assert.equal(completed.id, job.id);
    assert.equal(completed.status, 'completed');
    assert.match(seen, /用户主动引用/);
    assert.match(seen, /SK海力士/);
    const session = store.repositories.knowledge.listSessions('local').sessions[0];
    const detail = store.repositories.knowledge.getSessionDetail('local', session.id);
    assert.equal(detail.exchanges[0].refs[0].origin, 'selected');
    assert.equal(detail.exchanges[0].refs[0].resourceId, item.id);
    assert.equal(detail.exchanges[0].refs[0].label, 'SK海力士');
  } finally {
    await worker.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('agent runtime only executes registered read tools and returns their refs', async () => {
  const tools = createToolRegistry();
  let calls = 0;
  tools.register({
    id: 'context.build', effect: 'read', description: '读取基础上下文',
    parameters: { type: 'object', properties: {} },
    async execute() {
      calls += 1;
      return {
        data: { knowledge: ['投资方法'] },
        refs: [{ resourceType: 'knowledge-revision', resourceId: 'knowledge-1', revision: 1, asOf: null, label: '投资方法' }],
        observedAt: 100,
        warnings: [],
      };
    },
  });
  const responses = [
    { toolCalls: [{ name: 'context_build', args: {} }], modelContent: { role: 'model', parts: [] }, providerId: 'fake', modelId: 'fake' },
    { text: '我已读取投资方法。', providerId: 'fake', modelId: 'fake' },
  ];
  const runtime = createAgentRuntime({ llm: { respond: async () => responses.shift() }, tools });
  const result = await runtime.run({ message: '读取我的方法', workspaceId: 'local' });
  assert.equal(calls, 1);
  assert.equal(result.answer, '我已读取投资方法。');
  assert.equal(result.toolCalls[0].id, 'context.build');
  assert.equal(result.refs[0].resourceId, 'knowledge-1');
});

test('agent runtime can persist a session summary through a write tool', async () => {
  const tools = createToolRegistry();
  let saved = null;
  tools.register({
    id: 'memory.save', effect: 'write', description: '写入灵感或知识',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['inspiration', 'knowledge'] },
        title: { type: 'string' },
        contentType: { type: 'string' },
        bodyMarkdown: { type: 'string' },
      },
      required: ['target', 'title', 'contentType', 'bodyMarkdown'],
    },
    async execute(input, context) {
      saved = { ...input, sessionId: context.sessionId };
      return {
        data: { savedTo: '知识库', title: input.title, pathLabel: '投资研究 · 景气度' },
        refs: [{ resourceType: 'knowledge-revision', resourceId: 'saved-1', revision: null, asOf: null, label: input.title }],
        observedAt: 1,
        warnings: [],
      };
    },
  });
  const responses = [
    {
      toolCalls: [{
        name: 'memory_save',
        args: {
          target: 'knowledge',
          title: 'HBM 对 DRAM 的影响',
          contentType: 'mechanism',
          bodyMarkdown: '## 核心结论\nHBM 扩产挤占传统产能。',
        },
      }],
      modelContent: { role: 'model', parts: [] },
      providerId: 'fake',
      modelId: 'fake',
    },
    { text: '已保存到知识库：投资研究 · 景气度', providerId: 'fake', modelId: 'fake' },
  ];
  const runtime = createAgentRuntime({ llm: { respond: async () => responses.shift() }, tools });
  const result = await runtime.run({
    message: '把这次对话总结进知识库',
    workspaceId: 'local',
    sessionId: 'session-9',
  });
  assert.equal(saved.sessionId, 'session-9');
  assert.equal(result.toolCalls[0].id, 'memory.save');
  assert.match(result.answer, /已保存到知识库/);
});

test('agent runtime tells the model the remaining tool budget each round', async () => {
  let seen;
  const runtime = createAgentRuntime({
    llm: {
      respond: async (request) => {
        seen = request;
        return { text: '无需工具', providerId: 'fake', modelId: 'fake' };
      },
    },
  });
  await runtime.run({ message: '你好' });
  assert.equal(seen.budget.usedToolCalls, 0);
  assert.equal(seen.budget.remainingToolCalls, 12);
  assert.equal(seen.budget.maxToolCalls, 12);
  assert.match(seen.budgetNote, /remaining 12/);
});

test('agent runtime prefixes prior session turns before the new question', async () => {
  let contents = [];
  const runtime = createAgentRuntime({
    llm: {
      respond: async (request) => {
        contents = request.contents;
        return { text: '基于上一轮继续回答', providerId: 'fake', modelId: 'fake' };
      },
    },
  });
  const result = await runtime.run({
    message: '现金呢',
    priorTurns: [{ inputText: '今天持仓如何', outputText: 'A股小涨' }],
  });
  assert.equal(result.answer, '基于上一轮继续回答');
  assert.deepEqual(contents.map((item) => item.parts[0].text), ['今天持仓如何', 'A股小涨', '现金呢']);
});

test('agent runtime injects selected references into the current user turn', async () => {
  let request;
  const tools = createToolRegistry();
  for (const id of ['feed.search', 'knowledge.search', 'web.search']) {
    registerReadTool(tools, id, async () => ({ data: {}, refs: [], observedAt: 1, warnings: [] }));
  }
  const runtime = createAgentRuntime({
    tools,
    llm: {
      respond: async (value) => {
        request = value;
        return { text: '已根据引用回答', providerId: 'fake', modelId: 'fake' };
      },
    },
  });
  const result = await runtime.run({
    message: '结合起来怎么看',
    selectedContext: '[用户主动引用]\n\nReference 1\n类型：信息\n标题：SK海力士',
    webMode: 'always',
  });
  assert.equal(result.answer, '已根据引用回答');
  assert.match(request.contents[0].parts[0].text, /用户主动引用/);
  assert.match(request.contents[0].parts[0].text, /用户问题：\n结合起来怎么看/);
  assert.deepEqual(request.tools.map((tool) => tool.id).sort(), ['feed.search', 'knowledge.search', 'web.search']);
  assert.equal(request.toolChoice, undefined);
  assert.equal(result.toolCalls.length, 0);
});

test('tool registry validates input before execution and rejects provider name collisions', async () => {
  const tools = createToolRegistry();
  let executions = 0;
  tools.register({
    id: 'holdings.rank', effect: 'read', description: '排序',
    inputSchema: z.object({
      metric: z.enum(['dayPnlPct', 'dayPnlCny']),
      limit: z.number().int().min(1).max(20),
    }).strict(),
    async execute() {
      executions += 1;
      return { data: {}, refs: [], observedAt: 1, warnings: [] };
    },
  });
  await assert.rejects(
    () => tools.execute('holdings.rank', { metric: 'invalid', limit: -1, extra: true }, {}),
    /参数无效/,
  );
  assert.equal(executions, 0);

  tools.register({
    id: 'test.bad-result', effect: 'read', inputSchema: z.object({}).strict(),
    async execute() { return { refs: [], observedAt: 1, warnings: [] }; },
  });
  await assert.rejects(() => tools.execute('test.bad-result', {}, {}), /结果无效/);

  tools.register({ id: 'foo-bar.baz', parameters: { type: 'object', properties: {} }, execute: async () => ({ data: null, refs: [], observedAt: 1, warnings: [] }) });
  assert.throws(
    () => tools.register({ id: 'foo.bar-baz', parameters: { type: 'object', properties: {} }, execute() {} }),
    /providerName.*冲突/,
  );
});

test('agent runtime skips an oversized tool batch and answers from existing evidence', async () => {
  const tools = createToolRegistry();
  let executions = 0;
  tools.register({
    id: 'test.read', effect: 'read', inputSchema: z.object({ index: z.number().int() }).strict(),
    async execute(input) {
      executions += 1;
      return { data: input, refs: [], observedAt: 1, warnings: [] };
    },
  });
  const events = [];
  let round = 0;
  let finalContents;
  const runtime = createAgentRuntime({
    tools,
    limits: { maxToolCalls: 6, maxModelCalls: 7, maxParallelTools: 2 },
    llm: { respond: async ({ contents, budget }) => {
      round += 1;
      if (round === 1) {
        assert.equal(budget.remainingToolCalls, 6);
        return {
          toolCalls: [0, 1].map((index) => ({ name: 'test_read', callId: `call-${index}`, args: { index } })),
          modelContent: { role: 'model', parts: [] },
          providerId: 'fake', modelId: 'fake',
        };
      }
      if (round === 2) {
        assert.equal(budget.usedToolCalls, 2);
        assert.equal(budget.remainingToolCalls, 4);
        return {
          toolCalls: [2, 3, 4, 5, 6].map((index) => ({ name: 'test_read', callId: `call-${index}`, args: { index } })),
          modelContent: { role: 'model', parts: [] },
          providerId: 'fake', modelId: 'fake',
        };
      }
      finalContents = contents;
      return { text: '根据已有结果回答', providerId: 'fake', modelId: 'fake' };
    } },
  });
  const result = await runtime.run({
    message: '读取',
    workspaceId: 'local',
    trace: async ({ event }) => { events.push(event); },
  });
  assert.equal(executions, 2);
  assert.equal(result.answer, '根据已有结果回答');
  assert.equal(result.toolCalls.length, 2);
  assert.match(result.warnings[0], /整批未执行/);
  assert.equal(events.includes('tool.batch.skipped'), true);
  assert.match(finalContents.at(-1).parts[0].text, /None executed/);
  assert.match(finalContents.at(-1).parts[0].text, /remaining 4/);
});

test('same-name parallel tool calls keep results matched to callId and obey concurrency', async () => {
  const tools = createToolRegistry();
  let active = 0;
  let maxActive = 0;
  tools.register({
    id: 'test.lookup', effect: 'read', inputSchema: z.object({ key: z.string() }).strict(),
    async execute(input) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, input.key === 'slow' ? 20 : 1));
      active -= 1;
      return { data: { key: input.key }, refs: [], observedAt: 1, warnings: [] };
    },
  });
  let finalContents;
  let round = 0;
  const runtime = createAgentRuntime({
    tools,
    limits: { maxToolCalls: 12, maxParallelTools: 2 },
    llm: { respond: async ({ contents }) => {
      round += 1;
      if (round === 1) return {
        toolCalls: [
          { name: 'test_lookup', callId: 'call-slow', args: { key: 'slow' } },
          { name: 'test_lookup', callId: 'call-fast', args: { key: 'fast' } },
        ],
        modelContent: { role: 'model', parts: [] }, providerId: 'fake', modelId: 'fake',
      };
      finalContents = contents;
      return { text: '完成', providerId: 'fake', modelId: 'fake' };
    } },
  });
  await runtime.run({ message: '比较', workspaceId: 'local' });
  const responses = finalContents.at(-1).parts.map((part) => part.functionResponse);
  assert.deepEqual(responses.map((item) => [item.callId, item.response.result.data.key]), [
    ['call-slow', 'slow'], ['call-fast', 'fast'],
  ]);
  assert.equal(maxActive, 2);
});

test('an optional tool failure preserves successful evidence in the same batch', async () => {
  const tools = createToolRegistry();
  tools.register({
    id: 'test.optional', effect: 'read', inputSchema: z.object({ key: z.string() }).strict(),
    async execute({ key }) {
      if (key === 'bad') throw new Error('暂时不可用');
      return {
        data: { key },
        refs: [{ resourceType: 'content-item', resourceId: key, revision: null, asOf: 1, label: key }],
        observedAt: 1,
        warnings: [],
      };
    },
  });
  let toolParts;
  let round = 0;
  const runtime = createAgentRuntime({
    tools,
    llm: { respond: async ({ contents }) => {
      round += 1;
      if (round === 1) return {
        toolCalls: [
          { name: 'test_optional', callId: 'call-good', args: { key: 'good' } },
          { name: 'test_optional', callId: 'call-bad', args: { key: 'bad' } },
        ],
        modelContent: { role: 'model', parts: [] }, providerId: 'fake', modelId: 'fake',
      };
      toolParts = contents.at(-1).parts;
      return { text: '保留成功结果', providerId: 'fake', modelId: 'fake' };
    } },
  });
  const output = await runtime.run({ message: '同时读取', workspaceId: 'local' });
  assert.equal(toolParts[0].functionResponse.response.result.data.key, 'good');
  assert.equal(toolParts[1].functionResponse.response.result.error.code, 'TOOL_EXECUTION_FAILED');
  assert.equal(output.refs[0].resourceId, 'good');
  assert.match(output.warnings[0], /暂时不可用/);
});

test('agent run status includes compact progress from traces', async () => {
  const directory = temporaryDirectory();
  const store = createStore(path.join(directory, 'ai-center.db'));
  try {
    const trace = createAgentTraceLog({ dataDirectory: directory });
    const runtime = createRuntimeService({ runtimeRepository: store, agentProgressPort: trace });
    const job = store.createJob({ type: 'ai.agent.run', input: { message: '持仓如何', sessionId: 'session-1' }, maxAttempts: 1 });
    await trace.append({
      runId: job.id, workspaceId: 'local', event: 'run.started',
      detail: { message: '持仓如何', secretToken: 'must-not-appear' },
    });
    await trace.append({
      runId: job.id, workspaceId: 'local', event: 'tool.started',
      detail: { round: 0, callId: 'call-1', id: 'holdings.get', input: {}, data: { huge: true } },
    });
    const payload = await runtime.getAgentRun(job.id);
    assert.equal(payload.status, 'queued');
    assert.equal(payload.progress[0].label, '开始处理问题');
    assert.equal(payload.progress[0].detail, '持仓如何');
    assert.equal(payload.progress[1].label, '正在读取当前持仓');
    assert.equal(payload.progress[1].status, 'active');
    assert.equal(JSON.stringify(payload.progress).includes('must-not-appear'), false);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('agent HTTP endpoint accepts an authenticated question and exposes job status', async () => {
  const directory = temporaryDirectory();
  const app = createAiCenterServer({ host: '127.0.0.1', port: 0, dataDirectory: directory });
  const address = await app.listen();
  try {
    const pairing = await fetch(`${address.localUrl}/api/v1/pairing`).then((response) => response.json());
    const pair = await fetch(`${address.localUrl}/api/v1/pair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: pairing.code, deviceName: 'Agent API test' }),
    });
    const cookie = pair.headers.get('set-cookie').split(';')[0];
    const response = await fetch(`${address.localUrl}/api/v1/agent/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ message: '你好' }),
    });
    assert.equal(response.status, 202);
    const created = await response.json();
    assert.equal(created.job.type, 'ai.agent.run');
    assert.ok(created.sessionId);
    const listed = await fetch(`${address.localUrl}/api/v1/agent/sessions`, { headers: { Cookie: cookie } });
    assert.equal(listed.status, 200);
    const sessions = await listed.json();
    assert.ok(sessions.sessions.some((session) => session.id === created.sessionId));
    assert.ok(sessions.pendingRuns.some((run) => run.runId === created.runId && run.status === 'queued'));
    const active = await fetch(`${address.localUrl}/api/v1/agent/runs`, { headers: { Cookie: cookie } });
    assert.equal(active.status, 200);
    const activePayload = await active.json();
    assert.ok(activePayload.runs.some((run) => run.runId === created.runId && run.sessionId === created.sessionId));
    const detail = await fetch(`${address.localUrl}/api/v1/agent/sessions/${created.sessionId}`, { headers: { Cookie: cookie } });
    assert.equal(detail.status, 200);
    const detailPayload = await detail.json();
    assert.ok(detailPayload.exchanges.some((item) => item.id === created.runId && item.status === 'queued'));
    const status = await fetch(`${address.localUrl}/api/v1/agent/runs/${created.runId}`, { headers: { Cookie: cookie } });
    assert.equal(status.status, 200);
    const payload = await status.json();
    assert.equal(payload.status, 'queued');
    assert.deepEqual(payload.progress, []);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function registerReadTool(tools, id, execute) {
  tools.register({
    id, effect: 'read', description: id,
    parameters: { type: 'object', properties: { query: { type: 'string' }, tag: { type: 'string' }, timeRange: { type: 'string' } } },
    execute,
  });
}

const FIRST_ROUND_TOOL_IDS = [
  'context.build', 'feed.search', 'feed.tag.search', 'knowledge.search',
  'knowledge.get', 'holdings.get', 'market.overview.get', 'market.global.get', 'web.search',
];

test('first round exposes the full tool table with AUTO tool choice', async () => {
  const tools = createToolRegistry();
  for (const id of FIRST_ROUND_TOOL_IDS) {
    registerReadTool(tools, id, async () => ({ data: {}, refs: [], observedAt: 1, warnings: [] }));
  }
  let seen;
  const events = [];
  const runtime = createAgentRuntime({
    tools,
    llm: {
      respond: async (request) => {
        seen = request;
        return { text: '直接回答', providerId: 'fake', modelId: 'fake' };
      },
    },
  });
  await runtime.run({
    message: '看下我们今天的社媒下，算力 tag 相关的新闻有哪些',
    workspaceId: 'local',
    webMode: 'always',
    trace: async ({ event, detail }) => { if (event === 'model.requested') events.push(detail); },
  });
  assert.equal(seen.toolChoice, undefined);
  assert.deepEqual(seen.tools.map((tool) => tool.id).sort(), [...FIRST_ROUND_TOOL_IDS].sort());
  assert.match(seen.systemInstruction, /单 Agent/);
  assert.deepEqual(events[0].visibleToolIds.sort(), [...FIRST_ROUND_TOOL_IDS].sort());
});

test('local tag query uses feed.tag.search without forcing web.search', async () => {
  const tools = createToolRegistry();
  let webCalls = 0;
  registerReadTool(tools, 'feed.search', async () => ({ data: [], refs: [], observedAt: 1, warnings: [] }));
  registerReadTool(tools, 'feed.tag.search', async (input) => ({
    data: {
      resolvedTags: [{ id: 'ai_compute', name: 'AI算力' }],
      timeRange: input.timeRange || 'today',
      matchedCount: 1,
      items: [{ id: 'c-ascend', title: '昇腾 960 发布', body: '华为发布昇腾 960', publishedAt: Date.parse('2026-09-17T02:00:00.000Z') }],
    },
    refs: [], observedAt: 1, warnings: [],
  }));
  registerReadTool(tools, 'web.search', async () => {
    webCalls += 1;
    return { data: { available: true, results: [] }, refs: [], observedAt: 1, warnings: [] };
  });
  let round = 0;
  let firstRequest;
  const runtime = createAgentRuntime({
    tools,
    llm: {
      respond: async (request) => {
        round += 1;
        if (round === 1) {
          firstRequest = request;
          return {
            toolCalls: [{ name: 'feed_tag_search', args: { tag: '算力', timeRange: 'today' } }],
            modelContent: { role: 'model', parts: [] }, providerId: 'fake', modelId: 'fake',
          };
        }
        return { text: '今天算力 tag 命中昇腾 960。', providerId: 'fake', modelId: 'fake' };
      },
    },
  });
  const result = await runtime.run({
    message: '看下我们今天的社媒下，算力 tag 相关的新闻有哪些',
    workspaceId: 'local',
    webMode: 'always',
  });
  assert.equal(firstRequest.toolChoice, undefined);
  assert.ok(firstRequest.tools.some((tool) => tool.id === 'web.search'));
  assert.ok(firstRequest.tools.some((tool) => tool.id === 'feed.tag.search'));
  assert.equal(webCalls, 0);
  assert.deepEqual(result.toolCalls.map((call) => call.id), ['feed.tag.search']);
  assert.match(result.answer, /昇腾 960/);
});

test('public web query keeps the full tool table and lets the model choose web.search', async () => {
  const tools = createToolRegistry();
  for (const id of ['feed.search', 'feed.tag.search', 'holdings.get', 'market.global.get']) {
    registerReadTool(tools, id, async () => ({ data: {}, refs: [], observedAt: 1, warnings: [] }));
  }
  const searches = [];
  registerReadTool(tools, 'web.search', async (input) => {
    searches.push(input.query);
    return {
      data: { available: true, results: [{ title: 'Fed', url: 'https://example.com', snippet: 'held', publishedAt: '2026-09-16T00:00:00.000Z' }] },
      refs: [], observedAt: 1, warnings: [],
    };
  });
  let round = 0;
  let firstRequest;
  const runtime = createAgentRuntime({
    tools,
    llm: {
      respond: async (request) => {
        round += 1;
        if (round === 1) {
          firstRequest = request;
          return {
            toolCalls: [{ name: 'web_search', args: { query: 'Federal Reserve September 16 2026 rate decision' } }],
            modelContent: { role: 'model', parts: [] }, providerId: 'fake', modelId: 'fake',
          };
        }
        return { text: '根据 web.search，美联储维持利率。', providerId: 'fake', modelId: 'fake' };
      },
    },
  });
  const result = await runtime.run({
    message: '联网搜一下今天美国加息情况',
    workspaceId: 'local',
    webMode: 'always',
  });
  assert.equal(firstRequest.toolChoice, undefined);
  assert.ok(firstRequest.tools.map((tool) => tool.id).includes('feed.search'));
  assert.ok(firstRequest.tools.map((tool) => tool.id).includes('web.search'));
  assert.equal(searches.length, 1);
  assert.deepEqual(result.toolCalls.map((call) => call.id), ['web.search']);
  assert.match(result.answer, /维持利率/);
});

test('runtime rejects a final answer that fabricates web.search usage', async () => {
  const tools = createToolRegistry();
  registerReadTool(tools, 'web.search', async () => ({
    data: { available: true, results: [] }, refs: [], observedAt: 1, warnings: [],
  }));
  let round = 0;
  let sawProvenanceNote = false;
  const runtime = createAgentRuntime({
    tools,
    llm: {
      respond: async ({ contents }) => {
        round += 1;
        if (round === 1) return { text: '我已经通过 web.search 查到今天没有加息', providerId: 'fake', modelId: 'fake' };
        sawProvenanceNote = JSON.stringify(contents).includes('no web.search tool call exists');
        return { text: '我没有调用联网工具，因此不能核实今天的加息情况。', providerId: 'fake', modelId: 'fake' };
      },
    },
  });
  const result = await runtime.run({ message: '今天美联储加息了吗', workspaceId: 'local', webMode: 'fallback' });
  assert.equal(sawProvenanceNote, true);
  assert.equal(result.toolCalls.length, 0);
  assert.match(result.answer, /没有调用联网工具/);
});

test('explicit web request without a web.search call is sent back for correction', async () => {
  const tools = createToolRegistry();
  registerReadTool(tools, 'web.search', async () => ({
    data: { available: true, results: [] }, refs: [], observedAt: 1, warnings: [],
  }));
  let round = 0;
  let sawNote = false;
  const runtime = createAgentRuntime({
    tools,
    llm: {
      respond: async ({ contents }) => {
        round += 1;
        if (round === 1) return { text: '今天没有加息', providerId: 'fake', modelId: 'fake' };
        if (round === 2) {
          sawNote = JSON.stringify(contents).includes('explicitly asked to search');
          return {
            toolCalls: [{ name: 'web_search', args: { query: 'FOMC' } }],
            modelContent: { role: 'model', parts: [] }, providerId: 'fake', modelId: 'fake',
          };
        }
        return { text: '根据搜索结果，美联储维持利率。', providerId: 'fake', modelId: 'fake' };
      },
    },
  });
  const result = await runtime.run({ message: '联网搜一下今天美国加息情况', workspaceId: 'local', webMode: 'always' });
  assert.equal(sawNote, true);
  assert.equal(result.toolCalls[0].id, 'web.search');
  assert.match(result.answer, /维持利率/);
});

test('unavailable web.search counts as attempted evidence and does not retry forever', async () => {
  const tools = createToolRegistry();
  registerReadTool(tools, 'web.search', async () => ({
    data: { available: false, results: [] }, refs: [], observedAt: 1, warnings: ['web.search unavailable'],
  }));
  let round = 0;
  const runtime = createAgentRuntime({
    tools,
    llm: {
      respond: async () => {
        round += 1;
        if (round === 1) return {
          toolCalls: [{ name: 'web_search', args: { query: 'today FOMC' } }],
          modelContent: { role: 'model', parts: [] }, providerId: 'fake', modelId: 'fake',
        };
        if (round === 2) return { text: '我已经通过 web.search 查到今天没有加息', providerId: 'fake', modelId: 'fake' };
        return { text: '当前联网搜索不可用，因此我无法可靠核实今天的最新情况。', providerId: 'fake', modelId: 'fake' };
      },
    },
  });
  const result = await runtime.run({ message: '搜今天 FOMC', workspaceId: 'local', webMode: 'always' });
  assert.equal(result.toolCalls[0].id, 'web.search');
  assert.equal(result.toolCalls[0].webSearch.available, false);
  assert.match(result.answer, /无法可靠核实/);
  assert.equal(result.answer.includes('查到'), false);
  assert.equal(round, 3);
});

test('non-fresh knowledge questions do not require web.search even when webMode is always', async () => {
  const tools = createToolRegistry();
  let searches = 0;
  registerReadTool(tools, 'web.search', async () => {
    searches += 1;
    return { data: { available: true, results: [] }, refs: [], observedAt: 1, warnings: [] };
  });
  const runtime = createAgentRuntime({
    tools,
    llm: { respond: async () => ({ text: 'HBAO 是一种抗锯齿技术。', providerId: 'fake', modelId: 'fake' }) },
  });
  const result = await runtime.run({ message: '解释一下 HBAO 原理', workspaceId: 'local', webMode: 'always' });
  assert.equal(searches, 0);
  assert.equal(result.toolCalls.length, 0);
  assert.match(result.answer, /HBAO/);
});

test('local holdings questions can skip web.search even with current-time wording', async () => {
  const tools = createToolRegistry();
  registerReadTool(tools, 'holdings.get', async () => ({
    data: { positions: [{ symbol: 'NVDA' }] }, refs: [], observedAt: 1, warnings: [],
  }));
  registerReadTool(tools, 'web.search', async () => ({
    data: { available: true, results: [] }, refs: [], observedAt: 1, warnings: [],
  }));
  let round = 0;
  let firstRequest;
  const runtime = createAgentRuntime({
    tools,
    llm: {
      respond: async (request) => {
        round += 1;
        if (round === 1) {
          firstRequest = request;
          return {
            toolCalls: [{ name: 'holdings_get', args: {} }],
            modelContent: { role: 'model', parts: [] }, providerId: 'fake', modelId: 'fake',
          };
        }
        return { text: '当前持仓包含 NVDA。', providerId: 'fake', modelId: 'fake' };
      },
    },
  });
  const result = await runtime.run({ message: '看看我当前持仓', workspaceId: 'local', webMode: 'always' });
  assert.ok(firstRequest.tools.some((tool) => tool.id === 'web.search'));
  assert.equal(firstRequest.toolChoice, undefined);
  assert.deepEqual(result.toolCalls.map((call) => call.id), ['holdings.get']);
});

test('provider request includes authoritative current local time text', async () => {
  let seen;
  const now = new Date('2026-09-16T14:10:00.000Z');
  const runtime = createAgentRuntime({
    clock: () => now,
    timeZone: 'Asia/Shanghai',
    llm: {
      respond: async (request) => {
        seen = request;
        return { text: '无需工具', providerId: 'fake', modelId: 'fake' };
      },
    },
  });
  await runtime.run({ message: '你好' });
  assert.match(seen.budgetNote, /Current local time: 2026-09-16T22:10:00\+08:00/);
  assert.match(seen.budgetNote, /Current UTC time: 2026-09-16T14:10:00.000Z/);
  assert.match(seen.budgetNote, /remaining 12/);
  assert.equal(seen.budgetNote.includes('reusable reasoning context'), false);
  assert.match(seen.systemInstruction, /单 Agent/);
  assert.equal(seen.runtimeContext.currentLocalTime, '2026-09-16T22:10:00+08:00');
  assert.equal(seen.budgetNote.includes('2026-01-28'), false);
});

test('original rate-decision question traces to web.search rather than empty market sections', async () => {
  const tools = createToolRegistry();
  registerReadTool(tools, 'market.global.get', async () => ({
    data: { board: 'global', watchlist: [], sections: [] }, refs: [], observedAt: 1, warnings: ['global market board returned no projected instruments'],
  }));
  registerReadTool(tools, 'web.search', async (input) => ({
    data: {
      query: input.query, available: true,
      results: [{ title: 'FOMC', url: 'https://example.com/fomc', snippet: 'held the target range', publishedAt: '2026-09-16T18:00:00.000Z' }],
    },
    refs: [], observedAt: 2, warnings: [],
  }));
  let round = 0;
  const runtime = createAgentRuntime({
    tools,
    clock: () => new Date('2026-09-16T14:10:54.000Z'),
    llm: {
      respond: async () => {
        round += 1;
        if (round === 1) return {
          toolCalls: [{ name: 'web_search', args: { query: 'Federal Reserve FOMC September 16 2026 rate decision' } }],
          modelContent: { role: 'model', parts: [] }, providerId: 'fake', modelId: 'fake',
        };
        return { text: '根据 2026-09-16 的网页结果，美联储维持利率。', providerId: 'fake', modelId: 'fake' };
      },
    },
  });
  const result = await runtime.run({
    message: '看下现在是不是支持联网工具了，如实回答我，不支持的话就返回，支持的话就帮我搜今天的美国加息情况',
    workspaceId: 'local',
    webMode: 'always',
  });
  assert.deepEqual(result.toolCalls.map((call) => call.id), ['web.search']);
  assert.match(result.answer, /维持利率/);
  assert.equal(result.answer.includes('2026 年 1 月'), false);
});

test('webMode=off hides web.search but still calls the model', async () => {
  const tools = createToolRegistry();
  registerReadTool(tools, 'feed.search', async () => ({ data: [], refs: [], observedAt: 1, warnings: [] }));
  registerReadTool(tools, 'web.search', async () => ({ data: { available: true, results: [] }, refs: [], observedAt: 1, warnings: [] }));
  let round = 0;
  let firstRequest;
  const runtime = createAgentRuntime({
    tools,
    llm: {
      respond: async (request) => {
        round += 1;
        firstRequest = request;
        return { text: '当前没有联网搜索工具。', providerId: 'fake', modelId: 'fake' };
      },
    },
  });
  const result = await runtime.run({
    message: '帮我搜今天 FOMC',
    workspaceId: 'local',
    webMode: 'off',
  });
  assert.equal(round, 1);
  assert.equal(firstRequest.tools.some((tool) => tool.id === 'web.search'), false);
  assert.ok(firstRequest.tools.some((tool) => tool.id === 'feed.search'));
  assert.match(result.answer, /没有联网搜索/);
});
