export const FEED_FILTER_VERSION = 'feed-filter-v1';

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

export function createFeedFilter({ client = null, config, lookup = {} } = {}) {
  const resolved = config || resolveFeedFilterConfig();

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

export function createFeedFilterFromEnv({ client = null, env = process.env, lookup } = {}) {
  const config = resolveFeedFilterConfig(env);
  if (config.mode === 'off') return null;
  return createFeedFilter({ client, config, lookup });
}
