import {
  buildEvidenceGateQuestions,
  buildEvidenceGateState,
  buildSufficiencyQuestions,
  buildSufficiencyState,
  clampScore,
  extractRetrievalHits,
  formatSufficiencyHint,
  hitConfidence,
  isEvidenceGateTool,
  parseEvidenceHitScores,
  projectEvidenceGateAudit,
  publicEvidenceGateSummary,
  resolveEvidenceGateMode,
  roundScore,
} from './evidence-gate.js';

export const AGENT_QUALITY_WEIGHTS = Object.freeze({
  coverage: 0.25,
  relevance: 0.20,
  evidence: 0.20,
  sequence: 0.15,
  efficiency: 0.10,
  completion: 0.10,
});

// Temporary T0 quality table. Unknown tools default to root-capable.
// Long term this belongs on Tool Registry metadata, not a second catalog here.
export const TOOL_ROLES = Object.freeze({
  'holdings.get': { role: 'root' },
  'holdings.rank': { role: 'root' },
  'user.method.get': { role: 'root' },
  'web.search': { role: 'root' },
  'web.fetch': { role: 'root' },
  'static.signals.list': { role: 'root' },
  'assets.get': { role: 'root' },
  'market.overview.get': { role: 'root' },
  'market.global.get': { role: 'root' },
  'feed.search': { role: 'root' },
  'feed.tag.search': { role: 'root' },
  'tag.list': { role: 'root' },
  'context.build': { role: 'root' },
  'knowledge.search': { role: 'root' },
  'taxonomy.list': { role: 'root' },
  'official.source.get': { role: 'follow-up', dependsOn: 'static.signals.list' },
  'knowledge.get': { role: 'follow-up', dependsOn: 'knowledge.search' },
  'memory.save': { role: 'follow-up', dependsOn: 'taxonomy.list' },
});

const REVIEW_DIMENSIONS = Object.freeze([
  {
    id: 'coverage',
    instructions: 'Judge process coverage only. You cannot see the final answer. Required root tools were used. Omitting a follow-up tool is not an omission unless a previous observation made that follow-up required.',
    criteria: {
      true: 'Needed root tools were called, or no root tool was required.',
      false: 'A clearly required root tool was skipped.',
    },
  },
  {
    id: 'relevance',
    instructions: 'Every tool the agent actually called was relevant to the user task or to a previous observation.',
    criteria: {
      true: 'Called tools match the task or a just-observed follow-up need.',
      false: 'At least one called tool was unrelated to the task and to prior observations.',
    },
  },
  {
    id: 'evidence',
    instructions: 'Judge process evidence handling only. You cannot see the final answer. failed and unavailable are not successful evidence. empty-valid is successful evidence that the lookup worked and the resource does not exist.',
    criteria: {
      true: 'failed/unavailable were not treated as successful evidence; empty-valid was treated as absence, not as existing content.',
      false: 'The trajectory treated failed or unavailable results as successful evidence, or treated empty-valid as proof that content exists.',
    },
  },
  {
    id: 'sequence',
    instructions: 'The order of tool calls was reasonable. Root tools come before follow-up tools that depend on them.',
    criteria: {
      true: 'The sequence is a sensible path, including observation-triggered follow-ups.',
      false: 'The order is inverted, redundant, or confused.',
    },
  },
  {
    id: 'efficiency',
    instructions: 'Judge process efficiency only. You cannot see the final answer. A later call after weak or usable/partial evidence to get a strong result is incremental. resultCount alone is not enough. Do not treat partial as strong.',
    criteria: {
      true: 'No wasteful repeats. Weak or partial then strong, or listing then official detail, can be incremental.',
      false: 'Repeated same-utility calls, or continued search after a complete strong result already answered the process need.',
    },
  },
  {
    id: 'completion',
    instructions: 'Judge process completion only. You cannot see the final answer or tool bodies. A trajectory is complete when it reached a terminal process state: required root tools were called, empty-valid established absence, or no tool was required.',
    criteria: {
      true: 'The process reached a state sufficient to end the task.',
      false: 'The process stopped short of a usable terminal state, such as skipping a required root tool or leaving failed/unavailable unresolved.',
    },
  },
]);

