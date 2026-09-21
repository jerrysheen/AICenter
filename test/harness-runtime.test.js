import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createStore } from '../packages/database/src/index.js';
import { createAiCenterWorker } from '../apps/worker/src/worker.js';
import { createToolRegistry } from '../packages/runtime/src/tool-registry.js';
import { z } from 'zod';
import { AgentToolResultSchema, ARTICLE_ANALYSIS_JOB_TYPE, HoldingsRankToolInputSchema, KnowledgeSearchToolInputSchema } from '../packages/contracts/src/index.js';
import {
  buildHarnessPrompt,
  createHarnessAgentRuntime,
  createToolGateway,
  harnessDshEntryPath,
  harnessPatchPath,
  materializeHarnessPatch,
  parseAgentRuntimeMode,
  projectHarnessTraceEvents,
  projectToolCatalog,
  resolveAgentRuntimeMode,
  toDefineToolParameters,
  resolveHarnessLaunch,
  resolveHarnessLlm,
  resolveHarnessWebSearchProvider,
} from '../packages/harness/src/index.js';
import { HARNESS_DEFAULT_MODEL, HARNESS_ELUCID_PROVIDER, HARNESS_PROVIDER } from '../packages/harness/src/constants.js';
import { HARNESS_ELUCID_SEARCH_PROVIDER_ID } from '../packages/harness/src/web-search-elucid.js';
import { fromHarnessToolName, toHarnessToolName } from '../packages/harness/src/tool-id.js';
import { applyHarnessEvidenceGate } from '../packages/harness/src/evidence.js';

function temporaryDirectory() {
  return mkdtempSync(path.join(os.tmpdir(), 'ai-center-harness-'));
}

function holdingsTools() {
  const tools = createToolRegistry();
  tools.register({
    id: 'holdings.rank',
    effect: 'read',
    description: '从当前持仓快照按盈亏排序并截取短列表。',
    inputSchema: HoldingsRankToolInputSchema,
    resultSchema: AgentToolResultSchema,
    async execute(input, context) {
      return {
        data: {
          metric: input.metric,
          positions: [{ symbol: 'TEST', name: '测试', workspaceId: context.workspaceId }],
          returnedCount: 1,
          totalCount: 1,
          truncated: false,
        },
        refs: [{
          resourceType: 'holdings-board',
          resourceId: `${context.workspaceId}:current`,
          revision: null,
          asOf: 1,
          label: '当前持仓与行情快照',
          origin: 'tool',
        }],
        observedAt: 1,
        warnings: [],
      };
    },
  });
  tools.register({
    id: 'holdings.get',
    effect: 'read',
    description: '读取当前持仓。',
    async execute() {
      return { data: { positions: [] }, refs: [], observedAt: 1, warnings: [] };
    },
  });
  return tools;
}

test('zlib shim exposes zstd names for Harness plugins', async () => {
  const zlib = await import('../packages/harness/src/dsh-zlib-shim.js');
  assert.equal(typeof zlib.createZstdDecompress, 'function');
  assert.equal(typeof zlib.createZstdCompress, 'function');
  assert.throws(() => zlib.createZstdDecompress(), /Node\.js >= 22\.15/);
});

