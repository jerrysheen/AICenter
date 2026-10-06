import { createFeedValueEvaluator, normalizeFeedValueText, FEED_VALUE_VERSION, FEED_VALUE_RULE, feedValueRuleHash } from './feed-value.js';
import { FeedValueRuleSchema } from '../../contracts/src/feed-value.js';
export const FEED_FILTER_VERSION = FEED_VALUE_VERSION;

// V1 remains explicitly selectable; V2 is a frozen offline comparison.
export { createFeedQualityEvaluator, decideFeedQuality, normalizeFeedQualityText,
  FEED_QUALITY_VERSION, FEED_QUALITY_PROFILES } from './feed-quality.js';

const INFORMATION_LOW = 0.35;
const RESIDUE_HIGH = 0.65;
const WORTH_KEEPING_LOW = 0.35;
const SUBSTANTIAL_CHAR = /[\p{L}\p{N}]/u;

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clip(value, max = 1_200) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

function envFlag(value) {
  return text(value).toLowerCase();
}

function itemFields(input = {}) {
  const item = isRecord(input.item) ? input.item : input;
  return {
    title: String(item.title || ''),
    summary: String(item.summary || ''),
    body: String(item.body || ''),
    originalText: String(input.originalText || item.originalText || ''),
    authorName: String(item.authorName || ''),
    provider: String(input.provider || item.provider || ''),
    externalId: String(item.externalId || input.externalId || ''),
  };
}

function combinedText(fields) {
  return [fields.title, fields.summary, fields.body, fields.originalText]
    .map((value) => String(value || ''))
    .join('\n');
}

export function resolveFeedFilterConfig(env = process.env) {
  const raw = envFlag(env.AI_CENTER_FEED_FILTER);
  const mode = raw === 'enforce' || raw === 'off' ? raw : 'shadow';
  return Object.freeze({
    mode,
    version: text(env.AI_CENTER_FEED_FILTER_VERSION, FEED_FILTER_VERSION),
    rule: FeedValueRuleSchema.parse(text(env.AI_CENTER_FEED_FILTER_RULE, FEED_VALUE_RULE)),
  });
}

export function hasSubstantialText(value) {
  return SUBSTANTIAL_CHAR.test(String(value || ''));
}

export function isEmptyOrBlank(value) {
  return !String(value || '').trim();
}

export function evaluateDeterministic(input = {}, lookup = {}) {
  const fields = itemFields(input);
  const combined = combinedText(fields);
  if (isEmptyOrBlank(combined)) {
    return { kind: 'empty', reason: 'empty' };
  }
  if (!hasSubstantialText(combined)) {
    return { kind: 'empty', reason: 'no-body' };
  }

  const workspaceId = input.workspaceId;
  const provider = fields.provider || input.provider;
  const externalId = fields.externalId;
  const contentHash = input.contentHash;
  const identityHash = input.identityHash;

  const existingCapture = input.existingCapture !== undefined
    ? input.existingCapture
    : lookup.findCaptureByExternalId?.(workspaceId, provider, externalId);
  if (existingCapture && (!contentHash || existingCapture.contentHash === contentHash)) {
    return { kind: 'duplicate', reason: 'duplicate-external-id' };
  }

  const existingByHash = input.existingByContentHash !== undefined
    ? input.existingByContentHash
    : lookup.findCaptureByContentHash?.(workspaceId, provider, contentHash);
  if (existingByHash && String(existingByHash.externalId || '') !== externalId) {
    return { kind: 'duplicate', reason: 'duplicate-content-hash' };
  }

  const hasFingerprint = input.hasIdentityFingerprint !== undefined
    ? Boolean(input.hasIdentityFingerprint)
    : Boolean(lookup.hasIdentityFingerprint?.(workspaceId, provider, identityHash));
  if (hasFingerprint && !existingCapture) {
    return { kind: 'duplicate', reason: 'duplicate-identity' };
  }

  return null;
}

