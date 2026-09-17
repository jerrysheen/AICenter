import { createToolRegistry } from './tool-registry.js';
import { buildRuntimeContext, DEFAULT_USER_TIME_ZONE, formatRuntimeContextNote } from './runtime-context.js';
import { buildAgentSystemInstruction } from './agent-prompt.js';
import { explicitSearchIntent, resolveFinalAnswer, webSearchEvidence } from './web-evidence.js';

const DEFAULT_LIMITS = Object.freeze({
  maxModelCalls: 7,
  maxToolCalls: 12,
  maxParallelTools: 3,
});

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function safeErrorMessage(error) {
  const message = String(error?.message || '工具执行失败').replace(/[\r\n]+/g, ' ').trim();
  return message.slice(0, 500) || '工具执行失败';
}

function toolBudget(usedToolCalls, maxToolCalls, maxModelCalls, modelCallCount) {
  const remainingToolCalls = Math.max(0, maxToolCalls - usedToolCalls);
  return { usedToolCalls, remainingToolCalls, maxToolCalls, maxModelCalls, modelCallCount };
}

export function toolsVisibleForWebMode(tools, webMode = 'off') {
  const mode = webMode === 'always' || webMode === 'fallback' ? webMode : 'off';
  return tools.flatMap((tool) => {
    if (tool.id !== 'web.search') return [tool];
    if (mode === 'off') return [];
    const description = mode === 'always'
      ? '搜索公开互联网网页。不要用它代替本地 Feed、Tag、Knowledge、持仓等已经存在的本地数据源。用户允许并倾向在有帮助时使用，但不是必须调用。'
      : '搜索公开互联网网页。优先用户指定的本地来源；本地数据不足或确实需要公开互联网事实时再使用。不要用它代替本地 Feed、Tag、Knowledge、持仓。';
    return [{ ...tool, description }];
  });
}

export function formatToolBudgetNote(budget, extra = '', { runtimeContext } = {}) {
  const lines = [];
  if (runtimeContext) lines.push(formatRuntimeContextNote(runtimeContext));
  lines.push(
    `Tool budget: used ${budget.usedToolCalls}, remaining ${budget.remainingToolCalls}, max ${budget.maxToolCalls}.`,
    'Do not request more tools than remaining in this turn.',
    'If remaining is 0, do not call tools. Answer from existing evidence and say what is insufficient.',
  );
  if (extra) lines.push(extra);
  return lines.join('\n');
}

function clipPreview(text, max = 100) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function summarizeWebSearch(toolResult) {
  const rows = Array.isArray(toolResult?.data?.results) ? toolResult.data.results : [];
  return {
    available: toolResult?.data?.available !== false && !toolResult?.error,
    resultCount: rows.length,
  };
}

async function mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * A deliberately thin, bounded single-agent loop. Model requests, total tool
 * calls, and parallel tool executions have independent limits. Exhausting the
 * tool budget skips the oversized batch and forces an answer from existing
 * evidence; it does not fail the run.
 */
