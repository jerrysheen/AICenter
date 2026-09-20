import { modelIdForProfile } from './agent-model-profile.js';

const DEFAULT_ROOT = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-3.1-flash-lite';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function envText(...keys) {
  for (const key of keys) {
    const value = text(process.env[key]);
    if (value) return value;
  }
  return '';
}

function responseParts(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  return Array.isArray(parts) ? parts : [];
}

export function mergeInstruction(instruction, budgetNote) {
  return budgetNote ? `${instruction}\n\n${budgetNote}` : instruction;
}

export function geminiParameters(schema) {
  if (Array.isArray(schema)) {
    return schema.map((item) => (item && typeof item === 'object' && !Array.isArray(item) ? geminiParameters(item) : item));
  }
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {} };
  }
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === '$schema' || key === 'additionalProperties' || key === 'default') continue;
    if (Array.isArray(value) || (value && typeof value === 'object')) out[key] = geminiParameters(value);
    else out[key] = value;
  }
  return out;
}

export function geminiToolConfig(toolChoice) {
  const names = Array.isArray(toolChoice?.names) ? toolChoice.names.filter(Boolean) : [];
  if (toolChoice?.mode !== 'required' || !names.length) return undefined;
  return {
    functionCallingConfig: {
      mode: 'ANY',
      allowedFunctionNames: names,
    },
  };
}

const INSTRUCTIONS = `你是 AI Center 的单一助手。准确、简洁地用中文回答。用户询问本地知识库、信息流、行情、持仓或个人资产时，必须先调用可用工具并仅依据其结果回答；没有证据时明确说明。不要虚构本地数据、联网检索或执行过的操作。用最少工具完成问题；Runtime 会告知 Tool budget，单轮请求不能超过 remaining。预算耗尽后基于已有证据作答。
分析公司、行业、估值或投资质量时，先 knowledge.search 再按需 knowledge.get；把取回的 Knowledge 当作可复用判断结构，不是当前事实。当前 ARR、价格、财报等必须用信息流、行情或 web 工具核实。不要读取本地路径，不要一次装入整个知识库。
用户要求记录这次对话、总结进知识库、或把某段 hint 加入灵感时：先根据当前会话整理可独立阅读的内容，需要分类时先 taxonomy.list，再调用 memory.save。Inspiration 用 observation/hypothesis/question/idea；Knowledge 用 fact/mechanism/thesis/framework/case/procedure。推测不得写成 fact。bodyMarkdown 只写正文，禁止写入已落库、去向、分类路径或资源 ID。不要传入 sourceRefs。只有 memory.save 成功返回后，才能告诉用户已落库，并复述标题、类型和分类路径。`;

export function createGeminiAgentClient(options = {}) {
  const fetchImpl = options.fetch || fetch;
  // A dedicated key can replace the shared test key without changing code.
  const apiKey = options.apiKey !== undefined
    ? text(options.apiKey)
    : envText('AI_CENTER_AGENT_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'AI_CENTER_GEMINI_API_KEY');
  const apiRoot = (text(options.apiRoot) || envText('AI_CENTER_AGENT_API_ROOT', 'AI_CENTER_GEMINI_API_ROOT') || DEFAULT_ROOT).replace(/\/$/, '');
  const modelId = text(options.model) || envText('AI_CENTER_AGENT_MODEL', 'AI_CENTER_GEMINI_MODEL') || DEFAULT_MODEL;
  const researchModelId = text(options.researchModel) || envText('AI_CENTER_AGENT_RESEARCH_MODEL');

  return Object.freeze({
    async respond({ contents = [], tools = [], signal, budgetNote, systemInstruction, toolChoice, researchProfile } = {}) {
      if (!apiKey) throw new Error('未配置 AI_CENTER_AGENT_API_KEY 或 GEMINI_API_KEY');
      const usedModel = modelIdForProfile(modelId, researchModelId, researchProfile);
      const instruction = mergeInstruction(systemInstruction || INSTRUCTIONS, budgetNote);
      const toolConfig = geminiToolConfig(toolChoice);
      const response = await fetchImpl(`${apiRoot}/models/${encodeURIComponent(usedModel)}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: instruction }] },
          contents,
          ...(tools.length ? {
            tools: [{ functionDeclarations: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: geminiParameters(tool.parameters),
            })) }],
          } : {}),
          ...(toolConfig ? { toolConfig } : {}),
        }),
      });
      if (!response.ok) {
        let detail = '';
        try { detail = text((await response.json())?.error?.message); } catch {}
        throw new Error(`Gemini 问答失败（${response.status}${detail ? `: ${detail}` : ''}）`);
      }
      const payload = await response.json();
      const parts = responseParts(payload);
      const toolCalls = parts.filter((part) => part?.functionCall).map((part) => ({
        name: part.functionCall.name,
        args: part.functionCall.args || {},
      }));
      const answer = parts
        .filter((part) => !part?.thought && !part?.functionCall)
        .map((part) => text(part?.text))
        .join('')
        .trim();
      if (!answer && !toolCalls.length) throw new Error('Gemini 没有返回回答或工具请求');
      return {
        text: answer,
        toolCalls,
        modelContent: { role: 'model', parts },
        providerId: 'gemini',
        modelId: usedModel,
        warnings: [],
      };
    },
  });
}