const STRONG_UTILITY_TOOLS = new Set([
  'holdings.get', 'user.method.get', 'knowledge.get', 'official.source.get',
  'static.signals.list', 'assets.get', 'market.overview.get', 'market.global.get',
  'memory.save', 'web.fetch',
]);
const WEAK_UTILITY_TOOLS = new Set(['web.search']);
const DEFAULT_EVIDENCE_GATE_TIMEOUT_MS = 15_000;

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function clip(value, max = 280) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function envFlag(value) {
  return text(value).toLowerCase();
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function deadlineSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    const error = new Error(`Evidence Gate 超时（${timeoutMs}ms）`);
    error.name = 'EvidenceGateTimeoutError';
    error.code = 'EVIDENCE_GATE_TIMEOUT';
    controller.abort(error);
  }, timeoutMs);
  const onAbort = () => {
    controller.abort(parentSignal?.reason instanceof Error
      ? parentSignal.reason
      : new DOMException('The operation was aborted', 'AbortError'));
  };
  if (parentSignal?.aborted) onAbort();
  else parentSignal?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onAbort);
    },
  };
}

function questionKey(prefix, toolId) {
  return `${prefix}__${String(toolId || '').replace(/[^a-zA-Z0-9]+/g, '_')}`;
}

export function toolRole(toolId) {
  return TOOL_ROLES[String(toolId || '')] || { role: 'root' };
}

export function isRootTool(toolId) {
  return toolRole(toolId).role !== 'follow-up';
}

export function resolveAgentQualityConfig(env = process.env) {
  const disabled = envFlag(env.AI_CENTER_JEV_DISABLED) === '1';
  const priorRaw = envFlag(env.AI_CENTER_JEV_PRIOR);
  const priorMode = priorRaw === 'advisory' || priorRaw === 'off' || priorRaw === 'shadow'
    ? priorRaw
    : 'shadow';
  const reviewerRaw = envFlag(env.AI_CENTER_JEV_REVIEWER);
  const reviewerEnabled = reviewerRaw === 'off' || reviewerRaw === '0' ? false : true;
  const evidenceGateMode = resolveEvidenceGateMode(env, { disabled });
  return Object.freeze({
    disabled,
    priorMode: disabled ? 'off' : priorMode,
    reviewerEnabled: disabled ? false : reviewerEnabled,
    evidenceGateMode,
    evidenceGateTimeoutMs: positiveInteger(
      env.AI_CENTER_JEV_EVIDENCE_TIMEOUT_MS,
      DEFAULT_EVIDENCE_GATE_TIMEOUT_MS,
    ),
  });
}

export function projectVisibleTools(tools = []) {
  return (Array.isArray(tools) ? tools : []).map((tool) => {
    const id = String(tool.id || '').trim();
    const meta = toolRole(id);
    return {
      id,
      effect: String(tool.effect || 'read'),
      description: clip(tool.description, 360),
      role: meta.role,
      dependsOn: meta.dependsOn || null,
    };
  }).filter((tool) => tool.id);
}

export function relevanceBand(score) {
  const value = Number(score);
  if (!Number.isFinite(value)) return 'unknown';
  if (value >= 0.7) return 'high';
  if (value >= 0.4) return 'medium';
  return 'low';
}

export function formatPriorHint(scores = {}) {
  const rows = Object.entries(scores)
    .filter(([id, score]) => isRootTool(id) && Number.isFinite(Number(score)))
    .sort((left, right) => Number(right[1]) - Number(left[1]))
    .map(([id, score]) => `${id}: ${relevanceBand(score)} (${Number(score).toFixed(2)})`);
  if (!rows.length) return '';
  return [
    'T0 root-tool necessity hint (advisory only; the full tool table remains available; this is expected required, not helpfulness, and not a command to call or skip tools):',
    ...rows,
  ].join('\n');
}

export function buildPriorState({ message, webMode = 'off', researchMode = 'standard', tools = [] } = {}) {
  const visible = projectVisibleTools(tools);
  return {
    user_question: clip(message, 1_200),
    web_mode: webMode === 'always' || webMode === 'fallback' ? webMode : 'off',
    research_mode: researchMode === 'research' ? 'research' : 'standard',
    prior_scope: 't0-root-required',
    root_tools: visible.filter((tool) => tool.role === 'root'),
    follow_up_tools: visible.filter((tool) => tool.role === 'follow-up'),
  };
}