export function createAgentRuntime({
  llm, tools = createToolRegistry(), limits = {},
  clock = () => new Date(), timeZone = DEFAULT_USER_TIME_ZONE,
} = {}) {
  if (!llm || (typeof llm.respond !== 'function' && typeof llm.ask !== 'function')) {
    throw new Error('agent llm.respond or llm.ask is required');
  }
  const maxModelCalls = positiveInteger(limits.maxModelCalls, DEFAULT_LIMITS.maxModelCalls);
  const maxToolCalls = positiveInteger(limits.maxToolCalls, DEFAULT_LIMITS.maxToolCalls);
  const maxParallelTools = positiveInteger(limits.maxParallelTools, DEFAULT_LIMITS.maxParallelTools);

  return Object.freeze({
    availableTools() {
      return tools.list();
    },
    async run({
      message, workspaceId, sessionId = '', jobId = '', selectedRefs = [], signal,
      priorTurns = [], selectedContext = '', webMode = 'off', trace, now,
    }) {
      const runStartedAt = Date.now();
      const runtimeContext = buildRuntimeContext(now ?? clock(), timeZone);
      const record = async (event, detail) => {
        try { await trace?.({ event, detail }); } catch {}
      };
      const toolDefinitions = toolsVisibleForWebMode(tools.list(), webMode);
      const webSearchAvailable = toolDefinitions.some((tool) => tool.id === 'web.search');
      const explicitWebSearchRequested = explicitSearchIntent(message);
      const history = [];
      for (const turn of priorTurns) {
        if (turn.inputText) history.push({ role: 'user', parts: [{ text: String(turn.inputText) }] });
        if (turn.outputText) history.push({ role: 'model', parts: [{ text: String(turn.outputText) }] });
      }
      history.push({
        role: 'user',
        parts: [{ text: selectedContext
          ? `${selectedContext}\n\n用户问题：\n${String(message || '')}`
          : String(message || '') }],
      });
      const toolCalls = [];
      const refs = [];
      const warnings = [];
      const seenCallIds = new Set();
      let providerId = '';
      let modelId = '';
      let modelCallCount = 0;
      let toolCallCount = 0;
      const systemInstruction = buildAgentSystemInstruction(webMode);

      while (modelCallCount < maxModelCalls) {
        const round = modelCallCount;
        modelCallCount += 1;
        const budget = toolBudget(toolCallCount, maxToolCalls, maxModelCalls, modelCallCount);
        const remainingModelCalls = maxModelCalls - modelCallCount;
        const requestTools = toolDefinitions;
        const budgetNote = formatToolBudgetNote(budget, '', { runtimeContext });
        const visibleToolIds = requestTools.map((tool) => tool.id);
        const modelStartedAt = Date.now();
        await record('model.requested', {
          round, modelCallCount, toolCount: requestTools.length, visibleToolIds, ...budget,
          currentLocalTime: runtimeContext.currentLocalTime,
          webSearchAvailable,
        });
        const request = {
          contents: history, tools: requestTools, signal, budget, budgetNote, runtimeContext,
          systemInstruction,
        };
        const response = typeof llm.respond === 'function'
          ? await llm.respond(request)
          : await llm.ask({ message, workspaceId, tools: requestTools, signal, budget, budgetNote });
        providerId = response.providerId || providerId;
        modelId = response.modelId || modelId;
        warnings.push(...(response.warnings || []));
        const calls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
        await record('model.responded', {
          round, providerId, modelId,
          toolCalls: calls.map((call) => ({ callId: call.callId || null, name: call.name, args: call.args || {} })),
          answerPreview: clipPreview(response.text),
          answerChars: String(response.text || '').length, durationMs: Date.now() - modelStartedAt,
          webSearchAvailable,
        });
        if (!calls.length) {
          const answer = String(response.text || '').trim();
          if (!answer) throw new Error('模型没有返回回答');
          const decision = resolveFinalAnswer({
            answer,
            evidence: webSearchEvidence(toolCalls),
            remainingModelCalls,
            explicitWebSearchRequested,
            webSearchAvailable,
          });
          if (decision.action === 'correct') {
            warnings.push('Runtime 拒绝了缺少 Web 证据或虚构 Tool 使用的最终回答');
            await record('answer.rejected', {
              round, reason: decision.reason, modelCallCount,
              answerPreview: clipPreview(answer),
            });
            history.push(response.modelContent || { role: 'model', parts: [{ text: answer }] });
            history.push({ role: 'user', parts: [{ text: decision.correction }] });
            continue;
          }
          if (decision.action === 'fail') throw new Error('Agent Runtime 未能完成回答');
          await record('run.completed', {
            providerId, modelId, answer: decision.answer, modelCallCount, toolCallCount,
            toolCalls, refs, warnings, durationMs: Date.now() - runStartedAt,
            currentLocalTime: runtimeContext.currentLocalTime,
          });
          return { answer: decision.answer, providerId, modelId, toolCalls, refs, warnings, runtimeContext };
        }
        if (modelCallCount >= maxModelCalls) throw new Error('模型调用次数超过上限，无法为工具结果生成最终回答');
        if (calls.length > budget.remainingToolCalls) {
          const requested = calls.map((call) => call.name || call.id || 'unknown');
          const exhausted = budget.remainingToolCalls === 0;
          const extra = exhausted
            ? `Tool budget exhausted. Skipped this batch of ${calls.length} (${requested.join(', ')}). Do not call tools. Answer from existing evidence and say what is insufficient.`
            : `This batch of ${calls.length} exceeds remaining ${budget.remainingToolCalls}. None executed (${requested.join(', ')}). Request at most ${budget.remainingToolCalls} tools, or answer now.`;
          const warning = exhausted
            ? `工具预算已用尽（${toolCallCount}/${maxToolCalls}），本批 ${calls.length} 个请求未执行`
            : `本批 ${calls.length} 个工具超过剩余 ${budget.remainingToolCalls} 次，整批未执行`;
          warnings.push(warning);
          await record('tool.batch.skipped', {
            round, reason: exhausted ? 'budget-exhausted' : 'batch-exceeds-remaining',
            requested, remainingToolCalls: budget.remainingToolCalls, maxToolCalls, usedToolCalls: toolCallCount,
          });
          history.push({ role: 'user', parts: [{ text: formatToolBudgetNote(budget, extra, { runtimeContext }) }] });
          continue;
        }

        const planned = calls.map((call, index) => {
          const definition = requestTools.find((tool) => tool.id === call.id || tool.name === call.name);
          if (!definition) throw new Error(`模型请求了未注册工具 ${call.name || call.id}`);
          if (definition.effect === 'destructive') throw new Error(`不允许执行 ${definition.effect} 工具`);
          const callId = String(call.callId || `runtime-${round}-${index + 1}`);
          if (seenCallIds.has(callId)) throw new Error(`工具 callId 重复：${callId}`);
          seenCallIds.add(callId);
          return { call, callId, definition };
        });
        toolCallCount += planned.length;
        if (response.modelContent) history.push(response.modelContent);

        const concurrency = planned.some((item) => item.definition.effect !== 'read') ? 1 : maxParallelTools;
        const functionResponses = await mapConcurrent(planned, concurrency, async ({ call, callId, definition }) => {
          const toolStartedAt = Date.now();
          const input = call.args ?? {};
          await record('tool.started', { round, callId, id: definition.id, input });
          try {
            const toolResult = await tools.execute(definition.id, input, {
              workspaceId, message, signal, sessionId, jobId, selectedRefs, runtimeContext,
            });
            toolCalls.push({
              callId, id: definition.id, input, observedAt: toolResult.observedAt, warnings: toolResult.warnings,
              ...(definition.id === 'web.search' ? { webSearch: summarizeWebSearch(toolResult) } : {}),
            });
            refs.push(...toolResult.refs);
            warnings.push(...toolResult.warnings);
            await record('tool.completed', {
              round, callId, id: definition.id, input, data: toolResult.data,
              refs: toolResult.refs, observedAt: toolResult.observedAt, warnings: toolResult.warnings,
              durationMs: Date.now() - toolStartedAt,
            });
            return { functionResponse: { name: definition.name, callId, response: { result: toolResult } } };
          } catch (error) {
            if (signal?.aborted || error?.name === 'AbortError') throw error;
            const messageText = safeErrorMessage(error);
            const warning = `工具 ${definition.id} 调用失败：${messageText}`;
            const failure = {
              data: null,
              refs: [],
              observedAt: Date.now(),
              warnings: [warning],
              error: { code: error?.name === 'ValidationError' ? 'TOOL_VALIDATION_FAILED' : 'TOOL_EXECUTION_FAILED', message: messageText },
            };
            toolCalls.push({
              callId, id: definition.id, input, observedAt: failure.observedAt, warnings: failure.warnings, error: failure.error,
              ...(definition.id === 'web.search' ? { webSearch: { available: false, resultCount: 0 } } : {}),
            });
            warnings.push(warning);
            await record('tool.failed', {
              round, callId, id: definition.id, input, error: failure.error,
              durationMs: Date.now() - toolStartedAt,
            });
            return { functionResponse: { name: definition.name, callId, response: { result: failure } } };
          }
        });
        history.push({ role: 'user', parts: functionResponses });
      }
      throw new Error('Agent Runtime 未能完成回答');
    },
  });
}
