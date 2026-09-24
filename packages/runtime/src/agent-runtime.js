/**
 * LEGACY / LOCAL-RUNTIME ONLY
 *
 * In-process Agent loop for fake-LLM tests and explicit
 * `AI_CENTER_AGENT_RUNTIME=local`. Production Ask / article reading uses
 * `packages/harness`. Harness must not import this file.
 */
import { createToolRegistry } from './tool-registry.js';
import { buildRuntimeContext, DEFAULT_USER_TIME_ZONE, formatRuntimeContextNote } from './runtime-context.js';
import { buildAgentSystemInstruction } from './agent-prompt.js';
import { resolveResearchProfile } from '../../domain/src/research-profile.js';
import { explicitSearchIntent, resolveFinalAnswer, webSearchEvidence } from './web-evidence.js';
import {
  appendAuxiliarySearchNote,
  auxiliarySearchWarning,
  takeAuxiliarySearch,
} from './auxiliary-web-search.js';
import { formatPriorHint, projectToolAudit, settlePriorAdvice } from './agent-quality.js';
import {
  toolsVisibleForAllowlist,
  toolsVisibleForResearchProfile,
  toolsVisibleForWebMode,
} from './tool-policy.js';
import {
  aggregateEvidenceGate,
  applyEvidenceGateToToolResult,
  extractRetrievalHits,
  isEvidenceGateTool,
} from './evidence-gate.js';