export function buildPriorQuestions(tools = []) {
  const questions = {};
  for (const tool of projectVisibleTools(tools).filter((item) => item.role === 'root')) {
    questions[questionKey('prior', tool.id)] = {
      type: 'noul',
      instructions: `Given only the current user request, is the root tool "${tool.id}" likely to be required before the task can be satisfactorily completed? Do not score follow-up tools that depend on a later observation.`,
      criteria: {
        true: `At T0, ${tool.id} is expected to be required to complete this request.`,
        false: `${tool.id} is not required at T0. Being merely useful, confirmatory, or a later follow-up is a no.`,
      },
    };
  }
  return questions;
}

export function parseNoulAnswers(answers = {}, prefix, toolIds = []) {
  const scores = {};
  for (const toolId of toolIds) {
    const value = Number(answers[questionKey(prefix, toolId)]?.noul);
    if (Number.isFinite(value)) scores[toolId] = Math.min(1, Math.max(0, value));
  }
  return scores;
}

export function inferResultKind(toolId, data) {
  const id = String(toolId || '');
  if (data == null) return 'empty';
  if (id === 'holdings.get' || id === 'holdings.rank') return 'positions';
  if (id === 'assets.get') return 'assets';
  if (id === 'web.search') return 'web-results';
  if (id === 'knowledge.search' || id === 'knowledge.get' || id === 'user.method.get') return 'knowledge';
  if (id === 'feed.search' || id === 'feed.tag.search') return 'feed';
  if (id === 'context.build') return 'context';
  if (id === 'market.overview.get' || id === 'market.global.get') return 'market';
  if (id === 'static.signals.list') return 'official-listing';
  if (id === 'official.source.get') return 'official-detail';
  if (id === 'taxonomy.list') return 'taxonomy';
  if (id === 'tag.list') return 'tags';
  if (id === 'memory.save') return 'write';
  if (Array.isArray(data)) return 'list';
  if (isRecord(data)) {
    if (Array.isArray(data.positions)) return 'positions';
    if (Array.isArray(data.items)) return 'items';
    if (Array.isArray(data.results)) return 'results';
    return 'object';
  }
  return 'value';
}

export function inferResultCount(toolId, data) {
  if (data == null) return 0;
  if (Array.isArray(data)) return data.length;
  if (!isRecord(data)) return 1;
  if (Array.isArray(data.positions)) return data.positions.length;
  if (Array.isArray(data.items)) return data.items.length;
  if (Array.isArray(data.results)) return data.results.length;
  if (Array.isArray(data.knowledge)) return data.knowledge.length;
  if (Array.isArray(data.recentFeed)) return data.recentFeed.length;
  if (Array.isArray(data.upcoming) || Array.isArray(data.releases)) {
    return (data.upcoming?.length || 0) + (data.releases?.length || 0);
  }
  if (Array.isArray(data.nodes)) return data.nodes.length;
  if (Number.isFinite(data.matchedCount)) return Number(data.matchedCount);
  if (Number.isFinite(data.resultCount)) return Number(data.resultCount);
  if (Number.isFinite(data.totalCount)) return Number(data.totalCount);
  if (Number.isFinite(data.returnedCount)) return Number(data.returnedCount);
  if (data.webSearch && Number.isFinite(data.webSearch.resultCount)) return Number(data.webSearch.resultCount);
  if (data.latest) return 1;
  if (data.title || data.body) return 1;
  return 1;
}

function looksUnavailable(data, warnings = []) {
  if (isRecord(data) && data.available === false) return true;
  if (isRecord(data) && /unavailable/i.test(String(data.status || ''))) return true;
  return (Array.isArray(warnings) ? warnings : []).some((item) => /unavailable|不可用/i.test(String(item || '')));
}

export function inferAuditOutcome(toolId, toolResult = {}, { error = null } = {}) {
  if (error || toolResult?.error) return 'failed';
  const data = toolResult?.data;
  const warnings = toolResult?.warnings || [];
  if (looksUnavailable(data, warnings)) return 'unavailable';
  const count = inferResultCount(toolId, data);
  const truncated = Boolean(isRecord(data) && data.truncated);
  const missingQuotes = isRecord(data) && Array.isArray(data.missingQuotes) && data.missingQuotes.length > 0;
  const unhealthy = isRecord(data) && Array.isArray(data.sourceHealth)
    && data.sourceHealth.some((item) => item?.status && item.status !== 'ready');
  if (data == null || count === 0) return 'empty-valid';
  if (truncated || missingQuotes || unhealthy) return 'partial';
  return 'found';
}

