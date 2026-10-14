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
  materializeClosedContextPatch,
  materializeHarnessPatch,
  resolveHarnessLaunch,
} from './launch.js';
import { buildHarnessFollowUpPrompt, buildHarnessPrompt } from './prompt.js';
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
import { createHarnessUsageObserver } from './model-usage-observer.js';
import { supplementHarnessUsage } from './model-usage-history.js';
import { modelUsageContext, withModelUsageContext } from '../../runtime/src/model-usage-context.js';
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

function engineKey({ workspaceId, allow, provider, model, timeoutMs, closedContext = false, closedTask = '' }) {
  return `${workspaceId || ''}::${provider || ''}::${model || ''}::${closedContext ? 'closed' : 'open'}::${closedTask}::${Number(timeoutMs) > 0 ? Number(timeoutMs) : 'default'}::${allow.join(',')}`;
}

export function resolveHarnessRunTools(tools, {
  closedContext = false,
  researchProfile,
  configuredIds,
} = {}) {
  if (closedContext) return { allow: [], catalog: [], visibleTools: [] };
  const allow = visibleDomainToolIds(tools, { researchProfile, configuredIds });
  const catalog = projectToolCatalog(tools, allow);
  return { allow, catalog, visibleTools: withHarnessWebTools(catalog) };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function sameInput(left, right) {
  return JSON.stringify(stableValue(left || {})) === JSON.stringify(stableValue(right || {}));
}

function upstreamBodySnippet(error) {
  const source=error?.body ?? error?.responseBody ?? error?.response ?? error?.data ?? error?.details;
  if(source==null || source==='') return '';
  const text=typeof source==='string' ? source : JSON.stringify(source);
  return text.slice(0, 2000);
}

function turnFinishLabel(reason) {
  const provider=reason?.error?.finishReason ?? reason?.finishReason;
  if(typeof provider==='string' && provider.trim()) return provider.trim();
  if(provider && typeof provider==='object' && typeof provider.kind==='string' && provider.kind.trim()) return provider.kind.trim();
  return typeof reason?.kind==='string' ? reason.kind.trim() : '';
}

function assertSuccessfulTurn(result) {
  const end=(result?.events || []).findLast(event=>event.type==='turn/end');
  const reason=end?.data?.reason;
  if(reason?.kind==='error') {
    const raw=reason.error?.code;
    const code=raw ? `${String(raw)}: ` : '';
    const error=Object.assign(new Error(`模型调用失败：${code}${String(reason.error?.message || '模型执行未完成').slice(0,2000)}`),{name:'HarnessModelError'});
    if(raw!=null && String(raw).trim()) error.upstreamCode=String(raw).slice(0,80);
    const status=Number(reason.error?.status ?? reason.error?.statusCode ?? raw);
    if(Number.isInteger(status) && status>=400 && status<=599) error.upstreamStatus=status;
    const body=upstreamBodySnippet(reason.error);
    if(body) error.upstreamBody=body;
    const finish=turnFinishLabel(reason);
    if(finish) error.finishReason=finish;
    throw error;
  }
  if(reason?.kind==='aborted') throw Object.assign(new Error('模型调用已中止，未产生完成稿'),{name:'AbortError', finishReason:turnFinishLabel(reason) || 'aborted'});
}

function followUpPrompt({ message, selectedContext, priorHint, taskInstruction, priorTurns }) {
  return buildHarnessFollowUpPrompt({ message, selectedContext, priorHint, taskInstruction, priorTurns });
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
  usageLedger = null,
  articleAdmission = null,
  hourlyAdmission = null,
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
  const queue = [];
  let activeEntry = null, closing = false, sequence = 0;

  async function disposeEngine() {
    const current = engine;
    engine = null;
    if (!current) return;
    try { await current.client.close(); } catch {}
    try { await current.gateway.close(); } catch {}
    try { await rm(current.tempRoot, { recursive: true, force: true }); } catch {}
  }

  async function ensureEngine({ executionEnv=env, allow, catalog, workspaceId, timeoutMs, researchProfile, closedContext = false, closedTask = '' }) {
    const llm = resolveHarnessLlm(executionEnv, { researchProfile, closedTask });
    const key = engineKey({
      workspaceId,
      timeoutMs,
      allow,
      provider: llm.provider,
      model: llm.model+'::'+llm.apiKeyEnv+'::'+JSON.stringify(llm.execution || {}),
      closedContext,
      closedTask,
    });
    if (engine?.key === key) return engine;
    await disposeEngine();
    const gateway = await createToolGateway({
      tools,
      allowedToolIds: allow,
      context: {},
      onUsage(value, context) { usageLedger?.record({ ...value, ...context.usageAttribution }); },
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
    const patchSource = await readFile(harnessPatchPath(), 'utf8');
    await writeFile(
      overlayPath,
      closedContext
        ? materializeClosedContextPatch(patchSource, harnessPluginPath(), executionEnv)
        : materializeHarnessPatch(patchSource, harnessPluginPath(), executionEnv),
      'utf8',
    );
    const launch = resolveHarnessLaunch({
      env:executionEnv,
      runtimeDirectory,
      gateway,
      catalogPath,
      overlayPath,
      workspaceId,
      researchProfile,
      closedTask,
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

  function drain() {
    if(activeEntry || closing || !queue.length) return;
    queue.sort((a,b)=>b.priority-a.priority || a.sequence-b.sequence);
    const entry=queue.shift();activeEntry=entry;
    entry.input.signal?.removeEventListener('abort',entry.cancel);
    Promise.resolve().then(async()=>{
      entry.input.signal?.throwIfAborted();
      entry.input.onExecutionStart?.();
      try {await entry.input.trace?.({event:'runtime.execution.started',detail:{queueMs:Date.now()-entry.queuedAt}});} catch {}
      return withModelUsageContext(entry.usageContext, () => runWithFallback(entry.input));
    }).then(entry.resolve,entry.reject).finally(()=>{activeEntry=null;drain();});
  }
  function withLock(input) {
    if(closing) return Promise.reject(new Error('Harness 已关闭'));
    if(input.signal?.aborted) return Promise.reject(input.signal.reason || new DOMException('The operation was aborted','AbortError'));
    return new Promise((resolve,reject)=>{
      const entry={input,resolve,reject,usageContext:modelUsageContext(),sequence:sequence++,queuedAt:Date.now(),
        priority:input.closedContext===true ? Math.max(-10,Math.min(10,Number(input.executionPriority)||0)) : 20};
      entry.cancel=()=>{
        const index=queue.indexOf(entry);
        if(index<0) return;
        queue.splice(index,1);input.signal?.removeEventListener('abort',entry.cancel);
        reject(input.signal.reason || new DOMException('The operation was aborted','AbortError'));
      };
      input.signal?.addEventListener('abort',entry.cancel,{once:true});queue.push(entry);drain();
    });
  }

  return Object.freeze({
    kind: 'harness',
    supportsExecutionAdmission: true,
    availableTools({ researchProfile } = {}) {
      const profile = researchProfile?.mode ? researchProfile : resolveResearchProfile('standard');
      const domain = projectToolCatalog(tools, visibleDomainToolIds(tools, {
        researchProfile: profile, configuredIds,
      }));
      return withHarnessWebTools(domain);
    },
    async close() {
      closing=true;
      for(const entry of queue.splice(0)) {entry.input.signal?.removeEventListener('abort',entry.cancel);entry.reject(new Error('Harness 已关闭'));}
      await disposeEngine();
    },
    async run(input = {}) {
      return withLock(input);
    },
  });

  async function runWithFallback(input) {
    try {return await runOnce(input);}catch(error) {
      if(input.closedContext!==true || input.closedTask!=='article-normalize' || !error.quotaExhausted || env.AI_CENTER_HARNESS_ARTICLE_FALLBACK!=='elucid-grok')throw error;
      await input.trace?.({event:'article.provider.fallback',detail:{from:'google',to:'elucid-grok',reason:'quota-exhausted'}});
      return runOnce(input,true);
    }
  }

  async function runOnce({
    message, workspaceId, sessionId = '', jobId = '', selectedRefs = [], signal,
    priorTurns = [], selectedContext = '', webMode = 'off',
    researchMode = 'standard', researchProfile, taskInstruction = '',
    allowedToolIds: runAllow, timeoutMs, trace, now, closedContext = false, closedTask = '', usageStage = '', googleModel, googleKeyEnv,
  } = {}, articleFallback=false) {
    let runEnv=articleFallback ? {...env,AI_CENTER_HARNESS_ARTICLE_PROVIDER:'elucid-grok',AI_CENTER_HARNESS_ARTICLE_MODEL:env.AI_CENTER_HARNESS_ARTICLE_FALLBACK_MODEL || 'grok-4.7'} : env;
    if(!articleFallback && (googleModel!==undefined || googleKeyEnv!==undefined)) {
      const hourlyGoogle=closedTask==='hourly-brief' && String(env.AI_CENTER_HARNESS_HOURLY_PROVIDER || '').trim()==='google';
      const articleGoogle=closedTask==='article-normalize' && String(env.AI_CENTER_HARNESS_ARTICLE_PROVIDER || '').trim()==='google';
      if(closedContext!==true || (!hourlyGoogle && !articleGoogle))throw new Error('Google selectors require a closed Google task');
      const selected=resolveHarnessLlm(env,{closedTask,googleModel});
      const prefix=hourlyGoogle ? 'AI_CENTER_HARNESS_HOURLY' : 'AI_CENTER_HARNESS_ARTICLE';
      runEnv={...env,[`${prefix}_MODEL`]:selected.model};
    }
    const runStartedAt = Date.now();
    const runtimeContext = buildRuntimeContext(now ?? clock(), timeZone);
    const record = async (event, detail) => {
      try { await trace?.({ event, detail }); } catch {}
    };
    const profile = researchProfile?.mode
      ? researchProfile
      : resolveResearchProfile(researchMode);
    const closed = closedContext === true;
    const task = closed && ['media-brief','daily-analysis','hourly-brief','article-normalize'].includes(closedTask) ? closedTask : '';
    let llm = resolveHarnessLlm(runEnv, { researchProfile: profile, closedTask:task });
    if (missingHarnessLlmCredential(env, llm)) {
      throw new Error(harnessLlmCredentialError(llm));
    }
    const selection = resolveHarnessRunTools(tools, {
      closedContext: closed,
      researchProfile: profile,
      configuredIds: runAllow ?? configuredIds,
    });
    const { allow, catalog, visibleTools } = selection;
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
    const priorTask = !(closed && String(usageStage).startsWith('tree-')) && quality?.advisePrior && quality.config?.priorMode !== 'off'
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

    let slot, articleTicket, executionEnv=runEnv;
    const googleAdmission=task==='hourly-brief' ? hourlyAdmission : articleAdmission;
    if(['article-normalize','hourly-brief'].includes(task) && llm.provider==='google') {
      if(!googleAdmission)throw new Error('Google article task requires persistent traffic admission');
      articleTicket=googleAdmission.reserve({model:llm.model,keyEnv:googleKeyEnv,useModelPool:googleModel===undefined,inputBytes:Buffer.byteLength(buildHarnessPrompt({closedContext:true,taskInstruction,message})),maxTokens:llm.execution.maxTokens});
      const prefix=task==='hourly-brief' ? 'AI_CENTER_HARNESS_HOURLY' : 'AI_CENTER_HARNESS_ARTICLE';
      executionEnv={...runEnv,[prefix+'_KEY_ENV']:articleTicket.keyEnv,[prefix+'_MODEL']:articleTicket.model};
      llm=resolveHarnessLlm(executionEnv,{researchProfile:profile,closedTask:task});
    }
    if(articleFallback)articleAdmission.reserveFallback({model:llm.model,inputBytes:Buffer.byteLength(buildHarnessPrompt({closedContext:true,taskInstruction,message})),maxTokens:llm.execution.maxTokens});
    try {
      slot = await ensureEngine({
        executionEnv, allow, catalog, workspaceId, timeoutMs, researchProfile: profile, closedContext: closed, closedTask:task,
      });
    } catch (error) {
      if(articleTicket){googleAdmission.failed(articleTicket,error);googleAdmission.release?.(articleTicket);}
      await record('run.failed', {
        runtime: 'harness',
        name: error?.name || 'Error',
        message: error?.message || String(error),
      });
      throw error;
    }
    slot.gateway.setContext({
      workspaceId, message, signal, sessionId, jobId, selectedRefs, runtimeContext,
      usageAttribution: { workspaceId: workspaceId || modelUsageContext().workspaceId || 'local', jobId: jobId || modelUsageContext().jobId || '',
        jobAttempt: modelUsageContext().jobAttempt ?? null, applicationSessionId: sessionId || '', harnessSessionId: '', stage: 'web-search' },
    });

    const applicationSessionId = String(sessionId || '').trim();
    let harnessSessionId = applicationSessionId ? slot.sessionIds.get(applicationSessionId) : '';
    const warm = Boolean(harnessSessionId);
    if (applicationSessionId && !harnessSessionId) {
      harnessSessionId = `aicenter-${randomUUID().replaceAll('-', '')}`;
      slot.sessionIds.set(applicationSessionId, harnessSessionId);
    }
    if (!harnessSessionId) harnessSessionId = `aicenter-${randomUUID().replaceAll('-', '')}`;
    slot.gateway.setUsageAttribution({ harnessSessionId });
    const usageObserver = createHarnessUsageObserver({
      record: value => usageLedger?.record(value), provider: slot.launch.provider, model: slot.launch.model,
      attribution: { workspaceId, jobId, applicationSessionId, stage: usageStage || task || (taskInstruction ? 'article-analysis' : 'ask') },
    });
    const prompt = warm
      ? followUpPrompt({ message, selectedContext, priorHint, taskInstruction, priorTurns })
      : [
        buildHarnessPrompt({
          message,
          selectedContext,
          priorTurns,
          webMode,
          researchProfile: profile,
          taskInstruction,
          runtimeContext:task=='article-normalize' ? undefined : runtimeContext,
          catalog: visibleTools,
          closedContext: closed,
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
      usageObserver.notification(notification);
      const event = notification?.params?.event;
      if (notification?.method === 'session.event' && notification.params.sessionId === harnessSessionId && event?.type === 'step/start') {
        slot.gateway.setUsageAttribution({ turn: event.data?.turn ?? null, step: event.data?.step ?? null });
      }
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
      usageObserver.events(result?.sessionId || harnessSessionId, result?.events || []);
      for (const item of projectHarnessTraceEvents(result?.events || [])) {
        const stamp = `${item.event}:${JSON.stringify(item.detail || {})}`;
        if (liveTrace.has(stamp)) continue;
        noteHarnessTrace(runRef.current, item);
        liveTrace.add(stamp);
        await record(item.event, item.detail);
      }
      assertSuccessfulTurn(result);
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
      const webSearchAvailable = !closed;
      const evidence = webSearchEvidence(toolCalls);
      let decision = resolveFinalAnswer({
        answer,
        evidence,
        remainingModelCalls: task==='article-normalize' ? 0 : 1,
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
        usageObserver.events(retry?.sessionId || harnessSessionId, retry?.events || []);
        assertSuccessfulTurn(retry);
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
      const finishReason=turnFinishLabel((result?.events || []).findLast(event=>event.type==='turn/end')?.data?.reason);
      usageObserver.noteHttpStatus(harnessSessionId, 200);
      return {
        answer,
        providerId: slot.launch.provider,
        modelId: slot.launch.model,
        ...(finishReason ? {finishReason} : {}),
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
      if(articleTicket && error && typeof error==='object') {
        if(!error.googleKeyEnv && articleTicket.keyEnv) error.googleKeyEnv=articleTicket.keyEnv;
        if(!error.admittedModel && articleTicket.model) error.admittedModel=articleTicket.model;
      }
      if(articleTicket)googleAdmission.failed(articleTicket,error);
      const directStatus=Number(error?.upstreamStatus ?? error?.status);
      const httpStatus=Number.isInteger(directStatus) && directStatus>=100 && directStatus<=599 ? directStatus
        : (error?.name==='TimeoutError' || error?.name==='ModelExecutionTimeout' || /模型执行超时/.test(String(error?.message || '')) ? 408 : null);
      if(httpStatus) usageObserver.noteHttpStatus(harnessSessionId, httpStatus);
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
      try {await supplementHarnessUsage({ dshHome: slot.launch.dshHome, sessionId: harnessSessionId, observer: usageObserver });}
      finally {usageObserver.interrupt();if(articleTicket)googleAdmission.release?.(articleTicket);}
    }
  }
}