export function buildFeedFilterState(input = {}) {
  const fields = itemFields(input);
  return {
    provider: fields.provider,
    title: clip(fields.title, 280),
    body: clip(fields.body || fields.originalText || fields.summary, 1_200),
    author: clip(fields.authorName, 80),
  };
}

export function buildFeedFilterQuestions() {
  return {
    is_information: {
      type: 'noul',
      instructions: 'Does this captured text contain at least one independently understandable fact, opinion, event, data point, or question?',
      criteria: {
        true: 'It contains a fact, opinion, event, data point, or question that can be understood on its own.',
        false: 'It has no independently understandable information.',
      },
    },
    is_residue: {
      type: 'noul',
      instructions: 'Is this mainly UI residue, a CTA, a login prompt, an ad template, emoji-only noise, a simple greeting, or a scrape error?',
      criteria: {
        true: 'It is mainly residue, CTA, login prompt, ad template, emoji, greeting, or scrape error.',
        false: 'It is not mainly residue or template noise.',
      },
    },
    worth_keeping: {
      type: 'noul',
      instructions: 'From information completeness alone, is this worth saving as an independent FeedItem? Do not judge personal interest, investment value, or importance.',
      criteria: {
        true: 'It is complete enough to keep as its own FeedItem.',
        false: 'It is too incomplete or empty to keep as a FeedItem.',
      },
    },
  };
}

export function parseFeedFilterAnswers(answers = {}) {
  const scores = {};
  for (const key of ['is_information', 'is_residue', 'worth_keeping']) {
    const value = Number(answers?.[key]?.noul);
    if (Number.isFinite(value)) scores[key] = Math.min(1, Math.max(0, value));
  }
  return scores;
}

export function decideFeedFilter(scores = {}) {
  const information = Number(scores.is_information);
  const residue = Number(scores.is_residue);
  const worthKeeping = Number(scores.worth_keeping);
  if (![information, residue, worthKeeping].every(Number.isFinite)) {
    return { keep: true, reason: 'scores-unavailable' };
  }
  if (information <= INFORMATION_LOW && residue >= RESIDUE_HIGH && worthKeeping <= WORTH_KEEPING_LOW) {
    return { keep: false, reason: 'high-confidence-residue' };
  }
  return { keep: true, reason: 'keep' };
}

function verdict({
  action,
  reason,
  stage,
  mode,
  version,
  model = '',
  scores = {},
  failOpen = false,
}) {
  const wouldIgnore = action === 'ignore';
  const applyIgnore = wouldIgnore && mode === 'enforce';
  return Object.freeze({
    action: applyIgnore ? 'ignore' : (action === 'skip' ? 'skip' : 'keep'),
    createContentItem: action !== 'skip' && !applyIgnore,
    status: action === 'skip' ? null : (applyIgnore ? 'ignored' : 'ready'),
    reason,
    stage,
    mode,
    wouldKeep: !wouldIgnore,
    wouldIgnore,
    failOpen,
    scores,
    model,
    metadata: action === 'skip'
      ? {}
      : {
        filterReason: reason,
        filterVersion: version,
        evaluatorModel: model,
        wouldKeep: !wouldIgnore,
        wouldIgnore,
      },
  });
}