export function inferResultUtility(toolId, outcome, data) {
  if (outcome === 'failed' || outcome === 'unavailable' || outcome === 'empty-valid') return 'empty';
  if (outcome === 'partial') return 'usable';
  if (WEAK_UTILITY_TOOLS.has(toolId)) return 'weak';
  if (STRONG_UTILITY_TOOLS.has(toolId)) return 'strong';
  if (inferResultCount(toolId, data) > 0) return 'usable';
  return 'empty';
}

export function projectToolAudit(toolId, toolResult = {}, { durationMs = null, error = null } = {}) {
  const failed = Boolean(error || toolResult?.error);
  const data = failed ? null : toolResult?.data;
  const outcome = inferAuditOutcome(toolId, toolResult, { error });
  const meta = toolRole(toolId);
  return {
    tool: String(toolId || ''),
    role: meta.role,
    dependsOn: meta.dependsOn || null,
    success: !failed,
    resultKind: inferResultKind(toolId, data),
    resultCount: inferResultCount(toolId, data),
    outcome,
    resultUtility: inferResultUtility(toolId, outcome, data),
    warningCount: Array.isArray(toolResult?.warnings) ? toolResult.warnings.length : 0,
    durationMs: Number.isFinite(Number(durationMs)) ? Number(durationMs) : null,
    errorCode: error?.code || toolResult?.error?.code || null,
  };
}

function projectCalledAudit(item) {
  return {
    tool: item.tool,
    role: item.role || toolRole(item.tool).role,
    dependsOn: item.dependsOn || toolRole(item.tool).dependsOn || null,
    success: item.success !== false,
    resultKind: item.resultKind || 'object',
    resultCount: Number(item.resultCount) || 0,
    outcome: item.outcome || 'found',
    resultUtility: item.resultUtility || 'usable',
    warningCount: Number(item.warningCount) || 0,
    durationMs: item.durationMs ?? null,
    errorCode: item.errorCode || null,
  };
}

export function buildReviewerState({
  message, webMode = 'off', researchMode = 'standard', tools = [],
  toolAudits = [], answer = '', warnings = [], rejectedAnswers = 0,
  evidenceGate = null,
} = {}) {
  const visible = projectVisibleTools(tools);
  const evidenceAudit = projectEvidenceGateAudit(evidenceGate);
  return {
    user_question: clip(message, 1_200),
    web_mode: webMode === 'always' || webMode === 'fallback' ? webMode : 'off',
    research_mode: researchMode === 'research' ? 'research' : 'standard',
    prior_scope: 't0-root-required',
    root_tool_ids: visible.filter((tool) => tool.role === 'root').map((tool) => tool.id),
    follow_up_tool_ids: visible.filter((tool) => tool.role === 'follow-up').map((tool) => tool.id),
    called_tools: (Array.isArray(toolAudits) ? toolAudits : []).map(projectCalledAudit),
    evidence_gate: evidenceAudit,
    answer_present: Boolean(String(answer || '').trim()),
    answer_chars: String(answer || '').length,
    warning_count: Array.isArray(warnings) ? warnings.length : 0,
    rejected_answers: Number(rejectedAnswers) || 0,
  };
}

export function buildReviewerQuestions({ tools = [], toolAudits = [] } = {}) {
  const questions = {};
  for (const dimension of REVIEW_DIMENSIONS) {
    questions[dimension.id] = {
      type: 'noul',
      instructions: dimension.instructions,
      criteria: dimension.criteria,
    };
  }
  const neededIds = new Set([
    ...projectVisibleTools(tools).filter((tool) => tool.role === 'root').map((tool) => tool.id),
    ...(Array.isArray(toolAudits) ? toolAudits : []).map((item) => item.tool).filter(Boolean),
  ]);
  for (const toolId of neededIds) {
    const role = toolRole(toolId).role;
    questions[questionKey('needed', toolId)] = {
      type: 'noul',
      instructions: role === 'follow-up'
        ? `After looking at the trajectory, was the follow-up tool "${toolId}" necessary given previous observations? A follow-up can be necessary even if it was not required at T0.`
        : `Was the root tool "${toolId}" necessary to complete this user task?`,
      criteria: {
        true: `${toolId} was required to complete the task.`,
        false: `${toolId} was not required. Being merely useful or confirmatory is a no.`,
      },
    };
  }
  return questions;
}