export {
  toolsVisibleForAllowlist,
  toolsVisibleForResearchProfile,
  toolsVisibleForWebMode,
};
export { settlePriorAdvice };

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
  const gate = toolResult?.data?.evidenceGate || toolResult?.evidenceGate;
  return {
    available: toolResult?.data?.available !== false && !toolResult?.error,
    resultCount: rows.length,
    acceptedCount: Number.isFinite(Number(gate?.acceptedCount)) ? Number(gate.acceptedCount) : rows.length,
    rejectedCount: Number.isFinite(Number(gate?.rejectedCount)) ? Number(gate.rejectedCount) : 0,
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
  auxiliarySearch = null,
  quality = null,
} = {}) {
  if (!llm || (typeof llm.respond !== 'function' && typeof llm.ask !== 'function')) {
    throw new Error('agent llm.respond or llm.ask is required');
  }
  const maxModelCalls = positiveInteger(limits.maxModelCalls, DEFAULT_LIMITS.maxModelCalls);
  const maxToolCalls = positiveInteger(limits.maxToolCalls, DEFAULT_LIMITS.maxToolCalls);
  const maxParallelTools = positiveInteger(limits.maxParallelTools, DEFAULT_LIMITS.maxParallelTools);

  return Object.freeze({
    kind: 'local',
    availableTools() {
      return tools.list();
    },
    async run({
      message, workspaceId, sessionId = '', jobId = '', selectedRefs = [], signal,
      priorTurns = [], selectedContext = '', webMode = 'off',
      researchMode = 'standard', researchProfile, taskInstruction = '',
      allowedToolIds, timeoutMs, enableAuxiliarySearch = true, trace, now,
      closedContext = false,
    }) {
      const runStartedAt = Date.now();
      const runtimeContext = buildRuntimeContext(now ?? clock(), timeZone);
      const record = async (event, detail) => {
        try { await trace?.({ event, detail }); } catch {}
      };
      const profile = researchProfile?.mode
        ? researchProfile
        : resolveResearchProfile(researchMode);
      const closed = closedContext === true;
      const effectiveWebMode = closed ? 'off' : webMode;
      const toolDefinitions = closed ? [] : toolsVisibleForAllowlist(
        toolsVisibleForResearchProfile(
          toolsVisibleForWebMode(tools.list(), effectiveWebMode),
          profile,
        ),
        allowedToolIds,
      );
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
      const toolAudits = [];
      const evidenceGates = [];
      const refs = [];
      const warnings = [];
      const seenCallIds = new Set();
      let auxiliaryHandle = null;
      let providerId = '';
      let modelId = '';
      let modelCallCount = 0;
      let toolCallCount = 0;
      let rejectedAnswers = 0;
      const priorInput = {
        message, webMode: effectiveWebMode, researchMode: profile.mode, tools: toolDefinitions, signal,
      };
      const priorTask = quality?.advisePrior && quality.config?.priorMode !== 'off'
        ? quality.advisePrior(priorInput)
        : null;
      if (priorTask) await record('advisor.prior.started', {
        mode: quality.config?.priorMode || 'shadow',
        toolIds: toolDefinitions.map((tool) => tool.id),
      });
      let qualityPrior = null;
      let priorRecorded = false;
      const finishPrior = async () => {
        if (priorRecorded || !priorTask) return qualityPrior;
        priorRecorded = true;
        qualityPrior = await settlePriorAdvice(priorTask, record);
        return qualityPrior;
      };
      if (quality?.config?.priorMode === 'advisory') await finishPrior();
      const priorHint = quality?.config?.priorMode === 'advisory' && qualityPrior?.status === 'ok'
        ? formatPriorHint(qualityPrior.scores)
        : '';
      const systemInstruction = [
        closed
          ? [
            '本任务是封闭材料任务。',
            '只能依据下方给定材料。',
            '本轮没有开放任何外部工具或互联网能力。',
            '材料没有的信息必须保持未知。',
          ].join('\n')
          : buildAgentSystemInstruction(effectiveWebMode, profile),
        String(taskInstruction || '').trim(),
        priorHint,
      ].filter(Boolean).join('\n\n');

      try {
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
          systemInstruction, researchProfile: profile, researchMode: profile.mode,
          ...(Number(timeoutMs) > 0 ? { timeoutMs: Number(timeoutMs) } : {}),
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
            rejectedAnswers += 1;
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
          let finalAnswer = decision.answer;
          if (auxiliaryHandle) {
            if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
            const settled = await takeAuxiliarySearch(auxiliaryHandle, { signal });
            if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
            if (settled?.text) {
              finalAnswer = appendAuxiliarySearchNote(finalAnswer, settled.text);
              await record('auxiliary.merged', { chars: settled.text.length });
            } else {
              warnings.push(auxiliarySearchWarning(settled));
              await record('auxiliary.skipped', { status: settled?.status || 'timeout' });
            }
          }
          const evidenceGate = aggregateEvidenceGate(evidenceGates);
          await finishPrior();
          await record('run.completed', {
            providerId, modelId, answer: finalAnswer, modelCallCount, toolCallCount,
            toolCalls, refs, warnings, durationMs: Date.now() - runStartedAt,
            currentLocalTime: runtimeContext.currentLocalTime,
            evidenceGate,
          });
          return {
            answer: finalAnswer, providerId, modelId, toolCalls, toolAudits, refs, warnings,
            runtimeContext, qualityPrior, evidenceGate, rejectedAnswers, visibleTools: toolDefinitions,
          };
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
          const startAuxiliary = !closed && enableAuxiliarySearch !== false
            && definition.id === 'web.search'
            && !auxiliaryHandle
            && auxiliarySearch?.begin;
          if (startAuxiliary) {
            try {
              auxiliaryHandle = auxiliarySearch.begin({
                question: String(message || ''),
                query: String(input?.query || ''),
                signal,
              });
            } catch {
              auxiliaryHandle = null;
            }
          }
          await record('tool.started', { round, callId, id: definition.id, input });
          if (startAuxiliary && auxiliaryHandle) await record('auxiliary.started', { query: clipPreview(input?.query) });
          try {
            const toolResult = await tools.execute(definition.id, input, {
              workspaceId, message, signal, sessionId, jobId, selectedRefs, runtimeContext,
            });
            const audit = projectToolAudit(definition.id, toolResult, {
              durationMs: Date.now() - toolStartedAt,
            });
            toolAudits.push(audit);
            let observed = toolResult;
            if (
              isEvidenceGateTool(definition.id)
              && quality?.gateEvidence
              && quality.config?.evidenceGateMode
              && quality.config.evidenceGateMode !== 'off'
            ) {
              const rawHits = extractRetrievalHits(definition.id, toolResult.data);
              await record('evidence.gate.started', {
                round, callId, id: definition.id, resultCount: rawHits.length, query: input?.query || '',
              });
              const gated = await quality.gateEvidence({
                message,
                query: input?.query || '',
                toolId: definition.id,
                toolResult,
                signal,
                mode: quality.config.evidenceGateMode,
              });
              evidenceGates.push(gated);
              if (gated?.status === 'ok') {
                observed = applyEvidenceGateToToolResult({
                  toolId: definition.id,
                  toolResult,
                  decision: gated,
                  mode: quality.config.evidenceGateMode,
                });
                await record('evidence.gate.completed', {
                  round, callId, id: definition.id,
                  mode: gated.mode,
                  acceptedCount: gated.accepted?.length || 0,
                  rejectedCount: gated.rejected?.length || 0,
                  rejectedHosts: (gated.rejected || []).map((hit) => hit.host).filter(Boolean).slice(0, 8),
                  confidence: gated.confidence ?? null,
                  sufficiency: gated.sufficiency ?? null,
                  hint: gated.hint || '',
                  durationMs: gated.durationMs ?? null,
                });
              } else if (gated?.status === 'skipped') {
                await record('evidence.gate.skipped', { round, callId, id: definition.id, reason: gated.reason || 'off' });
              } else {
                await record('evidence.gate.failed', {
                  round, callId, id: definition.id,
                  message: gated?.error || 'evidence gate failed',
                  code: gated?.code || '',
                  durationMs: gated?.durationMs ?? null,
                });
              }
            }
            toolCalls.push({
              callId, id: definition.id, input, observedAt: observed.observedAt, warnings: observed.warnings,
              audit,
              ...(definition.id === 'web.search' ? { webSearch: summarizeWebSearch(observed) } : {}),
              ...(observed.evidenceGate ? { evidenceGate: observed.evidenceGate } : {}),
            });
            refs.push(...(observed.refs || []));
            warnings.push(...(observed.warnings || []));
            await record('tool.completed', {
              round, callId, id: definition.id, input, data: observed.data,
              refs: observed.refs, observedAt: observed.observedAt, warnings: observed.warnings,
              durationMs: Date.now() - toolStartedAt,
              evidenceGate: observed.evidenceGate || null,
            });
            return { functionResponse: { name: definition.name, callId, response: { result: observed } } };
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
            const audit = projectToolAudit(definition.id, failure, {
              durationMs: Date.now() - toolStartedAt,
              error: failure.error,
            });
            toolAudits.push(audit);
            toolCalls.push({
              callId, id: definition.id, input, observedAt: failure.observedAt, warnings: failure.warnings, error: failure.error,
              audit,
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
      } finally {
        await finishPrior();
      }
    },
  });
}