test('overlay patch keeps built-in web and rewrites the plugin to a file URL', () => {
  const overlay = materializeHarnessPatch(readFileSync(harnessPatchPath(), 'utf8'));
  assert.match(overlay, /compression: none/);
  assert.match(overlay, /name: "file:\/\/\//);
  assert.doesNotMatch(overlay, /name: \.\/plugin\/src\/index\.js/);
  assert.doesNotMatch(overlay, /dsh-tool-web[\s\S]*disabled: true/);
  assert.match(overlay, /Use built-in web_search and web_fetch/);
  assert.match(overlay, /web-search-elucid/);
  assert.match(overlay, /plugin\/src\/web-search-elucid\.js/);
  assert.doesNotMatch(overlay, /name: \.\/plugin\/src\/web-search-elucid\.js/);
});

test('harness model ignores legacy DEEPSEEK_SEARCH_MODEL', () => {
  const directory = temporaryDirectory();
  const gateway = { url: 'http://127.0.0.1:9', token: 'a'.repeat(64) };
  const catalogPath = path.join(directory, 'tools.json');
  try {
    const inherited = resolveHarnessLaunch({
      env: { DEEPSEEK_SEARCH_MODEL: 'legacy-search-model' },
      runtimeDirectory: directory,
      gateway,
      catalogPath,
    });
    assert.equal(inherited.model, HARNESS_DEFAULT_MODEL);
    const explicit = resolveHarnessLaunch({
      env: {
        AI_CENTER_HARNESS_MODEL: 'harness-ask-model',
        DEEPSEEK_SEARCH_MODEL: 'legacy-search-model',
      },
      runtimeDirectory: directory,
      gateway,
      catalogPath,
    });
    assert.equal(explicit.model, 'harness-ask-model');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('harness LLM route can use Elucid Grok through dsh-llm-pi-ai', () => {
  const directory = temporaryDirectory();
  const gateway = { url: 'http://127.0.0.1:9', token: 'a'.repeat(64) };
  const catalogPath = path.join(directory, 'tools.json');
  try {
    const auto = resolveHarnessLlm({
      AI_CENTER_HARNESS_PROVIDER: 'elucid-grok',
      ELUCID_GROK_API_KEY: 'elucid-key',
    });
    assert.equal(auto.provider, HARNESS_ELUCID_PROVIDER);
    assert.equal(auto.model, 'grok-4.6');
    assert.equal(auto.apiKeyEnv, 'ELUCID_GROK_API_KEY');
    assert.equal(auto.protocol, 'openai-responses');
    assert.match(auto.settingsYaml, /llm-deepseek:/);
    assert.match(auto.settingsYaml, /llm-pi-ai:/);
    assert.match(auto.settingsYaml, /api: openai-responses/);
    assert.match(auto.settingsYaml, /hk\.getelucid\.com\/v1/);
    assert.match(auto.settingsYaml, /grok-4.6/);
    assert.doesNotMatch(auto.settingsYaml, /elucid-key/);

    const launch = resolveHarnessLaunch({
      env: {
        AI_CENTER_HARNESS_PROVIDER: 'elucid-grok',
        ELUCID_GROK_API_KEY: 'elucid-key',
        AI_CENTER_ELUCID_GROK_API_ROOT: 'https://hk.getelucid.com/v1/',
        AI_CENTER_HARNESS_RESEARCH_MODEL: 'grok-research',
      },
      runtimeDirectory: directory,
      gateway,
      catalogPath,
      researchProfile: { mode: 'research', modelProfile: 'research' },
    });
    assert.equal(launch.provider, HARNESS_ELUCID_PROVIDER);
    assert.equal(launch.model, 'grok-research');
    assert.equal(launch.env.DSH_WEB_SEARCH_PROVIDER, HARNESS_ELUCID_SEARCH_PROVIDER_ID);
    assert.match(launch.llm.settingsYaml, /grok-research/);

    const pinned = resolveHarnessLlm({
      AI_CENTER_HARNESS_PROVIDER: 'deepseek-official',
      ELUCID_GROK_API_KEY: 'elucid-key',
      DEEPSEEK_API_KEY: 'deepseek-key',
    });
    assert.equal(pinned.provider, HARNESS_PROVIDER);
    assert.equal(pinned.model, HARNESS_DEFAULT_MODEL);
    assert.equal(resolveHarnessWebSearchProvider({
      AI_CENTER_HARNESS_PROVIDER: 'deepseek-official',
    }), HARNESS_PROVIDER);
    assert.match(pinned.settingsYaml, /llm-deepseek:/);
    assert.match(pinned.settingsYaml, /elucid-grok:/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('dsh entry prints sdk config on Node without import.meta.main', { timeout: 30_000 }, () => {
  const home = temporaryDirectory();
  try {
    const result = spawnSync(process.execPath, [
      harnessDshEntryPath(),
      '--profile',
      'sdk',
      '--dump-config',
    ], {
      encoding: 'utf8',
      env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
      timeout: 25_000,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message || 'dsh dump-config failed');
    assert.match(result.stdout, /sdk|dsh-sdk|profile/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('production executor is harness; injected LLM stays on the local loop', () => {
  assert.equal(parseAgentRuntimeMode(''), 'harness');
  assert.equal(parseAgentRuntimeMode('harness'), 'harness');
  assert.equal(parseAgentRuntimeMode('local'), 'local');
  assert.equal(resolveAgentRuntimeMode({ agentClient: { ask() {} } }, { AI_CENTER_AGENT_RUNTIME: 'harness' }), 'local');
  assert.equal(resolveAgentRuntimeMode({ agentRuntimeMode: 'harness' }, {}), 'harness');
  assert.equal(resolveAgentRuntimeMode({}, {}), 'harness');
  assert.equal(resolveAgentRuntimeMode({}, { AI_CENTER_AGENT_RUNTIME: 'local' }), 'local');
});

test('tool catalog only exposes the allowlisted Domain tools', () => {
  const catalog = projectToolCatalog(holdingsTools(), ['holdings.rank']);
  assert.deepEqual(catalog.map((tool) => tool.id), ['holdings.rank']);
  assert.equal(toHarnessToolName('holdings.rank'), 'holdings_rank');
  assert.equal(fromHarnessToolName('holdings_rank'), 'holdings.rank');
});

test('tool catalog defaults to every registered Domain tool', () => {
  assert.deepEqual(projectToolCatalog(holdingsTools()).map((tool) => tool.id), ['holdings.rank', 'holdings.get']);
});

test('defineTool projection keeps defaults optional and writes taxonomy format into description', () => {
  const { $schema, ...parameters } = z.toJSONSchema(KnowledgeSearchToolInputSchema);
  void $schema;
  const spec = toDefineToolParameters(parameters);
  assert.equal(spec.query.required, undefined);
  assert.equal(spec.taxonomy.required, undefined);
  assert.equal(spec.limit.required, undefined);
  assert.equal(spec.query.default, '');
  assert.deepEqual(spec.taxonomy.default, []);
  assert.equal(spec.limit.default, 8);
  assert.equal(spec.taxonomy.items.type, 'string');
  assert.equal(spec.taxonomy.items.pattern, undefined);
  assert.match(spec.taxonomy.items.description, /domain\.investment/);
  assert.deepEqual(spec.taxonomy.items.examples, ['domain.investment']);
  assert.match(spec.limit.description, /最小 1/);
  assert.match(spec.limit.description, /最大 20/);
});

test('defineTool projection still marks fields without defaults as required', () => {
  const spec = toDefineToolParameters({
    type: 'object',
    required: ['knowledgeId'],
    properties: {
      knowledgeId: { type: 'string' },
    },
  });
  assert.equal(spec.knowledgeId.required, true);
});

test('harness availableTools keeps built-in web and does not expose Domain web.search', () => {
  const directory = temporaryDirectory();
  const tools = holdingsTools();
  tools.register({
    id: 'web.search',
    effect: 'read',
    description: '搜索公开互联网网页。',
    async execute() {
      return { data: { results: [] }, refs: [], observedAt: 1, warnings: [] };
    },
  });
  try {
    const runtime = createHarnessAgentRuntime({
      tools,
      runtimeDirectory: directory,
      env: { DEEPSEEK_API_KEY: 'test-key' },
      async createClient() {
        return { async run() { return { finalResponse: 'ok', events: [] }; }, async close() {} };
      },
    });
    const off = runtime.availableTools({ webMode: 'off' }).map((tool) => tool.id);
    const always = runtime.availableTools({ webMode: 'always' }).map((tool) => tool.id);
    assert.deepEqual(off.filter((id) => id === 'web.search' || id === 'web.fetch').sort(), ['web.fetch', 'web.search']);
    assert.deepEqual(always.filter((id) => id === 'web.search' || id === 'web.fetch').sort(), ['web.fetch', 'web.search']);
    assert.ok(off.includes('holdings.rank'));
    assert.equal(off.filter((id) => id === 'web.search').length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('tool gateway executes Domain tools on loopback and rejects unknown tools', async () => {
  const tools = holdingsTools();
  const gateway = await createToolGateway({
    tools,
    allowedToolIds: ['holdings.rank'],
    context: { workspaceId: 'local' },
    token: 'a'.repeat(64),
  });
  try {
    const allowed = await fetch(`${gateway.url}/tools/execute`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${'a'.repeat(64)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: 'holdings_rank', input: { metric: 'dayPnlPct', limit: 5 } }),
    });
    const body = await allowed.json();
    assert.equal(allowed.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.result.data.positions[0].symbol, 'TEST');

    const denied = await fetch(`${gateway.url}/tools/execute`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${'a'.repeat(64)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: 'holdings.get', input: {} }),
    });
    assert.equal(denied.status, 403);

    const unauthorized = await fetch(`${gateway.url}/tools/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'holdings.rank', input: {} }),
    });
    assert.equal(unauthorized.status, 401);
  } finally {
    await gateway.close();
  }
});

test('harness prompt describes built-in web, not Domain web.search', () => {
  const prompt = buildHarnessPrompt({
    message: '核验这条新闻',
    webMode: 'fallback',
    catalog: [{ id: 'knowledge.search', name: 'knowledge_search', description: '本地知识' }],
  });
  assert.match(prompt, /内置 web_search \/ web_fetch/);
  assert.doesNotMatch(prompt, /Domain web\.search/);
});

test('harness prompt keeps the existing Agent instruction and names Domain tools', () => {
  const prompt = buildHarnessPrompt({
    message: '今天跌最多的是谁',
    webMode: 'off',
    runtimeContext: {
      currentUtcTime: '2026-09-20T04:00:00.000Z',
      timeZone: 'Asia/Shanghai',
      currentLocalTime: '2026-09-20T12:00:00+08:00',
    },
    catalog: [{ id: 'holdings.rank', name: 'holdings_rank', description: '持仓排序' }],
  });
  assert.match(prompt, /你是 AI Center 的单 Agent/);
  assert.match(prompt, /holdings\.rank/);
  assert.match(prompt, /web_search \/ web_fetch/);
  assert.match(prompt, /今天跌最多的是谁/);
  assert.match(prompt, /Current local time: 2026-09-20T12:00:00\+08:00/);
});

test('harness tool failures retain the official result reason', () => {
  const traces = projectHarnessTraceEvents([
    { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
    {
      type: 'tool/call',
      seq: 2,
      time: 2,
      data: {
        turn: 1,
        step: 1,
        callId: 'bad-knowledge',
        name: 'knowledge_search',
        arguments: JSON.stringify({ taxonomy: 'not-an-array' }),
      },
    },
    {
      type: 'tool/result',
      seq: 3,
      time: 3,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'user',
          source: { kind: 'tool', callId: 'bad-knowledge' },
          content: [{
            type: 'tool-result',
            toolCallId: 'bad-knowledge',
            isError: true,
            content: [{ type: 'text', text: 'taxonomy 必须是数组' }],
          }],
        },
      },
      surfaceOp: 'append',
    },
  ]);
  const failed = traces.find((item) => item.event === 'tool.failed');
  assert.equal(failed.detail.id, 'knowledge.search');
  assert.equal(failed.detail.error.message, 'taxonomy 必须是数组');
});

test('harness runtime drives the SDK client and records Domain tool results', async () => {
  const directory = temporaryDirectory();
  const traces = [];
  let seenPrompt = '';
  const runtime = createHarnessAgentRuntime({
    tools: holdingsTools(),
    runtimeDirectory: directory,
    env: { DEEPSEEK_API_KEY: 'test-key', AI_CENTER_HARNESS_TOOL_IDS: 'holdings.rank' },
    async createClient(launch) {
      assert.equal(launch.profile, 'sdk');
      assert.equal(launch.dshBin, harnessDshEntryPath());
      assert.match(readFileSync(launch.patches[0], 'utf8'), /name: "file:\/\/\//);
      assert.equal(launch.env.DSH_TELEMETRY_DISABLED, '1');
      assert.equal(launch.env.DSH_PERMISSION_MODE, 'read-only');
      assert.match(launch.env.AI_CENTER_HARNESS_GATEWAY_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
      const catalog = JSON.parse(await readFile(launch.env.AI_CENTER_HARNESS_TOOL_CATALOG_PATH, 'utf8'));
      assert.deepEqual(catalog.tools.map((tool) => tool.id), ['holdings.rank']);
      return {
        async run(prompt) {
          seenPrompt = prompt;
          const executed = await fetch(`${launch.env.AI_CENTER_HARNESS_GATEWAY_URL}/tools/execute`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${launch.env.AI_CENTER_HARNESS_GATEWAY_TOKEN}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ id: 'holdings.rank', input: { metric: 'dayPnlPct', limit: 3 } }),
          });
          assert.equal(executed.status, 200);
          return {
            sessionId: 'dsh-session',
            finalResponse: '跌最多的是测试。',
            events: [
              { type: 'turn/start' },
              { type: 'tool/call', name: 'holdings_rank', arguments: { metric: 'dayPnlPct' } },
              { type: 'tool/result', name: 'holdings_rank' },
              { type: 'assistant/message', text: '跌最多的是测试。' },
            ],
            notifications: [],
          };
        },
        async close() {},
      };
    },
  });
  try {
    const result = await runtime.run({
      message: '今天谁跌最多',
      workspaceId: 'local',
      trace: (entry) => traces.push(entry),
    });
    assert.equal(result.providerId, 'deepseek-official');
    assert.equal(result.answer, '跌最多的是测试。');
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].id, 'holdings.rank');
    assert.equal(result.refs[0].resourceType, 'holdings-board');
    assert.match(seenPrompt, /今天谁跌最多/);
    assert.ok(traces.some((item) => item.event === 'tool.started'));
    assert.ok(traces.some((item) => item.event === 'run.completed'));
  } finally {
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('harness runtime writes Elucid Grok into dsh settings and launch provider', async () => {
  const directory = temporaryDirectory();
  let seenLaunch = null;
  const runtime = createHarnessAgentRuntime({
    tools: holdingsTools(),
    runtimeDirectory: directory,
    env: {
      ELUCID_GROK_API_KEY: 'elucid-key',
      AI_CENTER_HARNESS_PROVIDER: 'elucid-grok',
    },
    async createClient(launch) {
      seenLaunch = launch;
      return {
        async run() {
          return { sessionId: 'dsh-elucid', finalResponse: 'Grok 回答', events: [] };
        },
        async close() {},
      };
    },
  });
  try {
    const result = await runtime.run({ message: '你好', workspaceId: 'local' });
    assert.equal(result.providerId, HARNESS_ELUCID_PROVIDER);
    assert.equal(result.modelId, 'grok-4.6');
    assert.equal(result.answer, 'Grok 回答');
    assert.equal(seenLaunch.provider, HARNESS_ELUCID_PROVIDER);
    assert.equal(seenLaunch.model, 'grok-4.6');
    const settings = readFileSync(path.join(seenLaunch.dshHome, 'settings.yaml'), 'utf8');
    assert.match(settings, /api: openai-responses/);
    assert.match(settings, /elucid-grok:/);
    assert.doesNotMatch(settings, /elucid-key/);
  } finally {
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('worker ask job can complete through the Harness adapter', async () => {
  const directory = temporaryDirectory();
  const store = createStore(path.join(directory, 'ai-center.db'));
  const worker = createAiCenterWorker({
    store,
    workerId: 'harness-job-worker',
    instanceRoot: directory,
    dataDirectory: directory,
    runtimeDirectory: path.join(directory, 'runtime'),
    agentQuality: null,
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: 'test-key',
      AI_CENTER_AGENT_RUNTIME: 'harness',
      AI_CENTER_HARNESS_PROVIDER: 'deepseek-official',
    },
    async createHarnessClient() {
      return {
        async run() {
          return { sessionId: 'dsh-session', finalResponse: 'Harness 回答', events: [], notifications: [] };
        },
        async close() {},
      };
    },
  });
  try {
    const job = store.createJob({ type: 'ai.agent.run', input: { message: 'hello', webMode: 'off' }, maxAttempts: 1 });
    const completed = await worker.runner.runOnce();
    assert.equal(completed.id, job.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.output.answer, 'Harness 回答');
    assert.equal(completed.output.providerId, 'deepseek-official');
  } finally {
    await worker.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('article analysis job uses the same Harness executor', async () => {
  const directory = temporaryDirectory();
  const store = createStore(path.join(directory, 'ai-center.db'));
  let seenAllow = null;
  const worker = createAiCenterWorker({
    store,
    workerId: 'harness-article-worker',
    instanceRoot: directory,
    dataDirectory: directory,
    runtimeDirectory: path.join(directory, 'runtime'),
    agentQuality: null,
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: 'test-key',
      AI_CENTER_AGENT_RUNTIME: 'harness',
      AI_CENTER_HARNESS_PROVIDER: 'deepseek-official',
    },
    async createHarnessClient() {
      return {
        async run(prompt) {
          seenAllow = prompt;
          return { sessionId: 'dsh-article', finalResponse: '## Knowledge\nAttention 用来聚合上下文。', events: [] };
        },
        async close() {},
      };
    },
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
    const completed = await worker.runner.runOnce();
    assert.equal(completed.id, job.id);
    assert.equal(completed.status, 'completed');
    assert.match(completed.output.outputText, /Attention/);
    assert.match(seenAllow, /请阅读下面这份材料/);
    assert.match(seenAllow, /- knowledge\.search \(/);
    assert.match(seenAllow, /- web\.fetch \(/);
    assert.doesNotMatch(seenAllow, /- holdings\.get \(/);
  } finally {
    await worker.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('evidence gate can replace retrieval results before Harness sees them', async () => {
  const traces = [];
  const { observed } = await applyHarnessEvidenceGate({
    quality: {
      config: { evidenceGateMode: 'enforce' },
      async gateEvidence() {
        return {
          status: 'ok',
          mode: 'enforce',
          hits: [
            { index: 0, accepted: false, title: 'spam', url: 'https://example.com' },
            { index: 1, accepted: true, title: 'fed', url: 'https://federalreserve.gov' },
          ],
          accepted: [{ index: 1, title: 'fed', url: 'https://federalreserve.gov' }],
          rejected: [{ index: 0, host: 'example.com' }],
        };
      },
    },
    toolId: 'web.search',
    toolResult: {
      data: {
        query: 'q',
        results: [
          { title: 'spam', url: 'https://example.com' },
          { title: 'fed', url: 'https://federalreserve.gov' },
        ],
      },
      refs: [],
      observedAt: 1,
      warnings: [],
    },
    record: (event, detail) => traces.push({ event, detail }),
  });
  assert.equal(observed.data.results.length, 1);
  assert.equal(observed.data.results[0].title, 'fed');
  assert.ok(traces.some((item) => item.event === 'evidence.gate.completed'));
});

test('harness reuses one subprocess and sends a short follow-up on the same session', async () => {
  const directory = temporaryDirectory();
  const prompts = [];
  const sessionIds = [];
  let created = 0;
  const runtime = createHarnessAgentRuntime({
    tools: holdingsTools(),
    runtimeDirectory: directory,
    env: { DEEPSEEK_API_KEY: 'test-key' },
    async createClient() {
      created += 1;
      return {
        async run(prompt, options) {
          prompts.push(prompt);
          sessionIds.push(options?.sessionId || '');
          return { sessionId: options?.sessionId || 'minted', finalResponse: 'ok', events: [] };
        },
        async close() {},
      };
    },
  });
  try {
    await runtime.run({ message: '第一问', workspaceId: 'local', sessionId: 'sess-1' });
    await runtime.run({ message: '第二问', workspaceId: 'local', sessionId: 'sess-1' });
    assert.equal(created, 1);
    assert.match(prompts[0], /你是 AI Center 的单 Agent/);
    assert.equal(prompts[1], '第二问');
    assert.equal(sessionIds.length, 2);
    assert.equal(sessionIds[0], sessionIds[1]);
    assert.match(sessionIds[0], /^aicenter-[0-9a-f]{32}$/);
  } finally {
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('harness records real nested session events and enriches completion from the Tool Gateway', async () => {
  const directory = temporaryDirectory();
  const traces = [];
  const runtime = createHarnessAgentRuntime({
    tools: holdingsTools(),
    runtimeDirectory: directory,
    env: { DEEPSEEK_API_KEY: 'test-key', AI_CENTER_HARNESS_TOOL_IDS: 'holdings.rank' },
    async createClient(launch) {
      return {
        async run(_prompt, options) {
          await options.onNotification({
            method: 'session.status',
            params: { sessionId: 'session-nested', status: 'running' },
          });
          await options.onNotification({
            method: 'session.event',
            params: {
              sessionId: 'session-nested',
              event: { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
            },
          });
          await options.onNotification({
            method: 'session.event',
            params: {
              sessionId: 'session-nested',
              event: {
                type: 'tool/call',
                seq: 2,
                time: 2,
                data: {
                  turn: 1,
                  step: 1,
                  callId: 'call-nested',
                  name: 'holdings_rank',
                  arguments: JSON.stringify({ metric: 'dayPnlPct', limit: 3 }),
                },
              },
            },
          });
          const executed = await fetch(`${launch.env.AI_CENTER_HARNESS_GATEWAY_URL}/tools/execute`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${launch.env.AI_CENTER_HARNESS_GATEWAY_TOKEN}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ id: 'holdings.rank', input: { metric: 'dayPnlPct', limit: 3 } }),
          });
          assert.equal(executed.status, 200);
          await options.onNotification({
            method: 'session.event',
            params: {
              sessionId: 'session-nested',
              event: {
                type: 'tool/result',
                seq: 3,
                time: 3,
                data: {
                  turn: 1,
                  step: 1,
                  message: {
                    role: 'tool',
                    source: { kind: 'tool', callId: 'call-nested' },
                    content: [{
                      type: 'tool-result',
                      toolCallId: 'call-nested',
                      content: [{ type: 'text', text: '{}' }],
                    }],
                  },
                },
                surfaceOp: 'append',
              },
            },
          });
          await options.onNotification({
            method: 'session.status',
            params: { sessionId: 'session-nested', status: 'idle' },
          });
          return { sessionId: 'session-nested', finalResponse: '跌最多的是测试。', events: [] };
        },
        async close() {},
      };
    },
  });
  try {
    await runtime.run({
      message: '今天谁跌最多',
      workspaceId: 'local',
      trace: (entry) => traces.push(entry),
    });
    const started = traces.find((item) => item.event === 'tool.started');
    assert.equal(started.detail.id, 'holdings.rank');
    assert.equal(started.detail.callId, 'call-nested');
    assert.equal(started.detail.input.metric, 'dayPnlPct');
    const completed = traces.find((item) => item.event === 'tool.completed');
    assert.equal(completed.detail.callId, 'call-nested');
    assert.equal(completed.detail.id, 'holdings.rank');
    assert.equal(completed.detail.data.returnedCount, 1);
    assert.ok(traces.some((item) => item.event === 'harness.status' && item.detail.status === 'idle'));
  } finally {
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('harness Final Guard rejects a fabricated web.search claim', async () => {
  const directory = temporaryDirectory();
  const prompts = [];
  const traces = [];
  const runtime = createHarnessAgentRuntime({
    tools: holdingsTools(),
    runtimeDirectory: directory,
    env: { DEEPSEEK_API_KEY: 'test-key' },
    async createClient() {
      return {
        async run(prompt) {
          prompts.push(prompt);
          if (prompts.length === 1) {
            return { sessionId: 's1', finalResponse: '我通过 web.search 查到了今天美联储降息。', events: [] };
          }
          return { sessionId: 's1', finalResponse: '我没有搜索公开网页。', events: [] };
        },
        async close() {},
      };
    },
  });
  try {
    const result = await runtime.run({
      message: '美联储怎么了',
      workspaceId: 'local',
      webMode: 'off',
      trace: (entry) => traces.push(entry),
    });
    assert.equal(result.rejectedAnswers, 1);
    assert.equal(result.answer, '我没有搜索公开网页。');
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /web\.search/);
    assert.ok(traces.some((item) => item.event === 'answer.rejected'));
  } finally {
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('harness counts native web_fetch from session events', async () => {
  const directory = temporaryDirectory();
  const traces = [];
  const runtime = createHarnessAgentRuntime({
    tools: holdingsTools(),
    runtimeDirectory: directory,
    env: { DEEPSEEK_API_KEY: 'test-key' },
    async createClient() {
      return {
        async run(_prompt, options) {
          await options.onNotification({
            method: 'session.event',
            params: { event: { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } } },
          });
          await options.onNotification({
            method: 'session.event',
            params: {
              event: {
                type: 'tool/call',
                seq: 2,
                time: 2,
                data: {
                  callId: 'fetch-1',
                  name: 'web_fetch',
                  arguments: JSON.stringify({ url: 'https://example.com/report' }),
                },
              },
            },
          });
          await options.onNotification({
            method: 'session.event',
            params: {
              event: {
                type: 'tool/result',
                seq: 3,
                time: 3,
                data: {
                  callId: 'fetch-1',
                  message: {
                    source: { kind: 'tool', callId: 'fetch-1' },
                    content: [{
                      type: 'tool-result',
                      toolCallId: 'fetch-1',
                      content: [{ type: 'text', text: 'page body' }],
                    }],
                  },
                },
              },
            },
          });
          return { sessionId: 's-web', finalResponse: '已经读过该页。', events: [] };
        },
        async close() {},
      };
    },
  });
  try {
    const result = await runtime.run({
      message: '展开细读这篇报告',
      workspaceId: 'local',
      trace: (entry) => traces.push(entry),
    });
    assert.equal(result.toolCalls.map((call) => call.id).join(','), 'web.fetch');
    assert.ok(result.toolAudits.some((item) => item.tool === 'web.fetch' && item.success === true));
    assert.ok(traces.some((item) => item.event === 'tool.completed' && item.detail.id === 'web.fetch'));
  } finally {
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('harness records Gateway validation failures that never hit onExecuted', async () => {
  const directory = temporaryDirectory();
  const traces = [];
  const runtime = createHarnessAgentRuntime({
    tools: holdingsTools(),
    runtimeDirectory: directory,
    env: { DEEPSEEK_API_KEY: 'test-key' },
    async createClient() {
      return {
        async run(_prompt, options) {
          await options.onNotification({
            method: 'session.event',
            params: { event: { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } } },
          });
          await options.onNotification({
            method: 'session.event',
            params: {
              event: {
                type: 'tool/call',
                seq: 2,
                time: 2,
                data: {
                  callId: 'feed-1',
                  name: 'feed_search',
                  arguments: JSON.stringify({ q: 'macro' }),
                },
              },
            },
          });
          await options.onNotification({
            method: 'session.event',
            params: {
              event: {
                type: 'tool/result',
                seq: 3,
                time: 3,
                data: {
                  callId: 'feed-1',
                  message: {
                    source: { kind: 'tool', callId: 'feed-1' },
                    content: [{
                      type: 'tool-result',
                      toolCallId: 'feed-1',
                      isError: true,
                      content: [{ type: 'text', text: 'Tool result exceeds 64KB' }],
                    }],
                  },
                },
              },
            },
          });
          return { sessionId: 's-fail', finalResponse: '信息流这次没搜到。', events: [] };
        },
        async close() {},
      };
    },
  });
  try {
    const result = await runtime.run({
      message: '信息流里最近有什么',
      workspaceId: 'local',
      trace: (entry) => traces.push(entry),
    });
    assert.equal(result.toolCalls.map((call) => call.id).join(','), 'feed.search');
    assert.equal(result.toolCalls[0].result.error.message, 'Tool result exceeds 64KB');
    assert.ok(result.toolAudits.some((item) => item.tool === 'feed.search' && item.success === false));
    assert.ok(traces.some((item) => item.event === 'tool.failed' && item.detail.id === 'feed.search'));
  } finally {
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