export function createFeedFilter({ client = null, config, lookup = {}, calibration = null } = {}) {
  const resolved = config || resolveFeedFilterConfig();
  if (resolved.version === FEED_VALUE_VERSION) return createFeedValueFilter({ client, config: resolved, lookup, calibration });
  if (resolved.version !== 'feed-filter-v1') throw new Error('Unsupported feed filter version');

  return Object.freeze({
    config: resolved,
    async evaluate(input = {}) {
      if (resolved.mode === 'off') {
        return verdict({
          action: 'keep',
          reason: 'off',
          stage: 'off',
          mode: resolved.mode,
          version: resolved.version,
        });
      }

      const deterministic = evaluateDeterministic(input, lookup);
      if (deterministic) {
        if (deterministic.kind === 'duplicate') {
          return verdict({
            action: 'skip',
            reason: deterministic.reason,
            stage: 'deterministic',
            mode: resolved.mode,
            version: resolved.version,
          });
        }
        return verdict({
          action: 'ignore',
          reason: deterministic.reason,
          stage: 'deterministic',
          mode: resolved.mode,
          version: resolved.version,
        });
      }

      if (!client || typeof client.evaluate !== 'function'
        || (typeof client.available === 'function' && !client.available())) {
        return verdict({
          action: 'keep',
          reason: 'jev-unavailable',
          stage: 'fail-open',
          mode: resolved.mode,
          version: resolved.version,
          failOpen: true,
        });
      }

      try {
        const response = await client.evaluate({
          state: buildFeedFilterState(input),
          questions: buildFeedFilterQuestions(),
          signal: input.signal,
        });
        const scores = parseFeedFilterAnswers(response?.answers);
        const decision = decideFeedFilter(scores);
        return verdict({
          action: decision.keep ? 'keep' : 'ignore',
          reason: decision.reason,
          stage: 'jev',
          mode: resolved.mode,
          version: resolved.version,
          model: text(response?.model),
          scores,
        });
      } catch (error) {
        return verdict({
          action: 'keep',
          reason: error?.code || 'jev-failed',
          stage: 'fail-open',
          mode: resolved.mode,
          version: resolved.version,
          failOpen: true,
        });
      }
    },
  });
}

function createFeedValueFilter({ client, config, lookup, calibration }) {
  const rule=FeedValueRuleSchema.parse(config.rule || 'calibrated-value');
  const evaluator = createFeedValueEvaluator({ client, model: calibration?.model || client?.modelId || '', calibration, rule });
  return Object.freeze({ config, async evaluate(input = {}) {
    if (config.mode === 'off') return verdict({ action:'keep', reason:'off', stage:'off', mode:config.mode, version:config.version });
    const duplicate = evaluateDeterministic(input, lookup);
    if (duplicate?.kind === 'duplicate') return verdict({ action:'skip', reason:duplicate.reason, stage:'deterministic', mode:config.mode, version:config.version });
    const fields=itemFields(input), capture=input.item?.captureContext || {};
    const normalized=normalizeFeedValueText(fields.originalText || fields.body || fields.summary,
      { title:fields.title, authorName:fields.authorName, capture });
    const result=await evaluator.evaluate(normalized,{signal:input.signal});
    // Explicit enforce of the user-selected rule is independent of empirical calibration qualification.
    const strictAdmission=rule===FEED_VALUE_RULE;
    const canDrop=strictAdmission || rule==='two-of-three-0.60' || config.mode!=='enforce' || calibration?.productionQualified===true;
    const blocked=strictAdmission ? result.decision.decision!=='KEEP' : result.decision.decision==='DROP';
    const action=blocked && canDrop?'ignore':'keep';
    const output=verdict({action,reason:result.decision.reason,stage:'jev-value',mode:config.mode,
      version:config.version,model:result.model,scores:result.scores || {},failOpen:!strictAdmission && result.decision.reviewKind==='technical'});
    return {...output,...(strictAdmission && config.mode==='enforce' && result.decision.decision==='REVIEW'?{status:'captured'}:{}),metadata:{...output.metadata,filterDecision:result.decision.decision,
      filterReviewKind:result.decision.reviewKind,filterScores:result.scores,
      filterPolicyHash:result.policyHash,filterCacheKey:result.cacheKey,
      calibrationApplied:calibration?.sampleHash || '',enforceQualified:calibration?.productionQualified===true,
      filterMode:config.mode,filterApplied:output.action==='ignore',filterRule:rule,filterRuleHash:feedValueRuleHash(rule),
      captureContext:input.item?.captureContext || {},
      qualityMissingParts:normalized.missingParts}};
  }});
}

export function createFeedFilterFromEnv({ client = null, env = process.env, lookup, calibration } = {}) {
  const config = resolveFeedFilterConfig(env);
  if (config.mode === 'off') return null;
  return createFeedFilter({ client, config, lookup, calibration });
}