export function parseReviewerAnswers(answers = {}, { tools = [], toolAudits = [] } = {}) {
  const dimensions = {};
  for (const dimension of REVIEW_DIMENSIONS) {
    const value = Number(answers[dimension.id]?.noul);
    if (Number.isFinite(value)) dimensions[dimension.id] = Math.min(1, Math.max(0, value));
  }
  const toolIds = [...new Set([
    ...projectVisibleTools(tools).filter((tool) => tool.role === 'root').map((tool) => tool.id),
    ...(Array.isArray(toolAudits) ? toolAudits : []).map((item) => item.tool).filter(Boolean),
  ])];
  return {
    dimensions,
    needed: parseNoulAnswers(answers, 'needed', toolIds),
  };
}

export function computeAgentQualityScore(dimensions = {}, weights = AGENT_QUALITY_WEIGHTS) {
  let weighted = 0;
  let total = 0;
  for (const [key, weight] of Object.entries(weights)) {
    const value = Number(dimensions[key]);
    if (!Number.isFinite(value)) continue;
    weighted += value * weight;
    total += weight;
  }
  if (total <= 0) return null;
  return Math.round((weighted / total) * 100);
}

export function comparePriorQuality(priorScores = {}, calledToolIds = [], neededScores = {}, {
  predictedThreshold = 0.5,
  neededThreshold = 0.5,
  scope = 't0-root',
} = {}) {
  const called = new Set((Array.isArray(calledToolIds) ? calledToolIds : []).filter(Boolean));
  const toolIds = [...new Set([
    ...Object.keys(priorScores),
    ...called,
    ...Object.keys(neededScores),
  ])];
  const counts = {
    hit: 0,
    miss: 0,
    falsePositive: 0,
    trueNegative: 0,
    unpredictedUsed: 0,
    predictedUnused: 0,
    excludedFollowUp: 0,
  };
  const items = toolIds.map((tool) => {
    const role = toolRole(tool).role;
    if (scope === 't0-root' && role === 'follow-up') {
      counts.excludedFollowUp += 1;
      return {
        tool,
        role,
        prior: Number.isFinite(Number(priorScores[tool])) ? Number(priorScores[tool]) : null,
        called: called.has(tool),
        needed: Number.isFinite(Number(neededScores[tool])) ? Number(neededScores[tool]) : null,
        verdict: 'excluded-follow-up',
      };
    }
    const prior = Number.isFinite(Number(priorScores[tool])) ? Number(priorScores[tool]) : null;
    const needed = Number.isFinite(Number(neededScores[tool])) ? Number(neededScores[tool]) : null;
    const predicted = prior != null && prior >= predictedThreshold;
    const used = called.has(tool);
    const necessary = needed == null ? null : needed >= neededThreshold;
    let verdict = 'unknown';
    if (necessary === true && predicted) {
      verdict = 'prior-hit';
      counts.hit += 1;
    } else if (necessary === true && !predicted) {
      verdict = 'prior-miss';
      counts.miss += 1;
    } else if (necessary === false && predicted) {
      verdict = 'prior-false-positive';
      counts.falsePositive += 1;
    } else if (necessary === false && !predicted) {
      verdict = 'prior-true-negative';
      counts.trueNegative += 1;
    } else if (predicted && used) {
      verdict = 'predicted-and-used';
    } else if (predicted && !used) {
      verdict = 'predicted-unused';
      counts.predictedUnused += 1;
    } else if (!predicted && used) {
      verdict = 'unpredicted-used';
      counts.unpredictedUsed += 1;
    } else {
      verdict = 'unpredicted-unused';
    }
    return { tool, role, prior, called: used, needed, verdict };
  });
  return { scope, items, counts };
}

function failedQuality(kind, error) {
  return {
    status: 'failed',
    kind,
    error: clip(error?.message || error, 240),
    code: error?.code || '',
  };
}

