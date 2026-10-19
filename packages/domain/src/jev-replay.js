import { decideFeedAdmissionFallback } from './feed-filter.js';
import {
  createFeedValueEvaluator,
  normalizeFeedValueText,
  FEED_VALUE_RULE,
  FEED_VALUE_VERSION,
  feedValuePolicyHash,
  feedValueRuleHash,
} from './feed-value.js';

export const JEV_REPLAY_REASONS = Object.freeze(['jev-failed', 'jev-unavailable', 'jev-disabled']);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function heldCaptureInput(capture = {}) {
  const metadata = capture.metadata && typeof capture.metadata === 'object' ? capture.metadata : {};
  return {
    provider: capture.provider,
    sourceExternalId: capture.sourceExternalId || '',
    originalText: metadata.originalText || '',
    item: {
      provider: capture.provider,
      title: capture.title || '',
      body: metadata.originalText || capture.title || '',
      xFocus: metadata.xFocus,
      sourceExternalId: capture.sourceExternalId || '',
    },
  };
}

function replayContent(capture) {
  const metadata = isRecord(capture.metadata) ? capture.metadata : {};
  const article = isRecord(metadata.article) ? metadata.article : {};
  if (capture.provider === 'media') {
    return {
      contentType: 'article',
      summary: String(metadata.summary || article.summary || ''),
      authorName: String(article.author || metadata.publisherKey || ''),
      body: String(metadata.originalText || article.text || capture.title || ''),
      dedup: {
        url: capture.sourceUrl || '',
        title: capture.title || '',
        publishedAt: capture.publishedAt || null,
        sourceKey: metadata.sourceKey || '',
        publisherKey: metadata.publisherKey || '',
        sourceExternalId: capture.sourceExternalId || (metadata.sourceKey ? `media:${metadata.sourceKey}` : ''),
      },
    };
  }
  return {
    contentType: 'post',
    summary: String(metadata.summary || ''),
    authorName: String(metadata.authorProfile?.name || ''),
    body: String(metadata.originalText || capture.title || ''),
    dedup: {
      url: capture.sourceUrl || '',
      title: capture.title || '',
      publishedAt: capture.publishedAt || null,
      sourceExternalId: capture.sourceExternalId || '',
    },
  };
}

function originalCreatedAt(capture) {
  const published = Number(capture.publishedAt);
  if (Number.isInteger(published) && published > 0) return published;
  const captured = Number(capture.capturedAt);
  if (Number.isInteger(captured) && captured >= 0) return captured;
  return Date.now();
}

export async function admitHeldCapture({
  feedRepository,
  capture,
  reason,
  evaluation = null,
  enqueueTranslation,
  articleDedup = null,
  transaction = null,
} = {}) {
  const scored = evaluation && !evaluation.errorReason && evaluation.scores;
  const metadata = {
    ...(capture.metadata || {}),
    filterDecision: 'KEEP',
    filterReason: reason,
    filterApplied: false,
    filterMode: capture.metadata?.filterMode || 'enforce',
    filterRule: scored ? FEED_VALUE_RULE : (capture.metadata?.filterRule || FEED_VALUE_RULE),
    filterReviewKind: 'none',
    fallbackAt: new Date().toISOString(),
    filterErrorCode: capture.metadata?.filterErrorCode || evaluation?.errorCode || '',
    filterErrorStatus: capture.metadata?.filterErrorStatus ?? evaluation?.errorStatus ?? null,
    ...(scored ? {
      filterScores: evaluation.scores,
      filterPolicyHash: evaluation.policyHash || feedValuePolicyHash(),
      filterCacheKey: evaluation.cacheKey || '',
      evaluatorModel: evaluation.model || '',
      filterRuleHash: evaluation.ruleHash || feedValueRuleHash(FEED_VALUE_RULE),
      filterVersion: FEED_VALUE_VERSION,
    } : {}),
  };
  const shape = replayContent(capture);
  const write = () => {
    const saved = feedRepository.saveCapture({
      id: capture.id,
      workspaceId: capture.workspaceId,
      provider: capture.provider,
      externalId: capture.externalId,
      sourceAccountId: capture.sourceAccountId || null,
      sourceUrl: capture.sourceUrl || '',
      title: capture.title || '',
      contentHash: capture.contentHash,
      rawArtifactPath: capture.rawArtifactPath || null,
      status: 'ready',
      publishedAt: capture.publishedAt || null,
      capturedAt: capture.capturedAt,
      authorNativeId: capture.authorNativeId || null,
      metadata,
    });
    const item = feedRepository.saveContentItem({
      workspaceId: capture.workspaceId,
      captureId: saved.id,
      originType: 'subscription',
      contentType: shape.contentType,
      title: capture.title || '',
      body: shape.body,
      summary: shape.summary,
      sourceUrl: capture.sourceUrl || '',
      authorName: shape.authorName,
      publishedAt: capture.publishedAt || null,
      createdAt: originalCreatedAt(capture),
    });
    articleDedup?.rememberFeed?.(capture.workspaceId, item.id, shape.dedup);
    return { capture: saved, item };
  };
  const saved = typeof transaction === 'function' ? transaction(write) : write();
  if (enqueueTranslation) await enqueueTranslation(saved.capture, saved.item);
  return saved;
}

export async function reevaluateHeldCaptures({
  captures = [],
  mode = 'fallback',
  jevEnabled = true,
  xFocusConfig = null,
  xFocusMin = 0.7,
  evaluator = null,
  dryRun = false,
  onKeep,
  prefix = '',
} = {}) {
  const useJev = mode === 'jev' && jevEnabled === true && evaluator;
  const reasonPrefix = prefix || (jevEnabled === false ? 'jev-disabled' : 'fallback');
  const results = [];
  for (const capture of captures) {
    if (useJev) {
      const input = normalizeFeedValueText(capture.metadata?.originalText || capture.title || '', {
        title: capture.title || '',
        authorName: capture.metadata?.authorProfile?.name || '',
        capture: capture.metadata?.captureContext || {},
      });
      const result = await evaluator.evaluate(input);
      if (result.decision?.decision === 'KEEP' && !result.errorReason) {
        if (!dryRun && onKeep) await onKeep(capture, result.decision.reason || 'all-three', result);
        results.push({ externalId: capture.externalId, action: 'keep', reason: result.decision.reason || 'all-three' });
      } else {
        results.push({
          externalId: capture.externalId,
          action: 'hold',
          reason: result.errorReason || result.decision?.reason || 'jev-failed',
        });
      }
      continue;
    }
    const admission = decideFeedAdmissionFallback(heldCaptureInput(capture), {
      xFocusConfig,
      xFocusMin,
      prefix: reasonPrefix,
    });
    if (!admission.admit) {
      results.push({
        externalId: capture.externalId,
        action: 'hold',
        reason: jevEnabled === false ? 'jev-disabled' : (capture.metadata?.filterReason || 'jev-failed'),
      });
      continue;
    }
    if (!dryRun && onKeep) await onKeep(capture, admission.reason);
    results.push({ externalId: capture.externalId, action: 'keep', reason: admission.reason });
  }
  return results;
}

export function createReplayEvaluator(client, model = '') {
  if (!client) return null;
  return createFeedValueEvaluator({ client, model: model || client.modelId || '', rule: FEED_VALUE_RULE });
}
