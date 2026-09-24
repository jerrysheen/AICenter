import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { modelIdForProfile } from './agent-model-profile.js';

const DEFAULT_ROOT = 'https://hk.getelucid.com/v1';
const DEFAULT_MODEL = 'grok-4.7';
export const ELUCID_GROK_DEFAULT_TIMEOUT_MS = 90_000;
export const ELUCID_GROK_MAX_TIMEOUT_MS = 600_000;

export function clampElucidTimeoutMs(value, fallback = ELUCID_GROK_DEFAULT_TIMEOUT_MS) {
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.max(10_000, Math.min(limit, ELUCID_GROK_MAX_TIMEOUT_MS));
}

export function elucidDispatcherOptions(timeoutMs) {
  const limit = clampElucidTimeoutMs(timeoutMs);
  return {
    headersTimeout: limit,
    bodyTimeout: limit,
    connectTimeout: 30_000,
  };
}

export function elucidHttpRequest(url, {
  method = 'GET',
  headers = {},
  body,
  signal,
  timeoutMs = ELUCID_GROK_DEFAULT_TIMEOUT_MS,
  onTransport,
} = {}) {
  const parsed = new URL(url);
  const transport = parsed.protocol === 'http:' ? httpRequest : httpsRequest;
  const requested = Number(timeoutMs);
  const limit = Number.isFinite(requested) && requested > 0 ? requested : ELUCID_GROK_DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  let bytesReceived = 0;
  let lastChunkEmit = 0;
  let sawFirstByte = false;
  const emit = (phase, extra = {}) => {
    if (typeof onTransport !== 'function') return;
    try {
      onTransport({
        phase,
        elapsedMs: Date.now() - startedAt,
        bytesReceived,
        ...extra,
      });
    } catch {
      /* transport observers must not fail the request */
    }
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const req = transport({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers,
    }, (response) => {
      emit('headers', { status: response.statusCode });
      const chunks = [];
      response.on('data', (chunk) => {
        chunks.push(chunk);
        bytesReceived += chunk.length;
        if (!sawFirstByte) {
          sawFirstByte = true;
          lastChunkEmit = bytesReceived;
          emit('first-byte');
          return;
        }
        if (bytesReceived - lastChunkEmit >= 2048) {
          lastChunkEmit = bytesReceived;
          emit('chunk');
        }
      });
      response.on('error', (error) => finish(() => reject(error)));
      response.on('end', () => {
        emit('complete');
        finish(() => resolve(new Response(Buffer.concat(chunks), {
          status: response.statusCode,
          headers: response.headers,
        })));
      });
    });
    req.on('socket', () => emit('socket'));
    req.setTimeout(limit, () => {
      const error = new Error(`Elucid Grok 等待响应超过 ${Math.round(limit / 1000)} 秒`);
      error.name = 'TimeoutError';
      req.destroy();
      finish(() => reject(error));
    });
    if (signal) {
      if (signal.aborted) {
        req.destroy();
        finish(() => reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted')));
        return;
      }
      signal.addEventListener('abort', () => {
        req.destroy();
        finish(() => reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted')));
      }, { once: true });
    }
    req.on('error', (error) => finish(() => reject(error)));
    req.end(body);
    emit('request');
  });
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function envText(env, ...keys) {
  const source = env || process.env;
  for (const key of keys) {
    const value = text(source[key]);
    if (value) return value;
  }
  return '';
}

const ELUCID_FUNCTION_NAME = Object.freeze({
  web_search: 'public_web_search',
});
const FROM_ELUCID_FUNCTION_NAME = Object.freeze({
  public_web_search: 'web_search',
});

function toElucidFunctionName(name) {
  return ELUCID_FUNCTION_NAME[name] || name;
}

function fromElucidFunctionName(name) {
  return FROM_ELUCID_FUNCTION_NAME[name] || name;
}

function toolCalls(payload) {
  return (payload?.output || []).filter((item) => item?.type === 'function_call').map((item) => {
    let args = {};
    try { args = JSON.parse(item.arguments || '{}'); } catch {}
    return { name: fromElucidFunctionName(item.name), args, callId: item.call_id };
  });
}

function responseText(payload) {
  if (text(payload?.output_text)) return text(payload.output_text);
  return (payload?.output || []).flatMap((item) => item?.content || [])
    .filter((part) => part?.type === 'output_text').map((part) => text(part.text)).join('').trim();
}

export function mergeInstruction(instruction, budgetNote) {
  return budgetNote ? `${instruction}\n\n${budgetNote}` : instruction;
}

export function elucidToolChoice(toolChoice) {
  const names = Array.isArray(toolChoice?.names) ? toolChoice.names.filter(Boolean) : [];
  if (toolChoice?.mode !== 'required') return undefined;
  if (names.length === 1) return { type: 'function', name: toElucidFunctionName(names[0]) };
  return 'required';
}

function continuationInput(contents) {
  return contents.flatMap((item) => {
    if (item?.provider === 'elucid-responses' && Array.isArray(item.output)) {
      return item.output.filter((output) => output && typeof output === 'object');
    }
    const role = item?.role === 'model' || item?.role === 'assistant' ? 'assistant'
      : item?.role === 'user' ? 'user' : '';
    if (!role) return [];
    const result = [];
    const message = (item.parts || []).map((part) => text(part?.text)).filter(Boolean).join('\n');
    if (message) result.push({ role, content: message });
    for (const part of item.parts || []) {
      if (!part?.functionResponse) continue;
      result.push({
        type: 'function_call_output',
        call_id: part.functionResponse.callId,
        output: JSON.stringify(part.functionResponse.response?.result ?? null),
      });
    }
    return result;
  });
}

const INSTRUCTIONS = `你是 AI Center 的个人研究与资产助手。
涉及本地知识库、信息流、行情、持仓或个人资产时，必须调用工具验证，不要根据工具名称猜测。
不要使用内置 web_search；公开网页只通过已注册的函数工具 public_web_search（即 web.search）检索。
分析公司、行业、估值或投资质量时，先 knowledge.search 再按需 knowledge.get。Knowledge 是 How to think；当前事实来自信息流、行情或 web 工具。不要读取本地路径，不要一次装入整个知识库。
问题明确时直接处理；用最少工具完成问题，不要为同一事实重复调用重叠工具。
Runtime 会告知 Tool budget（used / remaining / max）；单轮请求数不能超过 remaining。预算耗尽后必须基于已有证据作答，并标明不足处，不要再请求工具。
区分事实、推断和未知，不把相关性说成因果。只能依据工具结果声称读取过本地信息；没有证据就明确说明。
用户要求记录这次对话、总结进知识库、或把某段 hint 加入灵感时：先根据当前会话整理内容，需要分类时先 taxonomy.list，再调用 memory.save。bodyMarkdown 只写正文，禁止写入已落库、去向、分类路径或资源 ID。不要传入 sourceRefs。只有工具成功后才能声称已落库，并复述标题、类型和分类路径。`;

/** OpenAI Responses-compatible adapter for the Elucid Grok endpoint used by local Codex. */
export function createElucidGrokAgentClient(options = {}) {
  const fetchImpl = options.fetch || ((url, init) => elucidHttpRequest(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
    timeoutMs: init.timeoutMs,
    onTransport: init.onTransport,
  }));
  const env = options.env || process.env;
  const apiKey = options.apiKey !== undefined ? text(options.apiKey) : envText(env, 'ELUCID_GROK_API_KEY', 'AI_CENTER_GROK_API_KEY');
  const apiRoot = (text(options.apiRoot) || envText(env, 'AI_CENTER_ELUCID_GROK_API_ROOT') || DEFAULT_ROOT).replace(/\/$/, '');
  const modelId = text(options.model) || envText(env, 'AI_CENTER_HARNESS_MODEL', 'AI_CENTER_ELUCID_GROK_MODEL') || DEFAULT_MODEL;
  const researchModelId = text(options.researchModel) || envText(env, 'AI_CENTER_HARNESS_RESEARCH_MODEL', 'AI_CENTER_ELUCID_GROK_RESEARCH_MODEL');
  const configuredTimeout = options.timeoutMs ?? envText(env, 'AI_CENTER_ELUCID_GROK_TIMEOUT_MS');
  const timeoutMs = clampElucidTimeoutMs(configuredTimeout);

  return Object.freeze({
    async respond({
      contents = [],
      tools = [],
      signal,
      budgetNote,
      systemInstruction,
      toolChoice,
      timeoutMs: respondTimeout,
      researchProfile,
      onTransport,
    } = {}) {
      if (!apiKey) throw new Error('未配置 ELUCID_GROK_API_KEY');
      const usedModel = modelIdForProfile(modelId, researchModelId, researchProfile);
      const instruction = mergeInstruction(systemInstruction || INSTRUCTIONS, budgetNote);
      const forcedTool = elucidToolChoice(toolChoice);
      const limit = clampElucidTimeoutMs(respondTimeout, timeoutMs);
      const body = {
        model: usedModel,
        instructions: instruction,
        tools: tools.map((tool) => ({
          type: 'function',
          name: toElucidFunctionName(tool.name),
          description: tool.description,
          parameters: tool.parameters,
        })),
        ...(forcedTool ? { tool_choice: forcedTool } : {}),
      };
      // This endpoint does not retain response IDs for every account. Send the
      // complete ordered conversation plus provider output/tool results.
      body.input = continuationInput(contents);
      const response = await fetchImpl(`${apiRoot}/responses`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        signal,
        timeoutMs: limit,
        onTransport,
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        let detail = '';
        try { detail = text((await response.json())?.error?.message); } catch {}
        throw new Error(`Elucid Grok 问答失败（${response.status}${detail ? `: ${detail}` : ''}）`);
      }
      const payload = await response.json();
      const calls = toolCalls(payload);
      const answer = responseText(payload);
      const nativeSearch = (payload?.output || []).some((item) => item?.type === 'web_search_call');
      if (!answer && !calls.length) {
        if (nativeSearch) {
          throw new Error('Elucid 返回了内置 web_search_call，而不是函数 public_web_search');
        }
        throw new Error('Elucid Grok 没有返回回答或工具请求');
      }
      return {
        text: answer,
        toolCalls: calls,
        modelContent: { role: 'model', provider: 'elucid-responses', output: payload.output || [] },
        providerId: 'elucid-grok', modelId: usedModel, warnings: [],
      };
    },
  });
}