export function createAgentQualityLayer({ client, config, now = () => Date.now() } = {}) {
  if (!client || typeof client.evaluate !== 'function') {
    throw new Error('agent quality requires a TypeSafe client');
  }
  const resolved = config || resolveAgentQualityConfig();

  return Object.freeze({
    config: resolved,
    async advisePrior({ message, webMode, researchMode, tools, signal } = {}) {
      if (resolved.priorMode === 'off') return { status: 'skipped', kind: 'prior', reason: 'off', scores: {} };
      const visible = projectVisibleTools(tools);
      const rootTools = visible.filter((tool) => tool.role === 'root');
      if (!rootTools.length) return { status: 'skipped', kind: 'prior', reason: 'no-root-tools', scores: {} };
      const startedAt = now();
      try {
        const response = await client.evaluate({
          state: buildPriorState({ message, webMode, researchMode, tools: visible }),
          questions: buildPriorQuestions(visible),
          signal,
        });
        const scores = parseNoulAnswers(response.answers, 'prior', rootTools.map((tool) => tool.id));
        return {
          status: 'ok',
          kind: 'prior',
          mode: resolved.priorMode,
          scope: 't0-root-required',
          scores,
          bands: Object.fromEntries(Object.entries(scores).map(([id, score]) => [id, relevanceBand(score)])),
          rootToolIds: rootTools.map((tool) => tool.id),
          followUpToolIds: visible.filter((tool) => tool.role === 'follow-up').map((tool) => tool.id),
          hint: formatPriorHint(scores),
          model: response.model || '',
          usage: response.usage || {},
          durationMs: now() - startedAt,
        };
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        return { ...failedQuality('prior', error), scores: {}, durationMs: now() - startedAt };
      }
    },
    async reviewRun(input = {}) {
      if (!resolved.reviewerEnabled) return { status: 'skipped', kind: 'review', reason: 'off' };
      const startedAt = now();
      try {
        const response = await client.evaluate({
          state: buildReviewerState(input),
          questions: buildReviewerQuestions(input),
          signal: input.signal,
        });
        const parsed = parseReviewerAnswers(response.answers, input);
        const score = computeAgentQualityScore(parsed.dimensions);
        const calledToolIds = (input.toolAudits || []).map((item) => item.tool).filter(Boolean);
        const priorQuality = comparePriorQuality(input.priorScores || {}, calledToolIds, parsed.needed);
        return {
          status: 'ok',
          kind: 'review',
          dimensions: parsed.dimensions,
          needed: parsed.needed,
          score,
          weights: AGENT_QUALITY_WEIGHTS,
          priorQuality,
          model: response.model || '',
          usage: response.usage || {},
          durationMs: now() - startedAt,
        };
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        return { ...failedQuality('review', error), durationMs: now() - startedAt };
      }
    },
    async gateEvidence({
      message = '', query = '', toolId = '', toolResult = {}, signal, mode,
    } = {}) {
      const resolvedMode = mode || resolved.evidenceGateMode || 'off';
      if (resolvedMode === 'off') {
        return { status: 'skipped', kind: 'evidence-gate', reason: 'off', hits: [], accepted: [], rejected: [] };
      }
      if (!isEvidenceGateTool(toolId)) {
        return { status: 'skipped', kind: 'evidence-gate', reason: 'not-retrieval', hits: [], accepted: [], rejected: [] };
      }
      const hits = extractRetrievalHits(toolId, toolResult?.data);
      if (!hits.length) {
        return { status: 'skipped', kind: 'evidence-gate', reason: 'no-hits', hits: [], accepted: [], rejected: [] };
      }
      const startedAt = now();
      const deadline = deadlineSignal(
        signal,
        positiveInteger(resolved.evidenceGateTimeoutMs, DEFAULT_EVIDENCE_GATE_TIMEOUT_MS),
      );
      try {
        const scoredResponse = await client.evaluate({
          state: buildEvidenceGateState({ message, query, toolId, hits }),
          questions: buildEvidenceGateQuestions(hits),
          signal: deadline.signal,
        });
        const scoredHits = parseEvidenceHitScores(scoredResponse.answers, hits);
        const accepted = scoredHits.filter((hit) => hit.accepted);
        const rejected = scoredHits.filter((hit) => !hit.accepted);
        let sufficiency = accepted.length ? 0 : 0;
        let sufficiencyModel = scoredResponse.model || '';
        let sufficiencyUsage = scoredResponse.usage || {};
        if (accepted.length) {
          const sufficientResponse = await client.evaluate({
            state: buildSufficiencyState({ message, query, toolId, accepted }),
            questions: buildSufficiencyQuestions(),
            signal: deadline.signal,
          });
          sufficiency = clampScore(sufficientResponse.answers?.sufficiency?.noul) ?? 0;
          sufficiencyModel = sufficientResponse.model || sufficiencyModel;
          sufficiencyUsage = sufficientResponse.usage || sufficiencyUsage;
        }
        const confidence = accepted.length
          ? hitConfidence({
            relevance: accepted.reduce((sum, hit) => sum + Number(hit.relevance || 0), 0) / accepted.length,
            evidence: accepted.reduce((sum, hit) => sum + Number(hit.evidence || 0), 0) / accepted.length,
            quality: accepted.reduce((sum, hit) => sum + Number(hit.quality || 0), 0) / accepted.length,
          })
          : roundScore(sufficiency * 0.3);
        const decision = {
          status: 'ok',
          kind: 'evidence-gate',
          mode: resolvedMode,
          toolId,
          query: String(query || ''),
          hits: scoredHits,
          accepted,
          rejected,
          sufficiency,
          confidence,
          hint: formatSufficiencyHint(sufficiency),
          model: sufficiencyModel,
          usage: sufficiencyUsage,
          durationMs: now() - startedAt,
        };
        return {
          ...decision,
          summary: publicEvidenceGateSummary(decision),
        };
      } catch (error) {
        if (signal?.aborted) throw error;
        return {
          ...failedQuality('evidence-gate', error),
          hits: [],
          accepted: [],
          rejected: [],
          durationMs: now() - startedAt,
        };
      } finally {
        deadline.clear();
      }
    },
  });
}

