import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSearchToolInputSchema } from '../packages/contracts/src/index.js';
import { createDeepSeekSearchProvider, createElucidGrokAgentClient, createGeminiAgentClient } from '../packages/connectors/src/index.js';
import { createAgentRuntime } from '../packages/runtime/src/agent-runtime.js';
import { createToolRegistry } from '../packages/runtime/src/tool-registry.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function createConfiguredAgentClient() {
  const provider = String(process.env.AI_CENTER_AGENT_PROVIDER || '').trim().toLowerCase();
  if (provider === 'gemini') return createGeminiAgentClient();
  if (provider === 'elucid-grok' || process.env.ELUCID_GROK_API_KEY || process.env.AI_CENTER_GROK_API_KEY) {
    return createElucidGrokAgentClient();
  }
  return createGeminiAgentClient();
}

resolveInstanceConfig({ repositoryRoot });

const search = createDeepSeekSearchProvider();
const tools = createToolRegistry();
tools.register({
  id: 'web.search',
  effect: 'read',
  description: '联网检索公开网页的标题、链接和摘要。',
  inputSchema: WebSearchToolInputSchema,
  async execute(input) {
    try {
      const data = await search.search({ query: input.query, limit: input.limit });
      return { data, refs: [], observedAt: data.observedAt, warnings: [] };
    } catch (error) {
      return {
        data: { query: input.query, available: false, results: [] },
        refs: [],
        observedAt: Date.now(),
        warnings: [`web.search unavailable：${String(error.message || error).slice(0, 240)}`],
      };
    }
  },
});

const llm = createConfiguredAgentClient();
const requests = [];
const runtime = createAgentRuntime({
  llm: {
    respond: async (request) => {
      requests.push({
        toolChoice: request.toolChoice,
        toolNames: (request.tools || []).map((tool) => tool.name),
      });
      return llm.respond(request);
    },
  },
  tools,
});

const result = await runtime.run({
  message: '看下现在是不是支持联网工具了，如实回答我，不支持的话就返回，支持的话就帮我搜今天的美国加息情况',
  workspaceId: 'local',
  webMode: 'always',
});

const web = result.toolCalls.filter((call) => call.id === 'web.search');
if (!web.length) {
  throw new Error(`live run did not call web.search: ${JSON.stringify({
    providerId: result.providerId,
    modelId: result.modelId,
    tools: result.toolCalls.map((call) => call.id),
    toolChoice: requests.map((item) => item.toolChoice),
    answer: String(result.answer || '').slice(0, 300),
  })}`);
}

console.log(JSON.stringify({
  ok: true,
  providerId: result.providerId,
  modelId: result.modelId,
  modelCalls: requests.length,
  firstToolChoice: requests[0]?.toolChoice || null,
  webSearch: web.map((call) => ({
    query: call.input?.query,
    available: call.webSearch?.available,
    resultCount: call.webSearch?.resultCount,
  })),
  answerPreview: String(result.answer || '').replace(/\s+/g, ' ').slice(0, 400),
}, null, 2));
