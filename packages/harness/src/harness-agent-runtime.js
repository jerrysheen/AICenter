import { mkdir, mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { formatPriorHint, projectToolAudit, settlePriorAdvice } from '../../runtime/src/agent-quality.js';
import {
  toolsVisibleForAllowlist,
  toolsVisibleForResearchProfile,
} from '../../runtime/src/tool-policy.js';
import {
  buildRuntimeContext,
  DEFAULT_USER_TIME_ZONE,
} from '../../runtime/src/runtime-context.js';
import { explicitSearchIntent, resolveFinalAnswer, webSearchEvidence } from '../../runtime/src/web-evidence.js';
import { resolveResearchProfile } from '../../domain/src/research-profile.js';
import { aggregateEvidenceGate, applyHarnessEvidenceGate } from './evidence.js';
import {
  harnessPatchPath,
  harnessPluginPath,
  materializeHarnessPatch,
  resolveHarnessLaunch,
} from './launch.js';
import { buildHarnessPrompt } from './prompt.js';
import {
  harnessLlmCredentialError,
  materializeHarnessSettings,
  missingHarnessLlmCredential,
  resolveHarnessLlm,
} from './llm-route.js';
import { parseHarnessToolIds } from './runtime-mode.js';
import {
  collectToolCallsFromGateway,
  createHarnessTraceProjector,
  notificationToTraceEvents,
  projectHarnessTraceEvents,
} from './session-events.js';
import { projectToolCatalog } from './tool-catalog.js';
import { createToolGateway } from './tool-gateway.js';
import {
  excludeDomainWebTools,
  isHarnessWebToolId,
  withHarnessWebTools,
} from './web-infra.js';

async function loadDefaultClient(launch) {
  let DeepSeekHarness;
  try {
    ({ DeepSeekHarness } = await import('@deepseek-ai/dsh-sdk-client'));
  } catch (error) {
    throw new Error(`未安装 DeepSeek Harness SDK：${error?.message || error}`);
  }
  if (typeof DeepSeekHarness !== 'function') {
    throw new Error('DeepSeek Harness SDK 没有导出 DeepSeekHarness');
  }
  const harness = new DeepSeekHarness(launch);
  return {
    async run(prompt, options) {
      return harness.run(prompt, options);
    },
    async close() {
      if (typeof harness.close === 'function') await harness.close();
    },
  };
}

function visibleDomainToolIds(tools, { researchProfile, configuredIds }) {
  const explicit = parseHarnessToolIds(configuredIds, []);
  return excludeDomainWebTools(toolsVisibleForAllowlist(
    toolsVisibleForResearchProfile(tools.list(), researchProfile),
    explicit.length ? explicit : undefined,
  ).map((tool) => tool.id));
}

function engineKey({ workspaceId, allow, provider, model }) {
  return `${workspaceId || ''}::${provider || ''}::${model || ''}::${allow.join(',')}`;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function sameInput(left, right) {
  return JSON.stringify(stableValue(left || {})) === JSON.stringify(stableValue(right || {}));
}

function followUpPrompt({ message, selectedContext, priorHint }) {
  return [selectedContext && String(selectedContext).trim(), String(message || '').trim(), priorHint]
    .filter(Boolean)
    .join('\n\n');
}

function recordNativeWebExecution(run, item) {
  const detail = item.detail || {};
  let pendingIndex = run.pendingCalls.findIndex((call) => call.callId && call.callId === detail.callId);
  if (pendingIndex < 0) pendingIndex = run.pendingCalls.findIndex((call) => call.id === detail.id);
  if (pendingIndex >= 0) run.pendingCalls.splice(pendingIndex, 1);
  const failed = item.event === 'tool.failed';
  run.nativeExecutions.push({
    id: detail.id,
    input: detail.input || {},
    durationMs: null,
    result: failed
      ? { error: detail.error || { message: 'web tool failed' }, data: null, refs: [], warnings: [] }
      : { data: detail.data || {}, refs: detail.refs || [], warnings: [] },
  });
}

function recordFailedGatewayExecution(run, item) {
  const detail = item.detail || {};
  let pendingIndex = run.pendingCalls.findIndex((call) => call.callId && call.callId === detail.callId);
  if (pendingIndex < 0) pendingIndex = run.pendingCalls.findIndex((call) => call.id === detail.id);
  if (pendingIndex < 0) return;
  const pending = run.pendingCalls.splice(pendingIndex, 1)[0];
  run.executions.push({
    id: detail.id || pending.id,
    input: detail.input || pending.input || {},
    durationMs: null,
    result: {
      error: detail.error || { message: '工具失败' },
      data: null,
      refs: [],
      warnings: [],
    },
  });
}

function noteHarnessTrace(run, item) {
  if (item.event === 'tool.started') {
    run.pendingCalls.push({
      callId: item.detail?.callId || null,
      id: item.detail?.id || '',
      input: item.detail?.input || {},
      round: item.detail?.round ?? null,
    });
  }
  if (
    (item.event === 'tool.completed' || item.event === 'tool.failed')
    && isHarnessWebToolId(item.detail?.id)
  ) {
    recordNativeWebExecution(run, item);
  } else if (item.event === 'tool.failed') {
    recordFailedGatewayExecution(run, item);
  }
}

function collectHarnessToolCalls(run) {
  const executions = run.executions || [];
  const nativeExecutions = run.nativeExecutions || [];
  const recordedById = new Map();
  for (const item of [...executions, ...nativeExecutions]) {
    const id = String(item.id || '');
    recordedById.set(id, (recordedById.get(id) || 0) + 1);
  }
  const leftoverConsumed = new Map();
  const leftover = [];
  for (const [index, call] of (run.pendingCalls || []).entries()) {
    const id = String(call.id || '');
    const consumed = leftoverConsumed.get(id) || 0;
    if (consumed < (recordedById.get(id) || 0)) {
      leftoverConsumed.set(id, consumed + 1);
      continue;
    }
    leftover.push({
      callId: call.callId || `pending-${index + 1}`,
      id: call.id,
      name: call.id,
      args: call.input || {},
      result: { error: { message: '工具未返回 Gateway 结果' }, data: null, refs: [], warnings: [] },
    });
  }
  return {
    toolCalls: [
      ...collectToolCallsFromGateway(executions),
      ...collectToolCallsFromGateway(nativeExecutions),
      ...leftover,
    ],
    leftover,
  };
}

/**
 * AgentRuntime-compatible executor backed by dsh --profile sdk.
 * Domain tools still run in-process through Tool Gateway.
 * One Worker keeps one dsh child while the visible Tool set stays the same.
 */
export function createHarnessAgentRuntime({
  tools,
  quality = null,
  clock = () => new Date(),
  timeZone = DEFAULT_USER_TIME_ZONE,
  env = process.env,
  runtimeDirectory,
  createClient = loadDefaultClient,
  allowedToolIds,
} = {}) {
  if (!tools || typeof tools.list !== 'function' || typeof tools.execute !== 'function') {
    throw new Error('Harness runtime 需要现有 ToolRegistry');
  }
  if (!runtimeDirectory) throw new Error('Harness runtime 需要 Instance runtimeDirectory');
  const configuredIds = allowedToolIds ?? env.AI_CENTER_HARNESS_TOOL_IDS;
  const runRef = {
    current: {
      executions: [],
      nativeExecutions: [],
      evidenceGates: [],
      pendingCalls: [],
      record: async () => {},
      message: '',
      signal: undefined,
    },
  };
  let engine = null;
  let queue = Promise.resolve();

  async function disposeEngine() {
    const current = engine;
    engine = null;
    if (!current) return;
    try { await current.client.close(); } catch {}
    try { await current.gateway.close(); } catch {}
    try { await rm(current.tempRoot, { recursive: true, force: true }); } catch {}
  }

  async function ensureEngine({ allow, catalog, workspaceId, timeoutMs, researchProfile }) {
    const llm = resolveHarnessLlm(env, { researchProfile });
    const key = engineKey({
      workspaceId,
      allow,
      provider: llm.provider,
      model: llm.model,
    });
    if (engine?.key === key) return engine;
    await disposeEngine();
    const gateway = await createToolGateway({
      tools,
      allowedToolIds: allow,
      context: {},
      async onExecuted(item) {
        const run = runRef.current;
        let pendingIndex = run.pendingCalls.findIndex((call) => (
          call.id === item.id && sameInput(call.input, item.input)
        ));
        if (pendingIndex < 0) pendingIndex = run.pendingCalls.findIndex((call) => call.id === item.id);
        const pending = pendingIndex >= 0 ? run.pendingCalls.splice(pendingIndex, 1)[0] : null;
        const { observed, gated } = await applyHarnessEvidenceGate({
          quality,
          toolId: item.id,
          toolResult: item.result,
          input: item.input,
          message: run.message,
          signal: run.signal,
          record: run.record,
          callId: item.id,
        });
        if (gated) run.evidenceGates.push(gated);
        run.executions.push({ ...item, result: observed });
        await run.record(observed?.error ? 'tool.failed' : 'tool.completed', {
          round: pending?.round ?? null,
          callId: pending?.callId || `gateway-${run.executions.length}`,
          id: item.id,
          input: item.input,
          data: observed?.data,
          refs: observed?.refs || [],
          warnings: observed?.warnings || [],
          durationMs: item.durationMs,
          ...(observed?.error ? { error: observed.error } : {}),
        });
        return { result: observed };
      },
    });
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'aicenter-harness-'));
    const catalogPath = path.join(tempRoot, 'tool-catalog.json');
    const overlayPath = path.join(tempRoot, 'aicenter.cordis.yml');
    await writeFile(catalogPath, JSON.stringify({ tools: catalog }, null, 2), 'utf8');
    await writeFile(
      overlayPath,
      materializeHarnessPatch(await readFile(harnessPatchPath(), 'utf8'), harnessPluginPath()),
      'utf8',
    );
    const launch = resolveHarnessLaunch({
      env,
      runtimeDirectory,
      gateway,
      catalogPath,
      overlayPath,
      workspaceId,
      researchProfile,
    });
    await mkdir(launch.dshHome, { recursive: true });
    await mkdir(launch.cwd, { recursive: true });
    await writeFile(
      path.join(launch.dshHome, 'settings.yaml'),
      launch.llm?.settingsYaml || materializeHarnessSettings(),
      'utf8',
    );
    const client = await createClient({
      ...launch,
      ...(Number(timeoutMs) > 0 ? { requestTimeoutMs: Number(timeoutMs) } : {}),
    });
    engine = {
      key,
      launch,
      client,
      gateway,
      tempRoot,
      sessionIds: new Map(),
    };
    return engine;
  }

  function withLock(work) {
    const run = queue.then(work, work);
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  return Object.freeze({
    kind: 'harness',
    availableTools({ researchProfile } = {}) {
      const profile = researchProfile?.mode ? researchProfile : resolveResearchProfile('standard');
      const domain = projectToolCatalog(tools, visibleDomainToolIds(tools, {
        researchProfile: profile, configuredIds,
      }));
      return withHarnessWebTools(domain);
    },
    async close() {
      await disposeEngine();
    },
    async run(input = {}) {
      return withLock(() => runOnce(input));
    },
  });

  async function runOnce({
    message, workspaceId, sessionId = '', jobId = '', selectedRefs = [], signal,
    priorTurns = [], selectedContext = '', webMode = 'off',
    researchMode = 'standard', researchProfile, taskInstruction = '',
    allowedToolIds: runAllow, timeoutMs, trace, now,
  } = {}) {
    const runStartedAt = Date.now();
    const runtimeContext = buildRuntimeContext(now ?? clock(), timeZone);
    const record = async (event, detail) => {
      try { await trace?.({ event, detail }); } catch {}
    };
    const profile = researchProfile?.mode
      ? researchProfile
      : resolveResearchProfile(researchMode);
    const llm = resolveHarnessLlm(env, { researchProfile: profile });
    if (missingHarnessLlmCredential(env, llm)) {
      throw new Error(harnessLlmCredentialError(llm));
    }
    const allow = visibleDomainToolIds(tools, {
      researchProfile: profile,
      configuredIds: runAllow ?? configuredIds,
    });
    const catalog = projectToolCatalog(tools, allow);
    const visibleTools = withHarnessWebTools(catalog);
    const warnings = [];
    const toolDefinitions = visibleTools.map((tool) => ({ id: tool.id, description: tool.description, effect: tool.effect }));
    runRef.current = {
      executions: [],
      nativeExecutions: [],
      evidenceGates: [],
      pendingCalls: [],
      record,
      message,
      signal,
    };

    const priorInput = {
      message, webMode, researchMode: profile.mode, tools: toolDefinitions, signal,
    };
    const priorTask = quality?.advisePrior && quality.config?.priorMode !== 'off'
      ? quality.advisePrior(priorInput)
      : null;
    if (priorTask) await record('advisor.prior.started', {
      mode: quality.config?.priorMode || 'shadow',
      toolIds: visibleTools.map((tool) => tool.id),
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

    let slot;
    try {
      slot = await ensureEngine({ allow, catalog, workspaceId, timeoutMs, researchProfile: profile });
    } catch (error) {
      await record('run.failed', {
        runtime: 'harness',
        name: error?.name || 'Error',
        message: error?.message || String(error),
      });
      throw error;
    }
    slot.gateway.setContext({
      workspaceId, message, signal, sessionId, jobId, selectedRefs, runtimeContext,
    });

    const applicationSessionId = String(sessionId || '').trim();
    let harnessSessionId = applicationSessionId ? slot.sessionIds.get(applicationSessionId) : '';
    const warm = Boolean(harnessSessionId);
    if (applicationSessionId && !harnessSessionId) {
      harnessSessionId = `aicenter-${randomUUID().replaceAll('-', '')}`;
      slot.sessionIds.set(applicationSessionId, harnessSessionId);
    }
    const prompt = warm
      ? followUpPrompt({ message, selectedContext, priorHint })
      : [
        buildHarnessPrompt({
          message,
          selectedContext,
          priorTurns,
          webMode,
          researchProfile: profile,
          taskInstruction,
          runtimeContext,
          catalog: visibleTools,
        }),
        priorHint,
      ].filter(Boolean).join('\n\n');

    const onAbort = () => { disposeEngine(); };
    if (signal?.aborted) {
      await disposeEngine();
      throw new DOMException('The operation was aborted', 'AbortError');
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    const liveTrace = new Set();
    const liveProjector = createHarnessTraceProjector();
    const onNotification = async (notification) => {
      for (const item of notificationToTraceEvents(notification, liveProjector)) {
        noteHarnessTrace(runRef.current, item);
        const stamp = `${item.event}:${JSON.stringify(item.detail || {})}`;
        if (liveTrace.has(stamp)) continue;
        liveTrace.add(stamp);
        await record(item.event, item.detail);
      }
    };

    try {
      const result = await slot.client.run(prompt, {
        ...(harnessSessionId ? { sessionId: harnessSessionId } : {}),
        onNotification,
      });
      for (const item of projectHarnessTraceEvents(result?.events || [])) {
        const stamp = `${item.event}:${JSON.stringify(item.detail || {})}`;
        if (liveTrace.has(stamp)) continue;
        noteHarnessTrace(runRef.current, item);
        liveTrace.add(stamp);
        await record(item.event, item.detail);
      }
      const { toolCalls, leftover } = collectHarnessToolCalls(runRef.current);
      const refs = [
        ...runRef.current.executions.flatMap((item) => item.result?.refs || []),
        ...runRef.current.nativeExecutions.flatMap((item) => item.result?.refs || []),
      ];
      const leftoverAudits = leftover.map((call) => projectToolAudit(call.id, {
        error: { message: '工具未返回 Gateway 结果' },
      }, { error: { message: '工具未返回 Gateway 结果' } }));
      const toolAudits = [
        ...runRef.current.executions.map((item) => projectToolAudit(item.id, item.result, {
          durationMs: item.durationMs,
        })),
        ...runRef.current.nativeExecutions.map((item) => projectToolAudit(item.id, item.result, {
          durationMs: item.durationMs,
          error: item.result?.error || null,
        })),
        ...leftoverAudits,
      ];
      const evidenceGate = aggregateEvidenceGate(runRef.current.evidenceGates);
      let answer = String(result?.finalResponse || '').trim();
      if (!answer) throw new Error('Harness 没有返回回答');
      let rejectedAnswers = 0;
      const webSearchAvailable = true;
      const evidence = webSearchEvidence(toolCalls);
      let decision = resolveFinalAnswer({
        answer,
        evidence,
        remainingModelCalls: 1,
        explicitWebSearchRequested: explicitSearchIntent(message),
        webSearchAvailable,
      });
      if (decision.action === 'correct') {
        rejectedAnswers += 1;
        warnings.push('Runtime 拒绝了缺少 Web 证据或虚构 Tool 使用的最终回答');
        await record('answer.rejected', { reason: decision.reason, answerPreview: answer.slice(0, 100) });
        const retry = await slot.client.run(decision.correction, {
          sessionId: harnessSessionId || result.sessionId,
          onNotification,
        });
        answer = String(retry?.finalResponse || '').trim();
        if (!answer) throw new Error('Harness 没有返回回答');
        decision = resolveFinalAnswer({
          answer,
          evidence,
          remainingModelCalls: 0,
          explicitWebSearchRequested: explicitSearchIntent(message),
          webSearchAvailable,
        });
      }
      if (decision.action === 'fail') throw new Error('Agent Runtime 未能完成回答');
      if (decision.action === 'accept') answer = decision.answer;
      await finishPrior();
      await record('run.completed', {
        providerId: slot.launch.provider,
        modelId: slot.launch.model,
        answer,
        toolCallCount: toolCalls.length,
        runtime: 'harness',
        durationMs: Date.now() - runStartedAt,
        evidenceGate,
        reusedProcess: warm,
      });
      return {
        answer,
        providerId: slot.launch.provider,
        modelId: slot.launch.model,
        toolCalls,
        toolAudits,
        refs,
        warnings: [...warnings, ...(result?.warnings || [])],
        runtimeContext,
        qualityPrior,
        evidenceGate,
        rejectedAnswers,
        visibleTools,
      };
    } catch (error) {
      await record('run.failed', {
        runtime: 'harness',
        name: error?.name || 'Error',
        message: error?.message || String(error),
      });
      if (error?.name === 'AbortError' || error?.name === 'TransportClosedError') {
        await disposeEngine();
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