export async function settlePriorAdvice(priorTask, record) {
  if (!priorTask) return null;
  try {
    const prior = await priorTask;
    if (!prior || prior.status === 'skipped') {
      await record('advisor.prior.skipped', { reason: prior?.reason || 'off' });
      return prior || null;
    }
    if (prior.status !== 'ok') {
      await record('advisor.prior.failed', {
        message: prior.error || 'prior failed',
        code: prior.code || '',
        durationMs: prior.durationMs ?? null,
      });
      return prior;
    }
    await record('advisor.prior.completed', {
      mode: prior.mode,
      scores: prior.scores,
      bands: prior.bands,
      model: prior.model || '',
      usage: prior.usage || {},
      durationMs: prior.durationMs ?? null,
    });
    return prior;
  } catch (error) {
    if (error?.name === 'AbortError') return null;
    await record('advisor.prior.failed', { message: String(error?.message || error).slice(0, 240) });
    return null;
  }
}

export async function settleAgentQualityReview({ quality, input = {}, result = {}, record } = {}) {
  if (!quality?.reviewRun) return null;
  const startedAt = Date.now();
  try {
    const toolAudits = result.toolAudits
      || (Array.isArray(result.toolCalls) ? result.toolCalls.map((call) => call.audit).filter(Boolean) : []);
    await record?.('reviewer.started', { toolCount: toolAudits.length });
    const review = await quality.reviewRun({
      message: input.message,
      webMode: input.webMode || 'off',
      researchMode: input.researchMode || input.researchProfile?.mode || 'standard',
      tools: result.visibleTools || [],
      toolAudits,
      answer: result.answer || '',
      warnings: result.warnings || [],
      rejectedAnswers: result.rejectedAnswers || 0,
      priorScores: result.qualityPrior?.scores || {},
      evidenceGate: result.evidenceGate || null,
      signal: input.signal,
    });
    if (review?.status === 'ok') {
      await record?.('reviewer.completed', {
        score: review.score,
        dimensions: review.dimensions,
        weights: review.weights,
        needed: review.needed,
        durationMs: review.durationMs ?? null,
        model: review.model || '',
        usage: review.usage || {},
      });
      if (review.priorQuality) {
        await record?.('advisor.prior.quality', review.priorQuality);
      }
    } else if (review?.status === 'skipped') {
      await record?.('reviewer.skipped', { reason: review.reason || 'off' });
    } else {
      await record?.('reviewer.failed', {
        message: review?.error || 'review failed',
        code: review?.code || '',
        durationMs: review?.durationMs ?? Date.now() - startedAt,
      });
    }
    return review;
  } catch (error) {
    if (error?.name === 'AbortError') return null;
    await record?.('reviewer.failed', {
      message: clip(error?.message || error, 240),
      durationMs: Date.now() - startedAt,
    });
    return null;
  }
}

export function createAgentQualityLayerFromEnv({ client, env = process.env, now } = {}) {
  const config = resolveAgentQualityConfig(env);
  if (config.disabled || (config.priorMode === 'off' && !config.reviewerEnabled && config.evidenceGateMode === 'off')) {
    return null;
  }
  if (!client || typeof client.evaluate !== 'function') return null;
  if (typeof client.available === 'function' && !client.available()) return null;
  return createAgentQualityLayer({ client, config, now });
}
